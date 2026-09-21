// protocol/protocol.ts — protocol anti-corruption layer (Phase 1).
//
// Single source of truth for every piece of Google-side reverse-engineered
// knowledge: RPC endpoint names, the batchexecute wrapper format, token
// key names and extraction patterns, the fallback build number, sliding
// window limits, and the request-id convention.

export interface ProtocolRPCS {
    LIST: string;
    DETAIL: string;
    LEGACY_LIST: string;
    GEMS: string;
    DELETE: string;
}

export interface ProtocolTokens {
    AT: string;
    BL: string;
}

export interface ProtocolTokenPatterns {
    atFromScript: RegExp;
    atGenericFromScript: RegExp;
    blKeyFromScript: RegExp;
    blValueFromHtml: RegExp;
    blCfb2hFromHtml: RegExp;
    blAssistantFromHtml: RegExp;
    boqBuildFromScript: RegExp;
}

export interface ProtocolLimits {
    SLIDING_WINDOW: number;
    SERVER_LIMIT_TEXT: string;
}

export const CrossWorldEvents = {
    CREDENTIALS: 'GEMINI_CREDENTIALS',
    CONVERSATION_DELETED: 'GEMINI_CONVERSATION_DELETED',
    NETWORK_BATCHEXECUTE: 'GEMINI_NETWORK_BATCHEXECUTE',
    STREAM_START: 'GEMINI_STREAM_GENERATE_START',
    STREAM_COMPLETE: 'GEMINI_STREAM_GENERATE_COMPLETE',
    LIVE_SAVE_TRIGGER: 'GEMINI_LIVE_SAVE_TRIGGER'
} as const;

export const EVENTS = CrossWorldEvents;
export type CrossWorldEventType = typeof CrossWorldEvents[keyof typeof CrossWorldEvents];

export interface GeminiProtocolModule {
    PROTOCOL_VERSION: string;
    WRB: string;
    RPCS: ProtocolRPCS;
    EVENTS: typeof CrossWorldEvents;
    TOKENS: ProtocolTokens;
    TOKEN_PATTERNS: ProtocolTokenPatterns;
    DELETION_ANCHORS: RegExp[];
    BL_FALLBACK: string;
    LIMITS: ProtocolLimits;
    createReqidGenerator: () => () => string;
}

// @ts-ignore: suppress duplicate global var conflict
declare global {
    var GeminiProtocol: GeminiProtocolModule;
}

export const PROTOCOL_VERSION = '2026-09-07';

// batchexecute wrapper: every payload row is ["wrb.fr", "<rpc>", "<json string>", ...]
export const WRB = 'wrb.fr';

// RPC endpoint names (compiled Google-side identifiers — rotate together
// with WRB consumers when Google redeploys).
export const RPCS: ProtocolRPCS = {
    LIST: 'MaZiqc',        // conversation list (sidebar pagination)
    DETAIL: 'hNvQHb',      // conversation detail (turns payload)
    LEGACY_LIST: 'b7Lged', // legacy list payload shape still returned by detail calls
    GEMS: 'CNgdBe',        // gems/custom instructions list (currently unused, kept for reference)
    DELETE: 'GzXR5e'       // conversation delete (deletion sniffing anchor)
};

// WIZ_global_data token key names.
export const TOKENS: ProtocolTokens = {
    AT: 'SNlM0e', // XSRF/at token
    BL: 'cfb2h'   // frontend build label key (the "bl" request param)
};

// Extraction patterns for tokens from page HTML/scripts.
export const TOKEN_PATTERNS: ProtocolTokenPatterns = {
    atFromScript: /"SNlM0e"\s*:\s*"([^"]+)"/,
    atGenericFromScript: /"at"\s*:\s*"([^"]{20,})"/,
    blKeyFromScript: /"bl"\s*:\s*"([^"]+)"/,
    blValueFromHtml: /"bl":"(boq_[^"]+)"/,
    blCfb2hFromHtml: /"cfb2h"\s*:\s*"([^"]+)"/,
    blAssistantFromHtml: /"bl"\s*:\s*"(boq_assistant[^"]+)"/,
    boqBuildFromScript: /boq_assistant-bard-web-server_[^"']+/
};

// Deletion sniffing: the deleted conversation id must be anchored to the
// GzXR5e payload context (#194) — never take the first hex token in the
// response text.
export const DELETION_ANCHORS: RegExp[] = [
    /["']GzXR5e["'][\s\S]{1,150}?c_([a-f0-9]{8,64})/i,
    /GzXR5e[\s\S]{1,150}?(?:c_)?([a-f0-9]{8,64})/i
];

// Fallback frontend build label. WARNING: dated build numbers expire and
// then trigger HTTP 400 — TOKEN_PATTERNS.bl* extraction normally supplies
// a fresh one; this is last-resort only. Keep in sync with the live
// frontend when rotating protocol profiles.
export const BL_FALLBACK = 'boq_assistant-bard-web-server_20260802.09_p1';

// Conversation count limits. 500 is Google's sliding-window size: counts
// reaching it trigger the Takeout guidance flow. SERVER_LIMIT_TEXT is the
// (localized-ish) marker inside the server-side error message.
export const LIMITS: ProtocolLimits = {
    SLIDING_WINDOW: 500,
    SERVER_LIMIT_TEXT: '600条'
};

// Real frontends use an incrementing _reqid starting from a random base;
// a pure Math.random() per request is a fingerprintable deviation.
export function createReqidGenerator(): () => string {
    let n = 100000 + Math.floor(Math.random() * 900000);
    return function nextReqid(): string {
        return String(n++);
    };
}

export const GeminiProtocol: GeminiProtocolModule = {
    PROTOCOL_VERSION,
    WRB,
    RPCS,
    EVENTS: CrossWorldEvents,
    TOKENS,
    TOKEN_PATTERNS,
    DELETION_ANCHORS,
    BL_FALLBACK,
    LIMITS,
    createReqidGenerator
};

(GeminiProtocol as any).GeminiProtocol = GeminiProtocol;
(GeminiProtocol as any).CrossWorldEvents = CrossWorldEvents;
(GeminiProtocol as any).default = GeminiProtocol;

if (typeof globalThis !== 'undefined') {
    (globalThis as any).GeminiProtocol = GeminiProtocol;
}
if (typeof module === 'object' && module.exports) {
    module.exports = GeminiProtocol;
}

export default GeminiProtocol;

