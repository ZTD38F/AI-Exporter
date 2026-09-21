// src/ui/views/listView.ts - List rendering, no storage
import type { Conversation } from '../../types/conversation.js';
import type { ExportRecord, IListView } from '../../types/ui.js';

import GeminiUtils, {
    isRealTitle as utilsIsRealTitle,
    cleanTitle as utilsCleanTitle,
    resolveTitle as utilsResolveTitle,
    getEffectiveTimestamp as utilsGetEffectiveTimestamp
} from '../../core/utils/utils.js';

function $(id: string): HTMLElement | null {
    return document.getElementById(id);
}

const t = (key: string, ...args: any[]): string => {
    if (typeof I18n !== 'undefined' && I18n.t) {
        return I18n.t(key, ...args);
    }
    return key;
};

export const isRealTitle = (title?: string | null, id?: string | null): boolean => {
    if (typeof (globalThis as any).GeminiUtils?.isRealTitle === 'function') {
        return (globalThis as any).GeminiUtils.isRealTitle(title as unknown as string, id as unknown as string);
    }
    return utilsIsRealTitle(title, id || undefined);
};

export const cleanTitle = (tStr?: string | null): string => {
    if (typeof (globalThis as any).GeminiUtils?.cleanTitle === 'function') {
        return (globalThis as any).GeminiUtils.cleanTitle(tStr);
    }
    return utilsCleanTitle(tStr);
};

export const resolveTitle = (chat: any): { title: string; source: string } => {
    if (typeof (globalThis as any).GeminiUtils?.resolveTitle === 'function') {
        return (globalThis as any).GeminiUtils.resolveTitle(chat);
    }
    return utilsResolveTitle(chat);
};

export const getEffectiveTimestamp = (chat?: any): number => {
    if (typeof (globalThis as any).GeminiUtils?.getEffectiveTimestamp === 'function') {
        return (globalThis as any).GeminiUtils.getEffectiveTimestamp(chat);
    }
    return utilsGetEffectiveTimestamp(chat);
};

export function checkIsUpdated(c: any, rec?: ExportRecord | null): boolean {
    if (!c || !rec) return false;
    try {
        const cTs = getEffectiveTimestamp(c) || (c.updatedAt ? new Date(c.updatedAt).getTime() : 0) || (c.timestamp ? new Date(c.timestamp).getTime() : 0);
        const rTs = rec.exportedAt ? (typeof rec.exportedAt === 'string' ? new Date(rec.exportedAt).getTime() : Number(rec.exportedAt)) : 0;
        const rChatTime = (rec as any).chatTime ? (typeof (rec as any).chatTime === 'string' ? new Date((rec as any).chatTime).getTime() : Number((rec as any).chatTime)) : 0;

        // Check message count increase if both records have message counts
        const curMsgCount = c.messageCount || (Array.isArray(c.messages) ? c.messages.length : 0);
        const recMsgCount = (rec as any).messageCount || 0;
        if (curMsgCount > 0 && recMsgCount > 0 && curMsgCount > recMsgCount) {
            return true;
        }

        // Timestamp check with a 2000ms grace buffer for clock skew / write latency
        if (cTs > 0 && rChatTime > 0 && cTs > rChatTime + 2000) {
            return true;
        }
        if (cTs > 0 && rTs > 0 && cTs > rTs + 2000) {
            return true;
        }
    } catch {
        /* intentional */
    }
    return false;
}

