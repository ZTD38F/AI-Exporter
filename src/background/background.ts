import type { BackgroundMessage, BackgroundResponse } from '../types/entrypoints.js';
import type { AbortSyncMessage, DeepScanMessage, StopDeepScanMessage } from '../types/messages.js';
import { initSessionAccessLevel, initUninstallUrl, initLifecycleListeners } from './lifecycle.js';
import {
    __bgAborts,
    restoreAbortFlags,
    isSlotAborted,
    getSlotCancelEpoch,
    setSlotAborted,
    clearAllAborts
} from './abortManager.js';
import { startKeepAlive } from './keepAlive.js';
import {
    initTabActionListeners,
    updateTabActionState,
    isGeminiTabUrl,
    ACTION_COLOR_ICONS,
    ACTION_GRAY_ICONS
} from './tabAction.js';
import { handleLiveSaveViaHandle, markDirDeletedInConfig } from './liveSaveHandler.js';
import { fetchBatch, sendToGeminiTab, getGeminiTab } from './batchFetcher.js';
import { ensureStorageReady } from '../core/storage/schemaMigration.js';

const fetchBatchChains = new Map<string, Promise<void>>();
import { getExtensionVersion } from '../core/utils/constants.js';

initSessionAccessLevel();
initLifecycleListeners();
initUninstallUrl();
restoreAbortFlags().catch(() => {});
initTabActionListeners();

// Establish storage readiness boundary at background startup.
void ensureStorageReady().catch((err) => {
    console.error('[Background] Storage readiness initialization failed:', err);
});

