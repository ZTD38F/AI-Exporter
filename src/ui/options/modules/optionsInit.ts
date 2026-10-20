import type { OptionsInitOptions } from '../../../types/ui.js';
import {
    t,
    getStore,
    getList,
    getLogView as getLog,
    getDialogs,
    getAccountView as getAccount,
    getExportCtrl as getController,
    getTour,
    getStorage
} from '../optionsContext.js';
import { $ } from '../../uiCommon.js';
import { normId } from '../../../core/utils/pathUtils.js';
import {
    cleanTitle,
    isRealTitle,
    resolveTitle,
    getEffectiveTimestamp,
    compareConversations
} from '../../../core/utils/utils.js';
import { STORAGE_KEYS } from '../../../core/utils/constants.js';

export { normId, cleanTitle, isRealTitle, resolveTitle, compareConversations };
export const getEffectiveTime = getEffectiveTimestamp;
export const isBad = (tStr?: string | null, id?: string | null): boolean => !isRealTitle(tStr, id || undefined);

let __lastRenderedSignature = '';
let __lastRenderTime = 0;
let __chatSearchFilter = '';
let __chatFilterType = 'all';
let __searchDebounceTimer: any = null;
let __pendingTakeoutChecker: (() => Promise<void> | void) | null = null;

export function getChatFilterType(): string {
    return __chatFilterType;
}

export function setChatFilterType(type: string): void {
    __chatFilterType = type || 'all';
    const sel = $('chatFilterSelect') as HTMLSelectElement | null;
    if (sel) sel.value = __chatFilterType;
}

function getFailedChatIds(): Set<string> {
    const ids = new Set<string>();
    const Dialogs = getDialogs();
    const failedList = (Dialogs?.getLastFailedChats?.()) ?? DialogView.getLastFailedChats();
    if (Array.isArray(failedList)) {
        for (const item of failedList) {
            const id = typeof item === 'string' ? item : (item?.id || item?.chatId);
            if (id) {
                ids.add(id);
                ids.add(normId(id));
            }
        }
    }
    return ids;
}

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
        const data = await chrome.storage.local.get([STORAGE_KEYS.LAST_EXPORT_SESSION]);
        const session = data[STORAGE_KEYS.LAST_EXPORT_SESSION] as any;
        if (session && Array.isArray(session.failedChats) && session.failedChats.length > 0) {
            if (typeof (Dialogs as any)?.setLastFailedChats === 'function') {
                (Dialogs as any).setLastFailedChats(session.failedChats);
            }
        }
        const slot = Store ? Store.getCurrentSlot() : 'u0';
        Dialogs.renderExportBanner(session, slot, isRunning);
    } catch (e) {
        console.debug('[workbench:init] checkExportSession error', e);
    }
}

export async function loadStore(force: boolean = false, customSelected?: Set<string>): Promise<any> {
    try {
        const Store = getStore();
        const List = getList();
        const Storage = getStorage();
        if (!Store) return;
        const slot = Store.getCurrentSlot() || 'u0';
        const { conversations: incoming, exportedIds } = await Store.loadStore(slot);
        updateAccountSlotSelector();
        const hadExistingConvs = Store.getConversations().length > 0;

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

        const { processed, hasDirtyTitles } = Store.normalizeAndDeduplicate
            ? Store.normalizeAndDeduplicate(incoming)
            : { processed: (incoming || []).slice().sort(compareConversations), hasDirtyTitles: false };

        if ((hasDirtyTitles || processed.length !== (incoming || []).length) && Storage) {
            // SSOT: the normalize-then-write-back runs as an atomic transaction on
            // the freshest stored list. Blind-writing `processed` (derived from a
            // possibly stale UI snapshot) could clobber a concurrent tab's sync.
            const writeBack = typeof Storage.transactConversations === 'function'
                ? Storage.transactConversations(slot, (existing: any[]) => {
                    const norm = Store.normalizeAndDeduplicate
                        ? Store.normalizeAndDeduplicate(existing)
                        : { processed: (existing || []).slice().sort(compareConversations), hasDirtyTitles: false };
                    if (!norm.hasDirtyTitles && norm.processed.length === (existing || []).length) return null;
                    return { list: norm.processed, changed: 1 };
                })
                : Storage.setConversations(slot, processed);
            writeBack.catch(() => {});
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
            let prevSelected: Set<string> | null = null;
            if (customSelected instanceof Set) {
                prevSelected = customSelected;
            } else {
                try {
                    if (!force && hadExistingConvs) {
                        prevSelected = List.getSelectedIds();
                    }
                } catch {
                    prevSelected = null;
                }
            }
            const failedIds = getFailedChatIds();
            List.render(processed, exportedIds, prevSelected, __chatSearchFilter, __chatFilterType, failedIds);
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
        try {
            const msg = e instanceof Error ? e.message : String(e);
            log(`${typeof t === 'function' ? t('loadStoreFailed', msg) : `加载会话列表失败: ${msg}`}`, 'error');
        } catch { /* log view not ready — console.error above already recorded it */ }
    }
}

function bindSearchAndSelection(): void {
    const searchInput = $('chatSearchInput') as HTMLInputElement | null;
    const filterSelect = $('chatFilterSelect') as HTMLSelectElement | null;

    const doFilter = () => {
        const Store = getStore();
        const List = getList();
        const convs = Store ? Store.getConversations() : [];
        const expMap = Store ? Store.getExportedIds() : {};
        const currentSelected = List ? List.getSelectedIds() : new Set<string>();
        const failedIds = getFailedChatIds();
        if (List) List.render(convs, expMap, currentSelected, __chatSearchFilter, __chatFilterType, failedIds);
    };

    filterSelect?.addEventListener('change', (e: Event) => {
        __chatFilterType = ((e.target as HTMLSelectElement).value || 'all').trim();
        doFilter();
    });

    searchInput?.addEventListener('input', (e: Event) => {
        __chatSearchFilter = ((e.target as HTMLInputElement).value || '').trim();
        const Store = getStore();
        const convs = Store ? Store.getConversations() : [];
        if (convs && convs.length > 100) {
            clearTimeout(__searchDebounceTimer);
            __searchDebounceTimer = setTimeout(doFilter, 100);
        } else {
            doFilter();
        }
    });

    $('btnSelectAll')?.addEventListener('click', () => {
        const Store = getStore();
        const List = getList();
        const convs = Store ? Store.getConversations() : [];
        if (List) List.selectAll(convs);
    });
    $('btnSelectNone')?.addEventListener('click', () => {
        const Store = getStore();
        const List = getList();
        const convs = Store ? Store.getConversations() : [];
        if (List) List.deselectAll(convs);
    });

    $('accountSlotSelect')?.addEventListener('change', async (e: Event) => {
        const newSlot = (e.target as HTMLSelectElement).value;
        console.log('[workbench] Account slot changed to:', newSlot);
        const Store = getStore();
        if (Store) {
            Store.setCurrentSlot(newSlot);
            await loadStore();
        }
    });

    $('btnTourGuide')?.addEventListener('click', () => {
        const Tour = getTour();
        if (Tour && Tour.startTour) {
            void Tour.startTour(0);
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
    getChatFilterType,
    setChatFilterType,
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



export default OptionsInit;
