import type {
    RenderContext,
    RenderDiagnostic,
    TypstRenderPayload,
} from '../canonical/rendering.js';
import type { IPdfCompiler, PdfCompileResult } from '../pdf/pdfCompiler.js';

import {
    BUNDLED_FONT_PATHS,
    HOST_TO_SANDBOX,
    SANDBOX_OPAQUE_ORIGIN,
    SANDBOX_PAGE_PATH,
    SANDBOX_TO_HOST,
    TYPST_WASM_PATH,
    checkMessageSource,
    newJobId,
    parseProtocolMessage,
    SANDBOX_MESSAGE_TYPES,
} from './sandboxProtocol.js';
import {
    type TypstBlockNode,
    type TypstConversationRenderPayload,
    type TypstInlineNode,
} from './payload.js';

const PDF_MAGIC = '%PDF-';

export interface SandboxFrame {
    readonly contentWindow: unknown;
    postToSandbox(message: Record<string, unknown>, transfer?: Transferable[]): void;
    onMessage(handler: (event: { source: unknown; origin: string; data: unknown }) => void): () => void;
    destroy(): void;
}

export interface SandboxHost {
    pageUrl(): string;
    assetUrl(relativePath: string): string;
    fetchBytes(url: string): Promise<Uint8Array>;
    createFrame(url: string): SandboxFrame;
}

export class BrowserSandboxHost implements SandboxHost {
    pageUrl(): string {
        return chrome.runtime.getURL(SANDBOX_PAGE_PATH);
    }

    assetUrl(relativePath: string): string {
        return chrome.runtime.getURL(relativePath);
    }

    async fetchBytes(url: string): Promise<Uint8Array> {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`failed to fetch sandbox asset ${url}: HTTP ${response.status}`);
        }
        return new Uint8Array(await response.arrayBuffer());
    }

    createFrame(url: string): SandboxFrame {
        const iframe = document.createElement('iframe');
        // Do not set iframe.sandbox: manifest.json sandbox.pages already applies the MV3 sandbox CSP.
        iframe.src = url;
        iframe.style.display = 'none';
        iframe.setAttribute('aria-hidden', 'true');
        iframe.tabIndex = -1;
        document.documentElement.appendChild(iframe);
        return {
            contentWindow: iframe.contentWindow,
            postToSandbox: (message, transfer) => {
                iframe.contentWindow?.postMessage(message, '*', transfer ?? []);
            },
            onMessage: (handler) => {
                const listener = (event: MessageEvent) => handler(event);
                window.addEventListener('message', listener);
                return () => window.removeEventListener('message', listener);
            },
            destroy: () => iframe.remove(),
        };
    }
}

export interface TypstSandboxCompilerOptions {
    host?: SandboxHost;
    wasmPath?: string;
    fontPaths?: readonly string[];
    initTimeoutMs?: number;
    compileTimeoutMs?: number;
}

interface PendingJob {
    resolve: (value: PendingResult) => void;
    reject: (error: unknown) => void;
    onProgress?: (stage: string, current: number, total: number) => void;
    timer: ReturnType<typeof setTimeout>;
}

type PendingResult =
    | { kind: 'inited'; initMs?: number }
    | { kind: 'compiled'; pdf: ArrayBuffer | null; diagnostics: Array<{ severity: string; message: string }> };

export function fontHasMathTable(bytes: Uint8Array): boolean {
    if (bytes.length < 12) return false;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const numTables = view.getUint16(4);
    if (bytes.length < 12 + numTables * 16) return false;
    for (let i = 0; i < numTables; i += 1) {
        if (view.getUint32(12 + i * 16) === 0x4d415448) return true;
    }
    return false;
}

