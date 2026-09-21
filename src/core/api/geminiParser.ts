// geminiParser.ts - Facade for Gemini RPC response parsing engine
import type { GeminiParserExtractorsModule, GeminiJspbSchema, TurnDriftReport } from "./parser/extractors.js";
import type { GeminiParserAttachmentsModule, DeepResearchDocMeta } from "./parser/attachments.js";
import type { GeminiParserParseListModule, ListParseResult } from "./parser/parseList.js";
import type { GeminiParserParseDetailModule, DetailParseResult } from "./parser/parseDetail.js";

export interface GeminiResponseParserFacade {
    GEMINI_JSPB_SCHEMA: GeminiJspbSchema;
    detectTurnSchemaDrift: (turn: unknown, convId?: string) => TurnDriftReport;
    extractModelCandidates: (turn: unknown) => unknown[];
    extractCandidateText: (cand: unknown) => string;
    robustFirstPayload: (t?: string | null) => unknown[] | null;
    extractTurnTimestamp: (turnData: unknown) => number | null;
    extractImageSelectionIndex: (sourceUrl?: string | null) => number | undefined;
    getImageDedupKey: (img: any) => string;
    filterNewImages: (imgs: any[], seenSet: Set<string>) => any[];
    highResVariant: (u?: string | null) => string;
    extractImages: (obj: unknown, seqRef?: { value: number }) => any[];
    extractUserFiles: (turnUserArr: unknown) => any[];
    extractDocumentsMeta: (root: unknown) => DeepResearchDocMeta[];
    findDocContentById: (root: unknown, docId: string) => unknown;
    parseDocSections: (docContentArr: unknown) => any;
    findDocMarkdownByClues: (root: unknown, metaItem?: any) => string;
    extractThoughts: (candidateBlock: unknown) => string | null;
    extractCitations: (candidateBlock: unknown) => any[];
    extractConversationId: (inner: unknown, turns?: unknown[]) => string;
    extractConversationTitle: (inner: unknown, turns?: unknown[]) => any;
    isRealTitle: (t?: string | null, fallbackId?: string | number) => boolean;
    cleanTitle: (t?: string | null) => string;
    normId: (id?: string | number | null) => string;
    extractListItemTimestamp: (item: unknown) => number | null;
    parseList: (text: string) => ListParseResult;
    parseDetail: (text: string, targetConvId?: string, overrides?: any) => DetailParseResult;
    safeStructureClean: (s?: string | null) => string;
    deepWalk: (r: unknown, v: any, m?: number) => void;
    smartSummarizePrompt: (t?: string | null) => string;
    extractMetaTitleFromTop: (top: unknown[], targetConvId?: string) => string | null;
    isInternalChipUrl: (u?: string | null) => boolean;
    findTurnsDeep: (root: unknown, depth?: number) => unknown[] | null;
}

export interface GeminiParserModule {
    GeminiResponseParserClass: GeminiResponseParserFacade;
    isRealTitle: (t?: string | null, fallbackId?: string | number) => boolean;
    cleanTitle: (t?: string | null) => string;
    normId: (id?: string | number | null) => string;
    GEMINI_JSPB_SCHEMA: GeminiJspbSchema;
    detectTurnSchemaDrift: (turn: unknown, convId?: string) => TurnDriftReport;
    extractListItemTimestamp: (item: unknown) => number | null;
    extractors: GeminiParserExtractorsModule;
    attachments: GeminiParserAttachmentsModule;
    parseList: GeminiParserParseListModule;
    parseDetail: GeminiParserParseDetailModule;
}

declare global {
    var GeminiResponseParserClass: GeminiResponseParserFacade;
}

import * as ext from "./parser/extractors.js";
import * as att from "./parser/attachments.js";
import * as listMod from "./parser/parseList.js";
import * as detailMod from "./parser/parseDetail.js";

