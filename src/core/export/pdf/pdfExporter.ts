import type {
    ArtifactWriteReport,
    RenderDiagnostic,
} from '../canonical/rendering.js';
import { createWriter, type IExportWriter } from '../../engine/writers/writerInterface.js';
import { normId } from '../../utils/pathUtils.js';
import { DEFAULT_EXPORT_FOLDER_NAME } from '../../utils/constants.js';
import { isAbortError } from './errors.js';
import { BatchWorker, type FetchChatDetailResult } from '../../engine/export/batchWorker.js';
import { IPdfCompiler } from './pdfCompiler.js';
import { TypstSandboxCompiler, type RuntimeFontConsumer } from '../typst/typstSandboxCompiler.js';
import { PdfPipeline } from './pipeline/orchestrator.js';
import { resourceStage } from './pipeline/resourceStage.js';
import { payloadStage } from './pipeline/payloadStage.js';
import { compileStage } from './pipeline/compileStage.js';
import { deliverStage, finalizeZipDelivery } from './pipeline/deliveryStage.js';
import {
    BUNDLED_MATH_FALLBACK,
    SYSTEM_FALLBACK,
    resolveLocalFonts,
    type FontProviderDiagnostic,
    type LocalFontResolution,
} from '../typst/fonts/localFontProvider.js';
import type {
    PipelineItemInput,
    PipelineStages,
    StageContext,
} from './pipeline/types.js';

export interface PdfExportItemResult {
    id: string;
    title: string;
    ok: boolean;
    fileName?: string;
    bytesWritten?: number;
    error?: string;
    diagnostics: RenderDiagnostic[];
}

export interface PdfExportResult {
    total: number;
    succeeded: number;
    failed: PdfExportItemResult[];
    aborted: boolean;
    zipDelivery?: { fileName: string; bytesWritten: number; deliveredAt: string };
    /** Aliases matching ExportEngine's return shape for the shared Options UI summary and retry flow. */
    failedChats?: PdfExportItemResult[];
    landedChats?: number;
    exportedCount?: number;
}

export interface PdfExportProgress {
    current: number;
    total: number;
    pct: number;
    title: string;
}

export interface PdfExporterOptions {
    selected: Array<string | { id: string; title?: string }>;
    conversations?: any[];
    format?: string;
    useZip?: boolean;
    dirHandle?: any;
    folderName?: string;
    compiler?: IPdfCompiler;
    writer?: IExportWriter;
    downloadHandler?: (blob: Blob, filename: string) => void | Promise<void>;
    locale?: 'zh' | 'en';
    currentSlot?: string;
    skip?: boolean;
    /**
     * Detail-fetch seam. Production defaults to BatchWorker.fetchChatDetail —
     * the same path the normal export uses; tests inject a mock so no live
     * Gemini tab is needed.
     */
    fetchChatDetail?: typeof BatchWorker.fetchChatDetail;
    includeAssets?: boolean;
    takeoutEngine?: any;
    assetPipeline?: any;
    fetchAssetDelegate?: (params: any) => Promise<any>;
    fetchAsset?: (params: any) => Promise<any>;
    getGeminiTab?: (slot?: string) => Promise<any>;
    sendToGeminiTab?: (message: any, slot?: string, timeoutMs?: number) => Promise<any>;
    maxAssetRetries?: number;
}

export interface PdfExporterCallbacks {
    onProgress?: (p: PdfExportProgress) => void;
    onLog?: (msg: string, level?: string) => void;
    onItemExported?: (id: string, record: any) => void;
}

const DEFAULT_PIPELINE_STAGES: PipelineStages = {
    resources: resourceStage,
    payload: payloadStage,
    compile: compileStage,
    deliver: deliverStage,
};

function isExtensionPageContext(): boolean {
    return (
        typeof document !== 'undefined' &&
        typeof chrome !== 'undefined' &&
        typeof (chrome as any)?.runtime?.getURL === 'function'
    );
}

