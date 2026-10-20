import type { Conversation } from '../../types/index.js';
import {
    sanitizeFileName,
    sanitizeRelativePath,
    normId,
    shortId,
    shortScope,
    isReservedRoute,
    RESERVED_ROUTES,
    isGeminiUrl,
    detectSlotFromUrl,
    extractConversationIdFromUrl,
    buildExportFileName,
    sanitizeFileNameLegacy,
    buildExportFileNameLegacy,
    resolveExportFileName,
    isVersionGreater
} from './pathUtils.js';

import {
    isRealTitle,
    cleanTitle,
    cleanZeroWidth,
    isBrandPlaceholderTitle,
    unescapeHtml,
    stripHtmlTags,
    resolveTitle,
    resolveDetailTitle,
    setTitleBySource,
    applyExportTitleWriteback,
    assertCanonicalTitleProvenance,
    toTimestampMs,
    getEffectiveTimestamp,
    compareConversations,
    checkIsUpdated,
    resolveConversationExportState,
    isTakeoutConversation,
    TITLE_SOURCE_PRIORITY,
    TITLE_TIER_RANK,
    normalizeReliableTitleSource,
    resolveReliableTitleSource,
    type TitleResolution,
    type ConversationExportState,
    type ConversationExportStateKind,
    type ConversationBadgeDescriptor,
    type ResolveConversationExportStateOptions
} from './titleUtils.js';

import {
    formatExportProgress,
    type ExportProgressFormatted,
    type ExportProgressInput
} from './progressUtils.js';
import {
    mergeConversation,
    deduplicateConversations,
    type MergeConversationOptions,
    type MergeConversationResult,
    type DeduplicateResult
} from './mergeUtils.js';
import {
    sendTypedMessage,
    isMessageAction,
    getErrorMessage
} from './messaging.js';

export {
    sanitizeFileName,
    sanitizeRelativePath,
    normId,
    shortId,
    shortScope,
    isReservedRoute,
    RESERVED_ROUTES,
    isGeminiUrl,
    detectSlotFromUrl,
    extractConversationIdFromUrl,
    buildExportFileName,
    sanitizeFileNameLegacy,
    buildExportFileNameLegacy,
    resolveExportFileName,
    isVersionGreater,
    isRealTitle,
    cleanTitle,
    cleanZeroWidth,
    isBrandPlaceholderTitle,
    unescapeHtml,
    stripHtmlTags,
    resolveTitle,
    resolveDetailTitle,
    setTitleBySource,
    applyExportTitleWriteback,
    assertCanonicalTitleProvenance,
    toTimestampMs,
    getEffectiveTimestamp,
    compareConversations,
    checkIsUpdated,
    resolveConversationExportState,
    isTakeoutConversation,
    TITLE_SOURCE_PRIORITY,
    TITLE_TIER_RANK,
    normalizeReliableTitleSource,
    resolveReliableTitleSource,
    type TitleResolution,
    type ConversationExportState,
    type ConversationExportStateKind,
    type ConversationBadgeDescriptor,
    type ResolveConversationExportStateOptions,
    formatExportProgress,
    type ExportProgressFormatted,
    type ExportProgressInput,
    mergeConversation,
    deduplicateConversations,
    type MergeConversationOptions,
    type MergeConversationResult,
    type DeduplicateResult,
    sendTypedMessage,
    isMessageAction,
    getErrorMessage
};

