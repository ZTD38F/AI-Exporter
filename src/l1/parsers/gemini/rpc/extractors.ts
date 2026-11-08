import { extractSourceAttributions, type GeminiSourceAttribution } from "./sourceAttributions.js";
interface JspbTurnSchema {
    ID_META: number;
    TIMESTAMP: number;
    USER_PAYLOAD: number;
    MODEL_PAYLOAD: number;
    REQUEST_ID_SLOT: number;
}

interface JspbModelPayloadSchema {
    CANDIDATES: number;
    SEARCH_QUERIES: number;
    PROVIDER: number;
    SELECTED_CANDIDATE_ID: number;
    TELEMETRY_START: number;
    STRUCTURED_CONTENT?: number;
}

interface JspbCandidateSchema {
    ID: number;
    BODY: number;
    LANGUAGE_CODE: number;
}

interface JspbCandidateBodySchema {
    PARTS: number;
}

interface JspbListItemSchema {
    ID: number;
    TITLE: number;
    TIMESTAMP: number;
    UPDATE_TIME_ALT: number;
    CREATE_TIME_ALT: number;
    COUNT_ALT1: number;
    COUNT_ALT2: number;
}

interface JspbInnerSchema {
    TURNS_OR_LIST_PRIMARY: number;
    LIST_SECONDARY: number;
    TITLE_CANDIDATES: number[];
    CONV_ID_CANDIDATES: number[];
    NEXT_TOKEN_CANDIDATES: number[];
    METADATA_ONLY_LIST: number;
}

interface JspbInlineImageSchema {
    URL: number;
    WIDTH: number;
    HEIGHT: number;
    TOKEN: number;
}

interface JspbGeneratedImageSchema {
    FILENAME: number;
    URL: number;
    TOKEN: number;
    UPSCALE_FACTOR: number;
    MIME_TYPE: number;
    DIMENSIONS: number;
}

interface JspbDeepResearchDocSchema {
    CHIP_URL: number;
    ID: number;
    TITLE: number;
    CONTENT_ID: number;
    TIMESTAMP: number;
}

interface JspbErrorInfoSchema {
    ERROR_SLOT: number;
}

interface GeminiJspbSchema {
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

/** Selected Candidate facts decoded at the Turn boundary. Raw media evidence
 * stays private to Gemini resource decoders. */
export interface DecodedGeminiCandidate {
    /** Selected wire context; only the resource decoder interprets these remaining slots. */
    source: unknown[];
    body: unknown;
    turnDocument: unknown;
    index: number;
    id: string;
    text: string;
    /** Source facts decoded once, before message assembly. */
    thoughts: string | null;
    citations: Citation[];
    sourceAttributions: GeminiSourceAttribution[];
    groundingCitationMarkers: string[];
}

/** Known fields read once from a Turn. Selected wire evidence stays within
 * the L1 decoder and is consumed by specialized resource decoders. */
export interface DecodedGeminiTurn {
    userText: string;
    timestamp: number | null;
    userMessageId: string;
    fallbackTurnId: string;
    /** Only the confirmed request-ID slots yield provider identity. */
    rawProviderRequestId: string | undefined;
    candidate: DecodedGeminiCandidate | null;
}

interface GeminiParserExtractorsModule {
    GEMINI_JSPB_SCHEMA: GeminiJspbSchema;
    RESEARCH_PROMPT_PREFIX_RE: RegExp;
    detectTurnSchemaDrift: (turn: unknown, convId?: string) => TurnDriftReport;
    hasTurnContentMarkers: (turn: unknown[]) => boolean;
    extractModelCandidates: (turn: unknown) => unknown[];
    decodeTurn: (turn: unknown) => DecodedGeminiTurn | null;
    extractCandidateText: (cand: unknown) => string;
    safeStructureClean: (str?: string | null) => string;
    robustFirstPayload: (text?: string | null) => unknown[] | null;
    deepWalk: (root: unknown, visitor: (node: object, depth: number) => boolean | void, maxDepth?: number) => void;
    extractThoughts: (candidateBlock: unknown) => string | null;
    extractCitations: (candidateBlock: unknown) => Citation[];
    extractGroundingCitationMarkers?: (candidate: unknown) => string[];
    extractConversationId: (inner: unknown, turns?: unknown[]) => string;
    smartSummarizePrompt: (rawText?: string | null) => string;
    extractConversationTitle: (inner: unknown, turns?: unknown[]) => TitleResult;
    extractTurnTimestamp: (turnData: unknown) => number | null;
    normId: (id?: string | number | null) => string;
    cleanTitle: (rawTitle?: string | null) => string;
    isRealTitle: (t?: string | null, fallbackId?: string | number) => boolean;
}

import { normId } from "../../../../shared/utils/pathUtils.js";
import { isRealTitle, cleanTitle } from "../../../../shared/utils/titleText.js";
import { RESEARCH_PROMPT_PREFIX_RE } from "../../../../shared/utils/titleText.js";
import { payloadToMs, extractCandidateValue } from "./payload.js";


