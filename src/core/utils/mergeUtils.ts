import { normId, isReservedRoute } from './pathUtils.js';
import { cleanTitle, isRealTitle, resolveTitle, compareConversations, toTimestampMs, isBrandPlaceholderTitle as isBadTitle, normalizeReliableTitleSource } from './titleUtils.js';

export interface MergeConversationOptions {
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

/**
 * SSoT: "any authoritative title slot already holds a title" guard.
 * The legacy fallback below must not fabricate a zombie `legacy` slot when a
 * real source slot (rpc / api-detail / dom / takeout / sniff) already has a
 * title. `legacy` itself is excluded (the guard checks it separately) and
 * rank-0 `default` is intentionally not authoritative.
 */
function hasAuthoritativeTitleSlot(titles: Record<string, string | undefined>): boolean {
    return Boolean(
        titles.rpc ||
        titles['api-detail'] ||
        titles.dom ||
        titles.takeout ||
        titles.sniff
    );
}

export function mergeConversation(
    old: any,
    incoming: any,
    options?: MergeConversationOptions
): MergeConversationResult {
    const id = normId(incoming?.id || old?.id || '');
    const mergedTitles: Record<string, string> = {};
    if (old?.titles && typeof old.titles === 'object') {
        for (const [k, v] of Object.entries(old.titles)) {
            const relK = normalizeReliableTitleSource(k);
            if (relK && typeof v === 'string' && v) {
                mergedTitles[relK] = v;
            } else if (k === 'legacy' && typeof v === 'string' && v) {
                mergedTitles.legacy = v;
            }
        }
    }

    const reliableOldSource = normalizeReliableTitleSource(old?.titleSource);
    if (reliableOldSource && old.title && !mergedTitles[reliableOldSource]) {
        const cleanOldT = cleanTitle(old.title);
        if (cleanOldT && (isRealTitle(cleanOldT, id) || reliableOldSource === 'takeout')) {
            mergedTitles[reliableOldSource] = cleanOldT;
        }
    } else if (old && old.title && !mergedTitles.legacy && !hasAuthoritativeTitleSlot(mergedTitles)) {
        const cleanOldT = cleanTitle(old.title);
        if (cleanOldT && isRealTitle(cleanOldT, id)) {
            mergedTitles.legacy = cleanOldT;
        }
    }

    if (incoming?.titles && typeof incoming.titles === 'object') {
        for (const [k, v] of Object.entries(incoming.titles)) {
            const relK = normalizeReliableTitleSource(k);
            if (relK && typeof v === 'string') {
                const cleanV = cleanTitle(v);
                if (cleanV && (isRealTitle(cleanV, id) || relK === 'takeout')) {
                    if (relK === 'sniff' && mergedTitles.sniff && mergedTitles.sniff !== cleanV) {
                        if (mergedTitles.sniff.startsWith(cleanV) && cleanV.length < mergedTitles.sniff.length) {
                            continue;
                        }
                    }
                    mergedTitles[relK] = cleanV;
                }
            }
        }
    }

    // 2. Merge incoming title + titleSource
    const reliableInSrc = normalizeReliableTitleSource(incoming?.titleSource);
    if (reliableInSrc && incoming?.title) {
        const cleanT = cleanTitle(incoming.title);
        if (cleanT && (isRealTitle(cleanT, id) || reliableInSrc === 'takeout')) {
            if (reliableInSrc === 'sniff' && mergedTitles.sniff && mergedTitles.sniff !== cleanT) {
                if (mergedTitles.sniff.startsWith(cleanT) && cleanT.length < mergedTitles.sniff.length) {
                    // Do not overwrite longer sniff with truncated prefix
                } else {
                    mergedTitles.sniff = cleanT;
                }
            } else {
                mergedTitles[reliableInSrc] = cleanT;
            }
        }
    } else if (incoming?.title && !mergedTitles.legacy && !hasAuthoritativeTitleSlot(mergedTitles)) {
        const cleanT = cleanTitle(incoming.title);
        if (cleanT && isRealTitle(cleanT, id)) {
            mergedTitles.legacy = cleanT;
        }
    }

    const tempChat = {
        id,
        titles: mergedTitles,
        title: incoming?.title || old?.title,
        titleSource: reliableInSrc || reliableOldSource || 'legacy'
    };
    const resolved = resolveTitle(tempChat);
    const resolvedTitle = resolved.title;
    const resolvedSource = resolved.source;

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

    let cUpdated: any = toTimestampMs(incoming?.updatedAt ?? incoming?.timestamp);
    if (cUpdated !== null && cUpdated <= 0) cUpdated = null;

    let oldUpdated: any = toTimestampMs(old?.updatedAt ?? old?.timestamp);
    if (oldUpdated !== null && oldUpdated <= 0) oldUpdated = null;

    let bestUpdatedAt: number | null = null;
    if (cUpdated && oldUpdated) {
        bestUpdatedAt = Math.max(oldUpdated, cUpdated);
    } else {
        bestUpdatedAt = cUpdated || oldUpdated || null;
    }

    let cCreated: any = toTimestampMs(incoming?.createdAt);
    if (cCreated !== null && cCreated <= 0) cCreated = null;

    let oldCreated: any = toTimestampMs(old?.createdAt);
    if (oldCreated !== null && oldCreated <= 0) oldCreated = null;

    // createdAt must never advance into the future; take the earliest timestamp.
    let bestCreatedAt: number | null = null;
    if (cCreated && oldCreated) {
        bestCreatedAt = Math.min(oldCreated, cCreated);
    } else {
        bestCreatedAt = cCreated || oldCreated || null;
    }

    // Route raw .timestamp fallbacks through toTimestampMs to prevent legacy invalid strings from persisting
    const bestTimestamp = bestUpdatedAt || toTimestampMs(old?.timestamp) || toTimestampMs(incoming?.timestamp) || null;

    const effectiveMessageCount = (c: any): number => {
        if (!c || typeof c !== 'object') return 0;
        const n = Number(c.messageCount);
        const m = Array.isArray(c.messages) ? c.messages.length : 0;
        const t = Array.isArray(c.turns) ? c.turns.length : 0;
        return Math.max(Number.isFinite(n) && n > 0 ? n : 0, m, t);
    };
    const oldMsgLen = effectiveMessageCount(old);
    const inMsgLen = effectiveMessageCount(incoming);
    const bestMsgLen = Math.max(oldMsgLen, inMsgLen);
    const incomingShrinksMessages = !!old && oldMsgLen > inMsgLen;

    const toMs = (v: any): number | null => {
        if (v === null || v === undefined || v === '') return null;
        const ms = typeof v === 'string' ? new Date(v).getTime() : Number(v);
        return Number.isFinite(ms) && ms > 0 ? ms : null;
    };
    const oldSeenMs = toMs(old?.lastSeen);
    const inSeenMs = toMs(incoming?.lastSeen);
    let bestLastSeen: any = null;
    if (oldSeenMs !== null && inSeenMs !== null) {
        bestLastSeen = oldSeenMs >= inSeenMs ? old.lastSeen : incoming.lastSeen;
    } else {
        bestLastSeen = oldSeenMs !== null ? old.lastSeen : (inSeenMs !== null ? incoming.lastSeen : null);
    }

    const oldMsgCount = typeof old?.messageCount === 'number' ? old.messageCount : null;
    const inMsgCount = typeof incoming?.messageCount === 'number' ? incoming.messageCount : null;
    const oldBodyLen = Array.isArray(old?.messages) ? old.messages.length : null;
    const inBodyLen = Array.isArray(incoming?.messages) ? incoming.messages.length : null;
    const oldAttCount = typeof (old as any)?.attachmentCount === 'number' ? (old as any).attachmentCount : null;
    const inAttCount = typeof (incoming as any)?.attachmentCount === 'number' ? (incoming as any).attachmentCount : null;
    let isChanged = false;
    if (!old) {
        isChanged = true;
    } else if (
        old.title !== resolvedTitle ||
        (!old.timestamp && bestTimestamp) ||
        (bestUpdatedAt && bestUpdatedAt !== oldUpdated) ||
        (inMsgCount !== null && (oldMsgCount === null || inMsgCount > oldMsgCount)) ||
        (inBodyLen !== null && (oldBodyLen === null ? (oldMsgLen === 0 && inBodyLen > 0) : inBodyLen > oldBodyLen)) ||
        (oldAttCount !== null && inAttCount !== null && oldAttCount !== inAttCount) ||
        bestMsgLen > oldMsgLen
    ) {
        isChanged = true;
    }

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

    const oldBodyLen2 = Array.isArray(old?.messages) ? old.messages.length : 0;
    const inBodyLen2 = Array.isArray(incoming?.messages) ? incoming.messages.length : 0;
    if (oldBodyLen2 > 0 && inBodyLen2 < oldBodyLen2) {
        merged.messages = old.messages;
    }
    const oldTurnsLen2 = Array.isArray(old?.turns) ? old.turns.length : 0;
    const inTurnsLen2 = Array.isArray(incoming?.turns) ? incoming.turns.length : 0;
    if (oldTurnsLen2 > 0 && inTurnsLen2 < oldTurnsLen2) {
        merged.turns = old.turns;
    }
    if (oldMsgCount !== null && inMsgCount !== null) {
        merged.messageCount = Math.max(oldMsgCount, inMsgCount);
    }

    if (bestLastSeen !== null) {
        merged.lastSeen = bestLastSeen;
    }
    if (incomingShrinksMessages) {
        if (Array.isArray(old.messages)) {
            merged.messages = old.messages;
        } else {
            // CRITICAL: old was slimmed (messages stored in IndexedDB).
            // incoming has fewer messages than old's recorded messageCount/turns.
            // Under no circumstances should incoming's shorter/partial messages
            // attach to merged, as that would cause _setConversationsRaw to
            // overwrite IndexedDB's fuller detail with incoming's truncated body!
            delete merged.messages;
        }
        if (Array.isArray(old.turns)) {
            merged.turns = old.turns;
        } else {
            delete merged.turns;
        }
        if (typeof old.messageCount === 'number') merged.messageCount = old.messageCount;
        else if (bestMsgLen > 0) merged.messageCount = bestMsgLen;
    }
    if (options?.source) {
        merged.source = options.source || old?.source || 'unknown';
    }
    if (options?.targetSlot) {
        merged.accountSlot = options.targetSlot;
    }

    return { merged, isChanged, hasDirtyTitles };
}

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
        const uRouteMatch = u.match(/\/app\/([A-Za-z0-9_-]+)/);
        const uRoute = uRouteMatch ? uRouteMatch[1] : '';
        if (isReservedRoute(nid) || isReservedRoute(item.id) || isReservedRoute(uRoute)) {
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

export interface TakeoutMergePlan {
    processed: any[];
    addedCount: number;
    changed: number;
}

export function planTakeoutMerge(
    existing: any[],
    incoming: any[],
    dedupeFn: (list: any[]) => DeduplicateResult = deduplicateConversations
): TakeoutMergePlan | null {
    const existingList = existing || [];
    const incomingList = incoming || [];
    const existingIds = new Set(existingList.map((c: any) => normId(c?.id)));
    const addedCount = incomingList.filter((tc: any) => tc?.id && !existingIds.has(normId(tc.id))).length;
    const { processed, changedCount } = dedupeFn([...existingList, ...incomingList]);

    const trivialFirstSeen = processed.length;
    const hasChangeSignal = typeof changedCount === 'number';
    const repeatMods = hasChangeSignal ? changedCount - trivialFirstSeen : (incomingList.length > 0 ? 1 : 0);
    if (!(addedCount > 0 || repeatMods > 0)) return null;
    return { processed, addedCount, changed: hasChangeSignal ? changedCount : 0 };
}
