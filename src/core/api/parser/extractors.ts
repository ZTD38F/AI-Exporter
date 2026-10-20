export interface JspbTurnSchema {
    ID_META: number;
    TIMESTAMP: number;
    USER_PAYLOAD: number;
    MODEL_PAYLOAD: number;
    REQUEST_ID_SLOT: number;
}

export interface JspbModelPayloadSchema {
    CANDIDATES: number;
    SEARCH_QUERIES: number;
    PROVIDER: number;
    TELEMETRY_START: number;
    STRUCTURED_CONTENT?: number;
}

export interface JspbCandidateSchema {
    ID: number;
    BODY: number;
    LANGUAGE_CODE: number;
}

export interface JspbCandidateBodySchema {
    PARTS: number;
}

export interface JspbListItemSchema {
    ID: number;
    TITLE: number;
    TIMESTAMP: number;
    UPDATE_TIME_ALT: number;
    CREATE_TIME_ALT: number;
    COUNT_ALT1: number;
    COUNT_ALT2: number;
}

/**
 * Inner payload structure after batchexecute envelope unwrap.
 * Used by both parseList and parseDetail to locate turns, title, conv-id, and pagination token.
 */
export interface JspbInnerSchema {
    /** Primary index for turns array (detail) or conversation list (list) */
    TURNS_OR_LIST_PRIMARY: number;
    /** Secondary index (fallback) for conversation list */
    LIST_SECONDARY: number;
    /** Candidate indices for conversation title (scanned in order) */
    TITLE_CANDIDATES: number[];
    /** Candidate indices for conversation ID */
    CONV_ID_CANDIDATES: number[];
    /** Candidate indices for next-page token (scanned in order) */
    NEXT_TOKEN_CANDIDATES: number[];
    /** Metadata-only detection: null/null sentinel then list-format row */
    METADATA_ONLY_LIST: number;
}

/**
 * Simple inline image tuple: [url, width, height, token?]
 */
export interface JspbInlineImageSchema {
    URL: number;
    WIDTH: number;
    HEIGHT: number;
    TOKEN: number;
}

/**
 * Generated / uploaded media node (complex format):
 *   [?, ?, filename, url, ?, token, ..., mimeType, ..., ?, ?, ?, dimensions]
 */
export interface JspbGeneratedImageSchema {
    FILENAME: number;
    URL: number;
    TOKEN: number;
    UPSCALE_FACTOR: number;
    MIME_TYPE: number;
    DIMENSIONS: number;  // [width, height, size]
}

/**
 * Deep Research document metadata chip structure.
 */
export interface JspbDeepResearchDocSchema {
    CHIP_URL: number;     // item[0][0]
    ID: number;
    TITLE: number;
    CONTENT_ID: number;
    TIMESTAMP: number;    // item[5] → [seconds, ...]
}

/**
 * BardErrorInfo position within the batchexecute envelope.
 */
export interface JspbErrorInfoSchema {
    ERROR_SLOT: number;
}

export interface GeminiJspbSchema {
    TURN: JspbTurnSchema;
    MODEL_PAYLOAD: JspbModelPayloadSchema;
    CANDIDATE: JspbCandidateSchema;
    CANDIDATE_BODY: JspbCandidateBodySchema;
    LIST_ITEM: JspbListItemSchema;
    INNER: JspbInnerSchema;
    INLINE_IMAGE: JspbInlineImageSchema;
    GENERATED_IMAGE: JspbGeneratedImageSchema;
    DEEP_RESEARCH_DOC: JspbDeepResearchDocSchema;
    ERROR_INFO: JspbErrorInfoSchema;
}

export interface TurnDriftReport {
    isDrifted: boolean;
    warnings: string[];
}

export interface Citation {
    url: string;
    title: string;
}

export interface TitleResult {
    title: string;
    source: "rpc" | "sniff" | "default";
}

