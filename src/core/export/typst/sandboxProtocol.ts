// typst.ts's wasm-bindgen glue calls `new Function(...)` at init, which MV3 extension_pages CSP forbids;
// running inside an MV3 sandbox page allows `'unsafe-eval'` and `'wasm-unsafe-eval'`.

export const HOST_TO_SANDBOX = {
    INIT: 'typst/init',
    COMPILE: 'typst/compile',
    CANCEL: 'typst/cancel',
} as const;

export const SANDBOX_TO_HOST = {
    READY: 'typst/ready',
    INITED: 'typst/inited',
    PROGRESS: 'typst/progress',
    // Sent right after the font builder finishes, before compile(), so a failed compile never triggers a font resend (re-running the font builder wedges the WASM module).
    FONTS_INSTALLED: 'typst/fonts-installed',
    COMPILED: 'typst/compiled',
    ERROR: 'typst/error',
} as const;

export const HOST_MESSAGE_TYPES: ReadonlySet<string> = new Set(Object.values(HOST_TO_SANDBOX));
export const SANDBOX_MESSAGE_TYPES: ReadonlySet<string> = new Set(Object.values(SANDBOX_TO_HOST));

// Sandboxed iframes have an opaque origin ('null'), so host-side identity relies on matching event.source against iframe.contentWindow.
export const SANDBOX_OPAQUE_ORIGIN = 'null';

export const SANDBOX_PAGE_PATH = 'src/ui/sandbox/typst-compile.html';

export const TYPST_WASM_PATH = 'src/ui/sandbox/vendor/typst_ts_web_compiler_bg.wasm';

export const BUNDLED_FONT_PATHS: readonly string[] = [
    'src/ui/sandbox/fonts/NewCMMath-Regular.otf',
];

export interface ParsedProtocolMessage {
    type: string;
    jobId: string | null;
    body: Record<string, unknown>;
}

export type ParseResult =
    | { ok: true; message: ParsedProtocolMessage }
    | { ok: false; reason: string };

export function parseProtocolMessage(data: unknown, allowedTypes: ReadonlySet<string>): ParseResult {
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
        return { ok: false, reason: 'message is not a plain object' };
    }
    const record = data as Record<string, unknown>;
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

export interface MessageEventLike {
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