chrome.runtime.onMessage.addListener((msg: BackgroundMessage, sender: chrome.runtime.MessageSender, sendResponse: (response?: BackgroundResponse) => void) => {
    if (msg.action === 'openOptions') {
        void chrome.runtime.openOptionsPage();
        sendResponse({ ok: true });
        return;
    }

    if (msg.action === 'openGeminiPage') {
        chrome.tabs.create({ url: 'https://gemini.google.com/app' }, (tab) => {
            sendResponse({ ok: true, tabId: tab?.id });
        });
        return true;
    }

    if (msg.action === 'reloadGeminiTab') {
        if (msg.tabId) {
            chrome.tabs.get(msg.tabId, (tab) => {
                if (chrome.runtime.lastError || !tab) {
                    sendResponse({ ok: false, error: 'no such tab' });
                    return;
                }
                const url = tab.url || '';
                if (url.startsWith('https://gemini.google.com/')) {
                    chrome.tabs.reload(msg.tabId, () => sendResponse({ ok: true }));
                } else {
                    sendResponse({ ok: false, error: 'not a gemini tab' });
                }
            });
        } else {
            chrome.tabs.query({ url: 'https://gemini.google.com/*' }, (tabs) => {
                if (tabs && tabs.length > 0 && tabs[0].id != null) {
                    chrome.tabs.reload(tabs[0].id, () => sendResponse({ ok: true }));
                } else {
                    sendResponse({ ok: false, error: 'no tab' });
                }
            });
        }
        return true;
    }

    if (msg.action === 'fetchChat') {
        sendToGeminiTab({
            action: 'getConversationDetail',
            conversationId: msg.id || msg.conversationId
        }, msg.accountSlot)
            .then(r => sendResponse(r == null
                ? { ok: false, success: false, error: 'empty response from gemini tab' }
                : r))
            .catch(e => sendResponse({ success: false, error: e?.message }));
        return true;
    }

    if (msg.action === 'fetchBatch') {
        const slot = msg.accountSlot || 'u0';
        const ids = msg.ids;
        const format = msg.format;
        const skipExported = msg.skipExported;
        const globalOffset = msg.globalOffset;
        const globalTotal = msg.globalTotal;
        const prev = fetchBatchChains.get(slot) || Promise.resolve();
        const queuedCancelEpoch = getSlotCancelEpoch(slot);
        const run = prev.then(async () => {
            let responded = false;
            const guardedResponse = (response: any) => {
                if (responded) return;
                responded = true;
                try { sendResponse(response); } catch (_) { /* port may be gone */ }
            };
            // A batch queued before cancellation belongs to the cancelled
            // generation. Only a fresh request submitted afterward may reset it.
            if (getSlotCancelEpoch(slot) !== queuedCancelEpoch) {
                guardedResponse({ success: false, aborted: true, error: 'aborted' });
                return;
            }
            await setSlotAborted(slot, false);
            if (getSlotCancelEpoch(slot) !== queuedCancelEpoch) {
                guardedResponse({ success: false, aborted: true, error: 'aborted' });
                return;
            }
            try {
                await ensureStorageReady();
                await fetchBatch(ids, format, skipExported, guardedResponse, globalOffset, globalTotal, slot);
                if (!responded) {
                    // Fail closed: a batch that produced no response is a
                    // failure, never a silent success.
                    guardedResponse({ success: false, error: 'fetchBatch completed without a response' });
                }
            } catch (e: any) {
                guardedResponse({ success: false, error: e?.message || String(e) });
            }
        });
        // Keep the chain alive for later batches regardless of outcome.
        fetchBatchChains.set(slot, run.then(() => undefined, () => undefined));
        return true;
    }

    if (msg.action === 'cancelExport') {
        const slot = msg.accountSlot || 'u0';
        void setSlotAborted(slot, true);
        sendResponse({ ok: true, aborted: true });
        return true;
    }

    if (msg.action === 'abortSync') {
        const slot = msg.accountSlot || 'u0';
        void setSlotAborted(slot, true);
        const abortMsg: AbortSyncMessage = { action: 'abortSync' };
        sendToGeminiTab(abortMsg, slot).catch(() => {});
        sendResponse({ ok: true, aborted: true });
        return true;
    }

    if (msg.action === 'ping') {
        const ver = getExtensionVersion();
        sendResponse({
            ok: true,
            version: ver,
            ver: ver
        });
        return;
    }

    if (msg.action === 'deepScan') {
        void (async () => {
            const stopKeepAlive = startKeepAlive();
            try {
                const timeoutMs = (msg.mode === 'full' || msg.mode === 'auto') ? 300000 : 90000;
                const deepScanMsg: DeepScanMessage = {
                    action: 'deepScan',
                    maxIter: msg.maxIter || 150,
                    mode: msg.mode || 'auto'
                };
                const res = await sendToGeminiTab(deepScanMsg, msg.accountSlot, timeoutMs);
                sendResponse(res);
            } catch (e: any) {
                sendResponse({ success: false, error: e?.message });
            } finally {
                stopKeepAlive();
            }
        })();
        return true;
    }

    if (msg.action === 'stopDeepScan') {
        const slot = msg.accountSlot || 'u0';
        void setSlotAborted(slot, true);
        const stopMsg: StopDeepScanMessage = { action: 'stopDeepScan' };
        sendToGeminiTab(stopMsg, slot)
            .then(r => sendResponse(r || { ok: true, aborted: true }))
            .catch(() => sendResponse({ ok: true, aborted: true }));
        return true;
    }

    if (msg.action === 'scanProgress' || msg.action === 'syncUpdate') {
        // In MV3, chrome.runtime.sendMessage from content script is already delivered directly to all extension pages.
        // Re-broadcasting here causes duplicate message delivery and duplicate log entries.
        return;
    }

    if (msg.action === 'liveSaveViaHandle' && msg.payload) {
        (async () => {
            await ensureStorageReady();
            return handleLiveSaveViaHandle(msg.payload, msg.accountSlot || 'u0');
        })()
            .then(res => sendResponse(res))
            .catch(err => sendResponse({ ok: false, error: err?.message || String(err) }));
        return true;
    }

    return false;
});
