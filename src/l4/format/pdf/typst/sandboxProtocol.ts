// typst.ts's wasm-bindgen glue calls `new Function(...)` at init, which MV3 extension_pages CSP forbids;
// running inside an MV3 sandbox page allows `'unsafe-eval'` and `'wasm-unsafe-eval'`.

export const HOST_TO_SANDBOX: {
    readonly INIT: 'typst/init';
    readonly COMPILE: 'typst/compile';
    readonly CANCEL: 'typst/cancel';
} = {
    INIT: 'typst/init',
    COMPILE: 'typst/compile',
    CANCEL: 'typst/cancel',
};

export type HostSandboxMessage =
    | { type: typeof HOST_TO_SANDBOX.INIT; jobId: string; wasm: ArrayBuffer }
    | { type: typeof HOST_TO_SANDBOX.COMPILE; jobId: string;
        files: Array<{ path: string; text: string }>;
        binaries: Array<{ path: string; buf: ArrayBuffer }>;
        fonts: ArrayBuffer[] }
    | { type: typeof HOST_TO_SANDBOX.CANCEL; jobId: string };

export const SANDBOX_TO_HOST: {
    readonly READY: 'typst/ready';
    readonly INITED: 'typst/inited';
    readonly PROGRESS: 'typst/progress';
    readonly FONTS_INSTALLED: 'typst/fonts-installed';
    readonly COMPILED: 'typst/compiled';
    readonly ERROR: 'typst/error';
} = {
    READY: 'typst/ready',
    INITED: 'typst/inited',
    PROGRESS: 'typst/progress',
    // Sent right after the font builder finishes, before compile(), so a failed compile never triggers a font resend (re-running the font builder wedges the WASM module).
    FONTS_INSTALLED: 'typst/fonts-installed',
    COMPILED: 'typst/compiled',
    ERROR: 'typst/error',
};

// Internal outbound messages have a precise contract; incoming postMessage data remains untrusted.
export type SandboxToHostMessage =
    | { type: typeof SANDBOX_TO_HOST.READY }
    | { type: typeof SANDBOX_TO_HOST.INITED; jobId: string; ok: boolean; initMs: number }
    | { type: typeof SANDBOX_TO_HOST.PROGRESS; jobId: string;
        stage: string; current: number; total: number; fontMs?: number }
    | { type: typeof SANDBOX_TO_HOST.FONTS_INSTALLED; jobId: string }
    | { type: typeof SANDBOX_TO_HOST.COMPILED; jobId: string; ok: boolean;
        pdf: ArrayBuffer | null; pdfBytes: number; compileMs: number;
        diagnostics: Array<{ severity: string; message: string }> }
    | { type: typeof SANDBOX_TO_HOST.ERROR; jobId: string;
        error: { name: string; message: string } };

export const HOST_MESSAGE_TYPES: ReadonlySet<string> = new Set(Object.values(HOST_TO_SANDBOX));
export const SANDBOX_MESSAGE_TYPES: ReadonlySet<string> = new Set(Object.values(SANDBOX_TO_HOST));

// Sandboxed iframes have an opaque origin ('null'), so host-side identity relies on matching event.source against iframe.contentWindow.
export const SANDBOX_OPAQUE_ORIGIN = 'null';

export const SANDBOX_PAGE_PATH = 'src/l4/format/pdf/sandbox/typst-compile.html';

export const TYPST_WASM_PATH = 'src/l4/format/pdf/sandbox/vendor/typst_ts_web_compiler_bg.wasm';

export const BUNDLED_FONT_PATHS: readonly string[] = [
    'src/l4/format/pdf/sandbox/fonts/NewCMMath-Regular.otf',
    'src/l4/format/pdf/sandbox/fonts/NotoSansCJKsc-Regular.otf',
    'src/l4/format/pdf/sandbox/fonts/NotoSansMono-Variable.ttf',
    'src/l4/format/pdf/sandbox/fonts/DejaVuSansMono.ttf',
    'src/l4/format/pdf/sandbox/fonts/NotoEmoji-Variable.ttf',
];

export interface ProtocolMessageBody {
    readonly wasm?: unknown;
    readonly files?: unknown;
    readonly binaries?: unknown;
    readonly fonts?: unknown;
    readonly initMs?: unknown;
    readonly stage?: unknown;
    readonly current?: unknown;
    readonly total?: unknown;
    readonly pdf?: unknown;
    readonly diagnostics?: unknown;
    readonly error?: unknown;
}

interface ParsedProtocolMessage {
    type: string;
    jobId: string | null;
    body: ProtocolMessageBody;
}

type ParseResult =
    | { ok: true; message: ParsedProtocolMessage }
    | { ok: false; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isSandboxFileEntry(value: unknown): value is { path: string; text: string } {
    return isRecord(value) && typeof value.path === 'string' && typeof value.text === 'string';
}

export function isSandboxBinaryEntry(value: unknown): value is { path: string; buf: ArrayBuffer } {
    return isRecord(value) && typeof value.path === 'string' && value.buf instanceof ArrayBuffer;
}

export function readSandboxDiagnostic(value: unknown): { severity: string; message: string } {
    if (!isRecord(value)) return { severity: 'error', message: String(value ?? '') };
    return {
        severity: typeof value.severity === 'string' ? value.severity : 'error',
        message: typeof value.message === 'string' ? value.message : String(value.message ?? ''),
    };
}

export function readSandboxError(value: unknown): { name: string; message: string } {
    const err = isRecord(value) ? value : undefined;
    return {
        name: typeof err?.name === 'string' ? err.name : 'Error',
        message: typeof err?.message === 'string' ? err.message : 'sandbox reported an error',
    };
}

export function parseProtocolMessage(data: unknown, allowedTypes: ReadonlySet<string>): ParseResult {
    if (!isRecord(data)) {
        return { ok: false, reason: 'message is not a plain object' };
    }
    const record = data;
    if (typeof record.type !== 'string' || record.type.length === 0) {
        return { ok: false, reason: 'message has no string type' };
    }
    if (!allowedTypes.has(record.type)) {
        return { ok: false, reason: `unknown message type: ${record.type}` };
    }
    if (record.type === SANDBOX_TO_HOST.READY) {
        if (record.jobId !== undefined && record.jobId !== null) {
            return { ok: false, reason: 'ready broadcast must not carry a jobId' };
        }
        return { ok: true, message: { type: record.type, jobId: null, body: record } };
    }
    if (typeof record.jobId !== 'string' || record.jobId.length === 0) {
        return { ok: false, reason: 'message has no string jobId' };
    }
    return { ok: true, message: { type: record.type, jobId: record.jobId, body: record } };
}

interface MessageEventLike {
    source: unknown;
    origin: string;
}

export function checkMessageSource(
    event: MessageEventLike,
    expectedSource: unknown,
    expectedOrigin: string,
): boolean {
    return event.source === expectedSource && event.origin === expectedOrigin;
}

// Sandboxed pages lack chrome.*, so derive the parent extension origin from the sandbox's own URL.
// Node's WHATWG URL returns 'null' for non-special schemes like chrome-extension:, hence the protocol+host fallback.
export function sandboxExpectedHostOrigin(sandboxHref: string): string {
    const url = new URL(sandboxHref);
    if (url.origin !== 'null') return url.origin;
    return `${url.protocol}//${url.host}`;
}

export function newJobId(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    return `job-${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffffffff).toString(36)}`;
}
