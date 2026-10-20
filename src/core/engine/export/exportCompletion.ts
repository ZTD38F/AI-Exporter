import { normId } from '../../utils/pathUtils.js';
import {
    cleanTitle,
    isRealTitle,
    toTimestampMs,
    getEffectiveTimestamp,
    resolveTitle,
    TITLE_SOURCE_PRIORITY,
    type TitleSource,
    normalizeReliableTitleSource,
    resolveReliableTitleSource
} from '../../utils/titleUtils.js';

export { normalizeReliableTitleSource, resolveReliableTitleSource };


export interface BuildExportCompletionInput {
    /** The conversation object with messages/turns/timestamps */
    conversation?: any;
    /** Raw or normalized conversation ID */
    conversationId?: string | number | null;
    /** Export format (default: 'markdown') */
    format?: string;
    /** When export landed (ISO string, ms number, or Date) */
    exportedAt?: string | number | Date;
    /** Failed assets list or count */
    failedAssets?: Array<{ file?: string; error?: string } | any> | number | null;
    /** Status override if known (e.g. 'empty', 'partial', 'ok', 'failed') */
    statusOverride?: 'ok' | 'partial' | 'empty' | 'failed';
    /** Explicit candidate title if available */
    titleCandidate?: string | null;
    /** Explicit provenance/source of candidate title (e.g. 'rpc', 'takeout', 'dom', 'sniff') */
    titleProvenance?: string | null;
    /** Explicit titles map if available */
    titles?: Record<string, string> | null;
    /** Explicit message count if already calculated */
    messageCount?: number;
    /** Explicit authoritative timestamp if available */
    chatTime?: number | string | Date | null;
    /** Truncation flag */
    isTruncated?: boolean;
    truncateReason?: string;
}

export interface StandardExportRecord {
    title: string;
    exportedAt: string;
    format: string;
    messageCount: number;
    status: 'ok' | 'partial' | 'empty' | 'failed';
    hasFailedAssets: boolean;
    chatTime?: number;
    isTruncated?: boolean;
    truncateReason?: string;
    [key: string]: any;
}

export interface StandardConversationUpdate {
    title: string;
    titleSource?: string;
    titles?: Record<string, string>;
    messageCount: number;
    chatTime?: number;
    updatedAt?: number;
}

export interface ExportCompletionResult {
    /** Canonical normalized conversation ID without c_ prefix */
    targetId: string;
    /** Standardized ExportRecord to store in exportedIds SSoT */
    exportRecord: StandardExportRecord;
    /** Standardized update payload for gemini_conversations write-back */
    conversationUpdate: StandardConversationUpdate;
}

/**
 * Computes canonical message count across available message/turn containers.
 */
export function computeExportMessageCount(conversation: any, explicitCount?: number): number {
    if (typeof explicitCount === 'number' && Number.isFinite(explicitCount) && explicitCount > 0) {
        return explicitCount;
    }
    if (!conversation || typeof conversation !== 'object') return 0;
    const candidates = [
        conversation.messageCount,
        Array.isArray(conversation.messages) ? conversation.messages.length : 0,
        Array.isArray(conversation.turns) ? conversation.turns.length : 0
    ];
    let max = 0;
    for (const v of candidates) {
        const n = Number(v);
        if (Number.isFinite(n) && n > max) max = n;
    }
    return max;
}

/**
 * Computes the authoritative timestamp for a conversation across candidate fields.
 */
export function computeAuthoritativeTimestamp(conversation: any, explicitTime?: number | string | Date | null): number | undefined {
    const tsFromExplicit = toTimestampMs(explicitTime);
    let tsFromMessages = 0;
    if (Array.isArray(conversation?.messages)) {
        for (const m of conversation.messages) {
            const mt = toTimestampMs(m?.timestamp);
            if (mt && mt > tsFromMessages) tsFromMessages = mt;
        }
    }
    const tsFromChatTime = toTimestampMs(conversation?.chatTime);
    const tsFromEffective = getEffectiveTimestamp(conversation);
    const tsFromUpdated = toTimestampMs(conversation?.updatedAt);
    const tsFromTimestamp = toTimestampMs(conversation?.timestamp);
    const tsFromCreated = toTimestampMs(conversation?.createdAt);

    const max = Math.max(
        tsFromExplicit ?? 0,
        tsFromMessages,
        tsFromChatTime ?? 0,
        tsFromEffective ?? 0,
        tsFromUpdated ?? 0,
        tsFromTimestamp ?? 0,
        tsFromCreated ?? 0
    );
    return max > 0 ? max : undefined;
}

