// src/content/messageRouter.ts - Content script runtime message dispatcher & RPC handlers
import { SyncEngine } from './syncEngine.js';
import { DomScraper } from './domScraper.js';
import { AssetFetcher } from './assetFetcher.js';
import { contentContext } from './contentContext.js';
import { StorageService } from '../core/storage/storageService.js';
import { GeminiUtils, getErrorMessage } from '../core/utils/utils.js';

export interface MessageRouterDeps {
    syncEngine?: typeof SyncEngine;
    scraper?: typeof DomScraper;
    assets?: typeof AssetFetcher;
    storage?: any;
    utils?: any;
}

export function init({
    syncEngine = SyncEngine,
    scraper = DomScraper,
    assets = AssetFetcher,
    storage = (typeof StorageService !== 'undefined' ? StorageService : null),
    utils = (typeof GeminiUtils !== 'undefined' ? GeminiUtils : null)
}: MessageRouterDeps = {}): void {
    const Sync = syncEngine;
    const Scraper = scraper;
    const Assets = assets;
    const Storage = storage;
    const Utils = utils;

    const cleanTitle = (t?: string | null) => (Utils?.cleanTitle ? Utils.cleanTitle(t || '') : (t || '').trim());
    const isRealTitle = (t?: string | null, id?: string) => (Utils?.isRealTitle ? Utils.isRealTitle(t || '', id) : !!(t && String(t).trim().length > 1));
    const setTitleBySource = (it: any, src: string, val: string) => (Utils?.setTitleBySource ? Utils.setTitleBySource(it, src, val) : ((it.titles = it.titles || {})[src] = val));

    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.onMessage) return;

    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (msg.action === 'ping') {
            const ver = (typeof chrome !== 'undefined' && chrome.runtime?.getManifest?.()?.version) || (typeof __EXT_VERSION__ !== 'undefined' ? __EXT_VERSION__ : '1.4.3');
            sendResponse({
                ok: true,
                version: ver,
                ver: ver
            });
            return;
        }

        if (msg.action === 'deepScan') {
            (async () => {
                try {
                    let res: any = null;
                    if (Sync && Sync.tryBatchExecuteFull) {
                        res = await Sync.tryBatchExecuteFull({
                            forceIncremental: msg.mode === 'incremental',
                            forceFull: msg.mode === 'full'
                        });
                    }
                    sendResponse({
                        success: true,
                        count: res?.count || 0,
                        diagnostics: res?.diagnostics,
                        hitGoogleLimit: !!(res?.hitGoogleLimit || res?.diagnostics?.hitGoogleLimit)
                    });
                } catch (e: unknown) {
                    const errStr = getErrorMessage(e);
                    const isLimit = errStr.includes('BardErrorInfo')
                        || errStr.includes('1096')
                        || errStr.includes('429')
                        || /quota|rate\s*limit|resource_exhausted|too\s*many\s*requests/i.test(errStr);
                    sendResponse({ success: false, error: errStr, hitGoogleLimit: isLimit });
                }
            })();
            return true;
        }

        if (msg.action === 'stopDeepScan' || msg.action === 'abortSync') {
            contentContext.abort();
            // Static anchor for regression lock (tests/regression_p0.test.js)
            if (typeof window !== 'undefined') {
                const w = window as any;
                w.__gemExporterAborted = true;
                try { w.__gemExporterActiveClient && w.__gemExporterActiveClient.abort(); } catch { /* intentional: best-effort cleanup */ }
            }
            sendResponse({ ok: true, aborted: true });
            return true;
        }

        if (msg.action === 'getScrollContainer') {
            const c = Scraper ? Scraper.getScrollContainer() : null;
            sendResponse({
                found: !!c,
                tag: c?.tagName || null,
                id: c?.id || null,
                class: c?.className?.slice(0, 120) || null
            });
            return true;
        }

        if (msg.action === 'getConversationDetail') {
            const cid = msg.conversationId || msg.id;
            if (!cid) {
                sendResponse({ success: false, error: 'no id' });
                return true;
            }
            (async () => {
                async function persistDetailTitle(chatObj: any): Promise<void> {
                    if (!chatObj) return;
                    const normId = (id: string) => String(id || '').replace(/^c_/, '').trim();
                    const nid = normId(cid || chatObj.id);
                    chatObj.title = cleanTitle(chatObj.title);
                    let detectedSource = chatObj.titleSource || 'rpc';
                    if (!isRealTitle(chatObj.title, nid) && Array.isArray(chatObj.messages)) {
                        const firstUser = chatObj.messages.find((m: any) => m.role === 'user' && m.content && m.content.trim());
                        if (firstUser) {
                            const candidate = cleanTitle(firstUser.content.trim().slice(0, 60).replace(/\n+/g, ' '));
                            if (isRealTitle(candidate, nid)) {
                                chatObj.title = candidate;
                                detectedSource = 'sniff';
                            }
                        }
                    }
                    if (!isRealTitle(chatObj.title, nid)) return;
                    const slot = msg.accountSlot || (Sync && Sync.getAccountSlot ? Sync.getAccountSlot() : 'u0');
                    try {
                        if (Storage) {
                            const list = await Storage.getConversations(slot);
                            const item = list.find((c: any) => normId(c.id) === nid);
                            if (item) {
                                setTitleBySource(item, detectedSource, chatObj.title);
                                await Storage.setConversations(slot, list);
                            }
                        }
                    } catch (err) {
                        console.warn('[Gemini Exporter] persistDetailTitle error', err);
                    }
                }

                let batchexecuteEmptyDebug: any = null;
                try {
                    const ClientClass = (typeof GeminiAPIClient !== 'undefined' ? GeminiAPIClient : null) as any;
                    if (ClientClass) {
                        const client = new ClientClass();
                        const detail = await client.getConversationDetail(cid, msg.targetSid || null);
                        if (detail && Array.isArray(detail.messages) && detail.messages.length > 0) {
                            await persistDetailTitle(detail);
                            sendResponse({ success: true, data: detail, source: 'batchexecute' });
                            return;
                        } else if (detail) {
                            const rawKeys = detail._raw ? Object.keys(detail._raw) : [];
                            const rawPreview = detail._raw ? JSON.stringify(detail._raw).slice(0, 4000) : '';
                            const topPreview = detail._raw ? JSON.stringify(detail).slice(0, 1000) : '';
                            batchexecuteEmptyDebug = { rawKeys, rawPreview, topPreview, messagesLen: detail.messages?.length, hasRaw: !!detail._raw, titleSeen: detail.title };
                            if (contentContext.isDevMode()) {
                                console.warn('[Gemini Exporter] batchexecute returned empty messages, fallback to DOM', cid, batchexecuteEmptyDebug);
                            }
                        }
                    }
                } catch (e: unknown) {
                    const errMsg = getErrorMessage(e);
                    batchexecuteEmptyDebug = { error: errMsg };
                    if (contentContext.isDevMode()) {
                        console.warn('[Gemini Exporter] batchexecute detail fail, fallback to DOM', errMsg);
                    }
                }
                try {
                    if (Scraper) {
                        const chat = await Scraper.contentFetchChatDetail(cid);
                        if (chat && Array.isArray(chat.messages) && chat.messages.length > 0) {
                            await persistDetailTitle(chat);
                            sendResponse({ success: true, data: chat, source: 'dom' });
                            return;
                        } else {
                            if (contentContext.isDevMode()) {
                                console.warn('[Gemini Exporter] DOM fallback returned empty messages', cid, 'messages', chat?.messages?.length, 'has _raw', !!chat?._raw);
                            }
                            const isConfirmedDeleted = !!chat?.isDeleted || !!chat?._debug?.isNotFound;
                            if (isConfirmedDeleted) {
                                const slot = msg.accountSlot || (Sync && Sync.getAccountSlot ? Sync.getAccountSlot() : 'u0');
                                try {
                                    if (Storage && typeof Storage.removeConversation === 'function') {
                                        await Storage.removeConversation(slot, cid);
                                        const updatedList = await Storage.getConversations(slot);
                                        if (Sync && Sync.updateBadge) {
                                            Sync.updateBadge(updatedList.length, 0);
                                        }
                                        try {
                                            chrome.runtime.sendMessage({
                                                action: 'syncUpdate',
                                                slot,
                                                count: updatedList.length,
                                                from: 'prune-dead-chat'
                                            });
                                        } catch (e) {
                                            if (contentContext.isDevMode()) console.debug('[GemExporter:messageRouter]', e);
                                        }
                                    }
                                } catch (e) {
                                    if (contentContext.isDevMode()) console.debug('[GemExporter:messageRouter]', e);
                                }
                            }
                            const mergedDebug = { batchexecuteEmptyDebug, domDebug: chat?._debug || null, domHtmlLen: chat?._debug?.htmlLen || null, isDeleted: isConfirmedDeleted };
                            sendResponse({ success: true, data: { ...chat, _empty: true, isDeleted: isConfirmedDeleted, error: isConfirmedDeleted ? '云端会话已被删除或不存在' : (chat?.error || 'DOM 返回内容为空'), _debug: mergedDebug, _debug_dom_empty: true }, source: 'dom' });
                            return;
                        }
                    }
                } catch (e: unknown) {
                    const errMsg = getErrorMessage(e);
                    const mergedDebug = { batchexecuteEmptyDebug, domError: errMsg };
                    sendResponse({ success: false, error: errMsg, _debug: mergedDebug });
                }
            })();
            return true;
        }

        if (msg.action === 'getFileBlob') {
            if (Assets) Assets.handleGetFileBlob(msg, sendResponse);
            else sendResponse({ success: false, error: 'AssetFetcher not loaded' });
            return true;
        }

        if (msg.action === 'getImageBlob') {
            if (Assets) Assets.handleGetImageBlob(msg, sendResponse);
            else sendResponse({ success: false, error: 'AssetFetcher not loaded' });
            return true;
        }

        if (msg.action === 'downloadAssetDirect') {
            if (Assets) Assets.downloadAssetDirect(msg, sendResponse);
            else sendResponse({ success: false, error: 'AssetFetcher not loaded' });
            return true;
        }

        // Unknown action: structured error instead of port closed
        try { sendResponse({ ok: false, error: `unknown action: ${msg.action}` }); } catch {}
    });
}

export const MessageRouter = {
    init
};


(MessageRouter as any).MessageRouter = MessageRouter;
(MessageRouter as any).default = MessageRouter;

if (typeof globalThis !== 'undefined') {
    (globalThis as any).MessageRouter = MessageRouter;
}
if (typeof module !== 'undefined' && (module as any).exports) {
    (module as any).exports = MessageRouter;
}

export default MessageRouter;