    const GEMINI_JSPB_SCHEMA: GeminiJspbSchema = Object.freeze({
        TURN: {
            ID_META: 0,
            TIMESTAMP: 1,
            USER_PAYLOAD: 2,
            MODEL_PAYLOAD: 3,
            REQUEST_ID_SLOT: 1 // Canonical request ID position in ID_META tuple: ["c_xxx", "r_xxx"][1]
        },
        MODEL_PAYLOAD: {
            CANDIDATES: 0,
            SEARCH_QUERIES: 1,
            PROVIDER: 2,
            SELECTED_CANDIDATE_ID: 3,
            TELEMETRY_START: 3,
            STRUCTURED_CONTENT: 12
        },
        CANDIDATE: {
            ID: 0,
            BODY: 1,
            LANGUAGE_CODE: 2
        },
        CANDIDATE_BODY: {
            PARTS: 0
        },
        LIST_ITEM: {
            ID: 0,
            TITLE: 1,
            TIMESTAMP: 5,
            UPDATE_TIME_ALT: 2,
            CREATE_TIME_ALT: 3,
            COUNT_ALT1: 4,
            COUNT_ALT2: 9
        },
        INNER: {
            TURNS_OR_LIST_PRIMARY: 0,
            LIST_SECONDARY: 1,
            TITLE_CANDIDATES: [2, 1],
            CONV_ID_CANDIDATES: [0, 1],
            NEXT_TOKEN_CANDIDATES: [1, 2, 3],
            METADATA_ONLY_LIST: 2
        },
        INLINE_IMAGE: {
            URL: 0,
            WIDTH: 1,
            HEIGHT: 2,
            TOKEN: 3
        },
        GENERATED_IMAGE: {
            FILENAME: 2,
            URL: 3,
            TOKEN: 5,
            UPSCALE_FACTOR: 8,
            MIME_TYPE: 11,
            DIMENSIONS: 15
        },
        DEEP_RESEARCH_DOC: {
            CHIP_URL: 0,
            ID: 2,
            TITLE: 3,
            CONTENT_ID: 4,
            TIMESTAMP: 5
        },
        ERROR_INFO: {
            ERROR_SLOT: 5
        }
    });

    function isObjectRecord(value: unknown): value is Record<string, unknown> {
        return value !== null && typeof value === "object";
    }

    // Array.isArray narrows elements to any; preserve the untrusted element type.
    function isUnknownArray(value: unknown): value is unknown[] {
        return Array.isArray(value);
    }

    function deepWalk(root: unknown, visitor: (node: object, depth: number) => boolean | void, maxDepth: number = 50): void {
        function walk(node: unknown, depth: number) {
            if (!node || !isObjectRecord(node) || depth > maxDepth) return;
            const shouldDescend = visitor(node, depth);
            if (shouldDescend === false) return;
            if (isUnknownArray(node)) {
                for (let i = 0; i < node.length; i++) {
                    walk(node[i], depth + 1);
                }
            } else {
                for (const k in node) {
                    if (Object.prototype.hasOwnProperty.call(node, k)) {
                        walk(node[k], depth + 1);
                    }
                }
            }
        }
        walk(root, 0);
    }