export interface GeminiParserExtractorsModule {
    GEMINI_JSPB_SCHEMA: GeminiJspbSchema;
    RESEARCH_PROMPT_PREFIX_RE: RegExp;
    detectTurnSchemaDrift: (turn: unknown, convId?: string) => TurnDriftReport;
    hasTurnContentMarkers: (turn: unknown[]) => boolean;
    extractModelCandidates: (turn: unknown) => unknown[];
    extractCandidateText: (cand: unknown) => string;
    safeStructureClean: (str?: string | null) => string;
    robustFirstPayload: (text?: string | null) => unknown[] | null;
    deepWalk: (root: unknown, visitor: (node: unknown, depth: number) => boolean | void, maxDepth?: number) => void;
    extractThoughts: (candidateBlock: unknown) => string | null;
    extractCitations: (candidateBlock: unknown) => Citation[];
    extractGroundingCitationMarkers?: (candidate: unknown) => string[];
    extractConversationId: (inner: unknown, turns?: unknown[]) => string;
    smartSummarizePrompt: (rawText?: string | null) => string;
    extractConversationTitle: (inner: unknown, turns?: unknown[]) => TitleResult;
    extractMetaTitleFromTop: (top: unknown[], targetConvId?: string) => string | null;
    extractTurnTimestamp: (turnData: unknown) => number | null;
    normId: (id?: string | number | null) => string;
    cleanTitle: (rawTitle?: string | null) => string;
    isRealTitle: (t?: string | null, fallbackId?: string | number) => boolean;
    getUtils: () => any;
    getProtocol: () => any;
}

import { GeminiUtils, normId, isRealTitle, cleanTitle } from "../../utils/utils.js";
import { RESEARCH_PROMPT_PREFIX_RE } from "../../utils/titleUtils.js";
import { GeminiProtocol } from "../../protocol/protocol.js";
import { payloadToMs, extractInnerPayload, extractCandidateValue, extractWithScan } from "./payload.js";

