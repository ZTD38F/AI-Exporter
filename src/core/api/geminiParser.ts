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

import * as ext from "./parser/extractors.js";
import * as att from "./parser/attachments.js";
import * as listMod from "./parser/parseList.js";
import * as detailMod from "./parser/parseDetail.js";

const {
    GEMINI_JSPB_SCHEMA,
    detectTurnSchemaDrift,
    extractModelCandidates,
    extractCandidateText,
    robustFirstPayload,
    extractTurnTimestamp,
    extractThoughts,
    extractCitations,
    extractConversationId,
    extractConversationTitle,
    isRealTitle,
    cleanTitle,
    normId,
    safeStructureClean,
    deepWalk,
    smartSummarizePrompt,
    extractMetaTitleFromTop
} = ext;

const {
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
    isInternalChipUrl
} = att;

const { extractListItemTimestamp, parseList } = listMod;
const { parseDetail, findTurnsDeep } = detailMod;

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
    extractDocumentsMeta,
};
export {
    extractStructuredContent,
    decodeGeminiStructuredPayload,
    decodeGeminiStructuredNode,
    decodeGeminiAnnotation,
    type GeminiStructuredDocument,
    type GeminiStructuredNode,
    type GeminiAnnotation,
} from "./parser/structuredContent.js";

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

if (typeof module === 'object' && module.exports) module.exports = GeminiParser;

export default GeminiParser;