/**
 * Resolves standard export record status and failed assets indicator.
 * Strict priority order:
 * 1. 'failed'  -> always 'failed'
 * 2. 'empty'   -> stays 'empty'
 * 3. 'partial' -> 'partial'
 * 4. 'ok' + failedAssets -> 'partial'
 * 5. 'ok' + no failedAssets -> 'ok'
 */
export function resolveExportRecordStatus(options: {
    failedAssetsCount: number;
    statusOverride?: 'ok' | 'partial' | 'empty' | 'failed';
    messageCount: number;
    isEmpty?: boolean;
}): { status: 'ok' | 'partial' | 'empty' | 'failed'; hasFailedAssets: boolean } {
    const hasFailed = options.failedAssetsCount > 0;
    if (options.statusOverride === 'failed') {
        return { status: 'failed', hasFailedAssets: hasFailed };
    }
    if (options.statusOverride === 'empty' || options.messageCount === 0 || options.isEmpty) {
        return { status: 'empty', hasFailedAssets: hasFailed };
    }
    if (options.statusOverride === 'partial' || hasFailed) {
        return { status: 'partial', hasFailedAssets: hasFailed };
    }
    return { status: 'ok', hasFailedAssets: false };
}

/**
 * Applies runtime asset failure outcome to an existing canonical export record.
 * Preserves 'empty' or 'failed' status, upgrading successful 'ok' to 'partial'.
 */
export function applyAssetFailureToExportRecord(record: any): void {
    if (!record || typeof record !== 'object') return;
    if (record.status !== 'empty' && record.status !== 'failed') {
        record.status = 'partial';
    }
    record.hasFailedAssets = true;
}

/**
 * Unified factory that transforms raw export completion facts into standardized
 * ExportRecord and ConversationUpdate metadata, eliminating semantic drift between
 * live-save and batch exports.
 */
