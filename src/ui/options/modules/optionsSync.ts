// src/ui/options/modules/optionsSync.ts - Cloud synchronization, background progress & pruning
import type { OptionsSyncOptions } from '../../../types/ui.js';
import { ConversationsStore as DefaultConversationsStore } from '../../state/conversationsStore.js';
import { ExportController as DefaultExportController } from '../../controllers/exportController.js';
import { SyncController as DefaultSyncCtrl } from '../../controllers/syncController.js';
import { GeminiAPIClient as DefaultApiClient } from '../../../core/api/geminiClient.js';
import { GeminiProtocol as DefaultGeminiProtocol } from '../../../core/protocol/protocol.js';
import { TabService as DefaultTabService } from '../../../core/utils/tabService.js';
import { I18n as DefaultI18n } from '../../../core/utils/i18n.js';

function $(id: string): HTMLElement | null {
    return typeof document !== 'undefined' ? document.getElementById(id) : null;
}

const getI18n = () => {
    if (typeof I18n !== 'undefined' && I18n) return I18n;
    if (typeof DefaultI18n !== 'undefined' && DefaultI18n) return DefaultI18n;
    if (typeof globalThis !== 'undefined' && (globalThis as any).I18n) return (globalThis as any).I18n;
    return null;
};

const t = (key: string, ...args: any[]): string => {
    const i18n = getI18n();
    if (i18n && typeof i18n.t === 'function') {
        return i18n.t(key, ...args);
    }
    return key;
};

const getProtocol = () => {
    if (typeof GeminiProtocol !== 'undefined' && GeminiProtocol) return GeminiProtocol;
    if (typeof DefaultGeminiProtocol !== 'undefined' && DefaultGeminiProtocol) return DefaultGeminiProtocol;
    if (typeof globalThis !== 'undefined' && (globalThis as any).GeminiProtocol) return (globalThis as any).GeminiProtocol;
    return null;
};

const getApiClient = () => {
    if (typeof GeminiAPIClient !== 'undefined' && GeminiAPIClient) return GeminiAPIClient;
    if (typeof DefaultApiClient !== 'undefined' && DefaultApiClient) return DefaultApiClient;
    if (typeof globalThis !== 'undefined' && (globalThis as any).GeminiAPIClient) return (globalThis as any).GeminiAPIClient;
    return null;
};

const getTabService = () => {
    if (typeof TabService !== 'undefined' && TabService) return TabService;
    if (typeof DefaultTabService !== 'undefined' && DefaultTabService) return DefaultTabService;
    if (typeof globalThis !== 'undefined' && (globalThis as any).TabService) return (globalThis as any).TabService;
    return null;
};

const getStore = () => {
    if (typeof DefaultConversationsStore !== 'undefined' && DefaultConversationsStore) return DefaultConversationsStore;
    if (typeof ConversationsStore !== 'undefined') return ConversationsStore;
    return null;
};

const getExportController = () => {
    if (typeof DefaultExportController !== 'undefined' && DefaultExportController) return DefaultExportController;
    if (typeof ExportController !== 'undefined') return ExportController;
    return null;
};

const getSyncController = () => {
    if (typeof DefaultSyncCtrl !== 'undefined' && DefaultSyncCtrl) return DefaultSyncCtrl;
    if (typeof SyncController !== 'undefined') return SyncController;
    return null;
};

let __loadStore: ((force?: boolean) => Promise<any> | void) | null = null;
let __log: ((msg: string, level?: 'info' | 'warn' | 'error') => void) | null = null;
let __maybePromptTakeout: ((count: number, hitLimit: boolean) => Promise<void> | void) | null = null;

export function log(msg: string, level: 'info' | 'warn' | 'error' = 'info'): void {
    if (__log) __log(msg, level);
    else console.log(`[SYNC ${level}]`, msg);
}

