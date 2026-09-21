// src/ui/options/modules/optionsInit.ts - Workbench initialization & state loader
import type { OptionsInitOptions } from '../../../types/ui.js';
import { ConversationsStore as DefaultConversationsStore } from '../../state/conversationsStore.js';
import { ListView as DefaultListView } from '../../views/listView.js';
import { LogView as DefaultLogView } from '../../views/logView.js';
import { DialogView as DefaultDialogView } from '../../views/dialogView.js';
import { AccountView as DefaultAccountView } from '../../views/accountView.js';
import { ExportController as DefaultExportController } from '../../controllers/exportController.js';
import { TourGuide as DefaultTourGuide } from '../../tour/tourGuide.js';
import { StorageService as DefaultStorageService } from '../../../core/storage/storageService.js';
import { GeminiUtils as DefaultGeminiUtils } from '../../../core/utils/utils.js';
import { I18n as DefaultI18n } from '../../../core/utils/i18n.js';

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

function $(id: string): HTMLElement | null {
    return typeof document !== 'undefined' ? document.getElementById(id) : null;
}

const getStore = () => {
    if (typeof DefaultConversationsStore !== 'undefined' && DefaultConversationsStore) return DefaultConversationsStore;
    if (typeof ConversationsStore !== 'undefined') return ConversationsStore;
    return null;
};

const getList = () => {
    if (typeof DefaultListView !== 'undefined' && DefaultListView) return DefaultListView;
    if (typeof ListView !== 'undefined') return ListView;
    return null;
};

const getLog = () => {
    if (typeof DefaultLogView !== 'undefined' && DefaultLogView) return DefaultLogView;
    if (typeof LogView !== 'undefined') return LogView;
    return null;
};

const getDialogs = () => {
    if (typeof DefaultDialogView !== 'undefined' && DefaultDialogView) return DefaultDialogView;
    if (typeof DialogView !== 'undefined') return DialogView;
    return null;
};

const getAccount = () => {
    if (typeof DefaultAccountView !== 'undefined' && DefaultAccountView) return DefaultAccountView;
    if (typeof AccountView !== 'undefined') return AccountView;
    return null;
};

const getController = () => {
    if (typeof DefaultExportController !== 'undefined' && DefaultExportController) return DefaultExportController;
    if (typeof ExportController !== 'undefined') return ExportController;
    return null;
};

const getTour = () => {
    if (typeof DefaultTourGuide !== 'undefined' && DefaultTourGuide) return DefaultTourGuide;
    if (typeof TourGuide !== 'undefined') return TourGuide;
    return null;
};

const getStorage = () => {
    if (typeof StorageService !== 'undefined' && StorageService) return StorageService;
    if (typeof DefaultStorageService !== 'undefined' && DefaultStorageService) return DefaultStorageService;
    if (typeof globalThis !== 'undefined' && (globalThis as any).StorageService) return (globalThis as any).StorageService;
    return null;
};

const getUtils = () => {
    if (typeof GeminiUtils !== 'undefined' && GeminiUtils) return GeminiUtils;
    if (typeof DefaultGeminiUtils !== 'undefined' && DefaultGeminiUtils) return DefaultGeminiUtils;
    if (typeof globalThis !== 'undefined' && (globalThis as any).GeminiUtils) return (globalThis as any).GeminiUtils;
    return null;
};

export const normId = (id?: string | null): string => {
    const utils = getUtils();
    if (utils && typeof utils.normId === 'function') return utils.normId(id);
    return String(id || '').replace(/^c_/, '');
};

export const cleanTitle = (tStr?: string | null): string => {
    const utils = getUtils();
    if (utils && typeof utils.cleanTitle === 'function') return utils.cleanTitle(tStr);
    return (tStr || '').trim();
};

export const isRealTitle = (tStr?: string | null, id?: string | null): boolean => {
    const utils = getUtils();
    if (utils && typeof utils.isRealTitle === 'function') return utils.isRealTitle(tStr as string, id as string);
    return !!(tStr && String(tStr).trim().length > 1);
};

export const isBad = (tStr?: string | null, id?: string | null): boolean => !isRealTitle(tStr, id);

export const resolveTitle = (chat: any): { title: string; source: string } => {
    const utils = getUtils();
    if (utils && typeof utils.resolveTitle === 'function') return utils.resolveTitle(chat);
    return { title: cleanTitle(chat?.title) || '未命名对话', source: chat?.titleSource || 'legacy' };
};