const GEMINI_JSPB_SCHEMA: GeminiJspbSchema = ext.GEMINI_JSPB_SCHEMA;


    const detectTurnSchemaDrift = ext.detectTurnSchemaDrift || function() { return { isDrifted: false, warnings: [] }; };
    const extractModelCandidates = ext.extractModelCandidates || function() { return []; };
    const extractCandidateText = ext.extractCandidateText || function() { return ""; };
    const robustFirstPayload = ext.robustFirstPayload || function(t: any) { try { return JSON.parse(t); } catch (_) { return null; } };
    const safeStructureClean = ext.safeStructureClean || function(s: any) { return s || ""; };
    const deepWalk = ext.deepWalk || function(r: any, v: any) { if (r) v(r); };
    const extractThoughts = ext.extractThoughts || function() { return null; };
    const extractCitations = ext.extractCitations || function() { return []; };
    const extractConversationId = ext.extractConversationId || function(inner: any) { return inner?.[0] || "c_unknown"; };
    const smartSummarizePrompt = ext.smartSummarizePrompt || function(t: any) { return String(t || "").trim(); };
    const extractConversationTitle = ext.extractConversationTitle || function() { return { title: "未命名对话", source: "default" }; };
    const extractMetaTitleFromTop = ext.extractMetaTitleFromTop || function() { return null; };
    const extractTurnTimestamp = ext.extractTurnTimestamp || function() { return null; };
    const isRealTitle = ext.isRealTitle || function(t: any) { return !!(t && String(t).trim().length >= 2); };
    const cleanTitle = ext.cleanTitle || function(t: any) { return String(t || "").trim(); };
    const normId = ext.normId || function(id: any) { return String(id || "").replace(/^c_/, "").trim(); };

    const extractImageSelectionIndex = att.extractImageSelectionIndex || function() { return undefined; };
    const getImageDedupKey = att.getImageDedupKey || function(img: any) { return img?.sourceUrl || img?.token || ""; };
    const filterNewImages = att.filterNewImages || function(imgs: any) { return imgs || []; };
    const highResVariant = att.highResVariant || function(u: any) { return u; };
    const isInternalChipUrl = att.isInternalChipUrl || function() { return false; };
    const extractImages = att.extractImages || function() { return []; };
    const extractUserFiles = att.extractUserFiles || function() { return []; };
    const extractDocumentsMeta = att.extractDocumentsMeta || function() { return []; };
    const findDocContentById = att.findDocContentById || function() { return null; };
    const parseDocSections = att.parseDocSections || function() { return { sections: [], links: [], contentMarkdown: "" }; };
    const findDocMarkdownByClues = att.findDocMarkdownByClues || function() { return ""; };

    const extractListItemTimestamp = listMod.extractListItemTimestamp || function() { return null; };
    const parseList = listMod.parseList || function() { return { conversations: [], nextPageToken: null }; };
    const parseDetail = detailMod.parseDetail || function() { return { messages: [] }; };
    const findTurnsDeep = detailMod.findTurnsDeep || function() { return null; };

    /**
     * Facade object exporting all canonical parsing methods and schemas.
     * Preserves 100% backward compatibility with all test suites and browser modules.
     */
    const GeminiResponseParserClass: GeminiResponseParserFacade = {
        GEMINI_JSPB_SCHEMA,
        detectTurnSchemaDrift,
        extractModelCandidates,
        extractCandidateText,
        robustFirstPayload,
        extractTurnTimestamp,
        extractImageSelectionIndex,
        getImageDedupKey,
        filterNewImages,
        highResVariant,
        extractImages,
        extractUserFiles,
        extractDocumentsMeta,
        findDocContentById,
        parseDocSections,
        findDocMarkdownByClues,
        extractThoughts,
        extractCitations,
        extractConversationId,
        extractConversationTitle,
        isRealTitle,
        cleanTitle,
        normId,
        extractListItemTimestamp,
        parseList,
        parseDetail,
        // Utility methods
        safeStructureClean,
        deepWalk,
        smartSummarizePrompt,
        extractMetaTitleFromTop,
        isInternalChipUrl,
        findTurnsDeep
    };

export {
    GeminiResponseParserClass,
    isRealTitle,
    cleanTitle,
    normId,
    GEMINI_JSPB_SCHEMA,
    detectTurnSchemaDrift,
    extractListItemTimestamp,
    parseList,
    parseDetail,
    extractDocumentsMeta
};

export const GeminiParser: GeminiParserModule = {
    GeminiResponseParserClass,
    isRealTitle,
    cleanTitle,
    normId,
    GEMINI_JSPB_SCHEMA,
    detectTurnSchemaDrift,
    extractListItemTimestamp,
    extractors: ext,
    attachments: att,
    parseList: listMod,
    parseDetail: detailMod
};

if (typeof globalThis !== 'undefined') {
    (globalThis as any).GeminiResponseParserClass = GeminiResponseParserClass;
    (globalThis as any).isRealTitle = isRealTitle;
    (globalThis as any).cleanTitle = cleanTitle;
    (globalThis as any).normId = normId;
    (globalThis as any).GEMINI_JSPB_SCHEMA = GEMINI_JSPB_SCHEMA;
    (globalThis as any).detectTurnSchemaDrift = detectTurnSchemaDrift;
    (globalThis as any).extractListItemTimestamp = extractListItemTimestamp;
}
if (typeof module === 'object' && module.exports) module.exports = GeminiParser;

export default GeminiParser;