function bindSyncButtons(): void {
    const Store = getStore();
    const Controller = getExportController();
    const SyncCtrl = getSyncController();

    $('btnIncrementalScan')?.addEventListener('click', () => {
        if (Controller && Controller.isRunning()) return;
        const progWrap = $('progWrap');
        const bar = $('bar');
        const progText = $('progText');
        const slot = Store ? Store.getCurrentSlot() : 'u0';

        if (SyncCtrl) {
            SyncCtrl.startIncrementalScan(slot, {
                onStart: () => {
                    if (progWrap) progWrap.style.display = 'block';
                    if (bar) bar.style.width = '5%';
                    if (progText) progText.textContent = typeof t === 'function' ? t('syncingLatest') : '正在同步最新会话...';
                },
                onLog: (txt: string, lvl: 'info' | 'warn' | 'error') => log(txt, lvl),
                onFinished: ({ message }: any) => {
                    if (bar) bar.style.width = '100%';
                    if (progText) progText.textContent = message;
                    setTimeout(() => {
                        if (progWrap) progWrap.style.display = 'none';
                        if (bar) bar.style.width = '0%';
                        if (progText) progText.textContent = '';
                    }, 2500);
                    if (__loadStore) __loadStore();
                },
                onError: (err: any, errMsg: string) => {
                    if (progText) progText.textContent = errMsg;
                }
            });
        }
    });

    $('btnDeepScan')?.addEventListener('click', () => {
        if (Controller && Controller.isRunning()) return;
        const progWrap = $('progWrap');
        const bar = $('bar');
        const progText = $('progText');
        const slot = Store ? Store.getCurrentSlot() : 'u0';

        if (SyncCtrl) {
            SyncCtrl.startDeepScan(slot, {
                onStart: () => {
                    if (progWrap) progWrap.style.display = 'block';
                    if (bar) bar.style.width = '5%';
                    if (progText) progText.textContent = typeof t === 'function' ? t('deepSyncing') : '正在全量扫描历史...';
                },
                onLog: (txt: string, lvl: 'info' | 'warn' | 'error') => log(txt, lvl),
                onFinished: async ({ message, res, count, hitGoogleLimit }: any) => {
                    if (bar) bar.style.width = '100%';
                    if (progText) progText.textContent = message;
                    setTimeout(() => {
                        if (progWrap) progWrap.style.display = 'none';
                        if (bar) bar.style.width = '0%';
                        if (progText) progText.textContent = '';
                    }, 2500);
                    if (__loadStore) __loadStore();
                    const currentCount = count || res?.count || (Store && typeof (Store as any).getConversations === 'function' ? (Store as any).getConversations().length : 0);
                    const protocol = getProtocol();
                    const slidingLimit = (protocol && protocol.LIMITS?.SLIDING_WINDOW) || 600;
                    const isLimit = hitGoogleLimit || (currentCount >= slidingLimit);
                    if (isLimit && __maybePromptTakeout) {
                        await __maybePromptTakeout(currentCount, !!hitGoogleLimit);
                    }
                },
                onError: async (err: any, errMsg: string, details: any) => {
                    if (progText) progText.textContent = errMsg;
                    const protocol = getProtocol();
                    const slidingLimit = (protocol && protocol.LIMITS?.SLIDING_WINDOW) || 600;
                    const currentCount = (Store && typeof (Store as any).getConversations === 'function') ? (Store as any).getConversations().length : 0;
                    const isLimit = details?.hitGoogleLimit || (currentCount >= slidingLimit) || (details?.count >= slidingLimit);
                    if (isLimit && __maybePromptTakeout) {
                        await __maybePromptTakeout(currentCount || details?.count || slidingLimit, !!details?.hitGoogleLimit);
                    }
                }
            });
        }
    });

    $('btnStopScan')?.addEventListener('click', () => {
        const slot = Store ? Store.getCurrentSlot() : 'u0';
        if (SyncCtrl) {
            SyncCtrl.stopScan(slot, {
                onLog: (txt: string, lvl: 'info' | 'warn' | 'error') => log(txt, lvl),
                onStopped: ({ message }: any) => {
                    const progText = $('progText');
                    if (progText) progText.textContent = message;
                }
            });
        }
    });
}

export function bindBroadcastListeners(): void {
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.onMessage) return;

    chrome.runtime.onMessage.addListener((msg: any) => {
        if (msg.action === 'scanProgress') {
            const progWrap = $('progWrap');
            const bar = $('progBar') || $('bar');
            const progText = $('progText');
            if (progWrap) progWrap.style.display = 'block';
            let pct = typeof msg.percent === 'number' ? msg.percent : 50;
            if (bar) bar.style.width = Math.min(Math.max(pct, 5), 100) + '%';
            if (progText && msg.title) progText.textContent = msg.title;
            if (msg.title) log(msg.title);

            const protocol = getProtocol();
            const slidingLimit = (protocol && protocol.LIMITS?.SLIDING_WINDOW) || 600;
            if ((msg.percent === 100 || msg.done === 1) && (msg.hitGoogleLimit || (msg.count >= slidingLimit))) {
                if (__maybePromptTakeout) {
                    __maybePromptTakeout(msg.count || slidingLimit, !!msg.hitGoogleLimit);
                }
            }
        }
        if (msg.action === 'syncUpdate') {
            if (__loadStore) __loadStore(true);
        }
    });
}

export async function autoDetectActiveSlot(): Promise<void> {
    try {
        const TabService = getTabService();
        const Store = getStore();
        if (TabService && TabService.getGeminiTab) {
            const tab = await TabService.getGeminiTab();
            if (tab && tab.url) {
                const m = tab.url.match(/\/u\/(\d+)(?:\/|$)/);
                if (m && Store) {
                    Store.setCurrentSlot('u' + m[1]);
                }
            }
        }
    } catch (e) {
        if (typeof console !== 'undefined' && console.debug) console.debug('[GemExporter:optionsSync]', e);
    }
}

export async function init({ loadStore, log: logFn, maybePromptTakeout }: OptionsSyncOptions = {}): Promise<void> {
    __loadStore = loadStore || null;
    __log = logFn || null;
    __maybePromptTakeout = maybePromptTakeout || null;

    bindSyncButtons();
    bindBroadcastListeners();
    await autoDetectActiveSlot();
}

export const OptionsSync = {
    init,
    bindBroadcastListeners,
    autoDetectActiveSlot
};

(OptionsSync as any).OptionsSync = OptionsSync;
(OptionsSync as any).default = OptionsSync;

if (typeof globalThis !== 'undefined') {
    (globalThis as any).OptionsSync = OptionsSync;
}
if (typeof module === 'object' && module.exports) {
    module.exports = OptionsSync;
}

export default OptionsSync;
