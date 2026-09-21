// src/background/background.ts - Manifest V3 Background Service Worker for Gemini Exporter

import type { BackgroundMessage, BackgroundResponse } from '../types/entrypoints.js';
import { initSessionAccessLevel, initUninstallUrl, initLifecycleListeners } from './lifecycle.js';
import {
    __bgAborts,
    restoreAbortFlags,
    isSlotAborted,
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
import { getStoredDirHandle, clearStoredDirHandle } from '../core/storage/idbHandleStore.js';
import { FsWriter } from '../core/engine/writers/fsWriter.js';
import { ChatFormatter } from '../core/engine/chatFormatter.js';

// Re-export modular components for architectural backward-compatibility and diagnostic inspection
export {
    initSessionAccessLevel,
    initUninstallUrl,
    initLifecycleListeners,
    __bgAborts,
    restoreAbortFlags,
    isSlotAborted,
    setSlotAborted,
    clearAllAborts,
    startKeepAlive,
    initTabActionListeners,
    updateTabActionState,
    isGeminiTabUrl,
    ACTION_COLOR_ICONS,
    ACTION_GRAY_ICONS,
    handleLiveSaveViaHandle,
    markDirDeletedInConfig,
    fetchBatch,
    sendToGeminiTab,
    getGeminiTab,
    FsWriter,
    ChatFormatter
};

// Backwards-compatible handle store aliases
export const getStoredExportDirHandle = getStoredDirHandle;
export const clearStoredExportDirHandle = clearStoredDirHandle;

// Preserves _debug in failed chats via batchFetcher module
export const PRESERVE_DEBUG_NOTE = '_debug';

// 1. Initialize session storage access level for content script credentials
initSessionAccessLevel();

// 2. Initialize lifecycle listeners (install welcome page, uninstall feedback URL)
initLifecycleListeners();
initUninstallUrl();

// 3. Restore persisted slot abort flags from session storage
restoreAbortFlags().catch(() => {});

// 4. Initialize tab action dynamic icon status listeners
initTabActionListeners();

// 5. Central Message Router
chrome.runtime.onMessage.addListener((msg: BackgroundMessage, sender: chrome.runtime.MessageSender, sendResponse: (response?: BackgroundResponse) => void) => {
    if (msg.action === 'openOptions') {
        chrome.runtime.openOptionsPage();
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
            chrome.tabs.reload(msg.tabId, () => sendResponse({ ok: true }));
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
            .then(r => sendResponse(r))
            .catch(e => sendResponse({ success: false, error: e?.message }));
        return true;
    }

    if (msg.action === 'fetchBatch') {
        const slot = msg.accountSlot || 'u0';
        setSlotAborted(slot, false);
        fetchBatch(msg.ids, msg.format, msg.skipExported, sendResponse, msg.globalOffset, msg.globalTotal, slot);
        return true;
    }

    if (msg.action === 'cancelExport') {
        const slot = msg.accountSlot || 'u0';
        setSlotAborted(slot, true);
        sendResponse({ ok: true, aborted: true });
        return true;
    }

    if (msg.action === 'abortSync') {
        const slot = msg.accountSlot || 'u0';
        setSlotAborted(slot, true);
        sendToGeminiTab({ action: 'abortSync' }, slot).catch(() => {});
        sendResponse({ ok: true, aborted: true });
        return true;
    }

    if (msg.action === 'ping') {
        const ver = (typeof chrome !== 'undefined' && chrome.runtime?.getManifest?.()?.version) || (typeof __EXT_VERSION__ !== 'undefined' ? __EXT_VERSION__ : '1.5.0');
        sendResponse({
            ok: true,
            version: ver,
            ver: ver
        });
        return;
    }

    if (msg.action === 'deepScan') {
        (async () => {
            const stopKeepAlive = startKeepAlive();
            try {
                const timeoutMs = (msg.mode === 'full' || msg.mode === 'auto') ? 300000 : 90000;
                const res = await sendToGeminiTab({
                    action: 'deepScan',
                    maxIter: msg.maxIter || 150,
                    mode: msg.mode || 'auto'
                }, msg.accountSlot, timeoutMs);
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
        setSlotAborted(slot, true);
        sendToGeminiTab({ action: 'stopDeepScan' }, slot)
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
        handleLiveSaveViaHandle(msg.payload, msg.accountSlot || 'u0')
            .then(res => sendResponse(res))
            .catch(err => sendResponse({ ok: false, error: err?.message || String(err) }));
        return true;
    }

    return false;
});
