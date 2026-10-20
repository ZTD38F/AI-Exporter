import { isAbortError } from '../errors.js';
import type {
    AssetResolver,
    RenderContext,
    RenderDiagnostic,
    ResolvedAsset,
    TypstRenderPayload,
} from '../../canonical/rendering.js';
import {
    StageError,
    type CompileStageInput,
    type CompileStageOutput,
    type ImageMount,
    type StageFn,
} from './types.js';

const PDF_MAGIC = '%PDF-';
const MIN_PDF_BYTES = 64;

// Resolve strictly via pathMap[assetId] -> virtualPath so content-addressed mounts cannot collide with asset IDs.
function makeMountAssetResolver(
    mounts: ImageMount[],
    input: CompileStageInput,
    diagnostics: RenderDiagnostic[],
): AssetResolver {
    const byVirtualPath = new Map<string, ImageMount[]>();
    for (const mount of mounts) {
        const v = byVirtualPath.get(mount.virtualPath) ?? [];
        v.push(mount);
        byVirtualPath.set(mount.virtualPath, v);
    }

    const miss = (code: string, message: string): null => {
        diagnostics.push({ severity: 'warning', code, message });
        return null;
    };

    return {
        async resolve(assetId: string): Promise<ResolvedAsset | null> {
            const asset = input.bundle.assets.find((a) => a.id === assetId);
            if (!asset) {
                return miss(
                    'COMPILE_ASSET_UNKNOWN_ID',
                    `Asset ${assetId} is not in the canonical bundle; returning null so the template renders its placeholder.`,
                );
            }
            const virtualPath = input.pathMap.get(assetId);
            if (virtualPath === undefined) {
                return miss(
                    'COMPILE_ASSET_PATHMAP_MISSING',
                    `Asset ${assetId} has no resource pathMap entry; refusing to guess the mount, returning null so the template renders its placeholder.`,
                );
            }
            const candidates = byVirtualPath.get(virtualPath) ?? [];
            if (candidates.length === 0) {
                return miss(
                    'COMPILE_ASSET_MOUNT_MISSING',
                    `No sandbox mount found at virtual path ${virtualPath} for asset ${assetId}; returning null so the template renders its placeholder.`,
                );
            }
            if (candidates.length > 1) {
                return miss(
                    'COMPILE_ASSET_MOUNT_AMBIGUOUS',
                    `${candidates.length} mounts share virtual path ${virtualPath} for asset ${assetId}; refusing to guess, returning null so the template renders its placeholder.`,
                );
            }
            const mount = candidates[0];
            if (!mount.bytes || mount.bytes.length === 0) {
                return miss(
                    'COMPILE_ASSET_MOUNT_EMPTY',
                    `Mount for asset ${assetId} (${mount.virtualPath}) has no bytes; returning null so the template renders its placeholder.`,
                );
            }
            return { asset, bytes: mount.bytes };
        },
    };
}

function verifyPdfBytes(pdfBytes: Uint8Array): void {
    if (!pdfBytes || !(pdfBytes instanceof Uint8Array) || pdfBytes.length < MIN_PDF_BYTES) {
        throw new Error(
            `compiler returned empty or truncated PDF bytes (${pdfBytes?.length ?? 0} bytes); minimum expected is ${MIN_PDF_BYTES}`,
        );
    }
    let magic = '';
    for (let i = 0; i < PDF_MAGIC.length && i < pdfBytes.length; i++) {
        magic += String.fromCharCode(pdfBytes[i]);
    }
    if (magic !== PDF_MAGIC) {
        throw new Error(
            `compiler returned ${pdfBytes.length} bytes without the %PDF- magic; refusing to treat them as a PDF`,
        );
    }
}

export const compileStage: StageFn<CompileStageInput, CompileStageOutput> = async (input, ctx) => {
    ctx.signal.throwIfAborted();

    const diagnostics: RenderDiagnostic[] = [];

    for (const d of input.fonts.diagnostics) {
        diagnostics.push({ severity: d.severity, code: d.code, message: d.message });
    }
    if (input.fonts.localFontsAvailable) {
        ctx.log(`[PDF] compile: local fonts resolved, fallback chain: ${input.fonts.fallbackChain.join(' -> ')}`, 'info');
    } else {
        ctx.log('[PDF] compile: no local fonts resolved; the compiler falls back to bundled fonts', 'warn');
    }

    const context: RenderContext = {
        bundle: input.bundle,
        assets: makeMountAssetResolver(input.mounts, input, diagnostics),
        locale: input.locale,
        signal: ctx.signal,
        reportProgress: ctx.reportProgress,
    };

    const compilerPayload: TypstRenderPayload = {
        rendererSchemaVersion: 1,
        sourceSchemaVersion: 1,
        bundle: input.bundle,
        document: input.payload,
        assetPaths: input.pathMap,
    };

    let pdfBytes: Uint8Array;
    try {
        const result = await input.compiler.compile(compilerPayload, context);
        diagnostics.push(...result.diagnostics);
        pdfBytes = result.pdfBytes;
    } catch (e) {
        if (isAbortError(e)) throw e;
        throw new StageError(
            'compile',
            'COMPILE_FAILED',
            `PDF compiler '${input.compiler.name}' failed: ${(e as Error)?.message ?? String(e)}`,
            { retryable: true, cause: e, diagnostics },
        );
    }

    try {
        verifyPdfBytes(pdfBytes);
    } catch (e) {
        throw new StageError(
            'compile',
            'PDF_VERIFY_FAILED',
            `PDF verification failed for compiler '${input.compiler.name}': ${(e as Error)?.message ?? String(e)}`,
            { retryable: true, cause: e, diagnostics },
        );
    }

    return { output: { pdfBytes }, diagnostics };
};