/**
 * Declarative Schema Specification for Google Gemini JSPB (JavaScript Protocol Buffers)
 * Maps conceptual protobuf message fields directly to array index offsets.
 */

    const GEMINI_JSPB_SCHEMA: GeminiJspbSchema = Object.freeze({
        TURN: {
            ID_META: 0,        // ["c_xxx", "r_xxx"]
            TIMESTAMP: 1,      // [seconds, nanos]
            USER_PAYLOAD: 2,   // User input block
            MODEL_PAYLOAD: 3,  // Model payload container
            REQUEST_ID_SLOT: 1 // Canonical request ID position in ID_META tuple: ["c_xxx", "r_xxx"][1]
        },
        MODEL_PAYLOAD: {
            CANDIDATES: 0,      // repeated Candidate: AI answer drafts
            SEARCH_QUERIES: 1,  // repeated SearchQuery: Grounding search keywords
            PROVIDER: 2,        // string: Grounding provider name ("google")
            TELEMETRY_START: 3, // Internal routing/status codes ("c", "S", 6, 6, ".")
            STRUCTURED_CONTENT: 12 // repeated StructuredNode: Wire document tree
        },
        CANDIDATE: {
            ID: 0,             // "rc_xxxx"
            BODY: 1,           // Candidate content structure
            LANGUAGE_CODE: 2   // e.g. "zh", "en"
        },
        CANDIDATE_BODY: {
            PARTS: 0           // Array of content parts: [ [textChunk, ...], null, ... ]
        },
        LIST_ITEM: {
            ID: 0,             // string: "c_xxxx"
            TITLE: 1,          // string: Conversation title
            TIMESTAMP: 5,      // [seconds, nanos] Google server-side last updated time
            UPDATE_TIME_ALT: 2,// Legacy/Alternative update timestamp array
            CREATE_TIME_ALT: 3,// Legacy/Alternative create timestamp array
            COUNT_ALT1: 4,     // Optional turn count if number
            COUNT_ALT2: 9      // Optional turn count if number
        },
        INNER: {
            TURNS_OR_LIST_PRIMARY: 0,   // inner[0]: turns array (detail) or list items primary
            LIST_SECONDARY: 1,          // inner[1]: list items secondary candidate (fallback)
            TITLE_CANDIDATES: [2, 1],   // Scanned in order for string title
            CONV_ID_CANDIDATES: [0, 1], // Scanned for "c_..." conversation ID
            NEXT_TOKEN_CANDIDATES: [1, 2, 3], // Scanned for "tC..." pagination token
            METADATA_ONLY_LIST: 2       // inner[2]: list-format metadata-only row
        },
        INLINE_IMAGE: {
            URL: 0,            // string: Google media host URL
            WIDTH: 1,          // number: pixel width
            HEIGHT: 2,         // number: pixel height
            TOKEN: 3           // string?: optional dedup token
        },
        GENERATED_IMAGE: {
            FILENAME: 2,       // string: original file name (e.g. "watermarked_img_*.png")
            URL: 3,            // string: Google media host download URL
            TOKEN: 5,          // string?: dedup token
            UPSCALE_FACTOR: 8, // number?: e.g. 2 for 2x upscale derivative rendition
            MIME_TYPE: 11,     // string: e.g. "image/png"
            DIMENSIONS: 15     // [width, height, size]
        },
        DEEP_RESEARCH_DOC: {
            CHIP_URL: 0,       // item[0][0]: "...immersive_entry_chip..."
            ID: 2,             // string: UUID or "rc_xxx"
            TITLE: 3,          // string: document title
            CONTENT_ID: 4,     // string?: content lookup key
            TIMESTAMP: 5       // item[5][0] * 1000 → ms
        },
        ERROR_INFO: {
            ERROR_SLOT: 5      // item[5] → JSON.stringify checks for "BardErrorInfo"
        }
    });

    function getUtils(): any {
        return GeminiUtils;
    }

    // Protocol anti-corruption layer (see core/protocol/protocol.ts).
    function getProtocol(): any {
        return GeminiProtocol;
    }

    function deepWalk(root: unknown, visitor: (node: unknown, depth: number) => boolean | void, maxDepth: number = 50): void {
        function walk(node: unknown, depth: number) {
            if (!node || typeof node !== "object" || depth > maxDepth) return;
            const shouldDescend = visitor(node, depth);
            if (shouldDescend === false) return;
            if (Array.isArray(node)) {
                for (let i = 0; i < node.length; i++) {
                    walk(node[i], depth + 1);
                }
            } else {
                for (const k in (node as Record<string, unknown>)) {
                    if (Object.prototype.hasOwnProperty.call(node, k)) {
                        walk((node as Record<string, unknown>)[k], depth + 1);
                    }
                }
            }
        }
        walk(root, 0);
    }

    function hasTurnContentMarkers(turn: unknown[]): boolean {
        if (Array.isArray(turn[GEMINI_JSPB_SCHEMA.TURN.USER_PAYLOAD])) return true;
        const modelPayload = turn[GEMINI_JSPB_SCHEMA.TURN.MODEL_PAYLOAD];
        if (Array.isArray(modelPayload)) {
            const cands = modelPayload[GEMINI_JSPB_SCHEMA.MODEL_PAYLOAD.CANDIDATES];
            if (Array.isArray(cands)) {
                for (const c of cands) {
                    if (
                        Array.isArray(c) &&
                        typeof c[GEMINI_JSPB_SCHEMA.CANDIDATE.ID] === "string" &&
                        (c[GEMINI_JSPB_SCHEMA.CANDIDATE.ID] as string).startsWith("rc_")
                    ) return true;
                }
            }
        }
        let budget = 2000;
        const stack: unknown[] = [turn];
        while (stack.length && budget > 0) {
            const node = stack.pop();
            if (typeof node === "string") {
                budget--;
                if (node.startsWith("rc_") || node.startsWith("c_d")) return true;
            } else if (Array.isArray(node)) {
                for (let i = node.length - 1; i >= 0; i--) stack.push(node[i]);
            }
        }
        return false;
    }

    function detectTurnSchemaDrift(turn: unknown, convId?: string): TurnDriftReport {
        const warnings: string[] = [];
        if (!Array.isArray(turn)) {
            warnings.push("Turn is not an array");
            return { isDrifted: true, warnings };
        }
        if (turn.length < 3) {
            warnings.push(`Turn array length (${turn.length}) is less than expected minimum 3`);
        }
        const head = turn[GEMINI_JSPB_SCHEMA.TURN.ID_META];
        let idStr = "";
        if (typeof head === "string") idStr = head;
        else if (Array.isArray(head) && head.length) {
            idStr = typeof head[0] === "string" ? head[0] : (Array.isArray(head[0]) && typeof head[0][0] === "string" ? head[0][0] : "");
        }
        if (!idStr || (!idStr.startsWith("c_") && !idStr.startsWith("r_"))) {
            warnings.push(`Turn ID meta at index 0 does not match expected pattern: ${JSON.stringify(head)?.slice(0, 30)}`);
        } else if (!hasTurnContentMarkers(turn)) {
            warnings.push(`Turn head '${idStr.slice(0, 32)}' matches turn-id pattern but no rc_/c_d content markers found; isTurn() rejects this element (treated as non-turn)`);
        }

        const userPayload = turn[GEMINI_JSPB_SCHEMA.TURN.USER_PAYLOAD];
        if (userPayload !== undefined && !Array.isArray(userPayload)) {
            warnings.push(`UserPayload at index 2 is not an array (type: ${typeof userPayload})`);
        }

        const modelPayload = turn[GEMINI_JSPB_SCHEMA.TURN.MODEL_PAYLOAD];
        if (modelPayload !== undefined) {
            if (!Array.isArray(modelPayload)) {
                warnings.push(`ModelPayload at index 3 is not an array (type: ${typeof modelPayload})`);
            } else if (modelPayload.length > 0) {
                const candBlock = modelPayload[GEMINI_JSPB_SCHEMA.MODEL_PAYLOAD.CANDIDATES];
                if (!Array.isArray(candBlock)) {
                    warnings.push(`Candidates at index 3[0] is not an array (type: ${typeof candBlock})`);
                } else if (candBlock.length > 0) {
                    const firstCand = candBlock[0];
                    if (Array.isArray(firstCand)) {
                        const candId = firstCand[GEMINI_JSPB_SCHEMA.CANDIDATE.ID];
                        if (typeof candId !== "string" || (!candId.startsWith("rc_") && !candId.startsWith("c_"))) {
                            warnings.push(`First candidate ID at 3[0][0][0] does not match 'rc_' prefix: ${JSON.stringify(candId)}`);
                        }
                    }
                }
            }
        }

        if (warnings.length > 0) {
            const isDev = (typeof globalThis !== "undefined" && ((globalThis as any).__gemExporterDevMode || (globalThis as any).__gemExporterVerboseLog))
                || (typeof window !== "undefined" && ((window as any).__gemExporterDevMode || (window as any).__gemExporterVerboseLog));
            if (isDev) {
                console.warn("[Gemini Exporter][Schema Drift Warning] Detected %d schema drift(s) in conv %s:", warnings.length, convId || "unknown", warnings);
            }
        }

        return {
            isDrifted: warnings.length > 0,
            warnings
        };
    }

    function extractModelCandidates(turn: unknown): unknown[] {
        if (!turn || !Array.isArray(turn)) return [];
        const modelPayload = turn[GEMINI_JSPB_SCHEMA.TURN.MODEL_PAYLOAD];
        if (!modelPayload || !Array.isArray(modelPayload) || modelPayload.length === 0) return [];

        const candidateBlock = modelPayload[GEMINI_JSPB_SCHEMA.MODEL_PAYLOAD.CANDIDATES];
        if (Array.isArray(candidateBlock)) {
            if (candidateBlock.length > 0 && Array.isArray(candidateBlock[0])) {
                return candidateBlock;
            }
            if (typeof candidateBlock[0] === "string") {
                return [candidateBlock];
            }
        }
        if (Array.isArray(modelPayload[0]) && typeof modelPayload[0][0] === "string" && modelPayload[0][0].startsWith("rc_")) {
            return modelPayload;
        }
        return [];
    }

    type CandidateBodyTextExtractor = (body: unknown) => string | null;

    const CANDIDATE_BODY_EXTRACTORS: CandidateBodyTextExtractor[] = [
        (body) => (typeof body === "string" ? body : null),

        (body) => {
            if (!Array.isArray(body)) return null;
            const parts = body[GEMINI_JSPB_SCHEMA.CANDIDATE_BODY.PARTS];
            if (typeof parts === "string") return parts;
            if (Array.isArray(parts)) {
                const textChunks: string[] = [];
                for (const part of parts) {
                    if (typeof part === "string") {
                        textChunks.push(part);
                    } else if (Array.isArray(part) && typeof part[0] === "string") {
                        textChunks.push(part[0]);
                    }
                }
                if (textChunks.length) return textChunks.join("");
            }
            return null;
        },

        (body) => {
            if (Array.isArray(body) && typeof body[0] === "string" && body[0].length > 3) {
                return body[0];
            }
            return null;
        }
    ];

    function extractCandidateText(cand: unknown): string {
        if (!cand) return "";
        const body = (cand as any)?.[GEMINI_JSPB_SCHEMA.CANDIDATE.BODY] !== undefined
            ? (cand as any)[GEMINI_JSPB_SCHEMA.CANDIDATE.BODY]
            : (Array.isArray(cand) && cand.length === 1 ? cand[0] : cand);

        for (const extractor of CANDIDATE_BODY_EXTRACTORS) {
            const text = extractor(body);
            if (text !== null) return text;
        }
        return "";
    }

    function safeStructureClean(str?: string | null): string {
        if (!str || typeof str !== "string") return "";
        let out = "";
        let inString = false;
        let escape = false;
        for (let k = 0; k < str.length; k++) {
            const ch = str[k];
            if (inString) {
                out += ch;
                if (escape) {
                    escape = false;
                } else if (ch === "\\") {
                    escape = true;
                } else if (ch === '"') {
                    inString = false;
                }
            } else {
                if (ch === '"') {
                    inString = true;
                    out += ch;
                } else {
                    if (ch.charCodeAt(0) < 32 && ch !== "\t" && ch !== "\r" && ch !== "\n") {
                        continue;
                    }
                    out += ch;
                }
            }
        }
        return out;
    }

    function robustFirstPayload(text?: string | null): unknown[] | null {
        if (!text || typeof text !== "string") return null;

        let trimmed = text.trim();
        if (trimmed.startsWith(")]}'")) {
            trimmed = trimmed.slice(4).trim();
        }
        if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
            try {
                const parsed = JSON.parse(trimmed);
                if (Array.isArray(parsed)) return parsed;
            } catch {
                try {
                    const cleaned = safeStructureClean(trimmed).trim();
                    const parsed = JSON.parse(cleaned);
                    if (Array.isArray(parsed)) return parsed;
                } catch { /* proceed to chunk scanner */ }
            }
        }

        // O(N) single-pass bracket-balancing state machine for chunked / multiline payloads
        let allTop: unknown[] = [];
        const len = text.length;
        let inString = false;
        let escape = false;
        let depth = 0;
        let startIdx = -1;

        for (let i = 0; i < len; i++) {
            const ch = text[i];
            if (inString) {
                if (escape) {
                    escape = false;
                } else if (ch === "\\") {
                    escape = true;
                } else if (ch === '"') {
                    inString = false;
                }
                continue;
            }

            if (ch === '"') {
                inString = true;
                continue;
            }

            if (ch === "[") {
                if (depth === 0) {
                    startIdx = i;
                }
                depth++;
            } else if (ch === "]") {
                if (depth > 0) {
                    depth--;
                    if (depth === 0 && startIdx !== -1) {
                        const chunk = text.slice(startIdx, i + 1);
                        try {
                            const parsed = JSON.parse(chunk);
                            if (Array.isArray(parsed)) {
                                allTop.push(...parsed);
                            }
                        } catch {
                            try {
                                const cleaned = safeStructureClean(chunk).trim();
                                const parsed = JSON.parse(cleaned);
                                if (Array.isArray(parsed)) {
                                    allTop.push(...parsed);
                                }
                            } catch { /* intentional: skip malformed chunk */ }
                        }
                        startIdx = -1;
                    }
                }
            }
        }

        if (allTop.length > 0) return allTop;

        // Truncated / unclosed fallback
        if (depth > 0 && startIdx !== -1) {
            try {
                const tail = text.slice(startIdx) + "]".repeat(depth);
                const cleaned = safeStructureClean(tail).trim();
                const parsed = JSON.parse(cleaned);
                if (Array.isArray(parsed)) return parsed;
            } catch { /* intentional fallback failure */ }
        }

        return null;
    }

    function extractThoughts(candidateBlock: unknown): string | null {
        if (!Array.isArray(candidateBlock)) return null;
        let thoughts: string[] = [];
        deepWalk(candidateBlock, (node) => {
            if (Array.isArray(node)) {
                if (node.length >= 2 && typeof node[0] === "string" && node[0] === "THOUGHT" && typeof node[1] === "string") {
                    thoughts.push(node[1]);
                }
                if (node.length >= 3 && typeof node[1] === "string" && node[1].includes("thought") && typeof node[2] === "string") {
                    thoughts.push(node[2]);
                }
            }
        });
        return thoughts.length ? thoughts.join("\n\n") : null;
    }

    function extractCitations(candidateBlock: unknown): Citation[] {
        let citations: Citation[] = [];
        if (!Array.isArray(candidateBlock)) return citations;
        let seenUrls = new Set<string>();
        deepWalk(candidateBlock, (node) => {
            if (Array.isArray(node)) {
                if (node.length >= 2 && typeof node[0] === "string" && (node[0].startsWith("http://") || node[0].startsWith("https://")) && typeof node[1] === "string") {
                    let url = node[0],
                        title = node[1];
                    if (!seenUrls.has(url) && !url.includes("googleusercontent.com/immersive_entry_chip")) {
                        seenUrls.add(url);
                        citations.push({ url, title });
                    }
                }
            }
        });
        return citations;
    }

    function extractGroundingCitationMarkers(candidate: unknown): string[] {
        const markers = new Set<string>();
        if (!candidate) return [];

        deepWalk(candidate, (node) => {
            if (!node || typeof node !== "object") return;
            const f44 = (node as any)["44"] ?? (node as any)[44];
            if (Array.isArray(f44)) {
                for (const item of f44) {
                    if (Array.isArray(item) && Array.isArray(item[0])) {
                        const raw = item[0][0];
                        if (typeof raw === "string") {
                            const trimmed = raw.trim();
                            if (/^\[cite:\s*\d+\]$/i.test(trimmed)) {
                                markers.add(trimmed);
                            }
                        }
                    }
                }
            }
        });

        return Array.from(markers);
    }

    function extractConversationId(inner: unknown, turns?: unknown[]): string {
        const idFromCandidates = extractCandidateValue(
            inner,
            GEMINI_JSPB_SCHEMA.INNER.CONV_ID_CANDIDATES,
            val => (typeof val === "string" && val.startsWith("c_") ? val : null)
        );
        if (idFromCandidates) return idFromCandidates;

        if (Array.isArray(turns)) {
            for (let t of turns) {
                if (Array.isArray(t) && Array.isArray(t[0]) && typeof t[0][0] === "string" && t[0][0].startsWith("c_")) return t[0][0];
                if (Array.isArray(t) && typeof t[0] === "string" && t[0].startsWith("c_")) return t[0];
            }
        }
        const CONV_ID_STRICT_RE = /^c_[a-zA-Z0-9_-]{8,64}$/;
        let foundId: string | null = null;
        deepWalk(inner, (node) => {
            if (foundId) return false;
            if (Array.isArray(node)) {
                for (const el of node) {
                    if (typeof el === "string" && CONV_ID_STRICT_RE.test(el)) { foundId = el; return false; }
                }
            } else if (node && typeof node === "object") {
                for (const k in (node as Record<string, unknown>)) {
                    const v = (node as Record<string, unknown>)[k];
                    if (typeof v === "string" && CONV_ID_STRICT_RE.test(v)) { foundId = v; return false; }
                }
            }
        });
        if (foundId) return foundId;
        return "c_unknown";
    }

    function smartSummarizePrompt(rawText?: string | null): string {
        if (!rawText) return "";
        let s = cleanTitle(rawText).trim();
        s = s.replace(/^(请问一下|请问|我想问一下|我想问|你能帮我|帮我|你能|请教一下|请教|都说|那么|那个|如果说|如果|我发现|为什么)\s*[,，:：]?\s*/i, "");
        const breakMatch = s.match(/^([^，。？！\n\r\t,?!]{4,35})/);
        if (breakMatch && breakMatch[1]) {
            s = breakMatch[1].trim();
        } else {
            s = s.slice(0, 30).trim();
        }
        return s;
    }

    function extractConversationTitle(inner: unknown, turns?: unknown[]): TitleResult {
        if (Array.isArray(inner)) {
            const sanitizeIfTitle = (val: unknown): string | null => {
                if (typeof val === "string" && val.length > 0 && !val.startsWith("c_") && !val.startsWith("tC") && !val.startsWith("rc_")) {
                    const clean = cleanTitle(val);
                    if (isRealTitle(clean)) return clean;
                }
                return null;
            };

            const candidateTitle = extractCandidateValue(inner, GEMINI_JSPB_SCHEMA.INNER.TITLE_CANDIDATES, sanitizeIfTitle);
            if (candidateTitle) return { title: candidateTitle, source: "rpc" };

            const primary = inner[GEMINI_JSPB_SCHEMA.INNER.TURNS_OR_LIST_PRIMARY];
            if (Array.isArray(primary) && typeof primary[1] === "string") {
                const clean = cleanTitle(primary[1]);
                if (isRealTitle(clean)) return { title: clean, source: "rpc" };
            }

            const first6Indices = Array.from({ length: Math.min(inner.length, 6) }, (_, i) => i);
            const broadTitle = extractCandidateValue(
                inner,
                first6Indices,
                val => (typeof val === "string" && val.length >= 2 ? sanitizeIfTitle(val) : null)
            );
            if (broadTitle) return { title: broadTitle, source: "rpc" };
        }
        if (Array.isArray(turns)) {
            for (let t of turns) {
                let uText = (t as any)?.[2]?.[0]?.[0];
                if (typeof uText === "string" && uText.trim() && !RESEARCH_PROMPT_PREFIX_RE.test(uText)) {
                    const concise = smartSummarizePrompt(uText);
                    if (isRealTitle(concise)) return { title: concise, source: "sniff" };
                    const rawClean = cleanTitle(uText.slice(0, 40).trim());
                    if (isRealTitle(rawClean)) return { title: rawClean, source: "sniff" };
                }
            }
        }
        return { title: "未命名对话", source: "default" };
    }

    function extractMetaTitleFromTop(top: unknown[], targetConvId?: string): string | null {
        if (!Array.isArray(top)) return null;
        const targetNid = normId(targetConvId);
        const protocol = getProtocol();
        const wrb = protocol ? protocol.WRB : "wrb.fr";
        const listRpc = protocol ? protocol.RPCS.LIST : "MaZiqc";
        const legacyListRpc = protocol ? protocol.RPCS.LEGACY_LIST : "hXcbkd";

        const { inner: metaInner } = extractInnerPayload(top, {
            wrb,
            rpcId: [listRpc, legacyListRpc]
        });

        if (metaInner) {
            try {
                let list = Array.isArray(metaInner?.[1]) ? metaInner[1] : (Array.isArray(metaInner?.[2]) ? metaInner[2] : (Array.isArray(metaInner?.[0]) ? metaInner[0] : []));
                for (let entry of list) {
                    if (Array.isArray(entry)) {
                        let id = entry[0];
                        let rawTitle = entry[1];
                        let nid = normId(id);
                        if (!targetNid || !nid || nid === targetNid) {
                            let cleanT = cleanTitle(rawTitle);
                            if (isRealTitle(cleanT, nid || targetNid)) {
                                return cleanT;
                            }
                        }
                    }
                }
            } catch (e) { if (typeof console !== "undefined" && console.debug) console.debug("[GemExporter:extractors.ts]", e); }
        }
        return null;
    }

    function extractTurnTimestamp(turnData: unknown): number | null {
        if (!Array.isArray(turnData)) return null;
        const candidateIndices = [
            GEMINI_JSPB_SCHEMA.TURN.TIMESTAMP, // index 1 (primary)
            4,                                  // known alternative
            5,                                  // known alternative
            turnData.length - 1                 // last element fallback
        ];
        return extractCandidateValue(turnData, candidateIndices, val => payloadToMs(val));
    }

