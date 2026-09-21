/**
 * src/core/utils/titleUtils.ts
 * Conversation title arbitration, sanitization, and priority ordering.
 */

import type { Conversation } from '../../types/index.js';

export interface TitleResolution {
    title: string;
    source: string;
}

const RESEARCH_PROMPT_PREFIX_RE = /^(?:我已经完成了研究|我拟定了一个研究方案|I've completed your research|Here is a research plan)/i;

export const TITLE_SOURCE_PRIORITY: string[] = ['rpc', 'dom', 'takeout', 'sniff', 'legacy', 'default'];

/**
 * Determine if a title is a real, meaningful conversation title
 * (not a placeholder, ID, or auto-generated default).
 */
export function isRealTitle(title?: string | null, id?: string | number): boolean {
    if (!title || typeof title !== 'string') return false;
    let t = title.trim();
    if (!t || t.length < 2) return false;
    if (t === 'Untitled' || t === '未命名' || t === 'New chat' || t === '新对话') return false;
    if (id) {
        let cleanId = String(id).replace(/^c_/, '').trim();
        let cleanT = t.replace(/^c_/, '').trim();
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

/**
 * Clean conversation title by removing brand suffixes and prefixes
 */
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

    // 1. Traverse tiered title slots in priority order
    if (chat.titles && typeof chat.titles === 'object') {
        for (const source of TITLE_SOURCE_PRIORITY) {
            if (source === 'legacy' || source === 'default') continue;
            const raw = chat.titles[source];
            if (!raw) continue;
            const clean = cleanTitle(raw);
            if (clean && isRealTitle(clean, id)) {
                return { title: clean, source: source };
            }
        }
    }

    // 2. Legacy fallback to chat.title
    const legacyClean = cleanTitle(chat.title);
    if (legacyClean && isRealTitle(legacyClean, id)) {
        return { title: legacyClean, source: chat.titleSource || 'legacy' };
    }

    // 3. Fallback to Takeout Prompt if present in chat.titles
    if (chat.titles && chat.titles.takeout) {
        const rawTakeout = cleanTitle(chat.titles.takeout);
        if (rawTakeout) return { title: rawTakeout, source: 'takeout' };
    }

    return { title: '未命名对话', source: 'default' };
}

/**
 * Set a title into a specific source tier slot without destroying other tiers.
 */
export function setTitleBySource(chat: any, source?: string, rawTitle?: string): TitleResolution {
    if (!chat) return { title: '未命名对话', source: 'default' };
    chat.titles = (chat.titles && typeof chat.titles === 'object') ? chat.titles : {};
    const cleaned = cleanTitle(rawTitle);
    if (cleaned && isRealTitle(cleaned, chat.id)) {
        if (source) chat.titles[source as string] = cleaned;
    } else if (source === 'takeout' && cleaned) {
        if (source) chat.titles[source as string] = cleaned;
    }
    const resolved = resolveTitle(chat);
    chat.title = resolved.title;
    chat.titleSource = resolved.source;
    return resolved;
}

/**
 * Get the authoritative effective timestamp (milliseconds) of a conversation.
 */
export function getEffectiveTimestamp(chat?: Partial<Conversation> | null): number {
    if (!chat || typeof chat !== 'object') return 0;
    const candidates = [chat.updatedAt, chat.timestamp, (chat as any).chatTime, chat.createdAt, (chat as any).lastSeen];
    for (const raw of candidates) {
        if (raw === null || raw === undefined) continue;
        let ms = (typeof raw === 'string') ? new Date(raw).getTime() : Number(raw);
        if (Number.isFinite(ms) && ms > 0) {
            return ms;
        }
    }
    return 0;
}

/**
 * Authoritative conversation comparator for consistent ordering across UI and background sync.
 */
export function compareConversations(a?: any, b?: any): number {
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
        lsA = (typeof a.lastSeen === 'string') ? new Date(a.lastSeen).getTime() : Number(a.lastSeen);
        if (!Number.isFinite(lsA)) lsA = 0;
    }
    let lsB = 0;
    if (b.lastSeen) {
        lsB = (typeof b.lastSeen === 'string') ? new Date(b.lastSeen).getTime() : Number(b.lastSeen);
        if (!Number.isFinite(lsB)) lsB = 0;
    }
    return lsB - lsA;
}

export default {
    isRealTitle,
    cleanTitle,
    resolveTitle,
    setTitleBySource,
    getEffectiveTimestamp,
    compareConversations,
    TITLE_SOURCE_PRIORITY
};
