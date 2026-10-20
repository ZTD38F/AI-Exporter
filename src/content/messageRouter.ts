import { SyncEngine } from './syncEngine.js';
import { DomScraper } from './domScraper.js';
import { AssetFetcher } from './assetFetcher.js';
import { contentContext } from './contentContext.js';
import { StorageService } from '../core/storage/storageService.js';
import { GeminiUtils, getErrorMessage, resolveDetailTitle as defaultResolveDetailTitle } from '../core/utils/utils.js';
import { normId } from '../core/utils/pathUtils.js';
import { isRateLimited } from '../core/engine/export/rateLimiter.js';
import { isConfirmedDeletedError } from '../core/protocol/protocol.js';
import { getExtensionVersion } from '../core/utils/constants.js';
import { resolveProvider } from '../core/provider/providerResolver.js';
import { registerCleanup } from './cleanupRegistry.js';
import type { GetConversationDetailMessage } from '../types/messages.js';

// Only allow HTTPS URLs on Google media/content hosts before fetching assets.
function isAllowedAssetUrl(u: unknown): boolean {
    if (typeof u !== 'string' || !u) return false;
    let parsed: URL;
    try { parsed = new URL(u); } catch { return false; }
    if (parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    return /(^|\.)(googleusercontent\.com|gstatic\.com|googleapis\.com|google\.com)$/.test(host);
}

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
    storage = StorageService,
    utils = GeminiUtils
}: MessageRouterDeps = {}): void {
    const Sync = syncEngine;
    const Scraper = scraper;
    const Assets = assets;
    const Storage = storage;
    const Utils = utils;

    const cleanTitle = (t?: string | null) => (Utils?.cleanTitle ? Utils.cleanTitle(t || '') : (t || '').trim());
    const isRealTitle = (t?: string | null, id?: string) => (Utils?.isRealTitle ? Utils.isRealTitle(t || '', id) : !!(t && String(t).trim().length > 1));
    const setTitleBySource = (it: any, src: string, val: string) => {
        if (Utils?.setTitleBySource) return Utils.setTitleBySource(it, src, val);
        const rel = Utils?.normalizeReliableTitleSource ? Utils.normalizeReliableTitleSource(src) : undefined;
        if (rel && it) {
            (it.titles = it.titles || {})[rel] = val;
        }
    };
    const resolveDetailTitle = (msgs: any[], id?: string) => (Utils?.resolveDetailTitle ? Utils.resolveDetailTitle(msgs, id) : defaultResolveDetailTitle(msgs, id));

    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.onMessage) return;

    const dispatchMessage = (msg: any, sender: chrome.runtime.MessageSender, sendResponse: (response?: any) => void) => {
        // Exactly-once responder to avoid leaving message port open on failure.
        let responded = false;
        const respond = (response: any) => {
            if (responded) return;
            responded = true;
            try { sendResponse(response); } catch { /* port may be gone */ }
        };
        try {
        if (msg.action === 'ping') {
            const ver = getExtensionVersion();
            respond({
                ok: true,
                version: ver,
                ver: ver
            });
            return;
        }

        if (msg.action === 'deepScan') {
            void (async () => {
                try {
                    let res: any = null;
                    if (Sync && Sync.tryBatchExecuteFull) {
                        res = await Sync.tryBatchExecuteFull({
                            forceFull: msg.mode === 'full'
                        });
                    }
                    if (!res) {
                        respond({
                            success: false,
                            count: 0,
                            error: 'deep scan did not produce a result (already running or provider unavailable)'
                        });
                        return;
                    }
                    respond({
                        success: true,
                        count: res?.count || 0,
                        diagnostics: res?.diagnostics,
                        hitGoogleLimit: !!(res?.hitGoogleLimit || res?.diagnostics?.hitGoogleLimit)
                    });
                } catch (e: unknown) {
                    const errStr = getErrorMessage(e);
                    const isLimit = isRateLimited({ success: false, error: errStr });
                    respond({ success: false, error: errStr, hitGoogleLimit: isLimit });
                }
            })();
            return true;
        }

        if (msg.action === 'stopDeepScan' || msg.action === 'abortSync') {
            contentContext.abort();
            if (typeof window !== 'undefined') {
                const w = window as any;
                w.__gemExporterAborted = true;
                try { w.__gemExporterActiveClient && w.__gemExporterActiveClient.abort(); } catch { /* intentional: best-effort cleanup */ }
            }
            respond({ ok: true, aborted: true });
            return true;
        }

        if (msg.action === 'getScrollContainer') {
            const c = Scraper ? Scraper.getScrollContainer() : null;
            respond({
                found: !!c,
                tag: c?.tagName || null,
                id: c?.id || null,
                class: c?.className?.slice(0, 120) || null
            });
            return true;
        }

        if (msg.action === 'getConversationDetail') {
            const detailMsg = msg as GetConversationDetailMessage;
            const cid = detailMsg.conversationId;
            if (!cid) {
                respond({ success: false, error: 'no id' });
                return true;
            }
            void (async () => {
                async function persistDetailTitle(chatObj: any): Promise<void> {
                    if (!chatObj) return;
                    const nid = normId(cid || chatObj.id);
                    chatObj.title = cleanTitle(chatObj.title);
                    let detectedSource = chatObj.titleSource || 'rpc';
                    if (!isRealTitle(chatObj.title, nid) && Array.isArray(chatObj.messages)) {
                        const sniffed = resolveDetailTitle(chatObj.messages, nid);
                        if (sniffed) {
                            chatObj.title = sniffed.title;
                            detectedSource = sniffed.source;
                        }
                    }
                    if (!isRealTitle(chatObj.title, nid)) return;
                    const slot = detailMsg.accountSlot || (Sync && Sync.getAccountSlot ? Sync.getAccountSlot() : 'u0');
                    try {
                        // SSOT: single-item title update runs inside the cross-tab
                        // conversation lock via updateConversation. The old shape
                        // (read list outside the lock, mutate, blind setConversations)
                        // could clobber a concurrent tab's sync (lost update), and
                        // bypassed nothing here since setTitleBySource already
                        // arbitrates through the title tiers.
                        if (Storage && typeof Storage.updateConversation === 'function') {
                            await Storage.updateConversation(slot, nid, (current: any) => {
                                if (!current) return null;
                                const item = { ...current, titles: { ...(current.titles || {}) } };
                                const beforeTitle = item.title;
                                const beforeSource = item.titleSource;
                                setTitleBySource(item, detectedSource, chatObj.title);
                                if (item.title === beforeTitle && item.titleSource === beforeSource) return null;
                                return { title: item.title, titleSource: item.titleSource, titles: item.titles };
                            });
                        }
                    } catch (err) {
                        console.warn('[Gemini Exporter] persistDetailTitle error', err);
                    }
                }

                let batchexecuteEmptyDebug: any = null;
                try {
                    const provider = resolveProvider();
                    if (provider) {
                        const detail = await provider.fetchConversationDetail(cid, { targetSid: detailMsg.targetSid || null });
                        if (detail && Array.isArray(detail.messages) && detail.messages.length > 0) {
                            await persistDetailTitle(detail);
                            respond({ success: true, data: detail, source: 'batchexecute' });
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
                    const isRpcDeleted = isConfirmedDeletedError(errMsg);
                    if (isRpcDeleted) {
                        const slot = detailMsg.accountSlot || (Sync && Sync.getAccountSlot ? Sync.getAccountSlot() : 'u0');
                        try {
                            if (Storage && typeof Storage.removeConversation === 'function') {
                                await Storage.removeConversation(slot, cid);
                                const syncMeta = (Storage.getLastSync && typeof Storage.getLastSync === 'function')
                                    ? await Storage.getLastSync(slot)
                                    : { count: (await Storage.getConversations(slot)).length };
                                const count = syncMeta.count;
                                if (Sync && Sync.updateBadge) {
                                    Sync.updateBadge(count, 0);
                                }
                                try {
                                    void chrome.runtime.sendMessage({
                                        action: 'syncUpdate',
                                        slot,
                                        count,
                                        from: 'prune-dead-chat'
                                    });
                                } catch (e) {
                                    if (contentContext.isDevMode()) console.debug('[GemExporter:messageRouter]', e);
                                }
                            }
                        } catch (e) {
                            if (contentContext.isDevMode()) console.debug('[GemExporter:messageRouter]', e);
                        }
                        const errDeleted = contentContext.isZh() ? '云端会话已被删除或不存在' : 'Cloud conversation deleted or does not exist';
                        respond({
                            success: true,
                            data: {
                                id: cid,
                                title: cid,
                                messages: [],
                                _empty: true,
                                isDeleted: true,
                                error: errDeleted,
                                _debug: { batchexecuteEmptyDebug: { error: errMsg, isDeleted: true }, isDeleted: true }
                            },
                            source: 'batchexecute'
                        });
                        return;
                    }
                }
                try {
                    if (Scraper) {
                        const chat = await Scraper.contentFetchChatDetail(cid);
                        if (chat && Array.isArray(chat.messages) && chat.messages.length > 0) {
                            await persistDetailTitle(chat);
                            respond({ success: true, data: chat, source: 'dom' });
                            return;
                        } else {
                            if (contentContext.isDevMode()) {
                                console.warn('[Gemini Exporter] DOM fallback returned empty messages', cid, 'messages', chat?.messages?.length, 'has _raw', !!chat?._raw);
                            }
                            const isConfirmedDeleted = !!chat?.isDeleted
                                || !!chat?._debug?.isNotFound
                                || (typeof chat?.error === 'string' && (chat.error.includes('删除或不存在') || chat.error.includes('服务端删除')));
                            if (isConfirmedDeleted) {
                                const slot = detailMsg.accountSlot || (Sync && Sync.getAccountSlot ? Sync.getAccountSlot() : 'u0');
                                try {
                                    if (Storage && typeof Storage.removeConversation === 'function') {
                                        await Storage.removeConversation(slot, cid);
                                        const syncMeta = (Storage.getLastSync && typeof Storage.getLastSync === 'function')
                                            ? await Storage.getLastSync(slot)
                                            : { count: (await Storage.getConversations(slot)).length };
                                        const count = syncMeta.count;
                                        if (Sync && Sync.updateBadge) {
                                            Sync.updateBadge(count, 0);
                                        }
                                        try {
                                            void chrome.runtime.sendMessage({
                                                action: 'syncUpdate',
                                                slot,
                                                count,
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
                            const errDeleted = contentContext.isZh() ? '云端会话已被删除或不存在' : 'Cloud conversation deleted or does not exist';
                            const errDomEmpty = contentContext.isZh() ? 'DOM 返回内容为空' : 'DOM returned empty content';
                            respond({
                                success: true,
                                data: {
                                    ...chat,
                                    id: chat?.id || cid,
                                    title: chat?.title || cid,
                                    messages: [],
                                    _empty: true,
                                    isEmpty: !isConfirmedDeleted,
                                    isDeleted: isConfirmedDeleted,
                                    error: isConfirmedDeleted ? errDeleted : (chat?.error || errDomEmpty),
                                    _debug: mergedDebug,
                                    _debug_dom_empty: true
                                },
                                source: 'dom'
                            });
                            return;
                        }
                    }
                } catch (e: unknown) {
                    const errMsg = getErrorMessage(e);
                    const mergedDebug = { batchexecuteEmptyDebug, domError: errMsg };
                    respond({ success: false, error: errMsg, _debug: mergedDebug });
                }
                // S1: fail closed — every response path above returns, so
                // reaching here means nothing was sent (e.g. no provider
                // and no scraper). Never leave the port hanging. The
                // exactly-once guard makes this a no-op when a response
                // was already produced.
                respond({ ok: false, success: false, error: 'conversation detail unavailable: no provider or scraper produced a result' });
            })();
            return true;
        }

        if (msg.action === 'getFileBlob') {
            if (!isAllowedAssetUrl(msg.url)) { respond({ success: false, error: 'blocked: asset url not allowlisted (' + String(msg.url).split('?')[0].slice(0, 160) + ')'  }); return true; }
            if (Assets) void Assets.handleGetFileBlob(msg, respond);
            else respond({ success: false, error: 'AssetFetcher not loaded' });
            return true;
        }

        if (msg.action === 'getImageBlob') {
            if (!isAllowedAssetUrl(msg.url)) { respond({ success: false, error: 'blocked: asset url not allowlisted (' + String(msg.url).split('?')[0].slice(0, 160) + ')'  }); return true; }
            if (Assets) void Assets.handleGetImageBlob(msg, respond);
            else respond({ success: false, error: 'AssetFetcher not loaded' });
            return true;
        }

        if (msg.action === 'downloadAssetDirect') {
            if (!isAllowedAssetUrl(msg.url)) { respond({ success: false, error: 'blocked: asset url not allowlisted (' + String(msg.url).split('?')[0].slice(0, 160) + ')'  }); return true; }
            if (Assets) void Assets.downloadAssetDirect(msg, respond);
            else respond({ success: false, error: 'AssetFetcher not loaded' });
            return true;
        }

        // Unknown action: structured error instead of port closed
        respond({ ok: false, success: false, error: `unknown action: ${msg.action}` });
        } catch (e: unknown) {
            respond({ ok: false, success: false, error: getErrorMessage(e) });
        }
    };
    chrome.runtime.onMessage.addListener(dispatchMessage);
    registerCleanup(() => {
        try { chrome.runtime.onMessage.removeListener(dispatchMessage); } catch { /* already gone */ }
    });
}

export const MessageRouter = {
    init
};

export default MessageRouter;