export interface GeminiUtilsModule {
    isDevMode: () => boolean;
    isRealTitle: (title?: string | null, id?: string | number) => boolean;
    cleanTitle: (rawTitle?: string | null) => string;
    cleanZeroWidth: (t: any) => string;
    isBrandPlaceholderTitle: (t: any) => boolean;
    unescapeHtml: (text?: string | null) => string;
    stripHtmlTags: (html?: string | null) => string;
    sanitizeFileName: (name?: string | null, fallback?: string) => string;
    sanitizeRelativePath: (p?: string | null, defaultName?: string) => string;
    normId: (id?: string | number | null) => string;
    shortId: (id?: string | number | null) => string;
    shortScope: (id?: string | number | null) => string;
    isReservedRoute: (id?: string | number | null) => boolean;
    RESERVED_ROUTES: Set<string>;
    isGeminiUrl: (urlStr?: string | null) => boolean;
    detectSlotFromUrl: (urlOrPath?: string | null) => string;
    extractConversationIdFromUrl: (urlOrPath?: string | null) => string | null;
    buildExportFileName: (title?: string | null, id?: string | null, ext?: string) => string;
    sanitizeFileNameLegacy: (name?: string | null, fallback?: string) => string;
    buildExportFileNameLegacy: (title?: string | null, id?: string | null, ext?: string) => string;
    resolveExportFileName: (title?: string | null, id?: string | null, ext?: string, exists?: (name: string) => boolean | Promise<boolean>) => Promise<string>;
    isVersionGreater: (v1?: string | null, v2?: string | null) => boolean;
    resolveTitle: (chat?: Partial<Conversation> | null) => TitleResolution;

    resolveDetailTitle: (messages: any[] | null | undefined, convId?: string | number) => { title: string; source: 'sniff' } | null;
    setTitleBySource: (chat?: any, source?: string, rawTitle?: string) => TitleResolution;
    applyExportTitleWriteback: (existing: any, incoming: any) => any;
    assertCanonicalTitleProvenance: (chat: any) => void;
    toTimestampMs: (raw: any) => number | null;
    getEffectiveTimestamp: (chat?: Partial<Conversation> | null) => number;
    compareConversations: (a?: Partial<Conversation> | null, b?: Partial<Conversation> | null) => number;
    checkIsUpdated: (c: any, rec?: any) => boolean;
    resolveConversationExportState: (c: any, rec?: any, options?: ResolveConversationExportStateOptions) => ConversationExportState;
    isTakeoutConversation: (c: any) => boolean;
    formatExportProgress: (progress?: ExportProgressInput | number | null, txt?: string, isEn?: boolean) => ExportProgressFormatted;
    mergeConversation: (existing: any, incoming: any, options?: MergeConversationOptions) => MergeConversationResult;
    deduplicateConversations: (list: any[], options?: MergeConversationOptions) => DeduplicateResult;
    TITLE_SOURCE_PRIORITY: string[];
    TITLE_TIER_RANK: Record<string, number>;
    getErrorMessage: (err: unknown) => string;
}

declare global {
    var __gemExporterDevMode: boolean | undefined;
    var __gemExporterVerboseLog: boolean | undefined;
    var __gemExporterLogAll: boolean | undefined;
}

export function isDevMode(): boolean {
    if (typeof globalThis !== 'undefined' && (globalThis.__gemExporterDevMode || globalThis.__gemExporterVerboseLog || globalThis.__gemExporterLogAll)) return true;
    if (typeof window !== 'undefined' && ((window as any).__gemExporterDevMode || (window as any).__gemExporterVerboseLog || (window as any).__gemExporterLogAll)) return true;
    return false;
}

export const GeminiUtils: GeminiUtilsModule = {
    isDevMode,
    isRealTitle,
    cleanTitle,
    cleanZeroWidth,
    isBrandPlaceholderTitle,
    unescapeHtml,
    stripHtmlTags,
    sanitizeFileName,
    sanitizeRelativePath,
    normId,
    shortId,
    shortScope,
    isReservedRoute,
    RESERVED_ROUTES,
    isGeminiUrl,
    detectSlotFromUrl,
    extractConversationIdFromUrl,
    buildExportFileName,
    sanitizeFileNameLegacy,
    buildExportFileNameLegacy,
    resolveExportFileName,
    isVersionGreater,
    resolveTitle,

    resolveDetailTitle,
    setTitleBySource,
    applyExportTitleWriteback,
    assertCanonicalTitleProvenance,
    toTimestampMs,
    getEffectiveTimestamp,
    compareConversations,
    checkIsUpdated,
    resolveConversationExportState,
    isTakeoutConversation,
    formatExportProgress,
    mergeConversation,
    deduplicateConversations,
    TITLE_SOURCE_PRIORITY,
    TITLE_TIER_RANK,
    getErrorMessage
};


export default GeminiUtils;