function escapeHtml(str?: string | null): string {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

let onDeleteCallback: ((chatId: string) => void) | null = null;
export function setOnDelete(cb: (chatId: string) => void): void {
    onDeleteCallback = cb;
}

let currentConversationsRef: Conversation[] = [];
let currentOnDeleteChatRef: ((chatId: string) => void) | null = null;

function ensureListDelegation(list: HTMLElement & { _delegated?: boolean }): void {
    if (!list || list._delegated) return;
    list._delegated = true;

    list.addEventListener('click', (e: MouseEvent) => {
        const target = e.target as HTMLElement;
        if (target.closest('a.open-link')) {
            e.stopPropagation();
            return;
        }

        // If clicking directly on checkbox, let native toggle proceed and updateStat
        if (target.matches('input[type=checkbox]')) {
            return;
        }

        // Clicking anywhere else in the item row toggles selection
        const item = target.closest('.item') as HTMLElement | null;
        if (item) {
            const cb = item.querySelector('input[type=checkbox]') as HTMLInputElement | null;
            if (cb) {
                cb.checked = !cb.checked;
                cb.dispatchEvent(new Event('change', { bubbles: true }));
            }
        }
    });

    list.addEventListener('change', (e: Event) => {
        const target = e.target as HTMLElement;
        if (target.matches('input[type=checkbox]')) {
            updateStat(currentConversationsRef);
        }
    });
}

export function render(
    conversations: Conversation[],
    exportedIds: Record<string, ExportRecord> = {},
    prevSelectedSet?: Set<string> | null,
    searchFilter: string = '',
    onDeleteChat?: (id: string) => void
): void {
    const list = $('list') as (HTMLElement & { _delegated?: boolean }) | null;
    if (!list) return;
    currentConversationsRef = conversations || [];
    currentOnDeleteChatRef = onDeleteChat || onDeleteCallback;
    ensureListDelegation(list);

    if (!conversations || !conversations.length) {
        list.innerHTML = `<div style="color:var(--muted); padding:16px; text-align:center; font-size:12px;">${typeof t === 'function' ? t('emptyList') : 'No conversations found.'}</div>`;
        return;
    }
    const q = (searchFilter || '').trim().toLowerCase();
    const filtered = q
        ? conversations.filter(c => (resolveTitle(c).title || '').toLowerCase().includes(q) || String(c.id || '').toLowerCase().includes(q))
        : conversations;
    if (!filtered.length) {
        list.innerHTML = `<div style="color:var(--muted); padding:16px; text-align:center; font-size:12px;">${typeof t === 'function' ? t('emptyList') : 'No matching conversations found.'}</div>`;
        return;
    }

    const expMap = exportedIds || {};
    const htmlArr: string[] = [];
    const idxMap = new Map(conversations.map((c, idx) => [c as object, idx] as const));

    filtered.forEach((c) => {
        const origIdx = idxMap.get(c as object) ?? -1;
        const nid = String(c.id || '').replace(/^c_/, '');
        const rec = expMap[c.id] || expMap['c_' + nid] || expMap[nid] || null;
        const isUpdated = checkIsUpdated(c, rec);
        let isChecked = false;
        if (prevSelectedSet instanceof Set) {
            isChecked = prevSelectedSet.has(c.id) || prevSelectedSet.has(nid) || prevSelectedSet.has('c_' + nid);
        } else {
            isChecked = !rec || isUpdated;
        }

        const resolved = resolveTitle(c);
        const displayTitle = escapeHtml(resolved.title);
        const isBad = !isRealTitle(resolved.title, c.id);
        const titleStyle = isBad ? 'color:var(--warn); opacity:0.85;' : '';

        let dateStr = '';
        const effTs = getEffectiveTimestamp(c);
        const ts = effTs || (c as any).updatedAt || c.timestamp;
        if (ts) {
            try {
                const d = typeof ts === 'string' ? new Date(ts) : new Date(Number(ts));
                if (!isNaN(d.getTime())) {
                    dateStr = d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                }
            } catch { /* intentional */ }
        }

        let badgeHtml = '';
        if (rec) {
            let expDateStr = '';
            if (rec.exportedAt) {
                try {
                    const ed = typeof rec.exportedAt === 'string' ? new Date(rec.exportedAt) : new Date(Number(rec.exportedAt));
                    if (!isNaN(ed.getTime())) {
                        expDateStr = ed.toLocaleDateString();
                    }
                } catch { /* intentional */ }
            }
            if (isUpdated) {
                const badgeLabel = (typeof t === 'function' && (t('badgeUpdated') || t('badgeNeedsReexport'))) || 'Updated';
                badgeHtml = `<span class="badge badge-updated" style="font-size:10px; padding:2px 6px; border-radius:4px; background:rgba(245,158,11,0.15); color:#f59e0b; margin-left:8px; border:1px solid rgba(245,158,11,0.35);">${badgeLabel}${expDateStr ? ` (${expDateStr})` : ''}</span>`;
            } else {
                const badgeLabel = typeof t === 'function' ? t('badgeExported') : 'Exported';
                badgeHtml = `<span class="badge badge-exported" style="font-size:10px; padding:2px 6px; border-radius:4px; background:rgba(16,185,129,0.15); color:#10b981; margin-left:8px; border:1px solid rgba(16,185,129,0.3);">${badgeLabel}${expDateStr ? ` (${expDateStr})` : ''}</span>`;
            }
        }

        const url = (c as any).url || `https://gemini.google.com/app/${c.id}`;

        htmlArr.push(`
            <div class="item" data-chat-id="${escapeHtml(c.id)}" style="display:flex; align-items:center; padding:8px 12px; border-bottom:1px solid var(--border); font-size:13px; cursor:pointer; user-select:none;">
                <input type="checkbox" data-idx="${origIdx}" ${isChecked ? 'checked' : ''} style="margin-right:10px; cursor:pointer;" />
                <div style="flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
                    <span class="chat-title" style="${titleStyle}">${displayTitle}</span>
                    ${badgeHtml}
                </div>
                <span style="font-size:11px; color:var(--muted); margin-left:12px; white-space:nowrap;">${escapeHtml(dateStr)}</span>
                <a href="${escapeHtml(url)}" target="_blank" class="open-link" style="color:var(--muted); margin-left:10px; text-decoration:none; font-size:12px;" title="Open in Gemini">↗</a>
            </div>
        `);
    });

    list.innerHTML = htmlArr.join('');
}

export function updateItemExportStatus(chatId: string, exportRecord?: ExportRecord | null): void {
    if (!chatId || typeof document === 'undefined') return;
    const nid = String(chatId).replace(/^c_/, '');
    const item = (document.querySelector && (
        document.querySelector(`#list .item[data-chat-id="${nid}"]`)
        || document.querySelector(`.item[data-chat-id="${nid}"]`)
        || document.querySelector(`[data-chat-id="${chatId}"]`)
        || document.querySelector(`[data-chat-id="c_${nid}"]`)
        || document.querySelector(`[data-chat-id="${nid}"]`)
    ));
    if (!item) return;

    const bExported = (typeof I18n !== 'undefined' && I18n.t)
        ? I18n.t('badgeExported')
        : (typeof t === 'function' ? t('badgeExported') : 'Exported');
    const badgeText = (bExported && bExported !== 'badgeExported') ? bExported : 'Exported';

    let badge = item.querySelector ? item.querySelector('.badge') as HTMLElement | null : null;
    if (badge) {
        badge.className = 'badge badge-exported';
        badge.textContent = badgeText;
        if ((badge as HTMLElement).style) {
            (badge as HTMLElement).style.background = 'rgba(16,185,129,0.15)';
            (badge as HTMLElement).style.borderColor = 'rgba(16,185,129,0.3)';
            (badge as HTMLElement).style.color = '#10b981';
        }
    } else {
        const titleContainer = item.querySelector ? item.querySelector('div') : null;
        if (titleContainer && document.createElement) {
            const span = document.createElement('span');
            span.className = 'badge badge-exported';
            span.style.cssText = 'font-size:10px; padding:2px 6px; border-radius:4px; background:rgba(16,185,129,0.15); color:#10b981; margin-left:8px; border:1px solid rgba(16,185,129,0.3);';
            span.textContent = badgeText;
            titleContainer.appendChild(span);
        }
    }
}

export function updateStat(conversations?: Conversation[]): void {
    const list = $('list');
    if (!list || typeof document === 'undefined') return;
    const total = (conversations || currentConversationsRef || []).length;
    const checked = document.querySelectorAll('#list input[type=checkbox]:checked').length;
    const statEl = $('selectedStat') || $('stat');
    if (statEl) {
        statEl.textContent = typeof t === 'function' ? t('selectedStat', checked, total) : `${checked} of ${total} selected`;
    }
}

export function getSelected(conversations?: Conversation[]): Conversation[] {
    if (typeof document === 'undefined') return [];
    const convs = conversations || currentConversationsRef || [];
    const selected: Conversation[] = [];
    document.querySelectorAll('#list input[type=checkbox]:checked').forEach((cb) => {
        const item = typeof (cb as any).closest === 'function' ? ((cb as any).closest('.item') as HTMLElement | null) : null;
        const chatId = item?.dataset?.chatId;
        if (chatId) {
            const found = convs.find(c => c.id === chatId || String(c.id).replace(/^c_/, '') === String(chatId).replace(/^c_/, ''));
            if (found) {
                selected.push(found);
                return;
            }
        }
        const idx = parseInt((cb as HTMLElement).dataset.idx || '-1', 10);
        if (idx >= 0 && convs[idx]) {
            selected.push(convs[idx]);
        }
    });
    return selected;
}

export function getSelectedIds(): Set<string> {
    const ids = new Set<string>();
    if (typeof document === 'undefined') return ids;
    document.querySelectorAll('#list input[type=checkbox]:checked').forEach((cb) => {
        const item = cb.closest('.item') as HTMLElement | null;
        const chatId = item?.dataset?.chatId;
        if (chatId) ids.add(chatId);
    });
    return ids;
}

export function selectAll(conversations?: Conversation[]): void {
    if (typeof document === 'undefined') return;
    document.querySelectorAll('#list input[type=checkbox]').forEach((cb) => {
        (cb as HTMLInputElement).checked = true;
    });
    updateStat(conversations);
}

export function deselectAll(conversations?: Conversation[]): void {
    if (typeof document === 'undefined') return;
    document.querySelectorAll('#list input[type=checkbox]').forEach((cb) => {
        (cb as HTMLInputElement).checked = false;
    });
    updateStat(conversations);
}

export function selectUnexported(conversations?: Conversation[], exportedIds?: Record<string, ExportRecord>): void {
    if (typeof document === 'undefined') return;
    const convList = conversations || currentConversationsRef || [];
    const expMap = exportedIds || {};
    document.querySelectorAll('#list input[type=checkbox]').forEach((cb) => {
        const idx = parseInt((cb as HTMLElement).dataset.idx || '-1', 10);
        const c = convList[idx];
        if (!c) {
            (cb as HTMLInputElement).checked = false;
            return;
        }
        const nid = String(c.id || '').replace(/^c_/, '');
        const rec = expMap[c.id] || expMap['c_' + nid] || expMap[nid] || null;
        (cb as HTMLInputElement).checked = !rec;
    });
    updateStat(conversations);
}

export function selectNeedsUpdate(conversations?: Conversation[], exportedIds?: Record<string, ExportRecord>): void {
    if (typeof document === 'undefined') return;
    const convList = conversations || currentConversationsRef || [];
    const expMap = exportedIds || {};
    document.querySelectorAll('#list input[type=checkbox]').forEach((cb) => {
        const idx = parseInt((cb as HTMLElement).dataset.idx || '-1', 10);
        const c = convList[idx];
        if (!c) {
            (cb as HTMLInputElement).checked = false;
            return;
        }
        const nid = String(c.id || '').replace(/^c_/, '');
        const rec = expMap[c.id] || expMap['c_' + nid] || expMap[nid] || null;
        (cb as HTMLInputElement).checked = checkIsUpdated(c, rec);
    });
    updateStat(conversations);
}

export function selectByIds(targetIds: Set<string> | string[], conversations?: Conversation[]): void {
    if (typeof document === 'undefined') return;
    const idSet = new Set(Array.from(targetIds).map(id => String(id).replace(/^c_/, '')));
    document.querySelectorAll('#list input[type=checkbox]').forEach((cb) => {
        const item = cb.closest('.item') as HTMLElement | null;
        const chatId = item?.dataset?.chatId ? String(item.dataset.chatId).replace(/^c_/, '') : '';
        (cb as HTMLInputElement).checked = !!chatId && idSet.has(chatId);
    });
    updateStat(conversations || currentConversationsRef);
}

export const ListView: IListView = {
    render,
    updateStat,
    getSelected,
    getSelectedIds,
    selectAll,
    deselectAll,
    selectUnexported,
    selectNeedsUpdate,
    selectByIds,
    isRealTitle,
    setOnDelete,
    updateItemExportStatus,
    checkIsUpdated
};

(ListView as any).checkIsUpdated = checkIsUpdated;
(ListView as any).ListView = ListView;
(ListView as any).default = ListView;

if (typeof globalThis !== 'undefined') {
    (globalThis as any).ListView = ListView;
}
if (typeof module === 'object' && module.exports) {
    module.exports = ListView;
}

export default ListView;
