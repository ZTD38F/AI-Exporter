// extractors.ts - JSPB Schema, unified tree walker, candidate, title, and timestamp extractors
import type { Conversation } from "../../../types/index.js";

export interface JspbTurnSchema {
    ID_META: number;
    TIMESTAMP: number;
    USER_PAYLOAD: number;
    MODEL_PAYLOAD: number;
}

export interface JspbModelPayloadSchema {
    CANDIDATES: number;
    SEARCH_QUERIES: number;
    PROVIDER: number;
    TELEMETRY_START: number;
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

export interface GeminiJspbSchema {
    TURN: JspbTurnSchema;
    MODEL_PAYLOAD: JspbModelPayloadSchema;
    CANDIDATE: JspbCandidateSchema;
    CANDIDATE_BODY: JspbCandidateBodySchema;
    LIST_ITEM: JspbListItemSchema;
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
    extractModelCandidates: (turn: unknown) => unknown[];
    extractCandidateText: (cand: unknown) => string;
    safeStructureClean: (str?: string | null) => string;
    robustFirstPayload: (text?: string | null) => unknown[] | null;
    deepWalk: (root: unknown, visitor: (node: unknown, depth: number) => boolean | void, maxDepth?: number) => void;
    extractThoughts: (candidateBlock: unknown) => string | null;
    extractCitations: (candidateBlock: unknown) => Citation[];
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

declare global {
    var GeminiParserExtractors: GeminiParserExtractorsModule;
    var GEMINI_JSPB_SCHEMA: GeminiJspbSchema;
    var detectTurnSchemaDrift: (turn: any, convId?: string) => TurnDriftReport;
}

import { GeminiUtils, normId as utilsNormId, isRealTitle as utilsIsRealTitle, cleanTitle as utilsCleanTitle } from "../../utils/utils.js";
import { GeminiProtocol } from "../../protocol/protocol.js";

/**
 * Declarative Schema Specification for Google Gemini JSPB (JavaScript Protocol Buffers)
 * Maps conceptual protobuf message fields directly to array index offsets.
 */

    const GEMINI_JSPB_SCHEMA: GeminiJspbSchema = Object.freeze({
        TURN: {
            ID_META: 0,        // ["c_xxx", "r_xxx"]
            TIMESTAMP: 1,      // [seconds, nanos]
            USER_PAYLOAD: 2,   // User input block
            MODEL_PAYLOAD: 3   // Model payload container
        },
        MODEL_PAYLOAD: {
            CANDIDATES: 0,      // repeated Candidate: AI answer drafts
            SEARCH_QUERIES: 1,  // repeated SearchQuery: Grounding search keywords
            PROVIDER: 2,        // string: Grounding provider name ("google")
            TELEMETRY_START: 3  // Internal routing/status codes ("c", "S", 6, 6, ".")
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
        }
    });

    const RESEARCH_PROMPT_PREFIX_RE = /^(?:我已经完成了研究|我拟定了一个研究方案|I've completed your research|Here is a research plan)/i;

    function getUtils(): any {
        return GeminiUtils;
    }

    // Protocol anti-corruption layer (see core/protocol/protocol.ts).
    function getProtocol(): any {
        return GeminiProtocol;
    }

    function normId(id?: string | number | null): string {
        return utilsNormId(id);
    }

    function isRealTitle(t?: string | null, fallbackId?: string | number): boolean {
        return utilsIsRealTitle(t, fallbackId);
    }

    function cleanTitle(rawTitle?: string | null): string {
        return utilsCleanTitle(rawTitle);
    }


    /**
     * Generic depth-bounded recursive walker over nested arrays and objects.
     * Replaces 8+ duplicate ad-hoc walk() functions across the parsing pipeline.
     */
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

    /**
     * Validates turn structure against GEMINI_JSPB_SCHEMA and flags protocol drifts
     */
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
                console.warn(`[Gemini Exporter][Schema Drift Warning] Detected ${warnings.length} schema drift(s) in conv ${convId || "unknown"}:`, warnings);
            }
        }