export const getEffectiveTime = (conv: any): number => {
    const utils = getUtils();
    if (utils && typeof utils.getEffectiveTimestamp === 'function') return utils.getEffectiveTimestamp(conv);
    if (!conv) return 0;
    const ts = conv.updatedAt || conv.timestamp || 0;
    return (typeof ts === 'string') ? new Date(ts).getTime() : ts;
};

export const compareConversations = (a: any, b: any): number => {
    const utils = getUtils();
    if (utils && typeof utils.compareConversations === 'function') return utils.compareConversations(a, b);
    return 0;
};

let __lastRenderedSignature = '';
let __lastRenderTime = 0;
let __chatSearchFilter = '';
let __searchDebounceTimer: any = null;
let __pendingTakeoutChecker: (() => Promise<void> | void) | null = null;

export function log(msg: string, level: 'info' | 'warn' | 'error' = 'info'): void {
    console.log(`[LOG ${level}]`, msg);
    const Log = getLog();
    if (Log && Log.log) Log.log(msg, level);
}

export function clearLog(): void {
    const Log = getLog();
    if (Log && Log.clear) Log.clear();
}

export function renderLog(): void {
    const Log = getLog();
    if (Log && Log.render) Log.render();
}

export function getSearchFilter(): string {
    return __chatSearchFilter;
}

export function setSearchFilter(filter?: string): void {
    __chatSearchFilter = filter || '';
}

export function updateAccountSlotSelector(): void {
    const Account = getAccount();
    const Store = getStore();
    if (Account && Account.render && Store) {
        Account.render(Store.getAccountSlots(), Store.getCurrentSlot());
    }
}

export async function checkExportSession(): Promise<void> {
    try {
        const Dialogs = getDialogs();
        const Controller = getController();
        const Store = getStore();
        if (!Dialogs || !Dialogs.renderExportBanner) return;
        const isRunning = Controller ? Controller.isRunning() : false;
        const { gemini_last_export_session: session } = await chrome.storage.local.get(['gemini_last_export_session']);
        const slot = Store ? Store.getCurrentSlot() : 'u0';
        Dialogs.renderExportBanner(session, slot, isRunning);
    } catch (e) {
        console.debug('[workbench:init] checkExportSession error', e);
    }
}

export async function loadStore(force: boolean = false): Promise<any> {
    try {
        if (typeof window !== 'undefined') {
            (window as any).__workbenchLoadStore = loadStore;
        }
        const Store = getStore();
        const List = getList();
        const Storage = getStorage();
        if (!Store) return;
        const slot = Store.getCurrentSlot() || 'u0';
        const { conversations: incoming, exportedIds } = await Store.loadStore(slot);
        updateAccountSlotSelector();

        let prevSelected: Set<string> | null = null;
        try {
            if (!force && List && Store.getConversations().length > 0) {
                prevSelected = List.getSelectedIds();
            }
        } catch {
            prevSelected = null;
        }

        const syncInfo = await Store.getLastSync(slot);
        const lastSyncVal = syncInfo.timestamp;

        const incomingSig = Store.getSignature(incoming);
        const currentList = Store.getConversations();
        const sameSig = (incomingSig === __lastRenderedSignature && incoming.length === currentList.length && currentList.length > 0);

        if (!force && sameSig && Date.now() - __lastRenderTime < 500) {
            const lastSyncElFast = $('lastSync');
            if (lastSyncElFast && lastSyncVal) {
                const syncFmtFast = typeof t === 'function'
                    ? t('lastSync', new Date(lastSyncVal).toLocaleString(), incoming.length)
                    : `Last sync: ${new Date(lastSyncVal).toLocaleString()} | Total: ${incoming.length}`;
                lastSyncElFast.textContent = syncFmtFast;
            }
            return;
        }

        // Deduplicate and sanitize titles via ConversationsStore (scrubs isBad titles and sorts with compareConversations)
        const { processed, hasDirtyTitles } = Store.normalizeAndDeduplicate
            ? Store.normalizeAndDeduplicate(incoming)
            : { processed: (incoming || []).slice().sort(compareConversations), hasDirtyTitles: false };

        if ((hasDirtyTitles || processed.length !== (incoming || []).length) && Storage) {
            Storage.setConversations(slot, processed).catch(() => {});
        }

        Store.setConversations(processed);

        const lastSyncEl = $('lastSync');
        if (lastSyncEl) {
            if (lastSyncVal) {
                lastSyncEl.textContent = typeof t === 'function'
                    ? t('lastSync', new Date(lastSyncVal).toLocaleString(), processed.length)
                    : `Last sync: ${new Date(lastSyncVal).toLocaleString()} | Total: ${processed.length}`;
            } else {
                lastSyncEl.textContent = processed.length ? (typeof t === 'function' ? t('selectedStat', 0, processed.length) : `${processed.length} total`) : '';
            }
        }

        const syncCountEl = $('syncCount');
        if (syncCountEl && processed.length) {
            syncCountEl.textContent = typeof t === 'function' ? t('syncedBadge', processed.length) : `Synced: ${processed.length}`;
        }

        if (List) {
            List.render(processed, exportedIds, prevSelected, __chatSearchFilter);
            List.updateStat(processed);
        }

        __lastRenderedSignature = Store.getSignature(processed);
        __lastRenderTime = Date.now();
        await checkExportSession();
        if (__pendingTakeoutChecker) {
            await __pendingTakeoutChecker();
        }
    } catch (e) {
        console.error('[workbench:init] loadStore error', e);
    }
}