// Typst hard-fails math layout if no loaded font has an OpenType MATH table;
// stripping `typst` fields degrades math nodes to their raw LaTeX fallback.
export function stripConvertedMath(doc: TypstConversationRenderPayload): number {
    let stripped = 0;
    const stripInline = (nodes: TypstInlineNode[]): void => {
        for (const node of nodes) {
            if ((node.type === 'strong' || node.type === 'emphasis' || node.type === 'link') && 'children' in node) {
                stripInline(node.children);
            } else if (node.type === 'inlineMath' && 'typst' in node && node.typst !== undefined) {
                delete (node as { typst?: string }).typst;
                stripped += 1;
            }
        }
    };
    const stripBlock = (block: TypstBlockNode): void => {
        switch (block.type) {
            case 'paragraph':
            case 'heading':
                stripInline(block.children);
                break;
            case 'quote':
                for (const child of block.blocks) stripBlock(child);
                break;
            case 'note':
                if (block.children) stripInline(block.children);
                if (block.blocks) for (const child of block.blocks) stripBlock(child);
                break;
            case 'list':
                for (const item of block.items) for (const child of item.blocks) stripBlock(child);
                break;
            case 'table':
                for (const row of block.headers) {
                    for (const cell of row) stripInline(cell.children);
                }
                for (const row of block.rows) {
                    for (const cell of row) stripInline(cell.children);
                }
                break;
            case 'math':
                if ('typst' in block && block.typst !== undefined) {
                    delete (block as { typst?: string }).typst;
                    stripped += 1;
                }
                break;
            default:
                break;
        }
    };
    for (const message of doc.messages) {
        for (const block of message.blocks) stripBlock(block);
    }
    return stripped;
}

function abortError(message: string): DOMException {
    return new DOMException(message, 'AbortError');
}

function collectImagePaths(doc: TypstConversationRenderPayload): Set<string> {
    const paths = new Set<string>();
    const visitInline = (nodes: TypstInlineNode[]): void => {
        for (const node of nodes) {
            if (node.type === 'image') {
                paths.add(node.asset);
            } else if ((node.type === 'strong' || node.type === 'emphasis' || node.type === 'link') && 'children' in node) {
                visitInline(node.children);
            }
        }
    };
    const visitBlock = (block: TypstBlockNode): void => {
        if (block.type === 'image') {
            paths.add(block.asset);
        } else if (block.type === 'paragraph' || block.type === 'heading') {
            visitInline(block.children);
        } else if (block.type === 'quote') {
            for (const child of block.blocks) visitBlock(child);
        } else if (block.type === 'note') {
            if (block.children) visitInline(block.children);
            if (block.blocks) for (const child of block.blocks) visitBlock(child);
        } else if (block.type === 'list') {
            for (const item of block.items) for (const child of item.blocks) visitBlock(child);
        } else if (block.type === 'table') {
            for (const row of block.headers) for (const cell of row) visitInline(cell.children);
            for (const row of block.rows) {
                for (const cell of row) visitInline(cell.children);
            }
        }
    };
    for (const message of doc.messages) {
        for (const block of message.blocks) visitBlock(block);
    }
    return paths;
}

export interface RuntimeFontConsumer {
    setRuntimeFonts?(fonts: readonly Uint8Array[]): void;
}

export class TypstSandboxCompiler implements IPdfCompiler {
    readonly name = 'typst-wasm-sandbox';

    private readonly host: SandboxHost;
    private readonly wasmPath: string;
    private readonly fontPaths: readonly string[];
    private readonly initTimeoutMs: number;
    private readonly compileTimeoutMs: number;

    private frame: SandboxFrame | null = null;
    private detachListener: (() => void) | null = null;
    private readonly pending = new Map<string, PendingJob>();
    private readyPromise: Promise<void> | null = null;
    private initPromise: Promise<void> | null = null;
    private fontsInstalled = false;
    private fontBytes: Uint8Array[] | null = null;
    private runtimeFontBytes: readonly Uint8Array[] = [];
    private mathFontAvailable: boolean | null = null;
    /** Serializes compiles: the WASM compiler keeps mutable per-job state. */
    private compileQueue: Promise<void> = Promise.resolve();

    constructor(options: TypstSandboxCompilerOptions = {}) {
        this.host = options.host ?? new BrowserSandboxHost();
        this.wasmPath = options.wasmPath ?? TYPST_WASM_PATH;
        this.fontPaths = options.fontPaths ?? BUNDLED_FONT_PATHS;
        this.initTimeoutMs = options.initTimeoutMs ?? 120_000;
        this.compileTimeoutMs = options.compileTimeoutMs ?? 300_000;
    }