        return {
            isDrifted: warnings.length > 0,
            warnings
        };
    }

    /**
     * Safely extracts candidates array from turn according to schema
     */
    function extractModelCandidates(turn: unknown): unknown[] {
        if (!turn || !Array.isArray(turn)) return [];
        const modelPayload = turn[GEMINI_JSPB_SCHEMA.TURN.MODEL_PAYLOAD];
        if (!modelPayload || !Array.isArray(modelPayload) || modelPayload.length === 0) return [];

        const candidateBlock = modelPayload[GEMINI_JSPB_SCHEMA.MODEL_PAYLOAD.CANDIDATES];
        if (Array.isArray(candidateBlock)) {
            // Case 1 (Standard Protobuf): modelPayload[0] is array of candidates [cand0, cand1, ...]
            if (candidateBlock.length > 0 && Array.isArray(candidateBlock[0])) {
                return candidateBlock;
            }
            // Case 2 (Single candidate wrapped directly):
            if (typeof candidateBlock[0] === "string") {
                return [candidateBlock];
            }
        }
        // Fallback: If turn[3] was a flat candidates array directly (legacy test compatibility)
        if (Array.isArray(modelPayload[0]) && typeof modelPayload[0][0] === "string" && modelPayload[0][0].startsWith("rc_")) {
            return modelPayload;
        }
        return [];
    }

    /**
     * Cleanly extracts candidate response text without language tag (e.g. "zh") pollution
     */
    function extractCandidateText(cand: unknown): string {
        if (!cand) return "";
        const body = (cand as any)?.[GEMINI_JSPB_SCHEMA.CANDIDATE.BODY] !== undefined
            ? (cand as any)[GEMINI_JSPB_SCHEMA.CANDIDATE.BODY]
            : (Array.isArray(cand) && cand.length === 1 ? cand[0] : cand);

        if (typeof body === "string") return body;
        if (!Array.isArray(body)) return "";

        // Candidate body: typically [ partsArray, languageCode, ... ]
        const parts = body[GEMINI_JSPB_SCHEMA.CANDIDATE_BODY.PARTS];
        if (typeof parts === "string") return parts;
        if (Array.isArray(parts)) {
            let textChunks: string[] = [];
            for (let part of parts) {
                if (typeof part === "string") {
                    textChunks.push(part);
                } else if (Array.isArray(part) && typeof part[0] === "string") {
                    textChunks.push(part[0]);
                }
            }
            if (textChunks.length) return textChunks.join("");
        }

        // Fallback: if body itself is an array of strings [ "text chunk 1", ... ]
        if (typeof body[0] === "string" && body[0].length > 3) {
            return body[0];
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

        // Fast path 1: standard batchexecute response with optional prefix
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

    function extractConversationId(inner: unknown, turns?: unknown[]): string {
        if (Array.isArray(inner)) {
            if (typeof inner[0] === "string" && inner[0].startsWith("c_")) return inner[0];
            if (typeof inner[1] === "string" && inner[1].startsWith("c_")) return inner[1];
        }
        if (Array.isArray(turns)) {
            for (let t of turns) {
                if (Array.isArray(t) && Array.isArray(t[0]) && typeof t[0][0] === "string" && t[0][0].startsWith("c_")) return t[0][0];
                if (Array.isArray(t) && typeof t[0] === "string" && t[0].startsWith("c_")) return t[0];
            }
        }
        let flat = JSON.stringify(inner).match(/"c_[a-zA-Z0-9_-]{8,64}"/);
        if (flat) return flat[0].replace(/"/g, "");
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
            if (typeof inner[2] === "string" && inner[2].length > 0 && !inner[2].startsWith("c_") && !inner[2].startsWith("tC") && !inner[2].startsWith("rc_")) {
                const clean = cleanTitle(inner[2]);
                if (isRealTitle(clean)) return { title: clean, source: "rpc" };
            }
            if (typeof inner[1] === "string" && inner[1].length > 0 && !inner[1].startsWith("c_") && !inner[1].startsWith("tC") && !inner[1].startsWith("rc_")) {
                const clean = cleanTitle(inner[1]);
                if (isRealTitle(clean)) return { title: clean, source: "rpc" };
            }
            if (Array.isArray(inner[0]) && typeof inner[0][1] === "string") {
                const clean = cleanTitle(inner[0][1]);
                if (isRealTitle(clean)) return { title: clean, source: "rpc" };
            }
            for (let i = 0; i < Math.min(inner.length, 6); i++) {
                if (typeof inner[i] === "string" && (inner[i] as string).length >= 2 && !(inner[i] as string).startsWith("c_") && !(inner[i] as string).startsWith("tC") && !(inner[i] as string).startsWith("rc_")) {
                    const clean = cleanTitle(inner[i] as string);
                    if (isRealTitle(clean)) return { title: clean, source: "rpc" };
                }
            }
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

        for (let item of top) {
            if (Array.isArray(item) && item[0] === wrb && (item[1] === listRpc || item[1] === legacyListRpc) && typeof item[2] === "string") {
                try {
                    let metaInner = JSON.parse(item[2]);
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
        }
        return null;
    }

    function extractTurnTimestamp(turnData: unknown): number | null {
        if (!Array.isArray(turnData)) return null;
        let candidates = [turnData[4], turnData[5], turnData[turnData.length - 1]];
        for (let candidate of candidates) {
            if (Array.isArray(candidate) && typeof candidate[0] === "number" && candidate[0] > 1e9) {
                let val = candidate[0];
                if (val > 1e11) return Math.round(val);
                let timestampSec = val;
                let timestampNano = typeof candidate[1] === "number" ? candidate[1] : 0;
                return 1000 * timestampSec + Math.floor(timestampNano / 1e6);
            }
        }
        return null;
    }

export {
    GEMINI_JSPB_SCHEMA,
    RESEARCH_PROMPT_PREFIX_RE,
    detectTurnSchemaDrift,
    extractModelCandidates,
    extractCandidateText,
    safeStructureClean,
    robustFirstPayload,
    deepWalk,
    extractThoughts,
    extractCitations,
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
    extractModelCandidates,
    extractCandidateText,
    safeStructureClean,
    robustFirstPayload,
    deepWalk,
    extractThoughts,
    extractCitations,
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

if (typeof globalThis !== 'undefined') {
    (globalThis as any).GeminiParserExtractors = GeminiParserExtractors;
    (globalThis as any).GEMINI_JSPB_SCHEMA = GEMINI_JSPB_SCHEMA;
    (globalThis as any).detectTurnSchemaDrift = detectTurnSchemaDrift;
}
if (typeof module === 'object' && module.exports) module.exports = GeminiParserExtractors;

export default GeminiParserExtractors;

