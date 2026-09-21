// mergeUtils.ts - Conversation merging and deduplication utilities

import { normId, isReservedRoute } from './pathUtils.js';
import { cleanTitle, isRealTitle, resolveTitle, compareConversations } from './titleUtils.js';

export interface MergeConversationOptions {
    isRpcSource?: boolean;
    now?: number | string;
    source?: string;
    targetSlot?: string;
}

export interface MergeConversationResult {
    merged: any;
    isChanged: boolean;
    hasDirtyTitles: boolean;
}

export interface DeduplicateResult {
    processed: any[];
    changedCount: number;
    hasDirtyTitles: boolean;
}

const cleanForBad = (t: any) => String(t || '').replace(/[\u200E\u200B\uFEFF\u00A0]/g, '').trim();
const isBadTitle = (t: any) => !t || /^(Google\s+)?(Gemini|Bard|Google\s+AI|Google\s+Account)$/i.test(cleanForBad(t));

/**
 * SSoT: Merge an incoming conversation into an existing conversation.
 * Accurately arbitrates multi-tier titles, dates/timestamps, message counts, and dirty title status.
 */
export function mergeConversation(
    old: any,
    incoming: any,
    options?: MergeConversationOptions
): MergeConversationResult {
    const id = normId(incoming?.id || old?.id || '');
    const mergedTitles: Record<string, string> = { ...(old?.titles || {}) };

    // 1. Merge incoming.titles if provided
    if (incoming?.titles && typeof incoming.titles === 'object') {
        for (const [k, v] of Object.entries(incoming.titles)) {
            if (typeof v === 'string') {
                const cleanV = cleanTitle(v);
                if (cleanV && (isRealTitle(cleanV, id) || k === 'takeout')) {
                    mergedTitles[k] = cleanV;
                }
            }
        }
    }

    // 2. Merge incoming title + titleSource
    if (incoming?.titleSource && incoming?.title) {
        const cleanT = cleanTitle(incoming.title);
        if (cleanT && (isRealTitle(cleanT, id) || incoming.titleSource === 'takeout')) {
            mergedTitles[incoming.titleSource] = cleanT;
        }
    } else if (incoming?.title && !mergedTitles.legacy && !mergedTitles.rpc && !mergedTitles.dom && !mergedTitles.takeout) {
        const cleanT = cleanTitle(incoming.title);
        if (cleanT && isRealTitle(cleanT, id)) {
            mergedTitles.legacy = cleanT;
        }
    }

    // 3. Preserve old title if real and not yet in titles
    if (old && old.titleSource && old.title && !mergedTitles[old.titleSource]) {
        const cleanOldT = cleanTitle(old.title);
        if (cleanOldT && (isRealTitle(cleanOldT, id) || old.titleSource === 'takeout')) {
            mergedTitles[old.titleSource] = cleanOldT;
        }
    } else if (old && old.title && !mergedTitles.legacy && !mergedTitles.rpc && !mergedTitles.dom && !mergedTitles.takeout) {
        const cleanOldT = cleanTitle(old.title);
        if (cleanOldT && isRealTitle(cleanOldT, id)) {
            mergedTitles.legacy = cleanOldT;
        }
    }

    // 4. Resolve authoritative title
    const tempChat = {
        id,
        titles: mergedTitles,
        title: incoming?.title || old?.title,
        titleSource: incoming?.titleSource || old?.titleSource
    };
    const resolved = resolveTitle(tempChat);
    const resolvedTitle = resolved.title;
    const resolvedSource = resolved.source;

    // 5. Detect dirty title
    let hasDirtyTitles = false;
    if (!old) {
        if (isBadTitle(incoming?.title) || incoming?.title !== resolvedTitle) {
            hasDirtyTitles = true;
        }
    } else {
        if (isBadTitle(old.title) || old.title !== resolvedTitle) {
            hasDirtyTitles = true;
        }
    }

    // 6. Timestamps arbitration
    let cUpdated: any = incoming?.updatedAt || incoming?.timestamp || null;
    if (typeof cUpdated === 'string') cUpdated = new Date(cUpdated).getTime();
    if (!Number.isFinite(cUpdated) || cUpdated <= 0) cUpdated = null;

    let oldUpdated: any = old?.updatedAt || old?.timestamp || null;
    if (typeof oldUpdated === 'string') oldUpdated = new Date(oldUpdated).getTime();
    if (!Number.isFinite(oldUpdated) || oldUpdated <= 0) oldUpdated = null;

    const isRpcSource = options?.isRpcSource ?? (
        options?.source === 'network-list' ||
        options?.source === 'network-detail' ||
        (typeof options?.source === 'string' && options.source.startsWith('stream-')) ||
        incoming?.titleSource === 'rpc' ||
        incoming?.source === 'network-list'
    );

    let bestUpdatedAt = oldUpdated;
    if (cUpdated && (isRpcSource || !bestUpdatedAt || cUpdated > bestUpdatedAt)) {
        bestUpdatedAt = cUpdated;
    }

    let cCreated: any = incoming?.createdAt || null;
    if (typeof cCreated === 'string') cCreated = new Date(cCreated).getTime();
    if (!Number.isFinite(cCreated) || cCreated <= 0) cCreated = null;

    let oldCreated: any = old?.createdAt || null;
    if (typeof oldCreated === 'string') oldCreated = new Date(oldCreated).getTime();
    if (!Number.isFinite(oldCreated) || oldCreated <= 0) oldCreated = null;

    let bestCreatedAt = oldCreated || cCreated || null;
    if (cCreated && oldCreated && cCreated < oldCreated) {
        bestCreatedAt = cCreated;
    }

    const bestTimestamp = isRpcSource
        ? (cUpdated || bestUpdatedAt)
        : (bestUpdatedAt || old?.timestamp || incoming?.timestamp || null);

    // 7. Check if meaningful change occurred
    let isChanged = false;
    if (!old) {
        isChanged = true;
    } else if (
        old.title !== resolvedTitle ||
        (!old.timestamp && bestTimestamp) ||
        (bestUpdatedAt && bestUpdatedAt !== oldUpdated)
    ) {
        isChanged = true;
    }

    // 8. Assemble merged conversation
    const merged: any = {
        ...(old || {}),
        ...(incoming || {}),
        id,
        title: resolvedTitle,
        titleSource: resolvedSource,
        titles: mergedTitles,
        timestamp: bestTimestamp,
        updatedAt: bestUpdatedAt || bestTimestamp,
        createdAt: bestCreatedAt,
        sidebarIndex: typeof incoming?.sidebarIndex === 'number'
            ? incoming.sidebarIndex
            : old?.sidebarIndex
    };

    if (options?.now) {
        merged.lastSeen = options.now;
    }
    if (options?.source) {
        merged.source = options.source || old?.source || 'unknown';
    }
    if (options?.targetSlot) {
        merged.accountSlot = options.targetSlot;
    }

    return { merged, isChanged, hasDirtyTitles };
}

