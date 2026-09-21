// src/ui/options/modules/optionsExport.ts - Export interaction & pipeline runner
import type { OptionsExportOptions } from '../../../types/ui.js';
import { ConversationsStore as DefaultConversationsStore } from '../../state/conversationsStore.js';
import { ListView as DefaultListView } from '../../views/listView.js';
import { ExportController as DefaultExportController } from '../../controllers/exportController.js';
import { DialogView as DefaultDialogView } from '../../views/dialogView.js';
import { DirHandleController as DefaultDirHandle } from '../../controllers/dirHandleController.js';
import { FormatStore as DefaultFormatStore } from '../../../core/storage/formatStore.js';
import { TakeoutEngine as DefaultTakeoutEngine } from '../../../core/engine/takeoutEngine.js';
import { GeminiUtils as DefaultGeminiUtils, getErrorMessage } from '../../../core/utils/utils.js';
import { GeminiConstants as DefaultGeminiConstants } from '../../../core/utils/constants.js';
import { I18n as DefaultI18n } from '../../../core/utils/i18n.js';
import { LiveStorageManager as DefaultLiveStorageManager } from '../../../core/storage/liveStorageManager.js';

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

const getLang = (): string => {
    const i18n = getI18n();
    if (i18n && typeof i18n.getLang === 'function') {
        return i18n.getLang();
    }
    return 'en';
};

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

const getController = () => {
    if (typeof DefaultExportController !== 'undefined' && DefaultExportController) return DefaultExportController;
    if (typeof ExportController !== 'undefined') return ExportController;
    return null;
};

const getFormats = () => {
    if (typeof FormatStore !== 'undefined' && FormatStore) return FormatStore;
    if (typeof DefaultFormatStore !== 'undefined' && DefaultFormatStore) return DefaultFormatStore;
    if (typeof globalThis !== 'undefined' && (globalThis as any).FormatStore) return (globalThis as any).FormatStore;
    return null;
};

const getTakeoutEngine = () => {
    if (typeof TakeoutEngine !== 'undefined' && TakeoutEngine) return TakeoutEngine;
    if (typeof DefaultTakeoutEngine !== 'undefined' && DefaultTakeoutEngine) return DefaultTakeoutEngine;
    if (typeof globalThis !== 'undefined' && (globalThis as any).TakeoutEngine) return (globalThis as any).TakeoutEngine;
    return null;
};

const getConstants = () => {
    if (typeof GeminiConstants !== 'undefined' && GeminiConstants) return GeminiConstants;
    if (typeof DefaultGeminiConstants !== 'undefined' && DefaultGeminiConstants) return DefaultGeminiConstants;
    if (typeof globalThis !== 'undefined' && (globalThis as any).GeminiConstants) return (globalThis as any).GeminiConstants;
    return null;
};

const getDialogs = () => {
    if (typeof DefaultDialogView !== 'undefined' && DefaultDialogView) return DefaultDialogView;
    if (typeof DialogView !== 'undefined') return DialogView;
    return null;
};

const getDirHandle = () => {
    if (typeof DefaultDirHandle !== 'undefined' && DefaultDirHandle) return DefaultDirHandle;
    if (typeof DirHandleController !== 'undefined') return DirHandleController;
    return null;
};

