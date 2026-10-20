import { contentContext } from './contentContext.js';
import { GeminiResponseParserClass } from '../core/api/geminiParser.js';
import { GeminiProtocol, CrossWorldEvents } from '../core/protocol/protocol.js';
import { LiveSaveObserver } from './liveSaveObserver.js';
import { extractConversationIdFromUrl, normId } from '../core/utils/pathUtils.js';
import { TITLE_TIER_RANK, resolveDetailTitle, normalizeReliableTitleSource } from '../core/utils/titleUtils.js';
import type { TitleSource } from '../types/index.js';
import { registerCleanup } from './cleanupRegistry.js';
import type {
    GeminiNetworkBatchexecutePayload,
    GeminiConversationDeletedPayload,
    GeminiStreamStartPayload,
    GeminiStreamCompletePayload
} from '../core/protocol/events.js';

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

export function init(dependencies: MessageBridgeDeps = {}): { handleWindowMessage: (event: MessageEvent) => Promise<void> } {
    _deps = dependencies;
    if (typeof window !== 'undefined' && window.addEventListener) {
        const w = window as any;
        // Guard on window to survive re-injection and register removal on cleanup
        if (!w.__gemExporterBridgeListening) {
            window.addEventListener('message', handleWindowMessage);
            w.__gemExporterBridgeListening = true;
        }
        registerCleanup(() => {
            try { window.removeEventListener('message', handleWindowMessage); } catch { /* already gone */ }
            w.__gemExporterBridgeListening = false;
        });
    }
    return { handleWindowMessage };
}

