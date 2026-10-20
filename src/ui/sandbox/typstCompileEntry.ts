import { createTypstCompiler, createTypstFontBuilder } from '@myriaddreamin/typst.ts';
import type { TypstCompiler, TypstFontBuilder } from '@myriaddreamin/typst.ts';

// Numeric value of CompileFormatEnum.pdf (not re-exported from @myriaddreamin/typst.ts index).
const PDF_FORMAT = 1;

import { createOfflineInitOptions } from './offlineInit.js';
import {
    HOST_MESSAGE_TYPES,
    HOST_TO_SANDBOX,
    SANDBOX_TO_HOST,
    checkMessageSource,
    parseProtocolMessage,
    sandboxExpectedHostOrigin,
} from '../../core/export/typst/sandboxProtocol.js';

import themeTyp from '../../core/export/typst/templates/theme.typ';
import documentTyp from '../../core/export/typst/templates/document.typ';
import componentsTyp from '../../core/export/typst/templates/components.typ';
import renderBlockTyp from '../../core/export/typst/templates/render-block.typ';
import renderInlineTyp from '../../core/export/typst/templates/render-inline.typ';
import renderMessageTyp from '../../core/export/typst/templates/render-message.typ';
import mitexScopeTyp from '../../core/export/typst/templates/mitex-scope.typ';
import syntaxTheme from '../../core/export/typst/templates/quiet-light.tmTheme';

import { visual } from '../../core/export/visualContract';

const TEMPLATE_FILES: ReadonlyArray<readonly [string, string]> = [
    ['/visual-contract.json', JSON.stringify(visual)],
    ['/theme.typ', themeTyp],
    ['/document.typ', documentTyp],
    ['/components.typ', componentsTyp],
    ['/render-block.typ', renderBlockTyp],
    ['/render-inline.typ', renderInlineTyp],
    ['/render-message.typ', renderMessageTyp],
    ['/mitex-scope.typ', mitexScopeTyp],
    ['/quiet-light.tmTheme', syntaxTheme],
];

const MAIN_TYP = '#import "document.typ": render-document\n#let payload = json("/payload.json")\n#render-document(payload)\n';

interface CompileJob {
    cancelled: boolean;
}

let compiler: TypstCompiler | null = null;
let fontBuilder: TypstFontBuilder | null = null;
const jobs = new Map<string, CompileJob>();

// Guard against running the WASM font builder more than once (re-running build() wedges the
// WASM module), even if the host resends fonts before seeing FONTS_INSTALLED.
let sandboxFontsInstalled = false;

function postToHost(message: Record<string, unknown>, transfer?: Transferable[]): void {
    window.parent.postMessage(message, '*', transfer ?? []);
}

function reply(jobId: string, payload: Record<string, unknown>, transfer?: Transferable[]): void {
    postToHost({ jobId, ...payload }, transfer);
}

function replyError(jobId: string, error: unknown): void {
    const name = error instanceof DOMException ? error.name : 'Error';
    const message = error instanceof Error ? error.message : String(error);
    reply(jobId, { type: SANDBOX_TO_HOST.ERROR, error: { name, message } });
}

function throwIfCancelled(job: CompileJob, jobId: string): void {
    if (job.cancelled) {
        throw new DOMException(`Typst compile job ${jobId} was cancelled`, 'AbortError');
    }
}

async function handleInit(jobId: string, body: Record<string, unknown>): Promise<void> {
    const wasm = body.wasm;
    if (!(wasm instanceof ArrayBuffer)) {
        throw new Error('init message must carry the WASM module as a transferred ArrayBuffer');
    }
    const t0 = performance.now();
    const wasmBytes = new Uint8Array(wasm);
    compiler = createTypstCompiler();
    await compiler.init(createOfflineInitOptions(() => wasmBytes));
    fontBuilder = createTypstFontBuilder();
    await fontBuilder.init(createOfflineInitOptions(() => wasmBytes));
    sandboxFontsInstalled = false;
    reply(jobId, {
        type: SANDBOX_TO_HOST.INITED,
        ok: true,
        initMs: Math.round(performance.now() - t0),
    });
}