const getLiveStorage = () => {
    if (typeof LiveStorageManager !== 'undefined' && LiveStorageManager) return LiveStorageManager;
    if (typeof DefaultLiveStorageManager !== 'undefined' && DefaultLiveStorageManager) return DefaultLiveStorageManager;
    if (typeof globalThis !== 'undefined' && (globalThis as any).LiveStorageManager) return (globalThis as any).LiveStorageManager;
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

export const isRealTitle = (tStr?: string | null, id?: string | null): boolean => {
    const utils = getUtils();
    if (utils && typeof utils.isRealTitle === 'function') return utils.isRealTitle(tStr as string, id as string);
    return !!(tStr && String(tStr).trim().length > 1);
};

let __loadStore: ((force?: boolean) => Promise<any>) | null = null;
let __log: ((msg: string, level?: 'info' | 'warn' | 'error') => void) | null = null;
let __getSearchFilter: () => string = () => '';
let _isExporting = false;
let _lastFailedChats: any[] = [];

export function getLastFailedChats(): any[] {
    return _lastFailedChats;
}

export function renderExportFailureBanner(failedList: any[]): void {
    _lastFailedChats = Array.isArray(failedList) ? failedList : [];
    const card = $('exportFailureCard');
    if (!card) return;
    if (!_lastFailedChats.length) {
        card.style.display = 'none';
        return;
    }
    const titleEl = $('exportFailureTitle');
    if (titleEl) {
        titleEl.textContent = typeof t === 'function' ? t('exportFailureBannerTitle') : '部分会话导出失败';
    }
    const btnRetry = $('btnRetryFailed') as HTMLButtonElement | null;
    if (btnRetry) {
        btnRetry.textContent = typeof t === 'function' ? t('btnRetryFailedCount', _lastFailedChats.length) : `重试失败项 (${_lastFailedChats.length})`;
        btnRetry.onclick = () => {
            retryFailedExport();
        };
    }
    const btnDismiss = $('btnDismissFailure') as HTMLButtonElement | null;
    if (btnDismiss) {
        btnDismiss.onclick = () => {
            card.style.display = 'none';
        };
    }
    const listEl = $('exportFailureList');
    if (listEl) {
        listEl.innerHTML = '';
        _lastFailedChats.slice(0, 20).forEach(item => {
            const row = document.createElement('div');
            row.style.whiteSpace = 'nowrap';
            row.style.overflow = 'hidden';
            row.style.textOverflow = 'ellipsis';
            row.style.padding = '1px 0';
            const itemTitle = item.title || item.id || 'Untitled';
            const itemErr = item.error ? ` (${item.error})` : '';
            row.textContent = `• ${itemTitle}${itemErr}`;
            row.title = `${itemTitle}${itemErr}`;
            listEl.appendChild(row);
        });
        if (_lastFailedChats.length > 20) {
            const more = document.createElement('div');
            more.style.fontStyle = 'italic';
            more.textContent = `... 以及其他 ${_lastFailedChats.length - 20} 项`;
            listEl.appendChild(more);
        }
    }
    card.style.display = 'block';
}

export function hideExportFailureBanner(): void {
    _lastFailedChats = [];
    const card = $('exportFailureCard');
    if (card) card.style.display = 'none';
}

export async function retryFailedExport(): Promise<void> {
    if (!_lastFailedChats.length) return;
    const List = getList();
    const Store = getStore();
    const failedIds = new Set<string>();
    for (const c of _lastFailedChats) {
        if (c.id) {
            failedIds.add(c.id);
            failedIds.add(normId(c.id));
            failedIds.add('c_' + normId(c.id));
        }
    }
    if (List && typeof List.selectByIds === 'function') {
        List.selectByIds(failedIds, Store ? Store.getConversations() : undefined);
    }
    hideExportFailureBanner();
    await exportSelected();
}

export function log(msg: string, level: 'info' | 'warn' | 'error' = 'info'): void {
    if (__log) __log(msg, level);
    else console.log(`[EXPORT ${level}]`, msg);
}

export function updateZipUi(): void {
    const zipCheck = $('includeZip') as HTMLInputElement | null;
    if (!zipCheck) return;
    const isZip = zipCheck.checked;
    const btnExport = $('btnExport');
    if (btnExport) {
        btnExport.textContent = isZip
            ? (typeof t === 'function' ? t('btnExportZip') : '导出选中 → ZIP')
            : (typeof t === 'function' ? t('btnExportFolder') : '导出选中 → 文件夹');
    }
    const liveToggle = $('liveSaveDiskToggle') as HTMLInputElement | null;
    const isLiveDisk = !!liveToggle?.checked;
    const dirBox = $('dirBox');
    const btnSetDir = $('btnSetDir') as HTMLButtonElement | null;
    const disableDir = isZip && !isLiveDisk;
    if (dirBox) {
        dirBox.style.opacity = disableDir ? '0.28' : '1';
        dirBox.style.pointerEvents = disableDir ? 'none' : 'auto';
        dirBox.style.filter = disableDir ? 'grayscale(0.8)' : 'none';
    }
    if (btnSetDir) {
        btnSetDir.disabled = disableDir;
    }
}

export async function startExportPipeline(
    selected: any[],
    format: string,
    skip: boolean,
    includeIndex: boolean,
    includeAssets: boolean,
    includeZip: boolean,
    dirHandle: any
): Promise<void> {
    const Store = getStore();
    const Controller = getController();
    const DirHandle = getDirHandle();
    const List = getList();

    const convs = Store ? Store.getConversations() : [];

    // S-1 Memory Guardrail: Pre-flight memory estimation for large ZIP exports
    if (includeZip) {
        const convMap = new Map<string, any>((convs || []).map((c: any) => [normId(c.id), c]));
        let totalAttachments = 0;
        let totalMessages = 0;
        for (const item of selected) {
            const rawId = typeof item === 'string' ? item : item?.id;
            const conv = (rawId ? convMap.get(normId(rawId)) : null) || (typeof item === 'object' ? item : null);
            if (conv) {
                totalAttachments += (conv.attachmentCount || conv.attachments?.length || 0);
                totalMessages += (conv.messageCount || conv.messages?.length || 0);
            }
        }
        // Approximate: ~1.8MB per attachment, 20KB per message, 50KB per conversation metadata
        const estimatedMb = Math.round((totalAttachments * 1.8) + (totalMessages * 0.02) + (selected.length * 0.05));
        if (estimatedMb >= 300) {
            const warnMsg = typeof t === 'function'
                ? t('exportLargeMemoryWarn', estimatedMb)
                : `当前导出预估包含较多媒体资源 (约 ${estimatedMb}MB)。ZIP 模式将在内存中全量缓冲，若遇到内存限制推荐切换为【文件夹直写】模式以避免内存压力。`;
            log(warnMsg, 'warn');
        }
    }

    if (!includeZip && !dirHandle) {
        try {
            if (DirHandle) {
                dirHandle = await DirHandle.requestDirHandle();
                const dirLabel = $('dirLabel');
                if (dirLabel && dirHandle) dirLabel.textContent = typeof t === 'function' ? t('dirCurrent', dirHandle.name) : `已选目录: ${dirHandle.name}`;
                const liveStorage = getLiveStorage();
                if (liveStorage && typeof liveStorage.setLiveConfig === 'function' && dirHandle) {
                    await liveStorage.setLiveConfig({ dirName: dirHandle.name });
                }
            }
        } catch (err: unknown) {
            const errMsg = getErrorMessage(err);
            log(typeof t === 'function' ? t('dirCancelled', errMsg) : `未选择导出目录: ${errMsg}`, 'warn');
            return;
        }
    }

    hideExportFailureBanner();
    const progWrap = $('progWrap');
    const bar = $('bar');
    const progText = $('progText');
    if (progWrap) progWrap.style.display = 'block';
    if (bar) bar.style.width = '2%';
    if (progText) progText.textContent = typeof t === 'function' ? t('startExport') : 'Preparing export...';

    log(typeof t === 'function'
        ? t('exportStartingDetail', selected.length, format.toUpperCase(), includeZip ? 'ZIP' : (typeof t === 'function' ? t('folder') : 'Folder'), includeAssets ? 'ON' : 'OFF')
        : `Starting export: ${selected.length} chats | Format: ${format.toUpperCase()} | Target: ${includeZip ? 'ZIP' : 'Folder'}`);

    if (!Controller) {
        log('ExportController not available', 'error');
        return;
    }

    try {
        const currentSlot = Store ? Store.getCurrentSlot() : 'u0';
        const exportedIds = Store ? Store.getExportedIds() : {};
        const takeoutEngine = getTakeoutEngine();

        const result = await Controller.runExport({
            selected,
            format,
            skip,
            includeIndex,
            includeAssets,
            useZip: includeZip,
            dirHandle: DirHandle ? DirHandle.getDirHandle() : null,
            currentSlot,
            conversations: convs,
            exportedIds,
            takeoutEngine
        }, {
            onProgress: (progress: any, txt: string) => {
                const isEn = typeof getLang === 'function' && getLang() === 'en';
                const utils = getUtils();
                const formatted = (utils && typeof utils.formatExportProgress === 'function')
                    ? utils.formatExportProgress(progress, txt, isEn)
                    : { text: txt || '', pct: typeof progress === 'number' ? progress : (progress?.pct || 0) };

                if (bar && typeof formatted.pct !== 'undefined') {
                    bar.style.width = `${Math.min(Math.max(formatted.pct, 2), 100)}%`;
                }
                if (progText && formatted.text) {
                    progText.textContent = formatted.text;
                }
            },
            onLog: (msg: string, lvl: 'info' | 'warn' | 'error') => log(msg, lvl),
            onTitleUpdated: (chatId: string, newTitle: string, source: string) => {
                const currentConvs = Store ? Store.getConversations() : [];
                const item = currentConvs.find((c: any) => normId(c.id) === normId(chatId));
                if (item && isRealTitle(newTitle, chatId)) {
                    const utils = getUtils();
                    if (utils && typeof utils.setTitleBySource === 'function') {
                        utils.setTitleBySource(item, source || 'rpc', newTitle);
                    } else {
                        item.title = newTitle;
                        (item as any).titleSource = source || 'rpc';
                    }
                }
            },
            onItemExported: async (chatId: string, titleOrRecord: any, maybeRecord: any) => {
                const exportRecord = (maybeRecord && typeof maybeRecord === 'object')
                    ? maybeRecord
                    : ((titleOrRecord && typeof titleOrRecord === 'object') ? titleOrRecord : null);
                if (Store && exportRecord) {
                    const cur = Store.getExportedIds();
                    cur[chatId] = exportRecord;
                    cur['c_' + normId(chatId)] = exportRecord;
                    cur[normId(chatId)] = exportRecord;
                    Store.setExportedIds(cur);
                    const cSlot = Store.getCurrentSlot()!;
                    await Store!.saveExportedIds(cSlot, cur);
                    const currentConvs = Store.getConversations();
                    if (List) {
                        if (typeof List.updateItemExportStatus === 'function') {
                            List.updateItemExportStatus(chatId, exportRecord);
                        } else {
                            const currentSelected = List.getSelectedIds() || new Set<string>();
                            List.render(currentConvs, cur, currentSelected, __getSearchFilter());
                        }
                        List.updateStat(currentConvs);
                    }
                }
            }
        });

        if (result && result.aborted) {
            log(typeof t === 'function' ? t('exportAborted') : '导出任务已被用户中止', 'warn');
            if (progText) progText.textContent = typeof t === 'function' ? t('exportAborted') : '导出已终止';
        } else {
            const failedList = Array.isArray(result?.failedChats) ? result.failedChats : [];
            const failedCount = failedList.length;
            const successCount = typeof result?.landedChats === 'number'
                ? result.landedChats
                : (typeof result?.exportedCount === 'number' ? result.exportedCount : Math.max(0, selected.length - failedCount));

            let finishMsg = '';
            if (failedCount > 0) {
                if (typeof t === 'function') {
                    const translated = t('exportCompletedPartial', successCount, failedCount);
                    if (translated && translated !== 'exportCompletedPartial') {
                        finishMsg = translated;
                    }
                }
                if (!finishMsg) {
                    const isEn = typeof getLang === 'function' && getLang() === 'en';
                    finishMsg = isEn
                        ? `Export finished: ${successCount} succeeded, ${failedCount} failed.`
                        : `导出完成：成功 ${successCount} 篇，失败 ${failedCount} 篇。`;
                }
                log(finishMsg, 'warn');
                renderExportFailureBanner(failedList);
            } else {
                if (typeof t === 'function') {
                    const translated = t('exportSuccess', successCount);
                    if (translated && translated !== 'exportSuccess') {
                        finishMsg = translated;
                    }
                }
                if (!finishMsg) {
                    const isEn = typeof getLang === 'function' && getLang() === 'en';
                    finishMsg = isEn
                        ? `Export completed! ${successCount} conversations exported.`
                        : `导出完成！已导出 ${successCount} 篇对话。`;
                }
                log(finishMsg, 'info');
                hideExportFailureBanner();
            }
            if (bar) bar.style.width = '100%';
            if (progText) progText.textContent = finishMsg;
        }
    } catch (err: unknown) {
        const errMsg = getErrorMessage(err);
        log(typeof t === 'function' ? t('exportFailed', errMsg) : `Export failed: ${errMsg}`, 'error');
        if (progText) progText.textContent = `Error: ${errMsg}`;
    } finally {
        setTimeout(() => {
            if (progWrap) progWrap.style.display = 'none';
            if (bar) bar.style.width = '0%';
        }, 3000);
        if (__loadStore) await __loadStore(true);
    }
}

export async function exportSelected(overrideFormat: string | null = null): Promise<void> {
    if (_isExporting) return;
    _isExporting = true;
    try {
        const Store = getStore();
        const List = getList();
        const Formats = getFormats();
        const Dialogs = getDialogs();
        const DirHandle = getDirHandle();

    const convs = Store ? Store.getConversations() : [];
    const selected = List ? List.getSelected(convs) : [];
    if (!selected.length) {
        const noSelMsg = typeof t === 'function' ? t('noSelection') : 'Please select at least one conversation!';
        log(noSelMsg, 'warn');
        const progTextEl = $('progText');
        if (progTextEl) progTextEl.textContent = noSelMsg;
        return;
    }

    const formatSelect = $('format') as HTMLSelectElement | null;
    const format = overrideFormat || (Formats ? Formats.getCurrentFormat(document.body.classList.contains('dev-mode'), formatSelect?.value) : (formatSelect?.value || 'markdown'));
    const skipCheck = $('skipExported') as HTMLInputElement | null;
    const skip = skipCheck ? skipCheck.checked : false;
    const includeIndex = false;
    const assetsCheck = $('includeAssets') as HTMLInputElement | null;
    const includeAssets = assetsCheck ? assetsCheck.checked : true;
    const zipCheck = $('includeZip') as HTMLInputElement | null;
    const includeZip = zipCheck ? zipCheck.checked : true;
    const dirHandle = DirHandle ? DirHandle.getDirHandle() : null;

    const constants = getConstants();
    const threshold = (constants && constants.DIRECT_WRITE_THRESHOLD) ? constants.DIRECT_WRITE_THRESHOLD : 50;
    if (includeZip && !dirHandle && selected.length >= threshold && Dialogs && Dialogs.showDirectWritePrompt) {
        const suppressKey = (constants && constants.STORAGE_KEYS?.SUPPRESS_DIRECT_WRITE_PROMPT) || 'gemini_suppress_direct_write_prompt';
        let isSuppressed = false;
        try {
            const d = await chrome.storage.local.get([suppressKey]);
            isSuppressed = !!d[suppressKey];
        } catch (e) {
            console.warn('[GemExporter:storage] Storage operation failed:', e);
        }

        if (!isSuppressed) {
            try {
                await chrome.storage.local.set({ [suppressKey]: true });
            } catch (e) {
                console.warn('[GemExporter:storage] Storage operation failed:', e);
            }

            Dialogs.showDirectWritePrompt(
                selected.length,
                async () => {
                    try {
                        let newHandle: any = null;
                        if (DirHandle) {
                            newHandle = await DirHandle.requestDirHandle();
                            const dirLabel = $('dirLabel');
                            if (dirLabel) dirLabel.textContent = typeof t === 'function' ? t('dirCurrent', newHandle.name) : `已选目录: ${newHandle.name}`;
                            log(typeof t === 'function' ? t('logFolderSelected', newHandle.name) : `已选择保存目录: ${newHandle.name}`);
                            const liveStorage = getLiveStorage();
                            if (liveStorage && typeof liveStorage.setLiveConfig === 'function') {
                                await liveStorage.setLiveConfig({ dirName: newHandle.name });
                            }
                        }
                        const zipCh = $('includeZip') as HTMLInputElement | null;
                        if (zipCh) {
                            zipCh.checked = false;
                            updateZipUi();
                            try {
                                await chrome.storage.local.set({ gemini_export_zip: false });
                            } catch (e) {
                                console.warn('[GemExporter:storage] Storage operation failed:', e);
                            }
                        }
                        await startExportPipeline(selected, format, skip, includeIndex, includeAssets, false, newHandle);
                    } catch (err: unknown) {
                        const errMsg = getErrorMessage(err);
                        log(typeof t === 'function' ? t('dirCancelled', errMsg) : `未选择导出目录: ${errMsg}`, 'warn');
                    }
                },
                async () => {
                    await startExportPipeline(selected, format, skip, includeIndex, includeAssets, true, null);
                }
            );
            return;
        }
    }

    await startExportPipeline(selected, format, skip, includeIndex, includeAssets, includeZip, dirHandle);
    } finally {
        _isExporting = false;
    }
}

export async function init({ loadStore, log: logFn, getSearchFilter }: OptionsExportOptions = {}): Promise<void> {
    __loadStore = loadStore || null;
    __log = logFn || null;
    if (getSearchFilter) __getSearchFilter = getSearchFilter;

    const Formats = getFormats();
    const DirHandle = getDirHandle();
    const Controller = getController();
    const Dialogs = getDialogs();
    const Store = getStore();
    const List = getList();

    // Export Settings Init (ZIP & Formats)
    const zipCheck = $('includeZip') as HTMLInputElement | null;
    if (Formats && Formats.loadFormat) {
        const { format } = await Formats.loadFormat();
        const fmtSelect = $('format') as HTMLSelectElement | null;
        if (fmtSelect) fmtSelect.value = format;
        fmtSelect?.addEventListener('change', (e: Event) => Formats.saveFormat((e.target as HTMLSelectElement).value));
    }

    if (zipCheck) {
        const d = await chrome.storage.local.get(['gemini_export_zip']);
        if (typeof (d as any).gemini_export_zip !== 'undefined') {
            zipCheck.checked = (d as any).gemini_export_zip as boolean;
        } else {
            zipCheck.checked = true;
        }
        updateZipUi();
        zipCheck.addEventListener('change', () => {
            updateZipUi();
            chrome.storage.local.set({ gemini_export_zip: zipCheck.checked });
        });
    }

    // Directory selection
    $('btnSetDir')?.addEventListener('click', async () => {
        try {
            if (DirHandle) {
                const handle = await DirHandle.requestDirHandle();
                const dirLabel = $('dirLabel');
                if (dirLabel) dirLabel.textContent = typeof t === 'function' ? t('dirCurrent', handle.name) : `已选目录: ${handle.name}`;
                log(typeof t === 'function' ? t('logFolderSelected', handle.name) : `已选择保存目录: ${handle.name}`);
                const liveStorage = getLiveStorage();
                if (liveStorage && typeof liveStorage.setLiveConfig === 'function') {
                    await liveStorage.setLiveConfig({ dirName: handle.name });
                }
            }
        } catch (err: unknown) {
            const errMsg = getErrorMessage(err);
            log(typeof t === 'function' ? t('dirCancelled', errMsg) : `选择目录失败: ${errMsg}`, 'warn');
        }
    });

    // Directory restore on load
    if (DirHandle) {
        try {
            const savedHandle = await DirHandle.restoreSavedDirHandle();
            if (savedHandle) {
                const dirLabel = $('dirLabel');
                if (dirLabel) dirLabel.textContent = typeof t === 'function' ? t('dirCurrent', savedHandle.name) : `已选目录: ${savedHandle.name}`;
                log(typeof t === 'function' ? t('logDirRestored', savedHandle.name) : `已恢复保存的导出目录: ${savedHandle.name}`);
            }
        } catch (e) {
            console.debug('[workbench:export] restoreSavedDirHandle error', e);
        }
    }

    // Export Buttons
    $('btnExport')?.addEventListener('click', () => exportSelected());
    $('btnExportJson')?.addEventListener('click', () => exportSelected('json'));
    $('btnCancel')?.addEventListener('click', () => {
        if (Controller) Controller.abort();
        log(typeof t === 'function' ? t('stoppingExport') : '正在终止导出任务...', 'warn');
    });
    $('btnResumeExport')?.addEventListener('click', () => {
        const convs = Store ? Store.getConversations() : [];
        const expMap = Store ? Store.getExportedIds() : {};
        if (List) List.selectUnexported(convs, expMap);
        exportSelected();
    });
    $('btnDismissExportBanner')?.addEventListener('click', () => {
        if (Dialogs) Dialogs.dismissExportBanner();
    });
}

export const OptionsExport = {
    init,
    exportSelected,
    startExportPipeline,
    updateZipUi,
    getLastFailedChats,
    renderExportFailureBanner,
    hideExportFailureBanner,
    retryFailedExport
};

(OptionsExport as any).OptionsExport = OptionsExport;
(OptionsExport as any).default = OptionsExport;

if (typeof globalThis !== 'undefined') {
    (globalThis as any).OptionsExport = OptionsExport;
}
if (typeof module === 'object' && module.exports) {
    module.exports = OptionsExport;
}

export default OptionsExport;
