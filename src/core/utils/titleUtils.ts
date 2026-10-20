import type { Conversation, TitleSource } from '../../types/index.js';
export type { TitleSource };
import { normId } from './pathUtils.js';

export interface TitleResolution {
    title: string;
    source: string;
}

export const RESEARCH_PROMPT_PREFIX_RE = /^(?:我已经完成了研究|我拟定了一个研究方案|I've completed your research|Here is a research plan)/i;

export const TITLE_SOURCE_PRIORITY: TitleSource[] = ['rpc', 'api-detail', 'dom', 'takeout', 'openai', 'sniff', 'legacy', 'default'];

export const TITLE_TIER_RANK: Record<TitleSource, number> = {
    rpc: 50,
    'api-detail': 50,
    dom: 40,
    takeout: 30,
    openai: 30,
    sniff: 20,
    legacy: 10,
    default: 0
};

/**
 * Normalizes a raw source string into a canonical, reliable TitleSource.
 * Returns undefined if source is falsy, unknown, or an unreliable fallback
 * tier ('default', 'legacy', 'export').
 */
export function normalizeReliableTitleSource(source?: string | null): TitleSource | undefined {
    if (typeof source !== 'string') return undefined;
    const s = source.trim();
    if (!s || s === 'default' || s === 'legacy' || s === 'export') {
        return undefined;
    }
    return TITLE_SOURCE_PRIORITY.includes(s as TitleSource) ? (s as TitleSource) : undefined;
}

/**
 * Resolves the first reliable TitleSource from candidate sources in priority order.
 * Returns undefined if no candidate provides a reliable source.
 */
export function resolveReliableTitleSource(...sources: (string | null | undefined)[]): TitleSource | undefined {
    for (const src of sources) {
        const normalized = normalizeReliableTitleSource(src);
        if (normalized) return normalized;
    }
    return undefined;
}


export function isTakeoutConversation(c: any): boolean {
    if (!c) return false;
    return (
        (c as any).source === 'takeout' ||
        c.titleSource === 'takeout' ||
        (c as any).isTakeoutOnly ||
        !!(c.titles && (c.titles as any).takeout)
    );
}

export function cleanZeroWidth(t: any): string {
    return String(t || '').replace(/[\u200E\u200B\uFEFF\u00A0]/g, '').trim();
}

export function isBrandPlaceholderTitle(t: any): boolean {
    if (!t) return true;
    return /^(Google\s+)?(Gemini|Bard|Google\s+AI|Google\s+Account)$/i.test(cleanZeroWidth(t));
}

export function isRealTitle(title?: string | null, id?: string | number): boolean {
    if (!title || typeof title !== 'string') return false;
    let t = title.trim();
    if (!t || t.length < 2) return false;
    if (t === 'Untitled' || t === '未命名' || t === 'New chat' || t === '新对话') return false;
    if (id) {
        let cleanId = normId(id);
        let cleanT = normId(t);
        if (cleanT === cleanId) return false;
        if (cleanT.startsWith('未命名对话(') || cleanT.startsWith('Untitled(')) return false;
        if (cleanT === 'c_' + cleanId || cleanId === 'c_' + cleanT) return false;
    }
    if (/^(未命名对话|Untitled conversation|Untitled|Document|Gemini|Google Gemini|Bard|Google Bard|Google AI|New chat|新对话|Search|搜索)$/i.test(t)) return false;
    if (/^(Google\s+)?(Gemini|Bard|Google\s+AI)$/i.test(t)) return false;
    if (/^(Google Account|Sign in|Sign-in|Sign in with Google|登录|重新登录)/i.test(t)) return false;
    if (/^[a-f0-9_-]{8,64}$/i.test(t)) return false;
    if (/^[0-9a-f]{16}$/i.test(t) || /^c_[0-9a-f]{16}$/i.test(t)) return false;
    if (RESEARCH_PROMPT_PREFIX_RE.test(t)) return false;
    return true;
}

export function unescapeHtml(text?: string | null): string {
    if (!text || typeof text !== 'string') return '';
    return text
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
}

function removeElementBlocks(input: string, tagName: string): string {
    let current = input;
    const openToken = `<${tagName}`;
    const closeToken = `</${tagName}`;
    let searchFrom = 0;
    while (searchFrom < current.length) {
        const lower = current.toLowerCase();
        const startIdx = lower.indexOf(openToken, searchFrom);
        if (startIdx === -1) break;
        const afterOpen = current.charAt(startIdx + openToken.length);
        if (afterOpen && afterOpen !== '>' && afterOpen !== '/' && !/\s/.test(afterOpen)) {
            searchFrom = startIdx + openToken.length;
            continue;
        }
        const closeStart = lower.indexOf(closeToken, startIdx + openToken.length);
        if (closeStart === -1) {
            current = current.slice(0, startIdx);
            break;
        }
        const closeEnd = current.indexOf('>', closeStart + closeToken.length);
        if (closeEnd === -1) {
            current = current.slice(0, startIdx);
            break;
        }
        current = current.slice(0, startIdx) + current.slice(closeEnd + 1);
        searchFrom = startIdx;
    }
    return current;
}

export function stripHtmlTags(html?: string | null): string {
    if (!html || typeof html !== 'string') return '';
    let res = html;
    let prev = '';
    while (res !== prev) {
        prev = res;
        res = removeElementBlocks(res, 'script');
        res = removeElementBlocks(res, 'style');
        let tagStart = res.indexOf('<');
        while (tagStart !== -1) {
            const tagEnd = res.indexOf('>', tagStart + 1);
            if (tagEnd === -1) break;
            res = res.slice(0, tagStart) + res.slice(tagEnd + 1);
            tagStart = res.indexOf('<');
        }
    }
    return res;
}

export function cleanTitle(rawTitle?: string | null): string {
    if (!rawTitle || typeof rawTitle !== 'string') return '';
    let t = rawTitle.replace(/\u00a0/g, ' ').replace(/[\r\n\t]+/g, ' ').trim();
    if (/^(Google\s+)?(Gemini|Bard|Google\s+AI)$/i.test(t)) return '';
    t = t.replace(/\s*[-–—|·•]\s*(Google\s+)?(Gemini|Bard|Google\s+AI).*$/i, '');
    t = t.replace(/^(Google\s+)?(Gemini|Bard|Google\s+AI)\s*[-–—|·•]\s*/i, '');
    t = t.trim();
    if (/^(Google\s+)?(Gemini|Bard|Google\s+AI)$/i.test(t)) return '';
    return t;
}

/**
 * Resolve the most authoritative valid title from a chat object with multi-tier source slots.
 */
export function resolveTitle(chat?: Partial<Conversation> | null): TitleResolution {
    if (!chat) return { title: '未命名对话', source: 'default' };
    const id = chat.id || '';

    if (chat.titles && typeof chat.titles === 'object') {
        for (const source of TITLE_SOURCE_PRIORITY) {
            if (source === 'legacy' || source === 'default') continue;
            const raw = chat.titles[source];
            if (!raw) continue;
            const clean = cleanTitle(raw);
            if (clean && (isRealTitle(clean, id) || (source === 'takeout' && !isBrandPlaceholderTitle(clean)))) {
                return { title: clean, source: source };
            }
        }
    }

    const legacyClean = cleanTitle(chat.title);
    if (legacyClean && isRealTitle(legacyClean, id)) {
        return { title: legacyClean, source: normalizeReliableTitleSource(chat.titleSource) || 'legacy' };
    }

    if (chat.titles && typeof chat.titles === 'object' && chat.titles.legacy) {
        const legacyFromTitles = cleanTitle(chat.titles.legacy);
        if (legacyFromTitles && isRealTitle(legacyFromTitles, id)) {
            return { title: legacyFromTitles, source: 'legacy' };
        }
    }

    if (chat.titles && chat.titles.takeout) {
        const rawTakeout = cleanTitle(chat.titles.takeout);
        if (rawTakeout && (isRealTitle(rawTakeout, id) || !isBrandPlaceholderTitle(rawTakeout))) {
            return { title: rawTakeout, source: 'takeout' };
        }
    }

    return { title: '未命名对话', source: 'default' };
}

export function setTitleBySource(chat: any, source?: string, rawTitle?: string): TitleResolution {
    if (!chat) return { title: '未命名对话', source: 'default' };
    const reliableSource = normalizeReliableTitleSource(source);
    if (!reliableSource) {
        // Unknown or unreliable source: strictly non-influential.
        // It must NOT write into chat.titles nor mutate chat.title / chat.titleSource.
        return resolveTitle(chat);
    }
    chat.titles = (chat.titles && typeof chat.titles === 'object') ? chat.titles : {};
    const cleaned = cleanTitle(rawTitle);
    if (cleaned && isRealTitle(cleaned, chat.id)) {
        chat.titles[reliableSource] = cleaned;
    } else if (reliableSource === 'takeout' && cleaned) {
        chat.titles.takeout = cleaned;
    }
    const resolved = resolveTitle(chat);
    chat.title = resolved.title;
    chat.titleSource = resolved.source;
    return resolved;
}

/**
 * Invariant assertion helper:
 * Verifies that a conversation's titleSource and titles dictionary keys strictly belong
 * to the canonical provenance domain (reliable sources ∪ { 'legacy', 'default' }).
 * 'default' is only permitted as a placeholder titleSource, never as a titles key.
 * 'export' or any unrecognized strings are strictly forbidden.
 */
export function assertCanonicalTitleProvenance(chat: any): void {
    const validSources = new Set(['rpc', 'api-detail', 'dom', 'takeout', 'openai', 'sniff', 'legacy', 'default']);
    const validTitleKeys = new Set(['rpc', 'api-detail', 'dom', 'takeout', 'openai', 'sniff', 'legacy']);

    if (chat && chat.titleSource !== undefined) {
        if (!validSources.has(chat.titleSource)) {
            throw new Error(`titleSource '${chat.titleSource}' is not in canonical domain (${Array.from(validSources).join(', ')})`);
        }
    }

    if (chat && chat.titles && typeof chat.titles === 'object') {
        for (const k of Object.keys(chat.titles)) {
            if (!validTitleKeys.has(k)) {
                throw new Error(`titles key '${k}' is not in canonical titles domain (${Array.from(validTitleKeys).join(', ')})`);
            }
            if (k === 'export') {
                throw new Error("titles key must not be 'export'");
            }
            if (k === 'default') {
                throw new Error("titles key must not be 'default'");
            }
        }
    }
}

/**
 * Adopt titles from incoming conversation per source-tier slot and re-arbitrate
 * so that higher-authority stored titles are never downgraded by weaker sources.
 *
 * Rules:
 * 1. Source-tier arbitration: When incoming carries a reliable source (rpc, api-detail, dom, takeout, etc.),
 *    it routes through setTitleBySource and canonical resolveTitle arbitration.
 * 2. Unprovenanced / weak-source export candidate promotion:
 *    When export/finalize provides a candidate title where isRealTitle(candidate) is true,
 *    and existing currently resolves only to a generic placeholder (or default),
 *    the candidate is promoted to existing as a valid title (source: legacy).
 *    If existing already has any real title (rpc, api-detail, dom, takeout, etc.),
 *    an unprovenanced candidate can NEVER overwrite or downgrade it.
 * 3. Unknown provenance must be completely non-influential:
 *    Sources that fail normalizeReliableTitleSource() cannot be saved into titles,
 *    and their values cannot be scanned or used to promote titles.
 */
export function applyExportTitleWriteback(existing: any, incoming: any): any {
    if (!existing || !incoming) return existing;

    // 1. Seed the stored record's own resolved title into its tier slot first
    // so legacy-shaped records whose title lives only in title/titleSource are protected by arbitration.
    if (existing.titleSource && existing.title &&
        (!existing.titles || typeof existing.titles !== 'object' || !existing.titles[existing.titleSource])) {
        const cleanedSeed = cleanTitle(existing.title);
        if (cleanedSeed && (isRealTitle(cleanedSeed, existing.id) || existing.titleSource === 'takeout')) {
            const reliableExistingSource = normalizeReliableTitleSource(existing.titleSource);
            if (reliableExistingSource) {
                setTitleBySource(existing, reliableExistingSource, existing.title);
            }
        }
    }

    // 2. Adopt explicit source tiers if provided by incoming
    if (incoming.titles && typeof incoming.titles === 'object') {
        for (const [slot, slotTitle] of Object.entries(incoming.titles)) {
            const reliableSlot = normalizeReliableTitleSource(slot);
            if (reliableSlot && typeof slotTitle === 'string' && slotTitle) {
                setTitleBySource(existing, reliableSlot, slotTitle);
            }
        }
    }

    // 3. Adopt incoming title with reliable provenance
    const incomingSource = incoming.titleSource;
    const reliableIncomingSource = normalizeReliableTitleSource(incomingSource);

    if (incoming.title && reliableIncomingSource) {
        setTitleBySource(existing, reliableIncomingSource, incoming.title);
    }

    // 4. Candidate promotion rule for unprovenanced or weak-source export titles:
    // Candidate promotion MUST ONLY come from explicit incoming.title.
    // Unknown titles slots have zero influence and cannot promote titles.
    const currentResolved = resolveTitle(existing);
    const existingHasRealTitle = isRealTitle(currentResolved.title, existing.id) ||
        (currentResolved.source === 'takeout' && !isBrandPlaceholderTitle(currentResolved.title));

    if (!existingHasRealTitle) {
        const cleanedIncoming = cleanTitle(incoming.title);
        if (isRealTitle(cleanedIncoming, existing.id)) {
            existing.titles = (existing.titles && typeof existing.titles === 'object') ? existing.titles : {};
            existing.title = cleanedIncoming;
            existing.titleSource = reliableIncomingSource || 'legacy';
            if (existing.titleSource === 'legacy') {
                existing.titles.legacy = cleanedIncoming;
            } else {
                existing.titles[existing.titleSource] = cleanedIncoming;
            }
        }
    }

    return existing;
}

export function toTimestampMs(raw: any): number | null {
    if (raw === null || raw === undefined) return null;
    if (typeof raw === 'number') {
        return Number.isFinite(raw) && raw > 0 ? raw : null;
    }
    if (raw instanceof Date) {
        const t = raw.getTime();
        return Number.isFinite(t) && t > 0 ? t : null;
    }
    if (typeof raw === 'string') {
        const s = raw.trim();
        if (!s) return null;
        if (/^\d+(\.\d+)?$/.test(s)) {
            const n = Number(s);
            if (!Number.isFinite(n) || n <= 0) return null;
            return n < 1e11 ? n * 1000 : n;
        }
        const t = new Date(s).getTime();
        return Number.isFinite(t) && t > 0 ? t : null;
    }
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
}

// Server-authoritative only (updatedAt > timestamp > chatTime > createdAt).
// lastSeen is client-observed and intentionally excluded so missing timestamps return 0 rather than a guess.
export function getEffectiveTimestamp(chat?: Partial<Conversation> | null): number {
    if (!chat || typeof chat !== 'object') return 0;
    const candidates = [chat.updatedAt, chat.timestamp, (chat as any).chatTime, chat.createdAt];
    for (const raw of candidates) {
        const ms = toTimestampMs(raw);
        if (ms !== null) {
            return ms;
        }
    }
    return 0;
}

type SortableConversation = Partial<Conversation> & { sidebarIndex?: number };
export function compareConversations(a?: SortableConversation | null, b?: SortableConversation | null): number {
    if (!a && !b) return 0;
    if (!a) return 1;
    if (!b) return -1;

    const tsA = getEffectiveTimestamp(a);
    const tsB = getEffectiveTimestamp(b);
    if (tsA !== tsB) return tsB - tsA;

    const idxA = typeof a.sidebarIndex === 'number' ? a.sidebarIndex : 999999;
    const idxB = typeof b.sidebarIndex === 'number' ? b.sidebarIndex : 999999;
    if (idxA !== idxB) return idxA - idxB;

    let lsA = 0;
    if (a.lastSeen) {
        lsA = toTimestampMs(a.lastSeen) ?? 0;
    }
    let lsB = 0;
    if (b.lastSeen) {
        lsB = toTimestampMs(b.lastSeen) ?? 0;
    }
    return lsB - lsA;
}

export type ConversationExportStateKind =
    | 'unexported'
    | 'exporting_assets'
    | 'exported_ok'
    | 'exported_partial'
    | 'updated'
    | 'failed';

export interface ConversationBadgeDescriptor {
    kind: 'none' | 'exporting_assets' | 'exported_ok' | 'exported_partial' | 'updated' | 'failed';
    className: string;
    i18nKey: string;
    defaultLabel: string;
    bg: string;
    border: string;
    color: string;
}

export interface ConversationExportState {
    state: ConversationExportStateKind;
    /** True only when conversation activity on server/local advanced past the export record */
    hasNewerActivity: boolean;
    /** True when incremental export (skipExported) or default auto-select should include this conversation */
    needsIncrementalExport: boolean;
    /** True when the conversation failed in the current session or has a partial/failed export record */
    isFailed: boolean;
    /** True when never exported and not failed */
    isUnexported: boolean;
    /** True when exported without failure/partial status */
    isExportedClean: boolean;
    /** Deterministic badge visual & i18n descriptor */
    badge: ConversationBadgeDescriptor;
}

export interface ResolveConversationExportStateOptions {
    isFailedInSession?: boolean;
    customHasNewerActivity?: (c: any, rec: any) => boolean;
}

const BADGE_DESCRIPTORS: Record<ConversationBadgeDescriptor['kind'], ConversationBadgeDescriptor> = {
    none: {
        kind: 'none',
        className: '',
        i18nKey: '',
        defaultLabel: '',
        bg: '',
        border: '',
        color: ''
    },
    exporting_assets: {
        kind: 'exporting_assets',
        className: 'badge badge-exporting-assets',
        i18nKey: 'badgeExportingAssets',
        defaultLabel: 'Exporting assets...',
        bg: 'rgba(59,130,246,0.15)',
        border: 'rgba(59,130,246,0.3)',
        color: '#3b82f6'
    },
    updated: {
        kind: 'updated',
        className: 'badge badge-updated',
        i18nKey: 'badgeUpdated',
        defaultLabel: 'Updated',
        bg: 'rgba(245,158,11,0.15)',
        border: 'rgba(245,158,11,0.35)',
        color: '#f59e0b'
    },
    exported_partial: {
        kind: 'exported_partial',
        className: 'badge badge-exported-partial',
        i18nKey: 'badgeExportedPartial',
        defaultLabel: 'Exported (Partial Assets)',
        bg: 'rgba(234,179,8,0.15)',
        border: 'rgba(234,179,8,0.3)',
        color: '#eab308'
    },
    exported_ok: {
        kind: 'exported_ok',
        className: 'badge badge-exported',
        i18nKey: 'badgeExported',
        defaultLabel: 'Exported',
        bg: 'rgba(16,185,129,0.15)',
        border: 'rgba(16,185,129,0.3)',
        color: '#10b981'
    },
    failed: {
        kind: 'failed',
        className: 'badge badge-failed',
        i18nKey: 'badgeFailed',
        defaultLabel: 'Failed',
        bg: 'rgba(239,68,68,0.15)',
        border: 'rgba(239,68,68,0.3)',
        color: '#ef4444'
    }
};

function computeHasNewerActivity(c: any, rec: any): boolean {
    if (!c || !rec) return false;
    try {
        const cTs = getEffectiveTimestamp(c);
        const rTs = toTimestampMs(rec.exportedAt) ?? 0;
        const rChatTime = toTimestampMs((rec as any).chatTime) ?? 0;
        const curMsgCount = c.messageCount || (Array.isArray(c.messages) ? c.messages.length : 0);
        const recMsgCount = (rec as any).messageCount || 0;

        // 1. Authoritative same-clock check:
        // If export record captured the exported conversation's server chatTime:
        // When conversation server timestamp has NOT advanced past exported turn timestamp,
        // it cannot be updated by timestamp (immune to local clock skew).
        if (rChatTime > 0 && cTs > 0 && cTs <= rChatTime) {
            if (curMsgCount > 0 && recMsgCount > 0 && curMsgCount > recMsgCount) {
                if (rTs > 0 && rTs >= cTs + 2000 && (rec.isTruncated || (rec as any).truncated || c.id?.includes('truncated'))) {
                    return false;
                }
                return true;
            }
            return false;
        }

        // 2. Export freshness lock: if the export finished strictly AFTER the conversation's last activity,
        // the conversation content cannot be newer than the export.
        // Suppress messageCount / legacy chatTime discrepancies when exportedAt is strictly newer than cTs.
        if (rTs > 0 && cTs > 0 && rTs >= cTs + 2000) {
            return false;
        }

        // 3. Timestamp check:
        // If rChatTime is present, check if cTs advanced past rChatTime
        if (cTs > 0 && rChatTime > 0 && cTs > rChatTime + 2000) {
            return true;
        }

        // Legacy fallback when rChatTime is not present: check if cTs advanced past exportedAt
        if (!rChatTime && cTs > 0 && rTs > 0 && cTs > rTs + 2000) {
            return true;
        }

        // 4. Message count check:
        if (curMsgCount > 0 && recMsgCount > 0 && curMsgCount > recMsgCount) {
            return true;
        }
    } catch {}
    return false;
}

export function resolveConversationExportState(
    c: any,
    rec?: any,
    options?: ResolveConversationExportStateOptions
): ConversationExportState {
    const hasRecord = !!rec;
    const recStatus = rec ? (rec as any).status : undefined;
    const isPendingAssets = !!(rec && recStatus === 'pending_assets');
    const isPartial = !isPendingAssets && !!(rec && (recStatus === 'partial' || !!(rec as any).hasFailedAssets));
    const isRecordFailed = !!(rec && recStatus === 'failed');
    const isFailedInSession = !!options?.isFailedInSession;

    const isFailed = isFailedInSession || isPartial || isRecordFailed;
    const isUnexported = !hasRecord && !isFailed;
    const isExportedClean = hasRecord && !isFailed;

    const activityChecker = options?.customHasNewerActivity || computeHasNewerActivity;
    const hasNewerActivity = hasRecord && !isPendingAssets ? activityChecker(c, rec) : false;

    let state: ConversationExportStateKind;
    let badgeKind: ConversationBadgeDescriptor['kind'];

    if (!hasRecord) {
        state = isFailedInSession ? 'failed' : 'unexported';
        badgeKind = isFailedInSession ? 'failed' : 'none';
    } else if (isPendingAssets) {
        state = 'exporting_assets';
        badgeKind = 'exporting_assets';
    } else if (isRecordFailed || isFailedInSession) {
        state = 'failed';
        badgeKind = 'failed';
    } else if (hasNewerActivity) {
        state = 'updated';
        badgeKind = 'updated';
    } else if (isPartial) {
        state = 'exported_partial';
        badgeKind = 'exported_partial';
    } else {
        state = 'exported_ok';
        badgeKind = 'exported_ok';
    }

    const needsIncrementalExport = !hasRecord || isPartial || isRecordFailed || hasNewerActivity;

    return {
        state,
        hasNewerActivity,
        needsIncrementalExport,
        isFailed,
        isUnexported,
        isExportedClean,
        badge: BADGE_DESCRIPTORS[badgeKind]
    };
}

export function checkIsUpdated(c: any, rec?: any): boolean {
    if (!c || !rec) return false;
    // Partial export records are never considered up-to-date so failed attachments can be retried on subsequent syncs
    const st = resolveConversationExportState(c, rec);
    return st.state === 'exported_partial' || st.hasNewerActivity;
}

export function resolveDetailTitle(
    messages: any[] | null | undefined,
    convId?: string | number
): { title: string; source: 'sniff' } | null {
    if (!Array.isArray(messages)) return null;
    const firstUser = messages.find(m => m && m.role === 'user' && m.content && String(m.content).trim());
    if (!firstUser) return null;
    const rawContent = String(firstUser.content).trim().slice(0, 60).replace(/\n+/g, ' ');
    const candidate = cleanTitle(rawContent);
    if (isRealTitle(candidate, convId)) {
        return { title: candidate, source: 'sniff' };
    }
    return null;
}

export default {
    isRealTitle,
    cleanTitle,
    cleanZeroWidth,
    isBrandPlaceholderTitle,
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
    TITLE_SOURCE_PRIORITY,
    TITLE_TIER_RANK
};

