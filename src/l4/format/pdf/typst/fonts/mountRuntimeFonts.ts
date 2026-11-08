import type { Diagnostic as RenderDiagnostic } from '../../../../../shared/diagnostics/diagnostic.js';
import type { IPdfCompiler } from '../../pdfCompiler.js';
import { BUNDLED_MATH_FALLBACK, BUNDLED_TEXT_FALLBACK, SYSTEM_FALLBACK, type LocalFontResolution } from './localFontProvider.js';

interface MountedRuntimeFonts {
    readonly mountedCount: number;
    readonly mountedNames: readonly string[];
    readonly diagnostics: RenderDiagnostic[];
    readonly effectiveFonts: LocalFontResolution;
}

export async function mountRuntimeFonts(
    resolution: LocalFontResolution,
    compiler: IPdfCompiler,
): Promise<MountedRuntimeFonts> {
    if (!compiler.setRuntimeFonts) {
        return {
            mountedCount: 0,
            mountedNames: [],
            diagnostics: [],
            effectiveFonts: { ...resolution, localFontsAvailable: false },
        };
    }
    const bytes: Uint8Array[] = [];
    const names: string[] = [];
    const diagnostics: RenderDiagnostic[] = [];
    type FontRead = { ok: true; data: Uint8Array } | { ok: false; error: unknown };
    const reads: FontRead[] = [];
    const remaining = resolution.fonts.entries();
    const readNext = async (): Promise<void> => {
        for (const [index, font] of remaining) {
            try { reads[index] = { ok: true, data: await font.getBytes() }; }
            catch (error) { reads[index] = { ok: false, error }; }
        }
    };
    // Read independent font blobs in a small pool; preserve resolution order for Typst fallbacks.
    await Promise.all(Array.from({ length: Math.min(3, resolution.fonts.length) }, readNext));
    for (const [index, font] of resolution.fonts.entries()) {
        const read = reads[index];
        if (read.ok && read.data?.length > 0) {
            bytes.push(read.data);
            names.push(`${font.family} (local, ${font.postscriptName})`);
        } else if (read.ok) {
            diagnostics.push({
                severity: 'warning',
                code: 'TYPST_LOCAL_FONT_READ_FAILED',
                message: `Local font "${font.family}" (${font.postscriptName}) returned empty bytes; it will not be mounted in the Typst sandbox.`,
            });
        } else {
            diagnostics.push({
                severity: 'warning',
                code: 'TYPST_LOCAL_FONT_READ_FAILED',
                message: `Local font "${font.family}" (${font.postscriptName}) failed to read bytes (${
                    read.error instanceof Error ? read.error.message : String(read.error)
                }); it will not be mounted in the Typst sandbox.`,
            });
        }
    }
    compiler.setRuntimeFonts(bytes);
    const effectiveFonts: LocalFontResolution = {
        fonts: [],
        diagnostics: [...resolution.diagnostics, ...diagnostics],
        fallbackChain: [...names, BUNDLED_MATH_FALLBACK, BUNDLED_TEXT_FALLBACK, SYSTEM_FALLBACK],
        localFontsAvailable: bytes.length > 0,
    };
    return { mountedCount: bytes.length, mountedNames: names, diagnostics, effectiveFonts };
}

