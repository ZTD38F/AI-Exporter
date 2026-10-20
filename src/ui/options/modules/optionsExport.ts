import type { OptionsExportOptions } from '../../../types/ui.js';
import {
    t,
    getLang,
    getStore,
    getList,
    getExportCtrl as getController,
    getFormats,
    getTakeoutEngine,
    getConstants,
    getDialogs,
    getDirHandle,
    getLiveStorage,
    getStorage,
    getUtils
} from '../optionsContext.js';
import { DialogView } from '../../views/dialogView.js';
import { ProgressView } from '../../views/progressView.js';
import { getErrorMessage, isRealTitle } from '../../../core/utils/utils.js';
import { normId } from '../../../core/utils/pathUtils.js';
import { STORAGE_KEYS } from '../../../core/utils/constants.js';
import { warmLocalFontCache } from '../../../core/export/typst/fonts/localFontProvider.js';
import { $ } from '../../uiCommon.js';

export { normId, isRealTitle };

let __loadStore: ((force?: boolean, customSelected?: Set<string>) => Promise<any>) | null = null;
let __log: ((msg: string, level?: 'info' | 'warn' | 'error') => void) | null = null;
let __getSearchFilter: () => string = () => '';
let _isExporting = false;

export function getLastFailedChats(): any[] {
    const Dialogs = getDialogs();
    return (Dialogs?.getLastFailedChats?.()) ?? DialogView.getLastFailedChats();
}

export function renderExportFailureBanner(failedList: any[]): void {
    const Dialogs = getDialogs();
    if (typeof Dialogs?.renderExportFailureBanner === 'function') {
        Dialogs.renderExportFailureBanner(failedList, retryFailedExport);
    } else {
        DialogView.renderExportFailureBanner(failedList, retryFailedExport);
    }
}

export function hideExportFailureBanner(): void {
    const Dialogs = getDialogs();
    if (typeof Dialogs?.hideExportFailureBanner === 'function') {
        Dialogs.hideExportFailureBanner();
    } else {
        DialogView.hideExportFailureBanner();
    }
}