function createProductionCompiler(): IPdfCompiler {
    if (!isExtensionPageContext()) {
        throw new Error(
            '[PdfExporter] constructed without a compiler outside an ' +
                'extension page context. Inject an IPdfCompiler explicitly.',
        );
    }
    return new TypstSandboxCompiler();
}

export {
    PDF_NO_MESSAGES,
    PDF_DETAIL_FETCH_FAILED,
    hasUsableMessages,
    extractChatFromDetailResult,
    resolveFullChatDetail,
    preparePdfItem,
    toRenderDiagnostic,
    type PreparedPdfItemResult,
    type PreparedPdfItemSuccess,
    type PreparedPdfItemFailure,
    type PreparePdfItemContext,
} from './prepareItem.js';
import { preparePdfItem } from './prepareItem.js';

export interface MountedRuntimeFonts {
    readonly mountedCount: number;
    readonly mountedNames: readonly string[];
    readonly diagnostics: FontProviderDiagnostic[];
    readonly effectiveFonts: LocalFontResolution;
}

export async function mountRuntimeFonts(
    resolution: LocalFontResolution,
    compiler: IPdfCompiler,
): Promise<MountedRuntimeFonts> {
    const consumer = compiler as unknown as RuntimeFontConsumer;
    if (typeof consumer.setRuntimeFonts !== 'function') {
        return {
            mountedCount: 0,
            mountedNames: [],
            diagnostics: [],
            effectiveFonts: { ...resolution, localFontsAvailable: false },
        };
    }
    const bytes: Uint8Array[] = [];
    const names: string[] = [];
    const diagnostics: FontProviderDiagnostic[] = [];
    for (const font of resolution.fonts) {
        try {
            const data = await font.getBytes();
            if (data && data.length > 0) {
                bytes.push(data);
                names.push(`${font.family} (local, ${font.postscriptName})`);
            } else {
                diagnostics.push({
                    severity: 'warning',
                    code: 'TYPST_LOCAL_FONT_READ_FAILED',
                    message: `Local font "${font.family}" (${font.postscriptName}) returned empty bytes; it will not be mounted in the Typst sandbox.`,
                });
            }
        } catch (e) {
            diagnostics.push({
                severity: 'warning',
                code: 'TYPST_LOCAL_FONT_READ_FAILED',
                message: `Local font "${font.family}" (${font.postscriptName}) failed to read bytes (${
                    (e as Error)?.message ?? String(e)
                }); it will not be mounted in the Typst sandbox.`,
            });
        }
    }
    consumer.setRuntimeFonts(bytes);
    const effectiveFonts: LocalFontResolution = {
        fonts: [],
        diagnostics: [...resolution.diagnostics, ...diagnostics],
        fallbackChain: [...names, BUNDLED_MATH_FALLBACK, SYSTEM_FALLBACK],
        localFontsAvailable: bytes.length > 0,
    };
    return { mountedCount: bytes.length, mountedNames: names, diagnostics, effectiveFonts };
}

export class PdfExporter {
    aborted = false;
    private _abortController: AbortController | null = null;
    private _compiler: IPdfCompiler;
    private readonly ownsCompiler: boolean;

    constructor(compiler?: IPdfCompiler) {
        this.ownsCompiler = compiler === undefined;
        this._compiler = compiler ?? createProductionCompiler();
    }

    abort(): void {
        // Do not dispose the compiler here; runExport's finally block disposes it after the in-flight run settles.
        this.aborted = true;
        try {
            this._abortController?.abort();
        } catch {
            /* intentional */
        }
    }

    /** Disposes the sandbox compiler only if this instance created it, leaving injected compilers to their caller. */
    dispose(): void {
        if (!this.ownsCompiler) return;
        const maybeDisposable = this._compiler as { dispose?: unknown };
        if ('dispose' in this._compiler && typeof maybeDisposable.dispose === 'function') {
            maybeDisposable.dispose();
        }
    }

