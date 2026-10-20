import type { OptionsSyncOptions } from '../../../types/ui.js';
import {
    t,
    getProtocol,
    getTabService,
    getStore,
    getExportCtrl as getExportController,
    getSyncCtrl as getSyncController
} from '../optionsContext.js';
import { ProgressView } from '../../views/progressView.js';
import { $ } from '../../uiCommon.js';
import { detectSlotFromUrl } from '../../../core/utils/pathUtils.js';

let __loadStore: ((force?: boolean) => Promise<any> | void) | null = null;
let __log: ((msg: string, level?: 'info' | 'warn' | 'error') => void) | null = null;
let __maybePromptTakeout: ((count: number, hitLimit: boolean) => Promise<void> | void) | null = null;

async function checkAndPromptTakeoutLimit(count?: number, hitGoogleLimit?: boolean): Promise<void> {
    const protocol = getProtocol();
    const slidingLimit = (protocol && protocol.LIMITS?.SLIDING_WINDOW) || 500;
    const isLimit = !!hitGoogleLimit || ((count || 0) >= slidingLimit);
    if (isLimit && __maybePromptTakeout) {
        await __maybePromptTakeout(count || slidingLimit, !!hitGoogleLimit);
    }
}

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
        const slot = Store ? Store.getCurrentSlot() : 'u0';

        if (SyncCtrl) {
            SyncCtrl.startIncrementalScan(slot, {
                onStart: () => {
                    ProgressView.show(5, typeof t === 'function' ? t('syncingLatest') : '正在同步最新会话...');
                },
                onLog: (txt: string, lvl: 'info' | 'warn' | 'error') => log(txt, lvl),
                onFinished: ({ message }: any) => {
                    ProgressView.complete(message);
                    ProgressView.hide(2500);
                    if (__loadStore) void __loadStore();
                },
                onError: (err: any, errMsg: string) => {
                    ProgressView.update(0, errMsg);
                }
            });
        }
    });

    $('btnDeepScan')?.addEventListener('click', () => {
        if (Controller && Controller.isRunning()) return;
        const slot = Store ? Store.getCurrentSlot() : 'u0';

        if (SyncCtrl) {
            SyncCtrl.startDeepScan(slot, {
                onStart: () => {
                    ProgressView.show(5, typeof t === 'function' ? t('deepSyncing') : '正在全量扫描历史...');
                },
                onLog: (txt: string, lvl: 'info' | 'warn' | 'error') => log(txt, lvl),
                onFinished: async ({ message, res, count, hitGoogleLimit }: any) => {
                    ProgressView.complete(message);
                    ProgressView.hide(2500);
                    if (__loadStore) void __loadStore();
                    const currentCount = count || res?.count || (Store && typeof (Store as any).getConversations === 'function' ? (Store as any).getConversations().length : 0);
                    await checkAndPromptTakeoutLimit(currentCount, hitGoogleLimit);
                },
                onError: async (err: any, errMsg: string, details: any) => {
                    ProgressView.update(0, errMsg);
                    const currentCount = (Store && typeof (Store as any).getConversations === 'function') ? (Store as any).getConversations().length : 0;
                    await checkAndPromptTakeoutLimit(currentCount || details?.count, details?.hitGoogleLimit);
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
                    ProgressView.complete(message);
                }
            });
        }
    });
}

export function bindBroadcastListeners(): void {
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.onMessage) return;

    chrome.runtime.onMessage.addListener((msg: any) => {
        if (msg.action === 'scanProgress') {
            let pct = typeof msg.percent === 'number' ? msg.percent : 50;
            const clamped = Math.min(Math.max(pct, 5), 100);
            ProgressView.update(clamped, msg.title || '');
            if (msg.title) log(msg.title);

            if (msg.percent === 100 || msg.done === 1) {
                void checkAndPromptTakeoutLimit(msg.count, msg.hitGoogleLimit);
            }
        }

        if (msg.action === 'syncUpdate') {
            if (__loadStore) void __loadStore(true);
        }
    });
}

export async function autoDetectActiveSlot(): Promise<void> {
    try {
        const TabService = getTabService();
        const Store = getStore();
        if (TabService && TabService.getGeminiTab) {
            const tab = await TabService.getGeminiTab();
            if (tab && tab.url && Store) {
                Store.setCurrentSlot(detectSlotFromUrl(tab.url));
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



export default OptionsSync;