    setRuntimeFonts(fonts: readonly Uint8Array[]): void {
        if (this.fontsInstalled || this.fontBytes !== null) {
            return;
        }
        this.runtimeFontBytes = fonts.slice();
    }

    dispose(): void {
        this.detachListener?.();
        this.detachListener = null;
        for (const [, job] of this.pending) {
            clearTimeout(job.timer);
            job.reject(abortError('Typst sandbox compiler was disposed'));
        }
        this.pending.clear();
        this.frame?.destroy();
        this.frame = null;
        this.readyPromise = null;
        this.initPromise = null;
        this.fontsInstalled = false;
        this.fontBytes = null;
        this.mathFontAvailable = null;
    }

    async compile(payload: TypstRenderPayload, context: RenderContext): Promise<PdfCompileResult> {
        const run = this.compileQueue.then(() => this.compileOne(payload, context));
        this.compileQueue = run.then(
            () => undefined,
            () => undefined,
        );
        return run;
    }

    private async compileOne(payload: TypstRenderPayload, context: RenderContext): Promise<PdfCompileResult> {
        context.signal.throwIfAborted();

        const diagnostics: RenderDiagnostic[] = [];

        const doc = payload.document;
        if (!doc) {
            throw new Error(
                'TypstSandboxCompiler requires a prebuilt Typst document payload; ' +
                'pass { document, assetPaths } built by the PDF pipeline payloadStage.',
            );
        }
        context.reportProgress('typst-payload', 1, 4);
        context.signal.throwIfAborted();

        await this.ensureInitialized(context.signal);
        context.reportProgress('typst-init', 2, 4);
        context.signal.throwIfAborted();

        const fonts = this.fontsInstalled ? [] : await this.loadFontBytes();

        if (this.mathFontAvailable === false) {
            const stripped = stripConvertedMath(doc);
            diagnostics.push({
                severity: 'warning',
                code: 'TYPST_MATH_TABLE_MISSING',
                message:
                    `No loaded font provides an OpenType MATH table; stripped ${stripped} ` +
                    `converted math node(s) to the visible LaTeX-source fallback instead of failing the compile.`,
            });
        }

        const binaries: Array<{ path: string; buf: ArrayBuffer }> = [];
        const transfer: ArrayBuffer[] = [];
        const pathToAssetId = new Map<string, string>();
        for (const [assetId, path] of payload.assetPaths) {
            if (path) pathToAssetId.set(path, assetId);
        }
        for (const imagePath of collectImagePaths(doc)) {
            context.signal.throwIfAborted();
            const assetId = pathToAssetId.get(imagePath);
            if (!assetId) {
                diagnostics.push({
                    severity: 'warning',
                    code: 'TYPST_ASSET_PATH_UNMAPPED',
                    message: `Image path ${imagePath} could not be mapped back to a canonical asset; the template calls image() on this path, so the compile will fail on the missing file.`,
                });
                continue;
            }
            let resolved: { bytes?: Uint8Array; blob?: Blob } | null = null;
            try {
                resolved = await context.assets.resolve(assetId);
            } catch (error) {
                diagnostics.push({
                    severity: 'warning',
                    code: 'TYPST_ASSET_RESOLVE_FAILED',
                    message: `Image asset ${assetId} failed to resolve (${error instanceof Error ? error.message : String(error)}); the template calls image() on its path, so the compile will fail on the missing file.`,
                });
                continue;
            }
            let bytes = resolved?.bytes;
            if (!bytes && resolved?.blob) {
                bytes = new Uint8Array(await resolved.blob.arrayBuffer());
            }
            if (!bytes || bytes.length === 0) {
                diagnostics.push({
                    severity: 'warning',
                    code: 'TYPST_ASSET_EMPTY',
                    message: `Image asset ${assetId} resolved to no bytes; the template calls image() on its path, so the compile will fail on the missing file.`,
                });
                continue;
            }
            // Copy into a fresh ArrayBuffer so transferring neuters only our copy.
            const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
            binaries.push({ path: imagePath, buf });
            transfer.push(buf);
        }
        context.reportProgress('typst-assets', 3, 4);
        context.signal.throwIfAborted();

        const payloadText = JSON.stringify(doc);
        const fontBuffers: ArrayBuffer[] = fonts.map((bytes) => {
            const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
            transfer.push(buf);
            return buf;
        });
        const jobId = newJobId();
        const message = {
            type: HOST_TO_SANDBOX.COMPILE,
            jobId,
            files: [{ path: '/payload.json', text: payloadText }],
            binaries,
            fonts: fontBuffers,
        };
        const result = await this.roundTrip(
            jobId,
            message,
            transfer,
            this.compileTimeoutMs,
            context.signal,
            (stage, current, total) => context.reportProgress(`typst-${stage}`, current, total),
        );
        if (result.kind !== 'compiled') {
            throw new Error(`unexpected sandbox reply for compile job ${jobId}`);
        }
        for (const d of result.diagnostics) {
            diagnostics.push({
                severity: d.severity === 'warning' ? 'warning' : d.severity === 'info' ? 'info' : 'error',
                code: 'TYPST_DIAGNOSTIC',
                message: d.message,
            });
        }
        if (result.pdf === null) {
            throw new Error(
                `Typst compile failed for ${payload.bundle.conversation.key.providerId} conversation ` +
                `${payload.bundle.conversation.key.conversationId}: sandbox returned no PDF bytes`,
            );
        }
        const pdfBytes = new Uint8Array(result.pdf);
        const magic = String.fromCharCode(...pdfBytes.slice(0, 5));
        if (magic !== PDF_MAGIC) {
            throw new Error(
                `Typst compile returned ${pdfBytes.length} bytes that do not start with %PDF-; refusing to treat them as a PDF`,
            );
        }
        context.reportProgress('typst-done', 4, 4);
        return { pdfBytes, diagnostics };
    }