function bindSearchAndSelection(): void {
    const searchInput = ($('chatSearchInput') || $('search')) as HTMLInputElement | null;
    searchInput?.addEventListener('input', (e: Event) => {
        __chatSearchFilter = ((e.target as HTMLInputElement).value || '').trim();
        const doFilter = () => {
            const Store = getStore();
            const List = getList();
            const convs = Store ? Store.getConversations() : [];
            const expMap = Store ? Store.getExportedIds() : {};
            const currentSelected = List ? List.getSelectedIds() : new Set<string>();
            if (List) List.render(convs, expMap, currentSelected, __chatSearchFilter);
        };
        const Store = getStore();
        const convs = Store ? Store.getConversations() : [];
        if (convs && convs.length > 100) {
            clearTimeout(__searchDebounceTimer);
            __searchDebounceTimer = setTimeout(doFilter, 100);
        } else {
            doFilter();
        }
    });

    // List Selection Filter Buttons
    $('btnSelectAll')?.addEventListener('click', () => {
        const Store = getStore();
        const List = getList();
        const convs = Store ? Store.getConversations() : [];
        if (List) List.selectAll(convs);
    });
    ($('btnSelectNone') || $('btnDeselectAll'))?.addEventListener('click', () => {
        const Store = getStore();
        const List = getList();
        const convs = Store ? Store.getConversations() : [];
        if (List) List.deselectAll(convs);
    });

    // Account Slot Switch Handler
    $('accountSlotSelect')?.addEventListener('change', async (e: Event) => {
        const newSlot = (e.target as HTMLSelectElement).value;
        console.log('[workbench] Account slot changed to:', newSlot);
        const Store = getStore();
        if (Store) {
            Store.setCurrentSlot(newSlot);
            await loadStore();
        }
    });

    // Tour guide trigger
    $('btnTourGuide')?.addEventListener('click', () => {
        const Tour = getTour();
        if (Tour && Tour.startTour) {
            Tour.startTour(0);
        }
    });
}

function initHeaderVersion(): void {
    const verEl = $('ver');
    if (verEl) {
        try {
            verEl.textContent = 'v' + (chrome.runtime.getManifest()?.version || (typeof __EXT_VERSION__ !== 'undefined' ? __EXT_VERSION__ : '1.4.3'));
        } catch (e) {
            if (typeof console !== 'undefined' && console.debug) console.debug('[GemExporter:optionsInit]', e);
        }
    }
}

export function init({ onCheckPendingTakeout }: OptionsInitOptions = {}): void {
    if (typeof window !== 'undefined') {
        (window as any).__workbenchLoadStore = loadStore;
    }
    __pendingTakeoutChecker = onCheckPendingTakeout || null;
    initHeaderVersion();
    const Log = getLog();
    if (Log && Log.init) Log.init('log');
    bindSearchAndSelection();
}

export const OptionsInit = {
    init,
    loadStore,
    updateAccountSlotSelector,
    checkExportSession,
    getSearchFilter,
    setSearchFilter,
    log,
    clearLog,
    renderLog,
    compareConversations,
    isBad,
    normId,
    cleanTitle,
    isRealTitle,
    resolveTitle,
    getEffectiveTime
};

(OptionsInit as any).OptionsInit = OptionsInit;
(OptionsInit as any).default = OptionsInit;

if (typeof globalThis !== 'undefined') {
    (globalThis as any).OptionsInit = OptionsInit;
}
if (typeof module === 'object' && module.exports) {
    module.exports = OptionsInit;
}

export default OptionsInit;