    function hasTurnContentMarkers(turn: unknown[]): boolean {
        if (Array.isArray(turn[GEMINI_JSPB_SCHEMA.TURN.USER_PAYLOAD])) return true;
        const modelPayload = turn[GEMINI_JSPB_SCHEMA.TURN.MODEL_PAYLOAD];
        if (isUnknownArray(modelPayload)) {
            const cands = modelPayload[GEMINI_JSPB_SCHEMA.MODEL_PAYLOAD.CANDIDATES];
            if (isUnknownArray(cands)) {
                for (const c of cands) {
                    if (!isUnknownArray(c)) continue;
                    const id = c[GEMINI_JSPB_SCHEMA.CANDIDATE.ID];
                    if (typeof id === "string" && id.startsWith("rc_")) return true;
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
        if (!isUnknownArray(turn)) {
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
            if (!isUnknownArray(modelPayload)) {
                warnings.push(`ModelPayload at index 3 is not an array (type: ${typeof modelPayload})`);
            } else if (modelPayload.length > 0) {
                const candBlock = modelPayload[GEMINI_JSPB_SCHEMA.MODEL_PAYLOAD.CANDIDATES];
                if (!isUnknownArray(candBlock)) {
                    warnings.push(`Candidates at index 3[0] is not an array (type: ${typeof candBlock})`);
                } else if (candBlock.length > 0) {
                    const firstCand = candBlock[0];
                    if (isUnknownArray(firstCand)) {
                        const candId = firstCand[GEMINI_JSPB_SCHEMA.CANDIDATE.ID];
                        if (typeof candId !== "string" || (!candId.startsWith("rc_") && !candId.startsWith("c_"))) {
                            warnings.push(`First candidate ID at 3[0][0][0] does not match 'rc_' prefix: ${JSON.stringify(candId)}`);
                        }
                    }
                }
            }
        }

        if (warnings.length > 0) {
            const isDev = globalThis.__gemExporterDevMode || globalThis.__gemExporterVerboseLog;
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
        if (!turn || !isUnknownArray(turn)) return [];
        const modelPayload = turn[GEMINI_JSPB_SCHEMA.TURN.MODEL_PAYLOAD];
        if (!modelPayload || !isUnknownArray(modelPayload) || modelPayload.length === 0) return [];

        const candidateBlock = modelPayload[GEMINI_JSPB_SCHEMA.MODEL_PAYLOAD.CANDIDATES];
        if (isUnknownArray(candidateBlock)) {
            if (candidateBlock.length > 0 && Array.isArray(candidateBlock[0])) {
                return candidateBlock;
            }
            if (typeof candidateBlock[0] === "string") {
                return [candidateBlock];
            }
        }
        const first = modelPayload[0];
        if (isUnknownArray(first) && typeof first[0] === "string" && first[0].startsWith("rc_")) {
            return modelPayload;
        }
        return [];
    }

    type CandidateBodyTextExtractor = (body: unknown) => string | null;

    const CANDIDATE_BODY_EXTRACTORS: CandidateBodyTextExtractor[] = [
        (body) => (typeof body === "string" ? body : null),

        (body) => {
            if (!isUnknownArray(body)) return null;
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
        const candidateSlots = isUnknownArray(cand) ? cand : null;
        const body: unknown = candidateSlots !== null
            ? (candidateSlots[GEMINI_JSPB_SCHEMA.CANDIDATE.BODY] !== undefined
                ? candidateSlots[GEMINI_JSPB_SCHEMA.CANDIDATE.BODY]
                : (candidateSlots.length === 1 ? candidateSlots[0] : candidateSlots))
            : cand;

        for (const extractor of CANDIDATE_BODY_EXTRACTORS) {
            const text = extractor(body);
            if (text !== null) return text;
        }
        return "";
    }

    /** User text is a Turn-level fact, shared by user messages and generation prompts. */
    function extractUserText(userPayload: unknown): string {
        if (!isUnknownArray(userPayload) || userPayload.length === 0) return "";
        const first = userPayload[0];
        if (typeof first === "string") return first;
        if (isUnknownArray(first) && typeof first[0] === "string") return first[0];
        return "";
    }

    /** Keep the original candidate fallback, but resolve it before returning
     * typed Turn evidence instead of walking raw candidate data downstream. */
    function extractModelResponseText(candidate: unknown): string {
        const direct = extractCandidateText(candidate);
        if (direct) return direct;
        const textArr: string[] = [];
        deepWalk(candidate, (node) => {
            if (isUnknownArray(node)) {
                if (node.length >= 1 && typeof node[0] === "string" && node[0].length > 0
                    && !node[0].startsWith("http") && !node[0].startsWith("rc_") && !node[0].startsWith("c_")) {
                    if (node[0].trim().length > 2 && !textArr.includes(node[0])) {
                        textArr.push(node[0]);
                    }
                }
            }
        });
        return textArr.join("\n\n");
    }

    function safeStructureClean(str?: string | null): string {
        if (!str) return "";
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
        if (!text) return null;

        let trimmed = text.trim();
        if (trimmed.startsWith(")]}'")) {
            trimmed = trimmed.slice(4).trim();
        }
        if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
            try {
                const parsed: unknown = JSON.parse(trimmed);
                if (isUnknownArray(parsed)) return parsed;
            } catch {
                try {
                    const cleaned = safeStructureClean(trimmed).trim();
                    const parsed: unknown = JSON.parse(cleaned);
                    if (isUnknownArray(parsed)) return parsed;
                } catch { /* proceed to chunk scanner */ }
            }
        }

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
                            const parsed: unknown = JSON.parse(chunk);
                            if (isUnknownArray(parsed)) allTop.push(...parsed);
                        } catch {
                            try {
                                const cleaned = safeStructureClean(chunk).trim();
                                const parsed: unknown = JSON.parse(cleaned);
                                if (isUnknownArray(parsed)) allTop.push(...parsed);
                            } catch { /* intentional: skip malformed chunk */ }
                        }
                        startIdx = -1;
                    }
                }
            }
        }