    private async loadFontBytes(): Promise<Uint8Array[]> {
        if (this.fontBytes) return this.fontBytes;
        const bundled = await Promise.all(
            this.fontPaths.map((relative) => this.host.fetchBytes(this.host.assetUrl(relative))),
        );
        const loaded = [...this.runtimeFontBytes, ...bundled];
        this.fontBytes = loaded;
        this.mathFontAvailable = loaded.some((bytes) => fontHasMathTable(bytes));
        return loaded;
    }

    private ensureInitialized(signal: AbortSignal): Promise<void> {
        if (this.initPromise) return this.initPromise;
        this.initPromise = (async () => {
            const frame = this.host.createFrame(this.host.pageUrl());
            this.frame = frame;
            this.detachListener = frame.onMessage((event) => this.handleHostMessage(event));
            await this.readyPromiseOrTimeout(signal);
            const wasm = await this.host.fetchBytes(this.host.assetUrl(this.wasmPath));
            signal.throwIfAborted();
            const wasmBuffer = wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer;
            const jobId = newJobId();
            const result = await this.roundTrip(
                jobId,
                { type: HOST_TO_SANDBOX.INIT, jobId, wasm: wasmBuffer },
                [wasmBuffer],
                this.initTimeoutMs,
                signal,
            );
            if (result.kind !== 'inited') {
                throw new Error(`unexpected sandbox reply for init job ${jobId}`);
            }
        })();
        this.initPromise.then(
            () => undefined,
            () => {
                this.initPromise = null;
            },
        );
        return this.initPromise;
    }

    private readyPromiseOrTimeout(signal: AbortSignal): Promise<void> {
        if (!this.readyPromise) {
            this.readyPromise = new Promise<void>((resolve, reject) => {
                const jobId = `__ready__`;
                const timer = setTimeout(() => {
                    this.pending.delete(jobId);
                    reject(new Error(`sandbox page did not signal ready within ${this.initTimeoutMs}ms`));
                }, this.initTimeoutMs);
                const onAbort = () => {
                    clearTimeout(timer);
                    this.pending.delete(jobId);
                    reject(abortError('Typst sandbox init aborted while waiting for ready'));
                };
                if (signal.aborted) {
                    onAbort();
                    return;
                }
                signal.addEventListener('abort', onAbort, { once: true });
                this.pending.set(jobId, {
                    resolve: (result) => {
                        if (result.kind === 'inited') {
                            clearTimeout(timer);
                            signal.removeEventListener('abort', onAbort);
                            this.pending.delete(jobId);
                            resolve();
                        }
                    },
                    reject: (error) => {
                        clearTimeout(timer);
                        signal.removeEventListener('abort', onAbort);
                        this.pending.delete(jobId);
                        reject(error);
                    },
                    timer,
                });
            });
        }
        return this.readyPromise;
    }