export async function retryFailedExport(): Promise<void> {
    const failedList = getLastFailedChats();
    if (!failedList.length) return;
    const List = getList();
    const Store = getStore();
    const failedIds = new Set<string>();
    for (const c of failedList) {
        if (c.id) {
            // Single add is enough: List.selectByIds() normalizes every id with
            // normId() before matching, so 'c_<id>' / raw variants collapse to
            // the same key. No need to pre-expand aliases here.
            failedIds.add(c.id);
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

/**
 * Export title-update handler, extracted for testability.
 *
 * Applies an export-resolved title to the in-memory conversation AND persists
 * it to storage via the atomic `updateConversation` read-modify-write path
 * (the same convention exportOrchestrator uses). Previously this was a pure
 * in-memory dirty write and the resolved title was lost on page reload.
 *
 * Title arbitration is untouched: the same `setTitleBySource` transform is
 * applied to both the in-memory item and the stored copy.
 *
 * No loop risk: a storage write never re-enters the export pipeline, and
 * exportOrchestrator's own write (when convsNeedSave) carries identical values.
 */
export async function persistTitleUpdate(chatId: string, newTitle: string, source: string, exportSlot?: string): Promise<void> {
    const Store = getStore();
    const visibleSlot = Store?.getCurrentSlot?.() || 'u0';
    const slot = exportSlot || visibleSlot;
    const currentConvs = Store && visibleSlot === slot ? Store.getConversations() : [];
    const item = currentConvs.find((c: any) => normId(c.id) === normId(chatId));
    if ((!item && !exportSlot) || !isRealTitle(newTitle, chatId)) return;
    const utils = getUtils();
    const applyTitle = (chat: any) => {
        if (utils && typeof utils.setTitleBySource === 'function') {
            utils.setTitleBySource(chat, source || 'rpc', newTitle);
        } else {
            chat.title = newTitle;
            (chat as any).titleSource = source || 'rpc';
        }
    };
    // 1) in-memory (existing behavior; keeps the list UI fresh during export)
    if (item) applyTitle(item);
    // 2) persist so the title survives reload
    try {
        const storage = getStorage();
        if (storage && typeof storage.updateConversation === 'function') {
            await storage.updateConversation(slot, chatId, (existing: any) => {
                applyTitle(existing);
            });
        }
    } catch (err) {
        log(`persistTitleUpdate failed for ${chatId}: ${getErrorMessage(err)}`, 'warn');
    }
}

export function selectionAfterExport(
    selectedIds: Iterable<string>,
    selected: any[],
    failedList: any[]
): Set<string> {
    const remaining = new Set<string>(Array.from(selectedIds || [], id => String(id)));
    const failedIds = new Set<string>();
    for (const failed of failedList || []) {
        const rawId = typeof failed === 'string' ? failed : failed?.id || failed?.chatId;
        if (!rawId) continue;
        const nid = normId(String(rawId));
        failedIds.add(String(rawId));
        failedIds.add(nid);
        failedIds.add('c_' + nid);
    }
    for (const chat of selected || []) {
        const rawId = typeof chat === 'string' ? chat : chat?.id;
        if (!rawId) continue;
        const nid = normId(String(rawId));
        if (failedIds.has(String(rawId)) || failedIds.has(nid) || failedIds.has('c_' + nid)) continue;
        remaining.delete(String(rawId));
        remaining.delete(nid);
        remaining.delete('c_' + nid);
    }
    return remaining;
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
    const currentSlot = Store?.getCurrentSlot?.() || 'u0';

    const convs = Store ? Store.getConversations() : [];

    if (includeZip) {
        const estimatedMb = (Controller && typeof Controller.estimateMemoryUsage === 'function')
            ? Controller.estimateMemoryUsage(selected, convs)
            : Math.round((selected.length * 0.05));
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
    ProgressView.show(2, typeof t === 'function' ? t('startExport') : 'Preparing export...');

    log(typeof t === 'function'
        ? t('exportStartingDetail', selected.length, format.toUpperCase(), includeZip ? 'ZIP' : (typeof t === 'function' ? t('folder') : 'Folder'), includeAssets ? 'ON' : 'OFF')
        : `Starting export: ${selected.length} chats | Format: ${format.toUpperCase()} | Target: ${includeZip ? 'ZIP' : 'Folder'}`);

    if (!Controller) {
        log(typeof t === 'function' ? t('exportControllerUnavailable') : 'ExportController not available', 'error');
        return;
    }

    let remainingSelected: Set<string> | null = null;
    try {
        const exportedIds = Store ? Store.getExportedIds() : {};
        const takeoutEngine = getTakeoutEngine();

        const result = await Controller.runExport({
            selected,
            format,
            skip,
            includeIndex,
            includeAssets,
            useZip: includeZip,
            dirHandle: dirHandle || (DirHandle ? DirHandle.getDirHandle() : null),
            currentSlot,
            conversations: convs,
            exportedIds,
            takeoutEngine,
            downloadHandler: async (blob: Blob, filename: string) => {
                const blobUrl = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = blobUrl;
                a.download = filename;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                setTimeout(() => URL.revokeObjectURL(blobUrl), 30000);
            }
        }, {
            onProgress: (progress: any, txt: string) => {
                const isEn = typeof getLang === 'function' && getLang() === 'en';
                const utils = getUtils();
                const formatted = (utils && typeof utils.formatExportProgress === 'function')
                    ? utils.formatExportProgress(progress, txt, isEn)
                    : { text: txt || '', pct: typeof progress === 'number' ? progress : (progress?.pct || 0) };

                const pct = typeof formatted.pct !== 'undefined' ? Math.max(formatted.pct, 2) : 2;
                if (Store?.getCurrentSlot?.() === currentSlot) ProgressView.update(pct, formatted.text);
            },

            onLog: (msg: string, lvl: 'info' | 'warn' | 'error') => {
                if (Store?.getCurrentSlot?.() === currentSlot) log(msg, lvl);
            },
            onTitleUpdated: (chatId: string, newTitle: string, source: string) => {
                // Fire-and-forget: persistTitleUpdate updates the in-memory item
                // synchronously first, then persists to storage; failures are
                // logged inside and never reject here.
                void persistTitleUpdate(chatId, newTitle, source, currentSlot);
            },
            onItemPendingAssets: (chatId: string) => {
                if (Store?.getCurrentSlot?.() !== currentSlot) return;
                if (List && typeof List.updateItemExportStatus === 'function') {
                    List.updateItemExportStatus(chatId, { status: 'pending_assets' } as any);
                }
            },
            onItemExported: async (chatId: string, titleOrRecord: any, maybeRecord: any) => {
                if (Store?.getCurrentSlot?.() !== currentSlot) return;
                const exportRecord = (maybeRecord && typeof maybeRecord === 'object')
                    ? maybeRecord
                    : ((titleOrRecord && typeof titleOrRecord === 'object') ? titleOrRecord : null);
                if (Store && exportRecord) {
                    const cur = Store.getExportedIds();
                    const ck = normId(chatId);
                    if (ck) cur[ck] = exportRecord;
                    Store.setExportedIds(cur);
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

        if (Store?.getCurrentSlot?.() !== currentSlot) return;
        if (result && result.aborted) {
            log(typeof t === 'function' ? t('exportAborted') : '导出任务已被用户中止', 'warn');
            ProgressView.complete(typeof t === 'function' ? t('exportAborted') : '导出已终止');
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
            } else if (successCount === 0 && (result?.skipped || 0) > 0) {
                const skippedCount = result.skipped;
                if (typeof t === 'function') {
                    const translated = t('exportSkippedAll', skippedCount);
                    if (translated && translated !== 'exportSkippedAll') {
                        finishMsg = translated;
                    }
                }
                if (!finishMsg) {
                    const isEn = typeof getLang === 'function' && getLang() === 'en';
                    finishMsg = isEn
                        ? `Export completed: All ${skippedCount} selected conversations skipped (already exported and up-to-date).`
                        : `导出完成：所选 ${skippedCount} 篇对话均已导出且无更新，已全部跳过。`;
                }
                log(finishMsg, 'info');
                hideExportFailureBanner();
            } else {
                const skippedCount = result?.skipped || 0;
                if (skippedCount > 0 && typeof t === 'function') {
                    const translated = t('exportSuccessWithSkipped', successCount, skippedCount);
                    if (translated && translated !== 'exportSuccessWithSkipped') {
                        finishMsg = translated;
                    }
                }
                if (!finishMsg) {
                    const isEn = typeof getLang === 'function' && getLang() === 'en';
                    if (skippedCount > 0) {
                        finishMsg = isEn
                            ? `Export completed! ${successCount} conversations exported, ${skippedCount} skipped.`
                            : `导出完成！已导出 ${successCount} 篇对话，跳过 ${skippedCount} 篇已导出对话。`;
                    } else if (typeof t === 'function') {
                        const translated = t('exportSuccess', successCount);
                        if (translated && translated !== 'exportSuccess') {
                            finishMsg = translated;
                        }
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
            ProgressView.complete(finishMsg);

            // Compute updated selection: deselect ONLY successfully exported conversations
            remainingSelected = selectionAfterExport(List ? List.getSelectedIds() : new Set<string>(), selected, failedList);
            if (List && typeof List.setSelectedIds === 'function') {
                List.setSelectedIds(remainingSelected);
            }
        }
    } catch (err: unknown) {
        const errMsg = getErrorMessage(err);
        if (Store?.getCurrentSlot?.() === currentSlot) {
            log(typeof t === 'function' ? t('exportFailed', errMsg) : `Export failed: ${errMsg}`, 'error');
            ProgressView.complete(typeof t === 'function' ? t('exportFailedWithMessage', errMsg) : `Error: ${errMsg}`);
        }
    } finally {
        if (Store?.getCurrentSlot?.() === currentSlot) {
            ProgressView.hide(3000);
            if (__loadStore) await __loadStore(true, remainingSelected || undefined);
        }
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
        ProgressView.update(0, noSelMsg);
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
    const threshold = (constants && constants.DIRECT_WRITE_THRESHOLD) ? constants.DIRECT_WRITE_THRESHOLD : 20;
    if (includeZip && !dirHandle && selected.length > threshold && Dialogs && Dialogs.showDirectWritePrompt) {
        const Storage = getStorage();
        const isSuppressed = typeof Storage?.isDirectWritePromptSuppressed === 'function'
            ? await Storage.isDirectWritePromptSuppressed()
            : await (async () => {
                const suppressKey = (constants && constants.STORAGE_KEYS?.SUPPRESS_DIRECT_WRITE_PROMPT) || 'gemini_suppress_direct_write_prompt';
                try {
                    const d = await chrome.storage.local.get([suppressKey]);
                    return !!d[suppressKey];
                } catch (e) {
                    console.warn('[GemExporter:storage] Storage operation failed:', e);
                    return false;
                }
            })();

        if (!isSuppressed) {
            if (typeof Storage?.setDirectWritePromptSuppressed === 'function') {
                await Storage.setDirectWritePromptSuppressed(true);
            }

            // Hold the export mutex until the user actually decides.
            // showDirectWritePrompt is fire-and-forget (returns void) and its
            // Escape / X-close paths invoke NEITHER callback, so wrap both
            // callbacks in a decision promise and also settle when the modal
            // is hidden without a decision — otherwise _isExporting could be
            // released while the dialog is still open, or locked forever.
            // Guard with a synchronously-set decisionMade flag: the observer
            // only settles on Esc/X closes (no decision made).
            let decisionMade = false;
            let resolveDecision: (() => void) | null = null;
            const decisionPromise = new Promise<void>((resolve) => { resolveDecision = resolve; });
            const settleDecision = () => {
                if (resolveDecision) {
                    const r = resolveDecision;
                    resolveDecision = null;
                    r();
                }
            };
            let modalObserver: MutationObserver | null = null;
            let modalEl: HTMLElement | null = null;
            try {
                modalEl = typeof document !== 'undefined' ? document.getElementById('directWriteModal') : null;
                if (modalEl && typeof MutationObserver !== 'undefined') {
                    modalObserver = new MutationObserver(() => {
                        if (modalEl && modalEl.style.display === 'none' && !decisionMade) settleDecision();
                    });
                    modalObserver.observe(modalEl, { attributes: true, attributeFilter: ['style'] });
                }
            } catch (e) {
                console.warn('[GemExporter:storage] Storage operation failed:', e);
            }

            try {
                Dialogs.showDirectWritePrompt(
                    selected.length,
                    async () => {
                        decisionMade = true;
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
                                if (typeof Storage?.setZipPreference === 'function') {
                                    await Storage.setZipPreference(false);
                                }
                            }
                            await startExportPipeline(selected, format, skip, includeIndex, includeAssets, false, newHandle);
                        } catch (err: unknown) {
                            const errMsg = getErrorMessage(err);
                            log(typeof t === 'function' ? t('dirCancelled', errMsg) : `未选择导出目录: ${errMsg}`, 'warn');
                        } finally {
                            settleDecision();
                        }
                    },
                    async () => {
                        decisionMade = true;
                        try {
                            await startExportPipeline(selected, format, skip, includeIndex, includeAssets, true, null);
                        } catch (err: unknown) {
                            const errMsg = getErrorMessage(err);
                            log(typeof t === 'function' ? t('exportFailed', errMsg) : `导出失败: ${errMsg}`, 'error');
                        } finally {
                            settleDecision();
                        }
                    }
                );
            } catch (promptErr) {
                settleDecision();
                throw promptErr;
            }
            // If the prompt never actually showed (missing modal / early
            // return), don't wait forever.
            if (!modalEl || modalEl.style.display === 'none') settleDecision();
            try {
                await decisionPromise;
            } finally {
                if (modalObserver) modalObserver.disconnect();
            }
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
    const zipCheck = $('includeZip') as HTMLInputElement | null;
    if (Formats && Formats.loadFormat) {
        const { format } = await Formats.loadFormat();
        const fmtSelect = $('format') as HTMLSelectElement | null;
        if (fmtSelect) fmtSelect.value = format;
        fmtSelect?.addEventListener('change', (e: Event) => Formats.saveFormat((e.target as HTMLSelectElement).value));
    }

    if (zipCheck) {
        const Storage = getStorage();
        const d = await chrome.storage.local.get([STORAGE_KEYS.ZIP]);
        if (typeof (d as any)[STORAGE_KEYS.ZIP] !== 'undefined') {
            zipCheck.checked = (d as any)[STORAGE_KEYS.ZIP] as boolean;
        } else {
            zipCheck.checked = true;
        }
        updateZipUi();
        zipCheck.addEventListener('change', () => {
            updateZipUi();
            if (typeof Storage?.setZipPreference === 'function') {
                void Storage.setZipPreference(zipCheck.checked);
            }
        });
    }

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

    $('btnExport')?.addEventListener('click', async () => {
        const fmtSelect = $('format') as HTMLSelectElement | null;
        if (fmtSelect?.value === 'pdf') {
            await warmLocalFontCache();
        }
        exportSelected();
    });
    $('btnExportJson')?.addEventListener('click', () => exportSelected('json'));
    $('btnCancel')?.addEventListener('click', () => {
        if (Controller) Controller.abort();
        log(typeof t === 'function' ? t('stoppingExport') : '正在终止导出任务...', 'warn');
    });
    $('btnResumeExport')?.addEventListener('click', () => {
        const convs = Store ? Store.getConversations() : [];
        const expMap = Store ? Store.getExportedIds() : {};
        if (List) List.selectUnexported(convs, expMap);
        void exportSelected();
    });
    $('btnDismissExportBanner')?.addEventListener('click', () => {
        if (Dialogs) Dialogs.dismissExportBanner();
    });
}

export const OptionsExport = {
    init,
    exportSelected,
    startExportPipeline,
    persistTitleUpdate,
    updateZipUi,
    getLastFailedChats,
    renderExportFailureBanner,
    hideExportFailureBanner,
    retryFailedExport
};



export default OptionsExport;