/**
 * SSoT: Deduplicate an array of conversations, merging items with identical normId
 * and sorting by authoritative compareConversations.
 */
export function deduplicateConversations(
    list: any[],
    options?: MergeConversationOptions
): DeduplicateResult {
    if (!Array.isArray(list)) return { processed: [], changedCount: 0, hasDirtyTitles: false };
    const dedupMap = new Map<string, any>();
    let changedCount = 0;
    let hasDirtyTitles = false;

    for (const item of list) {
        if (!item || !item.id) continue;
        const u = ((item as any).url || (item as any).href || '').toString();
        if (/accounts\.google\.com|SignOutOptions/i.test(u)) continue;

        const nid = normId(item.id);
        if (isReservedRoute(nid) || isReservedRoute(item.id) || /\/app\/(download|settings|prompts|archive|trash|share|activity|help|feedback|gems|explore|privacy|terms|updates|faq)($|\/|\?)/i.test(u)) {
            changedCount++;
            hasDirtyTitles = true;
            continue;
        }

        const existing = dedupMap.get(nid);
        const res = mergeConversation(existing, item, options);
        if (res.isChanged) changedCount++;
        if (res.hasDirtyTitles) hasDirtyTitles = true;
        dedupMap.set(nid, res.merged);
    }

    const processed = Array.from(dedupMap.values());
    processed.sort(compareConversations);
    return { processed, changedCount, hasDirtyTitles };
}