    private roundTrip(
        jobId: string,
        message: Record<string, unknown>,
        transfer: ArrayBuffer[],
        timeoutMs: number,
        signal: AbortSignal,
        onProgress?: (stage: string, current: number, total: number) => void,
    ): Promise<PendingResult> {
        const frame = this.frame;
        if (!frame) return Promise.reject(new Error('sandbox frame is not created'));
        return new Promise<PendingResult>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(jobId);
                reject(new Error(`sandbox job ${jobId} timed out after ${timeoutMs}ms`));
            }, timeoutMs);
            const cleanup = () => {
                clearTimeout(timer);
                signal.removeEventListener('abort', onAbort);
                this.pending.delete(jobId);
            };
            const onAbort = () => {
                cleanup();
                try {
                    frame.postToSandbox({ type: HOST_TO_SANDBOX.CANCEL, jobId });
                } catch {
                    // Frame may already be disposed.
                }
                reject(abortError('Typst compile aborted'));
            };
            if (signal.aborted) {
                onAbort();
                return;
            }
            signal.addEventListener('abort', onAbort, { once: true });
            this.pending.set(jobId, {
                resolve: (result) => {
                    cleanup();
                    resolve(result);
                },
                reject: (error) => {
                    cleanup();
                    reject(error);
                },
                onProgress,
                timer,
            });
            try {
                frame.postToSandbox(message, transfer);
            } catch (error) {
                cleanup();
                reject(error);
            }
        });
    }

    private handleHostMessage(event: { source: unknown; origin: string; data: unknown }): void {
        const frame = this.frame;
        if (!frame) return;
        if (!checkMessageSource(event, frame.contentWindow, SANDBOX_OPAQUE_ORIGIN)) return;
        const parsed = parseProtocolMessage(event.data, SANDBOX_MESSAGE_TYPES);
        if (!parsed.ok) return;
        const { message } = parsed;
        if (message.type === SANDBOX_TO_HOST.READY) {
            const ready = this.pending.get('__ready__');
            ready?.resolve({ kind: 'inited' });
            return;
        }
        const jobId = message.jobId;
        if (jobId === null) return;
        if (message.type === SANDBOX_TO_HOST.FONTS_INSTALLED) {
            // Decoupled from compile completion because re-running the WASM font builder after a failed compile wedges the module.
            this.fontsInstalled = true;
            return;
        }
        const job = this.pending.get(jobId);
        if (!job) return;
        const body = message.body;
        if (message.type === SANDBOX_TO_HOST.INITED) {
            job.resolve({ kind: 'inited', initMs: typeof body.initMs === 'number' ? body.initMs : undefined });
        } else if (message.type === SANDBOX_TO_HOST.PROGRESS) {
            job.onProgress?.(
                typeof body.stage === 'string' ? body.stage : 'progress',
                typeof body.current === 'number' ? body.current : 0,
                typeof body.total === 'number' ? body.total : 0,
            );
        } else if (message.type === SANDBOX_TO_HOST.COMPILED) {
            const pdf = body.pdf;
            job.resolve({
                kind: 'compiled',
                pdf: pdf instanceof ArrayBuffer ? pdf : null,
                diagnostics: Array.isArray(body.diagnostics)
                    ? (body.diagnostics as Array<{ severity?: unknown; message?: unknown }>).map((d) => ({
                        severity: typeof d.severity === 'string' ? d.severity : 'error',
                        message: typeof d.message === 'string' ? d.message : String(d.message ?? ''),
                    }))
                    : [],
            });
        } else if (message.type === SANDBOX_TO_HOST.ERROR) {
            const err = body.error as { name?: unknown; message?: unknown } | undefined;
            const name = typeof err?.name === 'string' ? err.name : 'Error';
            const error = new Error(typeof err?.message === 'string' ? err.message : 'sandbox reported an error');
            error.name = name;
            job.reject(error);
        }
    }
}