export function buildExportCompletion(input: BuildExportCompletionInput): ExportCompletionResult {
    const chat = input.conversation || {};
    const rawId = input.conversationId || chat.id || '';
    const targetId = normId(rawId);

    // 1. Resolve title candidate & provenance
    const resolvedFromChat = resolveTitle(chat);
    let candidateTitle = cleanTitle(input.titleCandidate);
    if (!isRealTitle(candidateTitle, targetId)) {
        const chatTitle = cleanTitle(chat.title);
        if (isRealTitle(chatTitle, targetId)) {
            candidateTitle = chatTitle;
        } else if (isRealTitle(resolvedFromChat.title, targetId)) {
            candidateTitle = resolvedFromChat.title;
        } else {
            candidateTitle = candidateTitle || chatTitle || resolvedFromChat.title || '未命名对话';
        }
    }

    // Merge titles map: strictly gate canonical provenance domain
    const mergedTitles: Record<string, string> = {};
    const addCanonicalTitles = (srcObj: any) => {
        if (srcObj && typeof srcObj === 'object') {
            for (const [k, v] of Object.entries(srcObj)) {
                const reliableK = normalizeReliableTitleSource(k);
                if (reliableK && typeof v === 'string' && v) {
                    mergedTitles[reliableK] = v;
                } else if (k === 'legacy' && typeof v === 'string' && v) {
                    mergedTitles.legacy = v;
                }
            }
        }
    };
    addCanonicalTitles(chat.titles);
    addCanonicalTitles(input.titles);

    // Resolve provenance: only adopt if reliable (in TITLE_SOURCE_PRIORITY and not default/legacy/export)
    let candidateProvenance: TitleSource | undefined = resolveReliableTitleSource(
        input.titleProvenance,
        chat.titleSource
    );

    // If still unresolved, check if candidateTitle matches a reliable tier in mergedTitles
    if (!candidateProvenance && mergedTitles && typeof mergedTitles === 'object') {
        for (const source of TITLE_SOURCE_PRIORITY) {
            const reliableSource = normalizeReliableTitleSource(source);
            if (reliableSource && mergedTitles[reliableSource] && cleanTitle(mergedTitles[reliableSource]) === candidateTitle) {
                candidateProvenance = reliableSource;
                break;
            }
        }
    }

    // 2. Resolve timestamps
    const nowMs = toTimestampMs(input.exportedAt) || Date.now();
    const exportedAtIso = new Date(nowMs).toISOString();
    const chatTime = computeAuthoritativeTimestamp(chat, input.chatTime);

    // 3. Resolve message count
    const messageCount = computeExportMessageCount(chat, input.messageCount);

    // 4. Resolve status & failed assets
    const failedAssetsCount = Array.isArray(input.failedAssets)
        ? input.failedAssets.length
        : (typeof input.failedAssets === 'number' ? input.failedAssets : 0);

    const statusInfo = resolveExportRecordStatus({
        failedAssetsCount,
        statusOverride: input.statusOverride,
        messageCount,
        isEmpty: !!chat.isEmpty || !!chat._empty
    });

    const isTruncated = !!(input.isTruncated || chat.truncated || chat.isTruncated);

    const exportRecord: StandardExportRecord = {
        title: candidateTitle,
        exportedAt: exportedAtIso,
        format: input.format || 'markdown',
        messageCount,
        status: statusInfo.status,
        hasFailedAssets: statusInfo.hasFailedAssets,
        ...(chatTime ? { chatTime } : {}),
        ...(isTruncated ? { isTruncated: true, truncateReason: input.truncateReason || chat.truncateReason || 'truncated' } : {})
    };

    const conversationUpdate: StandardConversationUpdate = {
        title: candidateTitle,
        ...(candidateProvenance ? { titleSource: candidateProvenance } : {}),
        ...(Object.keys(mergedTitles).length > 0 ? { titles: mergedTitles } : {}),
        messageCount,
        ...(chatTime ? { chatTime, updatedAt: chatTime } : {})
    };

    return {
        targetId,
        exportRecord,
        conversationUpdate
    };
}

/**
 * Executes standardized export completion and persistence against a storage adapter.
 */
export async function completeConversationExport(
    storageAdapter: any,
    slot: string | null | undefined,
    input: BuildExportCompletionInput,
    options?: {
        onItemExported?: (id: string, record: any) => void;
        skipConversationUpdate?: boolean;
    }
): Promise<ExportCompletionResult> {
    const completion = buildExportCompletion(input);

    if (typeof storageAdapter?.finalizeConversationExport === 'function') {
        await storageAdapter.finalizeConversationExport(
            slot,
            completion.targetId,
            completion.exportRecord,
            {
                conversationUpdate: completion.conversationUpdate,
                skipConversationUpdate: options?.skipConversationUpdate,
                onItemExported: options?.onItemExported
            }
        );
    } else if (typeof storageAdapter?.saveExportRecord === 'function') {
        await storageAdapter.saveExportRecord(slot, completion.targetId, completion.exportRecord);
        try {
            options?.onItemExported?.(completion.targetId, completion.exportRecord);
        } catch { /* callback errors must not abort export completion */ }
    } else {
        throw new Error(
            `[completeConversationExport] storageAdapter must implement finalizeConversationExport or saveExportRecord for conversation ${completion.targetId} (slot ${slot || 'u0'})`
        );
    }

    return completion;
}

export default {
    buildExportCompletion,
    completeConversationExport,
    computeExportMessageCount,
    computeAuthoritativeTimestamp,
    resolveExportRecordStatus,
    applyAssetFailureToExportRecord,
    normalizeReliableTitleSource,
    resolveReliableTitleSource
};