export async function handleWindowMessage(event: MessageEvent): Promise<void> {
    if (!event || !_deps) return;
    if (typeof location !== 'undefined' && event.origin !== location.origin) return;
    // Restrict to same-window messages (does NOT authenticate the sender against page scripts).
    if (event.source && (typeof window === 'undefined' || event.source !== window)) return;
    const d = event.data;
    if (!d || typeof d !== 'object') return;

    const {
        upsertConversations,
        getAccountSlot,
        isRealTitle = () => true,
        cleanTitle = (t: string) => (t || '').trim()
    } = _deps;

    if (d.type === CrossWorldEvents.NETWORK_BATCHEXECUTE) {
        const { text, slot } = (d.payload || {}) as Partial<GeminiNetworkBatchexecutePayload>;
        if (!text) return;
        try {
            const parser = GeminiResponseParserClass;
            if (!parser) return;
            const Proto = (_deps && _deps.protocol) || GeminiProtocol;
            if (!Proto) return;

            if (text.includes(Proto.RPCS.LIST)) {
                try {
                    const listRes = parser.parseList(text);
                    if (listRes && listRes.conversations && listRes.conversations.length) {
                        const targetSlot = slot || (getAccountSlot ? getAccountSlot() : 'u0');
                        // Phase A (P1-3): 嗅探是数据面 —— 直写存储，不进 scan slice、不推进
                        // checkpoint。forceWrite=true 沿用此前经 ingestListBatch 的实际写语义。
                        if (typeof upsertConversations === 'function') {
                            await upsertConversations(listRes.conversations, 'network-list', true, targetSlot);
                        }
                    }
                } catch (e) {
                    if (contentContext.isDevMode()) console.debug('[MessageBridge] parseList err', e);
                }
            }

            if (text.includes(Proto.RPCS.DETAIL) && typeof upsertConversations === 'function') {
                try {
                    const detailRes = parser.parseDetail(text);
                    if (detailRes && detailRes.id) {
                        const nid = normId(detailRes.id);
                        let title = cleanTitle(detailRes.title);
                        let sourceTier = detailRes.titleSource || 'rpc';
                        if (!isRealTitle(title, nid) && Array.isArray(detailRes.messages)) {
                            const sniffed = resolveDetailTitle(detailRes.messages, nid);
                            if (sniffed) {
                                title = sniffed.title;
                                sourceTier = sniffed.source;
                            }
                        }
                        let titlesObj = detailRes.titles || {};
                        const targetSlot = slot || (getAccountSlot ? getAccountSlot() : 'u0');

                        if (isRealTitle(title, nid)) {
                            titlesObj[sourceTier] = title;
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

    if (d.type === CrossWorldEvents.CONVERSATION_DELETED) {
        const { id } = (d.payload || {}) as Partial<GeminiConversationDeletedPayload>;
        const isValidConvId = typeof id === 'string' && id.trim().length > 0 && id.trim().length <= 128 && /^[a-zA-Z0-9_\-]+$/.test(id.trim());
        if (id && isValidConvId) {
            const cleanId = id.trim();
            try {
                // Route verification through the account of this content tab,
                // never through a slot supplied by page-world JavaScript.
                const targetSlot = (getAccountSlot ? getAccountSlot() : 'u0') || 'u0';
                // Page-world postMessage is untrusted. The detail route only
                // prunes after an authoritative server "confirmed_deleted" RPC.
                if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
                    for (const delayMs of [0, 500, 1500]) {
                        if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
                        try {
                            const result = await chrome.runtime.sendMessage({ action: 'fetchChat', conversationId: cleanId, accountSlot: targetSlot });
                            if (result?.data?.isDeleted === true) break;
                        } catch (err) {
                            if (contentContext.isDevMode()) console.debug('[MessageBridge] delete verification attempt failed', err);
                        }
                    }
                }
            } catch (err) {
                if (contentContext.isDevMode()) console.debug('[MessageBridge] verify deleted conversation err', err);
            }
        }
        return;
    }

    if (d.type === CrossWorldEvents.STREAM_START) {
        const { id, slot } = (d.payload || {}) as Partial<GeminiStreamStartPayload>;
        if (typeof (_deps as any)?.onStreamStart === 'function') {
            (_deps as any).onStreamStart(id, slot);
        } else {
            const obs = LiveSaveObserver;
            if (obs && typeof obs.notifyStreamStart === 'function') {
                obs.notifyStreamStart(id);
            }
        }
        const activeId = id ? normId(id) : (typeof location !== 'undefined' ? extractConversationIdFromUrl(location.pathname) : null);
        if (activeId) {
            const nid = activeId;
            const targetSlot = slot || (getAccountSlot ? getAccountSlot() : 'u0') || 'u0';
            try {
                if (typeof (_deps as any)?.touchActiveConversation === 'function') {
                    await (_deps as any).touchActiveConversation(nid, targetSlot, { source: 'stream-start' });
                } else if (typeof upsertConversations === 'function') {
                    // SSOT timestamp authority: no client-clock timestamp here;
                    // timestamp/updatedAt are server-authoritative (see
                    // touchActiveConversation in syncEngine.ts).
                    await upsertConversations([{
                        id: nid,
                        url: `https://gemini.google.com/app/${nid}`,
                        href: `https://gemini.google.com/app/${nid}`,
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
        const { id, slot } = (d.payload || {}) as Partial<GeminiStreamCompletePayload>;
        if (typeof (_deps as any)?.onStreamComplete === 'function') {
            (_deps as any).onStreamComplete(id, slot);
        } else {
            const obs = LiveSaveObserver;
            if (obs && typeof obs.notifyStreamComplete === 'function') {
                obs.notifyStreamComplete(id);
            }
        }
        const activeId = id ? normId(id) : (typeof location !== 'undefined' ? extractConversationIdFromUrl(location.pathname) : null);
        if (activeId) {
            const nid = activeId;
            const targetSlot = slot || (getAccountSlot ? getAccountSlot() : 'u0') || 'u0';
            try {
                if (typeof (_deps as any)?.touchActiveConversation === 'function') {
                    await (_deps as any).touchActiveConversation(nid, targetSlot, { source: 'stream-complete' });
                } else if (typeof upsertConversations === 'function') {
                    // SSOT timestamp authority: no client-clock timestamp here;
                    // timestamp/updatedAt are server-authoritative (see
                    // touchActiveConversation in syncEngine.ts).
                    const item: any = {
                        id: nid,
                        url: `https://gemini.google.com/app/${nid}`,
                        href: `https://gemini.google.com/app/${nid}`,
                        sidebarIndex: 0
                    };
                    if (typeof (_deps as any)?.extractActiveChatTitle === 'function') {
                        const titleObj = (_deps as any).extractActiveChatTitle(nid);
                        if (titleObj && titleObj.title && isRealTitle(titleObj.title, nid)) {
                            item.title = cleanTitle(titleObj.title);
                            const sourceTier = normalizeReliableTitleSource(titleObj.source) || 'dom';
                            item.titleSource = sourceTier;
                            item.titles = { [sourceTier]: item.title };
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

export default MessageBridge;
