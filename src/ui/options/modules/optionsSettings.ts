import type { OptionsSettingsOptions } from '../../../types/ui.js';
import {
    getI18n,
    t,
    getStore,
    getList,
    getFormats,
    getStorage,
    getTour,
    getDirHandle as getDirHandleController,
    getLiveStorage,
    getProgressView,
    getExportCtrl,
    getLogView
} from '../optionsContext.js';
import { getLatestEligibleFeature } from '../../tour/featureReleases.js';
import { $ } from '../../uiCommon.js';
import { normId } from '../../../core/utils/pathUtils.js';
import { cleanTitle, resolveTitle } from '../../../core/utils/utils.js';
import { getExtensionVersion, STORAGE_KEYS } from '../../../core/utils/constants.js';
import { isLocalDevelopment } from '../../../core/utils/environment.js';
import { buildDiagnosticSnapshot } from '../../../core/diagnostics/diagnosticSnapshot.js';

export { normId, cleanTitle, resolveTitle };
let __log: ((msg: string, level?: 'info' | 'warn' | 'error') => void) | null = null;
let __clearLog: (() => void) | null = null;
let __renderLog: (() => void) | null = null;
let __updateZipUi: (() => void) | null = null;
let __checkExportSession: (() => Promise<void> | void) | null = null;
let __updateAccountSlotSelector: (() => void) | null = null;
let __getSearchFilter: () => string = () => '';
let __getChatFilterType: () => string = () => {
    const sel = $('chatFilterSelect') as HTMLSelectElement | null;
    return (sel && sel.value) ? sel.value.trim() : 'all';
};

export function log(msg: string, level: 'info' | 'warn' | 'error' = 'info'): void {
    if (__log) __log(msg, level);
    else console.log(`[SETTINGS ${level}]`, msg);
}

export async function handleLangChange(targetLang: 'zh' | 'en'): Promise<void> {
    console.log('[workbench] Switching language to:', targetLang);
    const List = getList();
    const Store = getStore();
    const currentSelected = List ? List.getSelectedIds() : new Set<string>();

    const i18n = getI18n();
    if (i18n && i18n.setLang) {
        await i18n.setLang(targetLang);
    }
    document.documentElement.lang = targetLang === 'zh' ? 'zh-CN' : 'en';
    if (i18n && typeof i18n.applyI18n === 'function') {
        i18n.applyI18n();
    }

    const Progress = getProgressView();
    if (Progress && typeof Progress.reset === 'function') {
        Progress.reset();
    }

    if (__updateAccountSlotSelector) __updateAccountSlotSelector();
    const convs = Store ? Store.getConversations() : [];
    const expMap = Store ? Store.getExportedIds() : {};
    if (List) {
        List.render(convs, expMap, currentSelected, __getSearchFilter(), __getChatFilterType());
        List.updateStat(convs);
    }
    if (__updateZipUi) __updateZipUi();
    if (__checkExportSession) await __checkExportSession();
    const syncCountEl = $('syncCount');
    if (syncCountEl && convs.length) {
        syncCountEl.textContent = typeof t === 'function' ? t('syncedBadge', convs.length) : `Synced: ${convs.length}`;
    }
}

export async function handleDevChange(devOn: boolean): Promise<void> {
    console.log('[workbench] Switching dev mode to:', devOn);
    document.body.classList.toggle('dev-mode', devOn);
    const labelDev = $('labelDevMode');
    if (labelDev) {
        labelDev.style.color = devOn ? 'var(--accent2, #06b6d4)' : 'var(--muted, #8a92b2)';
    }
    if (devOn && __renderLog) __renderLog();

    const Formats = getFormats();
    if (Formats && Formats.handleDevToggle) {
        const selectEl = $('format') as HTMLSelectElement | null;
        if (selectEl) {
            const result = Formats.handleDevToggle(devOn, selectEl.value);
            if (result.changed) {
                selectEl.value = result.format;
                await Formats.saveFormat(result.format);
            }
        }
    }
    const Store = getStore();
    if (Store) await Store.setDevMode(devOn);
}