export {
    GEMINI_JSPB_SCHEMA,
    RESEARCH_PROMPT_PREFIX_RE,
    detectTurnSchemaDrift,
    hasTurnContentMarkers,
    extractModelCandidates,
    extractCandidateText,
    safeStructureClean,
    robustFirstPayload,
    deepWalk,
    extractThoughts,
    extractCitations,
    extractGroundingCitationMarkers,
    extractConversationId,
    smartSummarizePrompt,
    extractConversationTitle,
    extractMetaTitleFromTop,
    extractTurnTimestamp,
    normId,
    cleanTitle,
    isRealTitle,
    getUtils,
    getProtocol
};

export const GeminiParserExtractors: GeminiParserExtractorsModule = {
    GEMINI_JSPB_SCHEMA,
    RESEARCH_PROMPT_PREFIX_RE,
    detectTurnSchemaDrift,
    hasTurnContentMarkers,
    extractModelCandidates,
    extractCandidateText,
    safeStructureClean,
    robustFirstPayload,
    deepWalk,
    extractThoughts,
    extractCitations,
    extractGroundingCitationMarkers,
    extractConversationId,
    smartSummarizePrompt,
    extractConversationTitle,
    extractMetaTitleFromTop,
    extractTurnTimestamp,
    normId,
    cleanTitle,
    isRealTitle,
    getUtils,
    getProtocol
};
if (typeof module === 'object' && module.exports) module.exports = GeminiParserExtractors;

export default GeminiParserExtractors;