async function handleCompile(jobId: string, body: Record<string, unknown>): Promise<void> {
    const activeCompiler = compiler;
    const activeFontBuilder = fontBuilder;
    if (!activeCompiler || !activeFontBuilder) {
        throw new Error('compiler not initialized; send typst/init first');
    }
    const job: CompileJob = { cancelled: false };
    jobs.set(jobId, job);
    const mappedPaths: string[] = [];
    try {
        const files = body.files;
        const binaries = body.binaries;
        const fonts = body.fonts;
        if (!Array.isArray(files) || !Array.isArray(binaries) || !Array.isArray(fonts)) {
            throw new Error('compile message must carry files/binaries/fonts arrays');
        }

        for (const [path, text] of TEMPLATE_FILES) {
            throwIfCancelled(job, jobId);
            activeCompiler.addSource(path, text);
        }
        activeCompiler.addSource('/main.typ', MAIN_TYP);
        for (const file of files) {
            throwIfCancelled(job, jobId);
            const entry = file as { path?: unknown; text?: unknown };
            if (typeof entry.path !== 'string' || typeof entry.text !== 'string') {
                throw new Error('compile file entries must be {path, text} strings');
            }
            activeCompiler.addSource(entry.path, entry.text);
        }
        reply(jobId, { type: SANDBOX_TO_HOST.PROGRESS, stage: 'sources', current: 1, total: 3 });

        for (const binary of binaries) {
            throwIfCancelled(job, jobId);
            const entry = binary as { path?: unknown; buf?: unknown };
            if (typeof entry.path !== 'string' || !(entry.buf instanceof ArrayBuffer)) {
                throw new Error('compile binary entries must be {path, buf:ArrayBuffer}');
            }
            const shadowPath = entry.path.startsWith('/') ? entry.path : `/${entry.path}`;
            activeCompiler.mapShadow(shadowPath, new Uint8Array(entry.buf));
            mappedPaths.push(shadowPath);
        }

        let fontMs = 0;
        if (fonts.length > 0 && !sandboxFontsInstalled) {
            const tF = performance.now();
            for (const font of fonts) {
                if (!(font instanceof ArrayBuffer)) {
                    throw new Error('compile font entries must be transferred ArrayBuffers');
                }
                throwIfCancelled(job, jobId);
                await activeFontBuilder.addFontData(new Uint8Array(font));
            }
            await activeFontBuilder.build(async (resolver) => {
                activeCompiler.setFonts(resolver);
            });
            sandboxFontsInstalled = true;
            fontMs = Math.round(performance.now() - tF);
            reply(jobId, { type: SANDBOX_TO_HOST.FONTS_INSTALLED });
        } else if (fonts.length > 0) {
            reply(jobId, { type: SANDBOX_TO_HOST.FONTS_INSTALLED });
        }
        if (fonts.length > 0) {
            reply(jobId, {
                type: SANDBOX_TO_HOST.PROGRESS,
                stage: 'fonts',
                current: 2,
                total: 3,
                fontMs,
            });
        }

        throwIfCancelled(job, jobId);
        const tC = performance.now();
        const { result, diagnostics } = await activeCompiler.compile({
            mainFilePath: '/main.typ',
            format: PDF_FORMAT,
        });
        throwIfCancelled(job, jobId);
        const compileMs = Math.round(performance.now() - tC);

        let pdf: ArrayBuffer | null = null;
        if (result && result.length > 0) {
            // Copy out of WASM memory before transferring.
            pdf = result.slice().buffer as ArrayBuffer;
        }
        reply(
            jobId,
            {
                type: SANDBOX_TO_HOST.COMPILED,
                ok: pdf !== null,
                pdf,
                pdfBytes: result ? result.length : 0,
                compileMs,
                diagnostics: (diagnostics ?? []).map((d) => {
                    const detail = typeof d === 'string' ? { severity: 'error', message: d } : d;
                    return {
                        severity: typeof detail.severity === 'string' ? detail.severity : 'error',
                        message: String(detail.message ?? '').slice(0, 500),
                    };
                }),
            },
            pdf ? [pdf] : [],
        );
    } catch (error) {
        replyError(jobId, error);
    } finally {
        jobs.delete(jobId);
        try {
            for (const path of mappedPaths) activeCompiler.unmapShadow(path);
        } catch {}
    }
}

window.addEventListener('message', (event: MessageEvent) => {
    const parsed = parseProtocolMessage(event.data, HOST_MESSAGE_TYPES);
    if (!parsed.ok) return;
    if (!checkMessageSource(event, window.parent, sandboxExpectedHostOrigin(window.location.href))) {
        return;
    }
    const { message } = parsed;
    const jobId = message.jobId;
    if (jobId === null) return;
    void (async () => {
        try {
            if (message.type === HOST_TO_SANDBOX.INIT) {
                await handleInit(jobId, message.body);
            } else if (message.type === HOST_TO_SANDBOX.COMPILE) {
                await handleCompile(jobId, message.body);
            } else if (message.type === HOST_TO_SANDBOX.CANCEL) {
                const job = jobs.get(jobId);
                if (job) job.cancelled = true;
            }
        } catch (error) {
            replyError(jobId, error);
        }
    })();
});

postToHost({ type: SANDBOX_TO_HOST.READY });