export async function exportDiagnostics(): Promise<void> {
    try {
        const Store = getStore();
        const slot = Store ? Store.getCurrentSlot() : 'u0';
        const convs = Store ? Store.getConversations() : [];
        const expMap = Store ? Store.getExportedIds() : {};
        const LogView = getLogView();
        const logs = typeof LogView?.getBuffer === 'function' ? LogView.getBuffer() : [];

        const snapshot = await buildDiagnosticSnapshot({
            slot,
            conversations: convs,
            exportedIds: expMap,
            workbenchLogs: logs
        });

        const jsonStr = JSON.stringify(snapshot, null, 2);
        const blob = new Blob([jsonStr], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `gemini_diagnostics_${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 3000);
        log(typeof t === 'function' ? t('diagExportSuccess') : '已生成诊断数据文件', 'info');
    } catch (e: any) {
        log(typeof t === 'function' ? t('diagExportFailed', e?.message || String(e)) : ('导出诊断失败: ' + (e?.message || String(e))), 'error');
    }
}

function bindLanguageControls(): void {
    $('langToggle')?.addEventListener('change', (e: Event) => {
        void handleLangChange((e.target as HTMLInputElement).checked ? 'en' : 'zh');
    });
    $('labelLangZh')?.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        const toggle = $('langToggle') as HTMLInputElement | null;
        if (toggle) toggle.checked = false;
        void handleLangChange('zh');
    });
    $('labelLangEn')?.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        const toggle = $('langToggle') as HTMLInputElement | null;
        if (toggle) toggle.checked = true;
        void handleLangChange('en');
    });
}

function bindDevControls(): void {
    $('devToggle')?.addEventListener('change', (e: Event) => handleDevChange((e.target as HTMLInputElement).checked));
    $('labelDevMode')?.addEventListener('click', () => {
        const dt = $('devToggle') as HTMLInputElement | null;
        if (dt) {
            dt.checked = !dt.checked;
            void handleDevChange(dt.checked);
        }
    });
}

function bindLogControls(): void {
    $('logFilter')?.addEventListener('input', () => { if (__renderLog) __renderLog(); });
    $('logLevel')?.addEventListener('change', () => { if (__renderLog) __renderLog(); });
    $('btnClearLog')?.addEventListener('click', () => { if (__clearLog) __clearLog(); });
    $('btnCopyLog')?.addEventListener('click', async () => {
        const l = $('log');
        const copyBtn = $('btnCopyLog');
        if (l) {
            await navigator.clipboard.writeText(l.textContent || '');
            if (copyBtn) copyBtn.textContent = typeof t === 'function' ? t('copied') : '已复制!';
            setTimeout(() => {
                if (copyBtn) copyBtn.textContent = typeof t === 'function' ? t('btnCopyLog') : '复制';
            }, 1500);
        }
    });
    $('btnExportDiag')?.addEventListener('click', exportDiagnostics);
}

function bindStorageCleanup(): void {
    const List = getList();
    const Store = getStore();

    $('btnClearExported')?.addEventListener('click', async (e?: Event) => {
        if (e && typeof e.preventDefault === 'function') e.preventDefault();
        if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
        const slot = Store ? Store.getCurrentSlot() : 'u0';
        if (Store) await Store.clearExported(slot);
        const convs = Store ? Store.getConversations() : [];
        const expMap = Store ? Store.getExportedIds() : {};
        if (List) {
            if (typeof List.setSelectedIds === 'function') List.setSelectedIds(null);
            List.render(convs, expMap, null, __getSearchFilter(), __getChatFilterType());
            List.updateStat(convs);
        }
        log(typeof t === 'function' ? t('confirmClearExported') : '已清空已导出记录', 'info');
    });

    const btnClearAll = $('btnClearAll') as HTMLButtonElement | null;
    let clearAllTimeout: any = null;
    let isConfirmingClear = false;

    const resetClearBtn = () => {
        if (!btnClearAll) return;
        isConfirmingClear = false;
        if (clearAllTimeout) {
            clearTimeout(clearAllTimeout);
            clearAllTimeout = null;
        }
        btnClearAll.textContent = typeof t === 'function' ? t('btnClearAll') : '清空全部';
        btnClearAll.style.background = 'transparent';
        btnClearAll.style.color = '#ff8a8a';
        btnClearAll.style.borderColor = '#5a2a2a';
    };

    btnClearAll?.addEventListener('click', async () => {
        if (!isConfirmingClear) {
            isConfirmingClear = true;
            btnClearAll.textContent = typeof t === 'function' ? (t('confirmClearAllInPlace') || '⚠️ 确认清空? (3s)') : '⚠️ 确认清空? (3s)';
            btnClearAll.style.background = '#dc2626';
            btnClearAll.style.color = '#ffffff';
            btnClearAll.style.borderColor = '#ef4444';
            clearAllTimeout = setTimeout(resetClearBtn, 3500);
            return;
        }

        resetClearBtn();
        const slot = Store ? Store.getCurrentSlot() : 'u0';
        if (Store) await Store.clearAll(slot);
        const convs = Store ? Store.getConversations() : [];
        const expMap = Store ? Store.getExportedIds() : {};
        if (List) {
            if (typeof List.setSelectedIds === 'function') List.setSelectedIds(null);
            List.render(convs, expMap, null, __getSearchFilter(), __getChatFilterType());
            List.updateStat(convs);
        }
        log(typeof t === 'function' ? t('confirmClearAll') : '本地会话数据已清空');
    });

    document.addEventListener('click', (e) => {
        if (isConfirmingClear && e.target !== btnClearAll) {
            resetClearBtn();
        }
    });
}

async function initLanguage(): Promise<void> {
    try {
        const i18n = getI18n();
        if (i18n) {
            if (i18n.initLanguage) await i18n.initLanguage();
            if (i18n.applyI18n) i18n.applyI18n();
            if (i18n.applyLangToggleUI) i18n.applyLangToggleUI();
            if (i18n.onLanguageChange) i18n.onLanguageChange(() => {
                if (i18n.applyLangToggleUI) i18n.applyLangToggleUI();
            });
        }
    } catch (e) {
        console.warn('[workbench:settings] i18n init error', e);
    }
}

async function initDevMode(): Promise<void> {
    try {
        const isDevEnv = isLocalDevelopment();
        const devWrapper = $('devModeWrapper');
        if (!isDevEnv) {
            if (devWrapper) {
                devWrapper.style.setProperty('display', 'none', 'important');
            }
            document.body.classList.remove('dev-mode');
            const Store = getStore();
            if (Store && Store.setDevMode) {
                await Store.setDevMode(false);
            }
            return;
        }

        if (devWrapper) {
            devWrapper.style.display = 'inline-flex';
        }
        const Store = getStore();
        const devOn = Store ? await Store.getDevMode() : false;
        const devToggle = $('devToggle') as HTMLInputElement | null;
        if (devToggle) devToggle.checked = devOn;
        document.body.classList.toggle('dev-mode', devOn);
        const labelDev = $('labelDevMode');
        if (labelDev) {
            labelDev.style.color = devOn ? 'var(--accent2, #06b6d4)' : 'var(--muted, #8a92b2)';
        }
    } catch (e) {
        if (typeof console !== 'undefined' && console.debug) console.debug('[GemExporter:optionsSettings]', e);
    }
}

export function checkWalkthroughOnOpen(): void {
    try {
        if (typeof window === 'undefined') return;
        const urlParams = new URLSearchParams(window.location.search);
        const isExplicitTour = urlParams.get('tour') === '1';
        if (urlParams.get('notour') === '1') return;

        setTimeout(async () => {
            const Storage = getStorage();
            const Tour = getTour();
            if (!Tour) return;

            const tourDone = (Storage && Storage.isTourCompleted)
                ? await Storage.isTourCompleted()
                : false;

            if (isExplicitTour || !tourDone) {
                if (Tour.startTour) void Tour.startTour(0);
                return;
            }

            const currentAppVersion = getExtensionVersion();
            const lastSeenVersion = (Storage && Storage.getLastSeenFeatureVersion)
                ? await Storage.getLastSeenFeatureVersion()
                : '';

            const eligibleFeature = getLatestEligibleFeature(lastSeenVersion, currentAppVersion);
            if (eligibleFeature && Tour.startFeatureSpotlight) {
                void Tour.startFeatureSpotlight(eligibleFeature.stepId, eligibleFeature.version);
            }
        }, 400);
    } catch (e) {
        if (typeof console !== 'undefined' && console.debug) console.debug('[GemExporter:optionsSettings]', e);
    }
}

export const checkOnboardingTour = checkWalkthroughOnOpen;

export async function init({
    log: logFn,
    clearLog: clearFn,
    renderLog: renderFn,
    updateZipUi: zipFn,
    checkExportSession: expSessFn,
    updateAccountSlotSelector: slotSelFn,
    getSearchFilter: filterFn,
    getChatFilterType: filterTypeFn
}: OptionsSettingsOptions = {}): Promise<void> {
    __log = logFn || null;
    __clearLog = clearFn || null;
    __renderLog = renderFn || null;
    __updateZipUi = zipFn || null;
    __checkExportSession = expSessFn || null;
    __updateAccountSlotSelector = slotSelFn || null;
    if (filterFn) __getSearchFilter = filterFn;
    if (filterTypeFn) __getChatFilterType = filterTypeFn;

    await initLanguage();
    await initDevMode();
    bindLanguageControls();
    bindDevControls();
    bindLogControls();
    bindStorageCleanup();
    await initLiveSaveSettings();
    if (__updateZipUi) __updateZipUi();
}

export function updateLiveSaveFormatAvailability(): void {
    const format = ($('format') as HTMLSelectElement | null)?.value || 'markdown';
    const toggle = $('liveSaveDiskToggle') as HTMLInputElement | null;
    if (!toggle) return;
    const disabled = format !== 'markdown';
    toggle.disabled = disabled;
    if (disabled) toggle.checked = false;
    const label = toggle.closest?.('label');
    if (label) {
        label.style.opacity = disabled ? '0.45' : '';
        label.style.cursor = disabled ? 'not-allowed' : 'pointer';
        label.setAttribute('data-i18n-title', disabled ? 'liveSaveMarkdownOnly' : 'liveSaveDiskTip');
        label.title = t(disabled ? 'liveSaveMarkdownOnly' : 'liveSaveDiskTip');
    }
    if (__updateZipUi) __updateZipUi();
}

export async function initLiveSaveSettings(): Promise<void> {
    const liveStorage = getLiveStorage();
    if (!liveStorage) return;

    const diskToggle = $('liveSaveDiskToggle') as HTMLInputElement | null;
    const dirLabel = $('dirLabel');
    const DirHandle = getDirHandleController();

    try {
        const cfg = await liveStorage.getLiveConfig();
        if (diskToggle) diskToggle.checked = !!cfg.enabledDisk;

        let savedHandle = DirHandle ? DirHandle.getDirHandle() : null;
        if (!savedHandle && DirHandle && typeof DirHandle.restoreSavedDirHandle === 'function') {
            savedHandle = await DirHandle.restoreSavedDirHandle();
        }
        if (savedHandle && dirLabel) {
            dirLabel.textContent = typeof t === 'function' ? t('dirCurrent', savedHandle.name || cfg.dirName || 'Folder') : `已选目录: ${savedHandle.name || cfg.dirName || 'Folder'}`;
            if (dirLabel.style) dirLabel.style.color = '';
        } else if (cfg.dirError === 'permission_prompt_needed' || (DirHandle && typeof DirHandle.getPendingPermissionHandle === 'function' && DirHandle.getPendingPermissionHandle())) {
            if (dirLabel) {
                const folderName = cfg.dirName || 'Folder';
                dirLabel.textContent = typeof t === 'function' ? t('dirPromptNeeded', folderName) : `目录权限待续期: ${folderName}（点击恢复授权）`;
                if (dirLabel.style) {
                    dirLabel.style.color = '#f59e0b';
                    dirLabel.style.cursor = 'pointer';
                }
                dirLabel.onclick = async () => {
                    if (DirHandle && typeof DirHandle.reauthorizeDirHandle === 'function') {
                        const ok = await DirHandle.reauthorizeDirHandle();
                        if (ok) {
                            const h = DirHandle.getDirHandle();
                            if (h && dirLabel) {
                                dirLabel.textContent = typeof t === 'function' ? t('dirCurrent', h.name) : `已选目录: ${h.name}`;
                                dirLabel.style.color = '';
                                dirLabel.style.cursor = 'default';
                                dirLabel.onclick = null;
                                await liveStorage.setLiveConfig({ enabledDisk: true, dirName: h.name, dirError: null });
                                log(typeof t === 'function' ? t('logFolderSelected', h.name) : `已恢复目录权限: ${h.name}`);
                            }
                        }
                    }
                };
            }
        } else if (cfg.dirError === 'not_found' || (!savedHandle && cfg.dirName)) {
            if (diskToggle) diskToggle.checked = false;
            if (dirLabel) {
                dirLabel.textContent = typeof t === 'function' ? t('dirNotFound') : '所选目录已被删除或失效，请重新选择';
                if (dirLabel.style) dirLabel.style.color = '#f59e0b';
            }
        }
    } catch (e) {
        if (typeof console !== 'undefined' && console.debug) console.debug('[OptionsSettings] initLiveSaveSettings error:', e);
    }

    updateLiveSaveFormatAvailability();
    if (diskToggle?.disabled) await liveStorage.setLiveConfig({ enabledDisk: false });
    const formatSelect = $('format') as HTMLSelectElement | null;
    if (formatSelect && !formatSelect.dataset.liveSaveBound) {
        formatSelect.dataset.liveSaveBound = 'true';
        formatSelect.addEventListener('change', updateLiveSaveFormatAvailability);
    }

    if (diskToggle && !diskToggle.dataset.bound) {
        diskToggle.dataset.bound = 'true';
        diskToggle.addEventListener('change', async () => {
            updateLiveSaveFormatAvailability();
            if (diskToggle.disabled) return;
            if (diskToggle.checked) {
                let handle = DirHandle ? DirHandle.getDirHandle() : null;
                if (!handle && DirHandle && typeof DirHandle.restoreSavedDirHandle === 'function') {
                    handle = await DirHandle.restoreSavedDirHandle();
                }

                if (!handle) {
                    try {
                        if (DirHandle && typeof DirHandle.requestDirHandle === 'function') {
                            handle = await DirHandle.requestDirHandle();
                        }
                    } catch (err: any) {
                        diskToggle.checked = false;
                        if (err?.name === 'AbortError') {
                            log(typeof t === 'function' ? t('dirCancelled', '用户取消选择') : '未选择导出目录: 用户取消选择', 'warn');
                        } else {
                            log(typeof t === 'function' ? t('dirCancelled', err?.message || '') : `选择目录失败: ${err?.message || ''}`, 'warn');
                        }
                        if (__updateZipUi) __updateZipUi();
                        return;
                    }
                }

                if (handle) {
                    if (dirLabel) {
                        dirLabel.textContent = typeof t === 'function' ? t('dirCurrent', handle.name) : `已选目录: ${handle.name}`;
                        if (dirLabel.style) dirLabel.style.color = '';
                    }
                    await liveStorage.setLiveConfig({ enabledDisk: true, dirName: handle.name, dirError: null });
                    log(typeof t === 'function' ? t('logFolderSelected', handle.name) : `已开启实时落盘: ${handle.name}`);
                } else {
                    diskToggle.checked = false;
                    await liveStorage.setLiveConfig({ enabledDisk: false });
                }
            } else {
                await liveStorage.setLiveConfig({ enabledDisk: false });
                log(typeof t === 'function' ? t('logLiveSaveDisabled') : '[LiveSave] Live disk sync disabled');
            }
            if (__updateZipUi) __updateZipUi();
        });
    }

    if (typeof chrome !== 'undefined' && chrome.storage?.onChanged && !(globalThis as any).__liveSaveStorageWatcherBound) {
        (globalThis as any).__liveSaveStorageWatcherBound = true;
        chrome.storage.onChanged.addListener((changes: any, area: string) => {
            if (area === 'local' && changes[STORAGE_KEYS.LIVE_SAVE_CONFIG]?.newValue) {
                if (diskToggle) diskToggle.checked = !!changes[STORAGE_KEYS.LIVE_SAVE_CONFIG].newValue.enabledDisk;
                updateLiveSaveFormatAvailability();
                const val = changes[STORAGE_KEYS.LIVE_SAVE_CONFIG].newValue;
                if (val.dirError === 'permission_prompt_needed') {
                    if (dirLabel) {
                        const folderName = val.dirName || 'Folder';
                        dirLabel.textContent = typeof t === 'function' ? t('dirPromptNeeded', folderName) : `目录权限待续期: ${folderName}（点击恢复授权）`;
                        if (dirLabel.style) {
                            dirLabel.style.color = '#f59e0b';
                            dirLabel.style.cursor = 'pointer';
                        }
                    }
                    log(typeof t === 'function' ? t('dirPromptNeeded', val.dirName || 'Folder') : `目录权限待续期: ${val.dirName || 'Folder'}，已暂存至下载目录`, 'warn');
                } else if (val.dirError === 'not_found') {
                    if (diskToggle) diskToggle.checked = false;
                    if (dirLabel) {
                        dirLabel.textContent = typeof t === 'function' ? t('dirNotFound') : '所选目录已被删除或失效，请重新选择';
                        if (dirLabel.style) dirLabel.style.color = '#f59e0b';
                    }
                    log(typeof t === 'function' ? t('dirNotFound') : '所选目录已被删除或失效，实时落盘已暂停', 'warn');
                } else if (val.lastSavedAt && val.lastSavedTitle) {
                    log(typeof t === 'function' ? t('logLiveSaveSuccess', val.lastSavedTitle) : `[实时落盘] 自动保存成功: ${val.lastSavedTitle}`);
                }
            }
            if (area === 'local' && changes[STORAGE_KEYS.LANG]) {
                const newLang = changes[STORAGE_KEYS.LANG].newValue;
                const i18n = getI18n();
                if (newLang && i18n && typeof i18n.getLang === 'function' && i18n.getLang() !== newLang) {
                    void handleLangChange(newLang as 'zh' | 'en');
                }
            }
            if (area === 'local' && changes[STORAGE_KEYS.FORMAT]) {
                const newFmt = String(changes[STORAGE_KEYS.FORMAT].newValue || 'markdown');
                const fmtSelect = $('format') as HTMLSelectElement | null;
                if (fmtSelect && fmtSelect.value !== newFmt) {
                    fmtSelect.value = newFmt;
                }
                updateLiveSaveFormatAvailability();
            }
            if (area === 'local' && (changes.exportedIds || Object.keys(changes).some(k => k.startsWith('gemini_exported_') || k.startsWith('gemini_conversations')))) {
                const exportCtrl = getExportCtrl();
                if (exportCtrl && typeof exportCtrl.isRunning === 'function' && exportCtrl.isRunning()) {
                    return;
                }
                if (typeof (window as any).__workbenchLoadStore === 'function') {
                    (window as any).__workbenchLoadStore();
                }
            }
        });
    }
}

export const OptionsSettings = {
    init,
    initLiveSaveSettings,
    handleLangChange,
    handleDevChange,
    exportDiagnostics,
    checkWalkthroughOnOpen,
    checkOnboardingTour
};



export default OptionsSettings;