        if (allTop.length > 0) return allTop;

        if (depth > 0 && startIdx !== -1) {
            try {
                const tail = text.slice(startIdx) + "]".repeat(depth);
                const cleaned = safeStructureClean(tail).trim();
                const parsed: unknown = JSON.parse(cleaned);
                if (isUnknownArray(parsed)) return parsed;
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
            if (!node || !isObjectRecord(node)) return;
            const record = node;
            const f44 = record["44"] ?? record[44];
            if (isUnknownArray(f44)) {
                for (const item of f44) {
                    if (!isUnknownArray(item)) continue;
                    const first = item[0];
                    if (isUnknownArray(first)) {
                        const raw = first[0];
                        if (typeof raw === "string") {
                            const trimmed = raw.trim();
                            if (/^\[cite:\s*\d+(?:\s*,\s*\d+)*\]$/i.test(trimmed)) {
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
            } else if (isObjectRecord(node)) {
                for (const k in node) {
                    const v = node[k];
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
        if (isUnknownArray(inner)) {
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
                const t2 = isUnknownArray(t) ? t[2] : undefined;
                const t20 = isUnknownArray(t2) ? t2[0] : undefined;
                const uText = isUnknownArray(t20) ? t20[0] : undefined;
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


    /** Decode the fields used by the message builder once, with existing
     * fallback/selection rules. Specialized parsers receive raw evidence. */
    function decodeTurn(turn: unknown): DecodedGeminiTurn | null {
        if (!isUnknownArray(turn)) return null;

        const idMeta = turn[GEMINI_JSPB_SCHEMA.TURN.ID_META];
        let userMessageId = "";
        if (isUnknownArray(idMeta)) {
            userMessageId = idMeta.find((id): id is string => typeof id === "string" && id.startsWith("r_"))
                || (typeof idMeta[1] === "string" ? idMeta[1] : "")
                || (typeof idMeta[0] === "string" ? idMeta[0] : "");
        } else if (typeof idMeta === "string") {
            userMessageId = idMeta;
        }

        const fallbackRawId = isUnknownArray(idMeta)
            ? (idMeta.find((id) => typeof id === "string" && (id.startsWith("rc_") || id.startsWith("r_")))
                || idMeta[1] || idMeta[0])
            : idMeta;
        const fallbackTurnId = typeof fallbackRawId === "string" ? fallbackRawId : "";

        // Request identity is stricter than user-message/fallback identity:
        // do not scan arbitrary metadata slots or the timestamp. Only the
        // captured request slot, then slot 0, can prove an r_-prefixed token.
        let rawProviderRequestId: string | undefined;
        if (isUnknownArray(idMeta)) {
            const request = idMeta[GEMINI_JSPB_SCHEMA.TURN.REQUEST_ID_SLOT];
            const alternative = idMeta[0];
            if (typeof request === "string" && request.startsWith("r_")) {
                rawProviderRequestId = request;
            } else if (typeof alternative === "string" && alternative.startsWith("r_")) {
                rawProviderRequestId = alternative;
            }
        } else if (typeof idMeta === "string" && idMeta.startsWith("r_")) {
            rawProviderRequestId = idMeta;
        }

        const rawUserPayload = turn[GEMINI_JSPB_SCHEMA.TURN.USER_PAYLOAD];
        const modelPayload = turn[GEMINI_JSPB_SCHEMA.TURN.MODEL_PAYLOAD];
        const selectedId = isUnknownArray(modelPayload)
            ? modelPayload[GEMINI_JSPB_SCHEMA.MODEL_PAYLOAD.SELECTED_CANDIDATE_ID]
            : undefined;
        const candidates = extractModelCandidates(turn);
        const selectedIndex = typeof selectedId === "string" && selectedId.startsWith("rc_")
            ? candidates.findIndex(raw => isUnknownArray(raw) && raw[GEMINI_JSPB_SCHEMA.CANDIDATE.ID] === selectedId)
            : -1;
        const candidateIndex = selectedIndex >= 0 ? selectedIndex : 0;
        const selected = candidates[candidateIndex];
        const slots = isUnknownArray(selected) ? selected : null;
        const rawId = slots?.[GEMINI_JSPB_SCHEMA.CANDIDATE.ID];
        const body = slots?.[GEMINI_JSPB_SCHEMA.CANDIDATE.BODY];
        const candidateBlock = body || selected;
        const candidate: DecodedGeminiCandidate | null = slots !== null
            ? {
                source: slots, body, index: candidateIndex,
                turnDocument: isUnknownArray(modelPayload) ? modelPayload[GEMINI_JSPB_SCHEMA.MODEL_PAYLOAD.STRUCTURED_CONTENT ?? 12] : undefined,
                id: typeof rawId === "string" ? rawId : "",
                text: extractModelResponseText(selected),
                thoughts: extractThoughts(candidateBlock),
                citations: extractCitations(candidateBlock),
                sourceAttributions: extractSourceAttributions(selected),
                groundingCitationMarkers: extractGroundingCitationMarkers(selected || candidateBlock)
            }
            : null;

        // Text in a neighboring metadata row is not proof of a message role.
        // Keep recoverable header drift when a request or selected candidate still owns it.
        const headId = isUnknownArray(idMeta) ? idMeta[0] : idMeta;
        const hasTurnIdentity = [headId, userMessageId].some(id => typeof id === 'string' && /^(?:c_|r_).+/.test(id));
        if (!hasTurnIdentity && !candidate?.id.startsWith('rc_')) return null;

        return {
            userText: extractUserText(rawUserPayload),
            timestamp: extractTurnTimestamp(turn),
            userMessageId,
            fallbackTurnId,
            rawProviderRequestId,
            candidate
        };
    }

export {
    GEMINI_JSPB_SCHEMA,
    RESEARCH_PROMPT_PREFIX_RE,
    detectTurnSchemaDrift,
    hasTurnContentMarkers,
    extractModelCandidates,
    decodeTurn,
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
    normId,
    cleanTitle,
    isRealTitle
};

const GeminiParserExtractors: GeminiParserExtractorsModule = {
    GEMINI_JSPB_SCHEMA,
    RESEARCH_PROMPT_PREFIX_RE,
    detectTurnSchemaDrift,
    hasTurnContentMarkers,
    extractModelCandidates,
    decodeTurn,
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
    extractTurnTimestamp,
    normId,
    cleanTitle,
    isRealTitle
};
export default GeminiParserExtractors;
