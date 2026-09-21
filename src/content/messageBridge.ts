// src/content/messageBridge.ts - Inter-world message bridge between MAIN world hooks and content script
import { contentContext } from './contentContext.js';
import { GeminiResponseParserClass } from '../core/api/geminiParser.js';
import { GeminiProtocol, CrossWorldEvents } from '../core/protocol/protocol.js';
import { StorageService } from '../core/storage/storageService.js';

export interface MessageBridgeDeps {
    upsertConversations?: (items: any[], source: string, forceWrite?: boolean, targetSlot?: string) => Promise<number>;
    touchActiveConversation?: (cid: string, slot?: string, options?: { forceWrite?: boolean; source?: string }) => Promise<number>;
    extractActiveChatTitle?: (id: string) => { title: string; source: string } | null;
    getAccountSlot?: () => string;
    isRealTitle?: (t: string, id: string) => boolean;
    cleanTitle?: (t: string) => string;
    updateBadge?: (mergedLen: number, visible?: number) => void;
    ensureBadge?: () => HTMLElement | null;
    Storage?: any;
    protocol?: any;
    onStreamStart?: (cid?: string | null, slot?: string) => void;
    onStreamComplete?: (cid?: string | null, slot?: string) => void;
}

let _deps: MessageBridgeDeps | null = null;
let _listening = false;

export function init(dependencies: MessageBridgeDeps = {}): { handleWindowMessage: (event: MessageEvent) => Promise<void> } {
    _deps = dependencies;
    if (!_listening && typeof window !== 'undefined' && window.addEventListener) {
        window.addEventListener('message', handleWindowMessage);
        _listening = true;
    }
    return { handleWindowMessage };
}