    async run(options: PdfExporterOptions, callbacks: PdfExporterCallbacks = {}): Promise<PdfExportResult> {
        const onProgress = callbacks.onProgress ?? (() => {});
        const onLog = callbacks.onLog ?? (() => {});
        const onItemExported = callbacks.onItemExported ?? (() => {});
        const compiler = options.compiler ?? this._compiler;

        this.aborted = false;
        this._abortController = typeof AbortController !== 'undefined' ? new AbortController() : null;
        const signal: AbortSignal =
            this._abortController?.signal ?? new AbortController().signal;

        const selected = Array.isArray(options.selected) ? options.selected : [];
        const useZip = options.useZip !== false;
        const locale = options.locale === 'en' ? 'en' : 'zh';
        const folderName = options.folderName || DEFAULT_EXPORT_FOLDER_NAME;
        const fetchChatDetailFn = options.fetchChatDetail ?? BatchWorker.fetchChatDetail;
        const currentSlot = options.currentSlot ?? 'u0';
        const skip = options.skip ?? false;

        const items = selected.map((s) => {
            const id = typeof s === 'string' ? s : s?.id;
            const title = (typeof s === 'object' && s?.title) || String(id ?? '');
            return { id: String(id ?? ''), title };
        }).filter((it) => it.id);

        const total = items.length;
        const failed: PdfExportItemResult[] = [];
        let succeeded = 0;
        // In ZIP mode, items are staged in memory and only marked succeeded after finalizeZipDelivery() completes.
        const staged: Array<{
            id: string;
            title: string;
            diagnostics: RenderDiagnostic[];
            pdfFileName: string;
            pdfBytesWritten: number;
        }> = [];
        let writer: IExportWriter | null = options.writer ?? null;
        let zipDelivery: PdfExportResult['zipDelivery'];

        const report = (current: number, title: string) => {
            onProgress({
                current,
                total,
                pct: total === 0 ? 100 : Math.round((current / total) * 100),
                title,
            });
        };

        const failItem = (id: string, title: string, error: string, diagnostics: RenderDiagnostic[]): void => {
            onLog(`[PDF] ${title || id} 导出失败: ${error}`, 'error');
            failed.push({ id, title, ok: false, error, diagnostics });
            completed.add(id);
            surfaceDiagnostics(id, title, diagnostics);
        };

        const surfaceDiagnostics = (id: string, title: string, diagnostics: RenderDiagnostic[]): void => {
            for (const d of diagnostics) {
                if (d.severity === 'warning' || d.severity === 'error') {
                    onLog(`[PDF] ${title || id} ${d.severity}: [${d.code}] ${d.message}`, d.severity === 'warning' ? 'warn' : 'error');
                }
            }
        };

        // Record persistence failure emits a warning diagnostic without failing the already-delivered file.
        const commitRecord = async (id: string, record: any, diagnostics: RenderDiagnostic[]): Promise<void> => {
            try {
                await onItemExported(id, record);
            } catch (e: any) {
                const rmsg = e?.message || String(e);
                diagnostics.push({
                    severity: 'warning',
                    code: 'EXPORT_RECORD_WRITE_FAILED',
                    message:
                        `Export record persistence failed for ${id}: ${rmsg}. ` +
                        `The file itself was delivered successfully; the record can be rebuilt on retry.`,
                    path: id,
                });
            }
        };

        const completed = new Set<string>();

        let wasAborted = false;
        const buildResult = (): PdfExportResult => ({
            total,
            succeeded,
            failed,
            aborted: wasAborted,
            zipDelivery,
            failedChats: failed,
            landedChats: succeeded,
            exportedCount: succeeded,
        });

        if (total === 0) {
            return buildResult();
        }

        if (useZip && typeof options.downloadHandler !== 'function') {
            const msg =
                'zip export requires downloadHandler: without it the ZIP blob can never be delivered to the user';
            for (const it of items) failItem(it.id, it.title, msg, []);
            return buildResult();
        }

        try {
            if (!writer) {
                if (!useZip && !options.dirHandle) {
                    throw new Error('Directory handle not provided for folder export');
                }
                writer = createWriter(useZip ? 'zip' : 'fs', { dirHandle: options.dirHandle, folderName });
                if (typeof writer.init === 'function' && !useZip) {
                    await writer.init();
                }
            }
        } catch (e: any) {
            const msg = e?.message || String(e);
            onLog(`[PDF] 写入器初始化失败: ${msg}`, 'error');
            for (const it of items) failItem(it.id, it.title, `writer init failed: ${msg}`, []);
            return buildResult();
        }

        const activeWriter: IExportWriter = writer;

        let fonts: LocalFontResolution;
        try {
            fonts = await resolveLocalFonts();
        } catch (e: any) {
            const msg = e?.message || String(e);
            onLog(`[PDF] 本地字体解析失败，已回退到内置字体: ${msg}`, 'warn');
            fonts = {
                fonts: [],
                diagnostics: [
                    {
                        severity: 'warning',
                        code: 'TYPST_LOCAL_FONTS_QUERY_FAILED',
                        message: `resolveLocalFonts threw: ${msg}; falling back to bundled fonts`,
                    },
                ],
                fallbackChain: [],
                localFontsAvailable: false,
            };
        }

        const pipeline = new PdfPipeline(DEFAULT_PIPELINE_STAGES);

        const mountedFonts = await mountRuntimeFonts(fonts, compiler);
        if (mountedFonts.mountedCount > 0) {
            onLog(
                `[PDF] 已将 ${mountedFonts.mountedCount} 个本地字体装载到 Typst sandbox: ${mountedFonts.mountedNames.join(', ')}`,
                'info',
            );
        }
        fonts = mountedFonts.effectiveFonts;

        for (let i = 0; i < items.length; i++) {
            const { id, title } = items[i];
            if (this.aborted || signal.aborted) break;
            report(i, title);

            const prep = await preparePdfItem(selected[i] ?? items[i], {
                conversations: options.conversations,
                fetchChatDetail: fetchChatDetailFn,
                index: i,
                total,
                currentSlot,
                skip,
                signal,
                onLog,
                includeAssets: options.includeAssets,
                takeoutEngine: options.takeoutEngine,
                assetPipeline: options.assetPipeline,
                fetchAssetDelegate: options.fetchAssetDelegate,
                fetchAsset: options.fetchAsset,
                getGeminiTab: options.getGeminiTab,
                sendToGeminiTab: options.sendToGeminiTab,
                maxAssetRetries: options.maxAssetRetries,
            });
            if (this.aborted || signal.aborted) break;
            if (!prep.ok) {
                failItem(prep.id, prep.title, prep.error, prep.diagnostics);
                report(i + 1, prep.title);
                continue;
            }

            const itemDiagnostics: RenderDiagnostic[] = [...prep.diagnostics];
            try {
                const itemInput: PipelineItemInput = {
                    conversationId: prep.id,
                    title: prep.title,
                    bundle: prep.bundle,
                    byteStore: prep.byteStore,
                    locale,
                    compiler,
                    fonts,
                    useZip,
                    writer: activeWriter,
                    downloadHandler: options.downloadHandler,
                    folderName,
                };
                const result = await pipeline.runOne(itemInput, {
                    signal,
                    reportProgress: (stage, current, ptotal) => {
                        const frac = ptotal > 0 ? current / ptotal : 0;
                        onProgress({
                            current: i + frac,
                            total,
                            pct: Math.round(((i + frac) / total) * 100),
                            title: `${title} (${stage})`,
                        });
                    },
                    log: (message, level) => onLog(message, level),
                });
                for (const d of result.diagnostics) itemDiagnostics.push(d);

                if (this.aborted || signal.aborted) break;

                switch (result.status) {
                    case 'delivered': {
                        const writeReport: ArtifactWriteReport = result.writeReport;
                        const record = {
                            title,
                            exportedAt: writeReport.writtenAt,
                            format: 'pdf',
                            fileName: writeReport.fileName,
                            bytesWritten: writeReport.bytesWritten,
                            status: 'ok',
                        };
                        succeeded++;
                        completed.add(id);
                        await commitRecord(id, record, itemDiagnostics);
                        surfaceDiagnostics(id, title, itemDiagnostics);
                        onLog(`[PDF] ${title} 导出成功 (${writeReport.fileName})`, 'info');
                        break;
                    }
                    case 'staged': {
                        staged.push({
                            id,
                            title,
                            diagnostics: itemDiagnostics,
                            pdfFileName: result.stagedArtifact.fileName,
                            pdfBytesWritten: result.stagedArtifact.bytesWritten,
                        });
                        onLog(`[PDF] ${title} 已暂存，等待 ZIP 打包交付后确认`, 'info');
                        break;
                    }
                    case 'failed':
                        failItem(
                            id,
                            title,
                            `[${result.error.stage}:${result.error.code}] ${result.error.message}`,
                            itemDiagnostics,
                        );
                        break;
                    case 'aborted':
                        break;
                }
                if (result.status === 'aborted') break;
            } catch (e: any) {
                if (isAbortError(e) || this.aborted || signal.aborted) break;
                failItem(id, title, `[pipeline:PIPELINE_THREW] ${e?.message || String(e)}`, itemDiagnostics);
            }
            report(i + 1, title);
        }

        wasAborted = this.aborted || signal.aborted;

        if (!wasAborted && useZip && staged.length > 0) {
            const zipFileName = `gemini_export_pdf_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.zip`;
            const finalizeCtx: StageContext = {
                signal,
                reportProgress: (_s, _c, _t) =>
                    onProgress({ current: total, total, pct: 100, title: '打包 ZIP' }),
                log: (message, level) => onLog(message, level),
            };
            try {
                const deliver = options.downloadHandler;
                if (typeof deliver !== 'function') {
                    throw new Error('internal invariant: downloadHandler is required for ZIP delivery');
                }
                const { bytesWritten } = await finalizeZipDelivery(
                    activeWriter,
                    deliver,
                    zipFileName,
                    finalizeCtx,
                );
                const writtenAt = new Date().toISOString();
                for (const s of staged) {
                    const record = {
                        title: s.title,
                        exportedAt: writtenAt,
                        format: 'pdf',
                        fileName: s.pdfFileName,
                        bytesWritten: s.pdfBytesWritten,
                        status: 'ok',
                    };
                    succeeded++;
                    completed.add(s.id);
                    await commitRecord(s.id, record, s.diagnostics);
                    surfaceDiagnostics(s.id, s.title, s.diagnostics);
                }
                zipDelivery = {
                    fileName: zipFileName,
                    bytesWritten,
                    deliveredAt: writtenAt,
                };
                onLog(`[PDF] ZIP 打包交付成功 (${zipFileName})，${staged.length} 个文件确认成功`, 'info');
            } catch (e: any) {
                if (isAbortError(e)) {
                    wasAborted = true;
                } else {
                    const code = e?.code ? `[${e.code}] ` : '';
                    const msg = `${code}${e?.message || String(e)}`;
                    onLog(`[PDF] ZIP 打包/交付失败: ${msg}；已暂存的 ${staged.length} 个文件不记为成功`, 'error');
                    for (const s of staged) {
                        failed.push({
                            id: s.id,
                            title: s.title,
                            ok: false,
                            error: `zip finalize/delivery failed: ${msg}`,
                            diagnostics: s.diagnostics,
                        });
                        completed.add(s.id);
                        surfaceDiagnostics(s.id, s.title, s.diagnostics);
                    }
                }
            }
        }

        if (wasAborted) {
            // Mark unfinished and staged-but-undelivered items as failed so retry covers them.
            const stagedById = new Map(staged.map((s) => [s.id, s.diagnostics]));
            for (const it of items) {
                if (!completed.has(it.id)) {
                    completed.add(it.id);
                    failed.push({
                        id: it.id,
                        title: it.title,
                        ok: false,
                        error: 'export aborted before completion (retryable)',
                        diagnostics: stagedById.get(it.id) ?? [],
                    });
                }
            }
            onLog('[PDF] 导出已取消', 'warn');
        }

        try {
            if (typeof activeWriter.close === 'function') await activeWriter.close();
        } catch {
            /* intentional */
        }

        return buildResult();
    }
}

export default PdfExporter;