export async function handleWindowMessage(event: MessageEvent): Promise<void> {
    if (!event || !_deps) return;
    if (typeof location !== 'undefined' && event.origin !== location.origin) return;
    // Same-origin iframes can postMessage forged payloads (e.g. conversation
    // deletion) into this window; only accept events raised by this window
    // itself. Synthetic dispatches (unit tests) carry no source and still pass.
    if (event.source && (typeof window === 'undefined' || event.source !== window)) return;
    const d = event.data;
    if (!d || typeof d !== 'object') return;

    const {
        upsertConversations,
        getAccountSlot,
        isRealTitle = () => true,
        cleanTitle = (t: string) => (t || '').trim(),
        updateBadge,
        ensureBadge,
        Storage = (typeof StorageService !== 'undefined' ? StorageService : null)
    } = _deps;

    // 1. Captured batchexecute response (Sidebar scroll, search, page load, opening any chat)
    if (d.type === CrossWorldEvents.NETWORK_BATCHEXECUTE) {
        const { text, slot } = d.payload || {};
        if (!text) return;
        try {
            const parser = (typeof GeminiResponseParserClass !== 'undefined' ? GeminiResponseParserClass : null)
                || ((typeof globalThis !== 'undefined' ? (globalThis as any).GeminiResponseParserClass : null) || null);
            if (!parser) return;
            const Proto = (_deps && _deps.protocol) || (typeof GeminiProtocol !== 'undefined' ? GeminiProtocol : ((typeof window !== 'undefined' && (window as any).GeminiProtocol) || null));
            if (!Proto) return;

            // If response contains conversation list (sidebar scroll or search)
            if (text.includes(Proto.RPCS.LIST) && typeof upsertConversations === 'function') {
                try {
                    const listRes = parser.parseList(text);
                    if (listRes && listRes.conversations && listRes.conversations.length) {
                        const targetSlot = slot || (getAccountSlot ? getAccountSlot() : 'u0');
                        await upsertConversations(listRes.conversations, 'network-list', false, targetSlot);
                    }
                } catch (e) {
                    if (contentContext.isDevMode()) console.debug('[MessageBridge] parseList err', e);
                }
            }

            // If response contains conversation detail (opening any chat)
            if (text.includes(Proto.RPCS.DETAIL) && typeof upsertConversations === 'function') {
                try {
                    const detailRes = parser.parseDetail(text);
                    if (detailRes && detailRes.id) {
                        const nid = String(detailRes.id).replace(/^c_/, '').trim();
                        let title = cleanTitle(detailRes.title);
                        let sourceTier = detailRes.titleSource || 'rpc';
                        if (!isRealTitle(title, nid) && Array.isArray(detailRes.messages)) {
                            const firstUser = detailRes.messages.find((m: any) => m.role === 'user' && m.content && m.content.trim());
                            if (firstUser) {
                                const candidate = cleanTitle(firstUser.content.trim().slice(0, 60).replace(/\n+/g, ' '));
                                if (isRealTitle(candidate, nid)) {
                                    title = candidate;
                                    sourceTier = 'sniff';
                                }
                            }
                        }
                        if (isRealTitle(title, nid)) {
                            const titlesObj = detailRes.titles || {};
                            titlesObj[sourceTier] = title;
                            const targetSlot = slot || (getAccountSlot ? getAccountSlot() : 'u0');
                            await upsertConversations([{
                                id: nid,
                                title: title,
                                titleSource: sourceTier,
                                titles: titlesObj,
                                url: `https://gemini.google.com/app/${nid}`,
                                href: `https://gemini.google.com/app/${nid}`,
                                timestamp: detailRes.updatedAt || detailRes.timestamp,
                                updatedAt: detailRes.updatedAt || detailRes.timestamp,
                                createdAt: detailRes.createdAt,
                                sidebarIndex: 0
                            }], 'network-detail', false, targetSlot);
                        }
                    }
                } catch (e) {
                    if (contentContext.isDevMode()) console.debug('[MessageBridge] parseDetail err', e);
                }
            }
        } catch (err) {
            if (contentContext.isDevMode()) console.debug('[MessageBridge] batchexecute hook process error', err);
        }
        return;
    }

    // 2. Real-time conversation deletion hook listener (GzXR5e)
    if (d.type === CrossWorldEvents.CONVERSATION_DELETED) {
        const { id, slot } = d.payload || {};
        if (id) {
            try {
                const targetSlot = slot || (getAccountSlot ? getAccountSlot() : 'u0') || 'u0';
                if (Storage && typeof Storage.removeConversation === 'function') {
                    const removed = await Storage.removeConversation(targetSlot, id);
                    if (removed) {
                        const updatedList = await Storage.getConversations(targetSlot);
                        if (updateBadge) updateBadge(updatedList.length, 0);
                        try {
                            if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
                                chrome.runtime.sendMessage({
                                    action: 'syncUpdate',
                                    slot: targetSlot,
                                    count: updatedList.length,
                                    from: 'delete-event'
                                });
                            }
                        } catch (e) {
                            if (contentContext.isDevMode()) console.debug('[MessageBridge]', e);
                        }
                        if (contentContext.isDevMode()) {
                            console.log(`[MessageBridge] Realtime pruned deleted conversation ${id} from slot ${targetSlot}`);
                        }
                    }
                }
            } catch (err) {
                if (contentContext.isDevMode()) console.debug('[MessageBridge] remove deleted conversation err', err);
            }
        }
        return;
    }

    // 3. In-page live auto-save trigger
    if (d.type === CrossWorldEvents.LIVE_SAVE_TRIGGER) {
        const { cid, reason, ...options } = d.payload || {};
        if (cid) {
            try {
                const coordinator = (typeof globalThis !== 'undefined' && (globalThis as any).LiveSaveCoordinator);
                if (coordinator && typeof coordinator.executeLiveSave === 'function') {
                    await coordinator.executeLiveSave(cid, reason || 'turn_complete', options);
                }
            } catch (err) {
                if (contentContext.isDevMode()) console.debug('[MessageBridge] live save trigger err', err);
            }
        }
        return;
    }

    // 4. Streaming generation lifecycle hooks (RPC / StreamGenerate)
    if (d.type === CrossWorldEvents.STREAM_START) {
        const { id, slot } = d.payload || {};
        if (typeof (_deps as any)?.onStreamStart === 'function') {
            (_deps as any).onStreamStart(id, slot);
        } else {
            const obs = (typeof globalThis !== 'undefined' && (globalThis as any).LiveSaveObserver);
            if (obs && typeof obs.notifyStreamStart === 'function') {
                obs.notifyStreamStart(id);
            }
        }
        const activeId = id || (typeof location !== 'undefined' && location.pathname.match(/\/app\/(c_)?([A-Za-z0-9_-]{8,})/)?.[2]) || null;
        if (activeId) {
            const nid = String(activeId).replace(/^c_/, '').trim();
            const targetSlot = slot || (getAccountSlot ? getAccountSlot() : 'u0') || 'u0';
            try {
                if (typeof (_deps as any)?.touchActiveConversation === 'function') {
                    await (_deps as any).touchActiveConversation(nid, targetSlot, { source: 'stream-start' });
                } else if (typeof upsertConversations === 'function') {
                    const now = Date.now();
                    await upsertConversations([{
                        id: nid,
                        url: `https://gemini.google.com/app/${nid}`,
                        href: `https://gemini.google.com/app/${nid}`,
                        timestamp: now,
                        updatedAt: now,
                        sidebarIndex: 0
                    }], 'stream-start', true, targetSlot);
                }
            } catch (err) {
                if (contentContext.isDevMode()) console.debug('[MessageBridge] stream start touch err', err);
            }
        }
        return;
    }

    if (d.type === CrossWorldEvents.STREAM_COMPLETE) {
        const { id, slot } = d.payload || {};
        if (typeof (_deps as any)?.onStreamComplete === 'function') {
            (_deps as any).onStreamComplete(id, slot);
        } else {
            const obs = (typeof globalThis !== 'undefined' && (globalThis as any).LiveSaveObserver);
            if (obs && typeof obs.notifyStreamComplete === 'function') {
                obs.notifyStreamComplete(id);
            }
        }
        const activeId = id || (typeof location !== 'undefined' && location.pathname.match(/\/app\/(c_)?([A-Za-z0-9_-]{8,})/)?.[2]) || null;
        if (activeId) {
            const nid = String(activeId).replace(/^c_/, '').trim();
            const targetSlot = slot || (getAccountSlot ? getAccountSlot() : 'u0') || 'u0';
            try {
                if (typeof (_deps as any)?.touchActiveConversation === 'function') {
                    await (_deps as any).touchActiveConversation(nid, targetSlot, { source: 'stream-complete' });
                } else if (typeof upsertConversations === 'function') {
                    const now = Date.now();
                    const item: any = {
                        id: nid,
                        url: `https://gemini.google.com/app/${nid}`,
                        href: `https://gemini.google.com/app/${nid}`,
                        timestamp: now,
                        updatedAt: now,
                        sidebarIndex: 0
                    };
                    if (typeof (_deps as any)?.extractActiveChatTitle === 'function') {
                        const titleObj = (_deps as any).extractActiveChatTitle(nid);
                        if (titleObj && titleObj.title && isRealTitle(titleObj.title, nid)) {
                            item.title = cleanTitle(titleObj.title);
                            item.titleSource = titleObj.source || 'dom';
                            item.titles = { [item.titleSource]: item.title };
                        }
                    }
                    await upsertConversations([item], 'stream-complete', true, targetSlot);
                }
            } catch (err) {
                if (contentContext.isDevMode()) console.debug('[MessageBridge] stream complete touch err', err);
            }
        }
        return;
    }
}

export const MessageBridge = {
    init,
    handleWindowMessage
};

(MessageBridge as any).MessageBridge = MessageBridge;
(MessageBridge as any).default = MessageBridge;

if (typeof globalThis !== 'undefined') {
    (globalThis as any).MessageBridge = MessageBridge;
}
if (typeof module !== 'undefined' && (module as any).exports) {
    (module as any).exports = MessageBridge;
}

export default MessageBridge;
