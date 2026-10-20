
export interface ExportOptions {
    selected: any[];
    format?: string;
    useZip?: boolean;
    currentSlot?: string;
    dirHandle?: any;
    skip?: boolean;
    includeIndex?: boolean;
    includeAssets?: boolean;
    conversations?: any[];
    exportedIds?: Record<string, any>;
    takeoutEngine?: any;
    downloadHandler?: (blob: Blob, filename: string) => Promise<void> | void;
    [key: string]: any;
}

export interface ExportCallbacks {
    onProgress?: (progress: any) => void;
    onLog?: (msg: string, level?: string) => void;
    onTitleUpdated?: (id: string, title: string, source?: string) => void;
    onItemExported?: (id: string, record: any) => void;
    onItemPendingAssets?: (id: string, count: number) => void;
}

export interface ExportResult {
    landedChats: number;
    exportedCount?: number;
    failedChats: any[];
    failedAttachments: any[];
    skipped: number;
    totalAssets: number;
    downloadedAssets: number;
    aborted?: boolean;
}

import { __resolveModule } from "../../utils/moduleOverrides.js";
import { AssetPipeline as AssetPipelineStatic } from "../assetPipeline.js";
import GeminiUtils, {
    type GeminiUtilsModule,
    sanitizeFileName as utilsSanitizeFileName,
    normId as utilsNormId,
    sanitizeRelativePath,
    buildExportFileName,
    resolveExportFileName as utilsResolveExportFileName,
    getErrorMessage,
    checkIsUpdated as utilsCheckIsUpdated,
    getEffectiveTimestamp as utilsGetEffectiveTimestamp,
    setTitleBySource as utilsSetTitleBySource,
    cleanTitle as utilsCleanTitle,
    isRealTitle as utilsIsRealTitle,
    applyExportTitleWriteback
} from "../../utils/utils.js";
export { applyExportTitleWriteback };
import { stripInternalChipMarkdown } from "../../utils/chipUtils.js";
import { ExportPipelineError } from "../../../types/errors.js";
import BatchWorker, { type BatchWorkerModule } from "./batchWorker.js";
import SessionRecovery, { type SessionRecoveryModule } from "./sessionRecovery.js";
import rateLimitModule, { isRateLimited, calculateBackoff, abortableSleep, type RateLimitModule } from "./rateLimiter.js";
import progressReporterModule, { ProgressReporter } from "./progressReporter.js";
import TabService from "../../utils/tabService.js";
import { ensureSubDir as fsEnsureSubDir } from "../writers/fsWriter.js";
import { createWriter } from "../writers/writerInterface.js";
import { SessionStore } from "../../storage/sessionStore.js";
import { StorageService as StorageServiceStatic } from "../../storage/storageService.js";
import { ChatFormatter } from "../chatFormatter.js";
import { shortId } from "../../utils/pathUtils.js";
import { extractChatParseDrift, chatRecordStatusWithDrift } from "./parseDrift.js";
import { I18n as I18nStatic } from "../../utils/i18n.js";
import { assertSchemaWritable } from "../../storage/schemaMigration.js";
import { FlightRecorder } from "../../diagnostics/flightRecorder.js";
import {
    buildExportCompletion,
    computeExportMessageCount,
    computeAuthoritativeTimestamp,
    resolveReliableTitleSource
} from "./exportCompletion.js";

import { EXT_VERSION, getExtensionVersion, DEFAULT_EXPORT_FOLDER_NAME } from "../../utils/constants.js";
export { EXT_VERSION, getExtensionVersion };

const getUtils = (): GeminiUtilsModule | null => __resolveModule('GeminiUtils', GeminiUtils);
const getI18n = (): any => __resolveModule('I18n', I18nStatic);
const getProgressReporter = (): any => progressReporterModule;
const getBatchWorker = (): BatchWorkerModule => BatchWorker;
const getSessionRecovery = (): SessionRecoveryModule => SessionRecovery;
const getRateLimiter = (): RateLimitModule => rateLimitModule;

export const sanitizeFileName = (name?: string | null, fallback?: string): string =>
    ((getUtils()?.sanitizeFileName) || utilsSanitizeFileName)(name, fallback);

export const normId = (id?: string | number | null): string =>
    ((getUtils()?.normId) || utilsNormId)(id);

export const sanitizeZipPath = (p?: string | null): string =>
    ((getUtils()?.sanitizeRelativePath) || sanitizeRelativePath)(p, 'file');

export const checkIsUpdated = (c: any, rec?: any): boolean =>
    ((getUtils()?.checkIsUpdated) || utilsCheckIsUpdated)(c, rec);

export const getEffectiveTimestamp = (c: any): number =>
    ((getUtils()?.getEffectiveTimestamp) || utilsGetEffectiveTimestamp)(c);

export const setTitleBySource = (chat: any, source?: string, rawTitle?: string): any =>
    ((getUtils()?.setTitleBySource) || utilsSetTitleBySource)(chat, source, rawTitle);

export const cleanTitle = (rawTitle?: string | null): string =>
    ((getUtils()?.cleanTitle) || utilsCleanTitle)(rawTitle);

export const isRealTitle = (title?: string | null, id?: string | number): boolean =>
    ((getUtils()?.isRealTitle) || utilsIsRealTitle)(title, id);



    function toIso(v: any): string | null {
        if (!v) return null;
        let ms = typeof v === 'number' ? v : new Date(v).getTime();
        return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
    }

    class AsyncQueue {
        _queue: any[];
        _waiters: ((task: any) => void)[];
        _closed: boolean;

        constructor() {
            this._queue = [];
            this._waiters = [];
            this._closed = false;
        }

        push(task: any): boolean {
            if (this._closed) return false;
            if (this._waiters.length > 0) {
                const waiter = this._waiters.shift()!;
                waiter(task);
            } else {
                this._queue.push(task);
            }
            return true;
        }

        async pop(abortSignal?: AbortSignal | null): Promise<any> {
            if (this._queue.length > 0) {
                return this._queue.shift();
            }
            if (this._closed) return null;
            return new Promise((resolve) => {
                let onAbort: any = null;
                const waiter = (task: any) => {
                    if (onAbort && abortSignal) {
                        try { abortSignal.removeEventListener('abort', onAbort); } catch (_) { /* intentional */ }
                    }
                    resolve(task);
                };
                if (abortSignal) {
                    onAbort = () => {
                        const idx = this._waiters.indexOf(waiter);
                        if (idx !== -1) this._waiters.splice(idx, 1);
                        resolve(null);
                    };
                    if (abortSignal.aborted) return resolve(null);
                    try { abortSignal.addEventListener('abort', onAbort, { once: true }); } catch (e) {
                        if (typeof console !== 'undefined' && console.debug) console.debug('[GemExporter:exportOrchestrator.ts]', e);
                    }
                }
                this._waiters.push(waiter);
            });
        }

        close(): void {
            this._closed = true;
            while (this._waiters.length > 0) {
                const waiter = this._waiters.shift()!;
                waiter(null);
            }
        }

        get length(): number {
            return this._queue.length;
        }
    }

    const ensureSubDir = fsEnsureSubDir;

    const getGeminiTab = async (slot?: string): Promise<any> =>
        (__resolveModule('TabService', TabService))?.getGeminiTab?.(slot) ?? null;
    const sendToGeminiTab = (message: any, slot?: string, timeoutMs?: number): Promise<any> =>
        (__resolveModule('TabService', TabService)).sendToGeminiTab(message, slot, timeoutMs);

    const getAssetPipelineClass = (): any => __resolveModule('AssetPipeline', AssetPipelineStatic);

    class ExportOrchestrator {
        aborted: boolean;
        _abortController: AbortController | null;
        rateLimiter: any;

        get rateLimitCooldownUntil(): number {
            return this.rateLimiter ? this.rateLimiter.rateLimitCooldownUntil : 0;
        }
        set rateLimitCooldownUntil(v: number) {
            if (this.rateLimiter) this.rateLimiter.rateLimitCooldownUntil = v;
        }

        constructor() {
            this.aborted = false;
            this._abortController = null;
            const rlModule = getRateLimiter();
            if (!rlModule || !rlModule.RateLimitManager) throw new Error('RateLimitModule missing: ensure rateLimiter.ts is bundled');
            this.rateLimiter = new rlModule.RateLimitManager();
        }

        abort(): void {
            this.aborted = true;
            try { this._abortController && this._abortController.abort(); } catch (_) { /* intentional */ }
            try {
                if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
                    chrome.runtime.sendMessage({ action: 'cancelExport' }, () => {
                        if (chrome.runtime.lastError) {}
                    });
                }
            } catch (e) { if (typeof console !== 'undefined' && console.debug) console.debug('[GemExporter:exportOrchestrator.ts]', e); }
            const recovery = getSessionRecovery();
            if (recovery && recovery.updateSessionStatus) {
                // G2 no-floating-promises: abort() 是同步方法，await 会改接口；
                // 状态写失败不能 unhandledrejection，catch 里记 debug 日志。
                recovery.updateSessionStatus({ status: 'aborted' }).catch((e) => {
                    if (typeof console !== 'undefined' && console.debug) console.debug('[GemExporter:exportOrchestrator.ts] updateSessionStatus failed on abort', e);
                });
            }
        }

        async _initSession(options: ExportOptions, _callbacks: ExportCallbacks = {}): Promise<any> {
            const {
                selected = [],
                format = 'markdown',
                useZip = true,
                currentSlot = 'u0',
                skip = false,
                conversations = []
            } = options;

            if (!selected.length) {
                throw new Error('No items selected');
            }

            this.aborted = false;
            if (this.rateLimiter && typeof this.rateLimiter.reset === 'function') {
                this.rateLimiter.reset();
            }
            this._abortController = typeof AbortController !== 'undefined' ? new AbortController() : null;
            const abortSignal = this._abortController ? this._abortController.signal : null;

            const slot = currentSlot || 'u0';
            // Phase A (P1-4): Storage 解析不再允许 null —— 静态 import 做 fallback，
            // 生产环境永远拿到真正的 StorageService；测试可用 __setModuleOverride 覆盖。
            // finalizeChatExport 只认 saveExportRecord 一条正式路径（fail-closed）。
            const Storage = __resolveModule('StorageService', StorageServiceStatic);
            let curIds = await Storage.getExportedIds(slot);
            if (options.exportedIds && typeof options.exportedIds === 'object') {
                curIds = { ...curIds, ...options.exportedIds };
            }

            const payloadIds: any[] = [];
            const skippedItems: any[] = [];

            const utils = getUtils();
            const checkUpdatedFn = (utils && typeof utils.checkIsUpdated === 'function')
                ? utils.checkIsUpdated
                : checkIsUpdated;

            for (const s of selected) {
                const sid = typeof s === 'string' ? s : s?.id;
                const nid = normId(sid);
                const itemPayload = {
                    id: sid,
                    title: s.title || sid,
                    url: s.url || s.href || `https://gemini.google.com/app/${sid}`,
                    timestamp: s.timestamp,
                    lastSeen: s.lastSeen
                };

                if (skip) {
                    // Triage #5 read-path fix: curIds is canonical-keyed — the
                    // StorageService read path collapses legacy alias keys, the
                    // raw store fallback is written canonical-only by
                    // setExportedIds/saveExportRecordsBatch, and caller-supplied
                    // options.exportedIds comes from the normalized in-memory
                    // store. A single canonical probe is enough.
                    const rec = curIds[nid] || null;
                    if (rec) {
                        const conv = (Array.isArray(conversations) ? conversations.find((c: any) => normId(c.id) === nid) : null) || (typeof s === 'object' ? s : null);
                        const isUpdated = checkUpdatedFn(conv || itemPayload, rec);
                        if (!isUpdated) {
                            skippedItems.push(itemPayload);
                            FlightRecorder.record('export', 'item_skipped_unmodified', {
                                id: nid,
                                chatTime: (rec as any)?.chatTime,
                                exportedAt: rec.exportedAt
                            });
                            continue;
                        }
                    }
                }
                payloadIds.push(itemPayload);
                FlightRecorder.record('export', 'item_enqueued', {
                    id: nid,
                    hasRecord: !!curIds[nid]
                });
            }

            FlightRecorder.record('export', 'pipeline_start', {
                total: selected.length,
                skipped: skippedItems.length,
                enqueued: payloadIds.length,
                skip
            });

            const recovery = getSessionRecovery();
            if (recovery && recovery.updateSessionStatus) {
                await recovery.updateSessionStatus({
                    status: 'running',
                    slot,
                    total: selected.length,
                    current: skippedItems.length,
                    format,
                    useZip,
                    startTime: Date.now()
                });
            }

            return {
                payloadIds,
                skippedItems,
                totalSelected: selected.length,
                slot,
                Storage,
                curIds,
                abortSignal
            };
        }

        async _initWriter(options: ExportOptions, onLog: (msg: string, level?: string) => void): Promise<any> {
            // P1-13: schema frozen 时写路径 fail-closed（读路径不受影响）
            await assertSchemaWritable();
            const { useZip = true, dirHandle = null } = options;
            const exportFolderName = DEFAULT_EXPORT_FOLDER_NAME;
            let batchDirHandle: any = null;
            let zip: any = null;
            let folder: any = null;
            let zipWriter: any = null;
            let fsWriter: any = null;
            let writer: any = null;

            if (useZip) {
                writer = createWriter('zip', { folderName: exportFolderName });
                zipWriter = writer;
                zip = (writer as any).zip;
                folder = (writer as any).folder;
            } else {
                if (!dirHandle) throw new Error('Directory handle not provided');
                try {
                    writer = createWriter('fs', { dirHandle, folderName: exportFolderName });
                    fsWriter = writer;
                    batchDirHandle = await (fsWriter as any).init();
                } catch (e: unknown) {
                    const errMsg = getErrorMessage(e);
                    onLog(`创建子文件夹失败: ${errMsg}`, 'warn');
                    const errObj = e as any;
                    const isPermissionRevoked = errObj?.name === 'NotAllowedError' || /permission|not\s*allowed/i.test(errMsg);
                    if (isPermissionRevoked) {
                        onLog('目录句柄权限失效，请重新授权文件夹', 'warn');
                    }
                    throw new ExportPipelineError(`无法创建导出子目录 "${exportFolderName}": ${errMsg}`, undefined, 'write', isPermissionRevoked);
                }
            }

            const writeFileDirect = async (localName: string, data: any): Promise<void> => {
                if (this.aborted) throw new DOMException('Export aborted', 'AbortError');
                const cleanPath = sanitizeZipPath(localName);
                if (!writer) {
                    throw new ExportPipelineError(`无可用写入器，无法保存 (${localName})`, undefined, 'write');
                }
                try {
                    await writer.writeFile(cleanPath, data);
                } catch (e: unknown) {
                    const errMsg = getErrorMessage(e);
                    const errObj = e as any;
                    const isPermissionRevoked = errObj?.name === 'NotAllowedError'
                        || /permission|not\s*allowed/i.test(errMsg);
                    if (isPermissionRevoked) {
                        const I18n = getI18n();
                        onLog(I18n.t('fsPermissionRevoked'), 'error');
                        this.abort();
                    } else {
                        onLog(`保存文件失败 (${localName}): ${errMsg}`, 'error');
                    }
                    throw new ExportPipelineError(`保存文件失败 (${localName}): ${errMsg}`, undefined, 'write', isPermissionRevoked);
                }
            };

            return { zip, folder, zipWriter, batchDirHandle, fsWriter, writer, writeFileDirect };
        }

        async _packageAndDownload(
            zipWriterOrZip: any,
            payloadIds: any[],
            downloadedAssets: number,
            totalAssets: number,
            options: ExportOptions,
            onLog: (msg: string, level?: string) => void,
            onProgress: (progress: any) => void
        ): Promise<void> {
            // B3: 取消后不再打包/下载 —— 取消是用户意图，不应触发下载回调
            if (this.aborted || this._abortController?.signal.aborted) return;
            const zipFileName = `gemini_export_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.zip`;
            const I18n = getI18n();
            onLog(I18n.t('logPackagingZip'), 'info');
            const onUpdate = (percent: number) => {
                onProgress({
                    current: payloadIds.length,
                    total: payloadIds.length,
                    pct: Math.floor(percent),
                    title: I18n.t('progPackagingZip', Math.floor(percent)),
                    assetsDownloaded: downloadedAssets,
                    assetsTotal: totalAssets
                });
            };
            const blob = (zipWriterOrZip && typeof zipWriterOrZip.generateBlob === 'function')
                ? await zipWriterOrZip.generateBlob(onUpdate)
                : await zipWriterOrZip.generateAsync({ type: 'blob' }, (metadata: any) => onUpdate(metadata.percent));

            if (options.downloadHandler && typeof options.downloadHandler === 'function') {
                await options.downloadHandler(blob, zipFileName);
            }
        }

        async run(options: ExportOptions, callbacks: ExportCallbacks = {}): Promise<ExportResult> {
            const onProgress = callbacks.onProgress || (() => {});
            const onLog = callbacks.onLog || (() => {});
            const onTitleUpdated = callbacks.onTitleUpdated || (() => {});
            const onItemExported = callbacks.onItemExported || (() => {});
            const onItemPendingAssets = callbacks.onItemPendingAssets || (() => {});

            const session = await this._initSession(options, callbacks);
            const { payloadIds, skippedItems = [], totalSelected = options.selected?.length || 0, slot, Storage, curIds, abortSignal } = session;
            // B3: _initSession 是异步的，期间用户可能已取消 —— 直接返回，不再初始化 writer/跑导出循环
            if (this.aborted || (abortSignal && abortSignal.aborted)) {
                onLog(getI18n().t('logExportAborted') || '导出已取消', 'warn');
                const earlyRecovery = getSessionRecovery();
                if (earlyRecovery && earlyRecovery.updateSessionStatus) {
                    await earlyRecovery.updateSessionStatus({
                        status: 'aborted',
                        slot,
                        total: totalSelected,
                        current: 0,
                        failedCount: 0,
                        skipped: skippedItems.length
                    });
                }
                return {
                    landedChats: 0,
                    exportedCount: 0,
                    failedChats: [],
                    failedAttachments: [],
                    skipped: skippedItems.length,
                    totalAssets: 0,
                    downloadedAssets: 0,
                    aborted: true
                };
            }

            const {
                format = 'markdown',
                skip = false,
                includeIndex = false,
                includeAssets = true,
                useZip = true,
                currentSlot = 'u0',
                conversations = [],
                exportedIds = {},
                takeoutEngine = null
            } = options;

            const { zip, zipWriter, batchDirHandle, writer, writeFileDirect } = await this._initWriter(options, onLog);

            const AssetPipelineClass = getAssetPipelineClass();
            const assetPipeline = AssetPipelineClass ? new AssetPipelineClass({
                currentSlot,
                useZip,
                writer,
                writeFileDirect,
                takeoutEngine,
                getGeminiTab,
                sendToGeminiTab,
                onLog
            }) : null;

            let totalAssets = 0;
            let downloadedAssets = 0;
            let landedChats = 0;
            let failedChats: any[] = [];
            let failedAttachments: any[] = [];
            let parseDriftChats: any[] = [];
            let skipped = skippedItems.length;
            let metaResults: any[] = [];

            const totalChats = totalSelected || payloadIds.length;

            const I18n = getI18n();

            for (const sItem of skippedItems) {
                const sTitle = sItem.title || sItem.id;
                onLog(I18n.t('logExportSkippedAlreadyExported', sTitle) || `[${sTitle}] 跳过已导出内容 (无更新)`, 'info');
            }

            const ProgressReporterClass = getProgressReporter()?.ProgressReporter || ProgressReporter;
            const reporter = new ProgressReporterClass({
                totalChats,
                onProgress,
                onLog
            });

            const updateProgress = (chatIdx?: number, chatTitle?: string) => {
                reporter.update(chatIdx, chatTitle, { downloadedAssets, totalAssets });
            };


            if (payloadIds.length === 0) {
                updateProgress(totalChats, I18n.t('exportSkippedAll', skipped));
            } else {
                updateProgress(skipped, 'Preparing...');
            }

            const attachmentQueue = new AsyncQueue();
            const MAX_CONCURRENT = 4;

            if (abortSignal) {
                abortSignal.addEventListener('abort', () => attachmentQueue.close(), { once: true });
            }

            const processAttachmentWorker = async () => {
                while (!this.aborted && !(abortSignal && abortSignal.aborted)) {
                    const task = await attachmentQueue.pop(abortSignal);
                    if (!task) break;
                    try {
                        await task();
                    } catch (e) {
                        const meta = (task as any)?.__assetMeta || null;
                        if (meta) {
                            const errMsg = typeof e === 'object' && e !== null && 'message' in (e as any) ? String((e as any).message) : String(e);
                            chatFailedAssetsSet.add(meta.nid);
                            failedAttachments.push({
                                chatId: meta.chatId,
                                chatTitle: meta.listTitle,
                                file: meta.fileName,
                                error: errMsg || 'asset task threw'
                            });
                            if (!this.aborted && !(abortSignal && abortSignal.aborted)) {
                                onLog(`[${meta.listTitle || meta.chatId}] 附件任务异常，已记为失败: ${errMsg}`, 'warn');
                            }
                            const left = (pendingAssetsPerChat.get(meta.nid) || 1) - 1;
                            pendingAssetsPerChat.set(meta.nid, left);
                            if (left === 0) {
                                try { await finalizeChatExport(meta.chatId); } catch (_) { /* intentional */ }
                            }
                        } else if (typeof console !== 'undefined' && console.warn) {
                            console.warn('[GemExporter:exportOrchestrator.ts] attachment task threw without metadata', e);
                        }
                        if (abortSignal && abortSignal.aborted) break;
                    }
                }
            };

            const consumerPool: Promise<void>[] = [];
            for (let i = 0; i < MAX_CONCURRENT; i++) {
                consumerPool.push(processAttachmentWorker());
            }

            const pendingAssetsPerChat = new Map<string, number>();
            const chatRecordsMap = new Map<string, any>();
            const chatFailedAssetsSet = new Set<string>();
            const finalizedChatsSet = new Set<string>();

            const recovery = getSessionRecovery();
            const worker = options.worker || getBatchWorker();

            async function finalizeChatExport(targetId: string) {
                if (recovery && recovery.finalizeChatExport) {
                    await recovery.finalizeChatExport(targetId, {
                        finalizedChatsSet,
                        chatRecordsMap,
                        chatFailedAssetsSet,
                        curIds,
                        exportedIds,
                        Storage,
                        slot,
                        onItemExported
                    });
                }
            }

            const CONCURRENCY = Math.max(1, typeof options.concurrency === 'number' ? options.concurrency : 3);
            let nextIndex = 0;
            let completedCount = skipped;

            const exportWorker = async () => {
                while (nextIndex < payloadIds.length && !this.aborted && !(abortSignal && abortSignal.aborted)) {
                    if (this.rateLimiter && typeof this.rateLimiter.waitForCooldown === 'function') {
                        const canProceed = await this.rateLimiter.waitForCooldown(abortSignal);
                        if (!canProceed || this.aborted || (abortSignal && abortSignal.aborted)) break;
                    } else if (this.rateLimitCooldownUntil && Date.now() < this.rateLimitCooldownUntil) {
                        const waitMs = Math.max(0, this.rateLimitCooldownUntil - Date.now());
                        if (waitMs > 0) {
                            // B2: 冷却等待同样可被取消打断，不傻等整个窗口
                            await abortableSleep(waitMs, abortSignal);
                            if (this.aborted || (abortSignal && abortSignal.aborted)) break;
                        }
                    }

                    const currentIndex = nextIndex++;
                    const requestedItem = payloadIds[currentIndex];
                    if (!requestedItem) break;

                    // Per-chat error isolation: one failed chat must not abort the entire batch
                    try {
                        const nid = normId(requestedItem.id);
                        let res: any = null;
                        let retryCount = 0;
                        const maxRateLimitRetries = 3;

                        const I18n = getI18n();

                        while (retryCount <= maxRateLimitRetries && !this.aborted && !(abortSignal && abortSignal.aborted)) {
                            res = worker && worker.fetchChatDetail
                                ? await worker.fetchChatDetail(requestedItem, currentIndex, totalChats, currentSlot, skip, format, abortSignal)
                                : null;

                            if (this.aborted || (abortSignal && abortSignal.aborted)) break;

                            const isLimited = (this.rateLimiter && typeof this.rateLimiter.isRateLimited === 'function')
                                ? this.rateLimiter.isRateLimited(res)
                                : isRateLimited(res);

                            if (isLimited && retryCount < maxRateLimitRetries) {
                                const delayMs = (this.rateLimiter && typeof this.rateLimiter.calculateBackoff === 'function')
                                    ? this.rateLimiter.calculateBackoff(retryCount)
                                    : calculateBackoff(retryCount);
                                if (this.rateLimiter && typeof this.rateLimiter.recordRateLimit === 'function') {
                                    this.rateLimiter.recordRateLimit(delayMs);
                                } else {
                                    this.rateLimitCooldownUntil = Date.now() + delayMs;
                                }
                                onLog(I18n.t('logRateLimitedBackoff', requestedItem.title || nid, (delayMs / 1000).toFixed(1)), 'warn');
                                // B2: 退避等待可被取消打断 —— 取消后不再傻等整个退避窗口
                                const backoffAborted = await abortableSleep(delayMs, abortSignal);
                                retryCount++;
                                if (backoffAborted) break;
                                continue;
                            }
                            break;
                        }

                        if (this.aborted || (abortSignal && abortSignal.aborted)) break;

                        if (!res || !res.success) {
                            const fetchErr = res ? res.error : 'unknown';
                            onLog(I18n.t('logFetchFailed', fetchErr), 'warn');
                            failedChats.push({ id: requestedItem.id, title: requestedItem.title || requestedItem.id, error: fetchErr });
                            onLog(I18n.t('logExportSkipped', requestedItem.title || requestedItem.id, fetchErr), 'warn');
                            completedCount++;
                            updateProgress(completedCount, requestedItem.title || requestedItem.id);
                            continue;
                        }

                        skipped += (res.skipped || 0);
                        const chunkResults = res.results || (res.chat ? [res.chat] : []);
                        let chat = chunkResults[0] || { id: nid, title: requestedItem.title };
                        chat.id = nid;

                        const listC = conversations.find((c: any) => normId(c.id) === nid) || null;
                        const resolvedRes = worker && worker.resolveChat
                            ? await worker.resolveChat(chat, requestedItem, listC, takeoutEngine, currentSlot, onTitleUpdated, onLog)
                            : { chat, listTitle: chat.title, displayTitle: chat.title, isError: false, errMsg: null, isConfirmedDeleted: false, convsNeedSave: false };

                        if (resolvedRes.isError) {
                            failedChats.push({ id: chat.id || nid, title: resolvedRes.displayTitle, error: resolvedRes.errMsg, debug: chat._debug || null, raw: chat._raw || null, isDeleted: resolvedRes.isConfirmedDeleted });
                            if (typeof console !== 'undefined' && console.warn) {
                                console.warn('[Gemini Exporter] export empty detail', nid, resolvedRes.errMsg, 'chat keys', Object.keys(chat || {}));
                            }
                            completedCount++;
                            updateProgress(completedCount, resolvedRes.displayTitle);
                            continue;
                        }

                        chat = resolvedRes.chat || chat;
                        const listTitle = resolvedRes.listTitle;
                        chat.title = listTitle;

                        const actualMsgCount = computeExportMessageCount(chat);
                        let needUpdateStorage = !!resolvedRes.convsNeedSave;
                        if (listC && typeof listC === 'object' && actualMsgCount > 0 && listC.messageCount !== actualMsgCount) {
                            listC.messageCount = actualMsgCount;
                            needUpdateStorage = true;
                        }

                        if (needUpdateStorage) {
                            const storageService = Storage || __resolveModule('StorageService', StorageServiceStatic);
                            if (storageService && typeof storageService.updateConversation === 'function') {
                                try {
                                    await storageService.updateConversation(currentSlot, nid, (existing: any) => {
                                        if (listC) {
                                            // Route the title write-back through the canonical tier
                                            // arbitration: a lower-authority list snapshot must not
                                            // downgrade a higher-authority stored title.
                                            applyExportTitleWriteback(existing, listC);
                                            if (listC.messageCount) existing.messageCount = listC.messageCount;
                                        }
                                        return existing;
                                    });
                                } catch (err) {
                                    if (typeof console !== 'undefined' && console.warn) {
                                        console.warn('[Gemini Exporter] atomic updateConversation failed for', nid, err);
                                    }
                                }
                            }
                        }

                        let formatted;
                        if (format === 'html') {
                            formatted = await ChatFormatter.formatHtmlCanonical(chat);
                        } else if (format === 'markdown') {
                            formatted = await ChatFormatter.formatMarkdownCanonical(chat);
                        } else {
                            formatted = ChatFormatter.formatContent(chat, format);
                        }

                        const content = formatted.content;
                        const ext = formatted.ext;
                        const safeBase = sanitizeFileName(listTitle, chat.id);
                        const resolveName = ((getUtils()?.resolveExportFileName) || utilsResolveExportFileName);
                        const fileName = useZip
                            ? buildExportFileName(listTitle, chat.id, ext)
                            : await resolveName(listTitle, chat.id, ext, async (n: string) => {
                                try {
                                    if (!batchDirHandle || typeof batchDirHandle.getFileHandle !== 'function') return false;
                                    await batchDirHandle.getFileHandle(n, { create: false });
                                    return true;
                                } catch {
                                    return false;
                                }
                            });

                        let mainWriteError: unknown = null;
                        try {
                            await writeFileDirect(fileName, content);
                        } catch (e) {
                            mainWriteError = e;
                        }

                        let queuedAssetsForThisChat = 0;
                        const chatAssetTasks: (() => Promise<void>)[] = [];
                        const queueAsset = (item: any, isImage: boolean) => {
                            totalAssets++;
                            queuedAssetsForThisChat++;
                            updateProgress();
                            const assetTask = async () => {
                                let assetRes = { saved: false, failReason: '', localName: item.localName || item.fileName || (isImage ? 'image.jpg' : 'file.bin') };
                                if (assetPipeline) {
                                    assetRes = await assetPipeline.processAsset(item, chat, { isImage, listTitle, signal: abortSignal });
                                }
                                if (assetRes.saved) {
                                    downloadedAssets++;
                                    updateProgress();
                                    const left = (pendingAssetsPerChat.get(nid) || 1) - 1;
                                    pendingAssetsPerChat.set(nid, left);
                                    if (left === 0) await finalizeChatExport(chat.id);
                                } else {
                                    chatFailedAssetsSet.add(nid);
                                    // decrement 紧跟 add(nid)：regression lock 要求失败分支必须
                                    // decrement pendingAssetsPerChat，否则 finalize 永远等不到 left===0。
                                    const left = (pendingAssetsPerChat.get(nid) || 1) - 1;
                                    pendingAssetsPerChat.set(nid, left);
                                    failedAttachments.push({ chatId: chat.id, chatTitle: listTitle || chat.title || chat.id, file: assetRes.localName, error: assetRes.failReason || 'CDN auth expired', sourceUrl: item.sourceUrl || item.src || item.url, sourceEvidence: item.sourceEvidence });
                                    const logKey = isImage ? 'logImageFailed' : 'logAssetFailed';
                                    const fallbackMsg = isImage
                                        ? `[${chat.title || chat.id}] 图片获取失败 (${assetRes.localName}): ${assetRes.failReason || 'CDN鉴权过期或资源不可达'}`
                                        : `[${chat.title || chat.id}] 附件获取失败 (${assetRes.localName}): ${assetRes.failReason || 'CDN鉴权过期或资源不可达'}`;
                                    onLog(getI18n().t(logKey, chat.title || chat.id, assetRes.localName, assetRes.failReason || 'CDN auth expired'), 'warn');
                                    if (left === 0) await finalizeChatExport(chat.id);
                                }
                            };
                            (assetTask as any).__assetMeta = { nid, chatId: chat.id, listTitle, fileName: item.localName || item.fileName || (isImage ? 'image.jpg' : 'file.bin') };
                            chatAssetTasks.push(assetTask);
                        };

                        if (includeAssets && chat.messages && !mainWriteError) {
                            for (const m of chat.messages) {
                                if (m.attachments && m.attachments.length) {
                                    for (const att of m.attachments) {
                                        if (att.type === 'image') {
                                            if (!m.images || !m.images.some((im: any) => im.localName === att.localName || im.url === att.url || im.fileName === att.fileName)) {
                                                queueAsset(att, true);
                                            }
                                            continue;
                                        }
                                        if (att.type !== 'file') continue;
                                        if ((att.url && att.url.includes('immersive_entry_chip')) && !att.contentMarkdown) continue;
                                        if (att.contentMarkdown) {
                                            const cleanDocMd = stripInternalChipMarkdown(att.contentMarkdown).trim();
                                            if (!cleanDocMd) {
                                                continue;
                                            }
                                            if (useZip) {
                                                try {
                                                    await writeFileDirect(att.localName, cleanDocMd);
                                                    totalAssets++;
                                                    downloadedAssets++;
                                                    updateProgress();
                                                } catch (e) {
                                                    // 取消不记为资产失败，直接向上传播（B3 会进一步区分取消语义）
                                                    if ((e as any)?.name === 'AbortError' || this.aborted) throw e;
                                                    chatFailedAssetsSet.add(nid);
                                                    failedAttachments.push({ chatId: chat.id, chatTitle: listTitle || chat.title || chat.id, file: att.localName, error: getErrorMessage(e) });
                                                }
                                            } else {
                                                totalAssets++;
                                                queuedAssetsForThisChat++;
                                                updateProgress();
                                                const mdTask = async () => {
                                                    const docFileName = att.localName || `${safeBase}_${shortId(chat.id)}.md`;
                                                    try {
                                                        await writeFileDirect(docFileName, cleanDocMd);
                                                        downloadedAssets++;
                                                    } catch (e) {
                                                        // 取消不记为资产失败，直接向上传播
                                                        if ((e as any)?.name === 'AbortError' || this.aborted) throw e;
                                                        chatFailedAssetsSet.add(nid);
                                                        failedAttachments.push({ chatId: chat.id, chatTitle: listTitle || chat.title || chat.id, file: docFileName, error: getErrorMessage(e) });
                                                    }
                                                    updateProgress();
                                                    const left = (pendingAssetsPerChat.get(nid) || 1) - 1;
                                                    pendingAssetsPerChat.set(nid, left);
                                                    if (left === 0) await finalizeChatExport(chat.id);
                                                };
                                                (mdTask as any).__assetMeta = { nid, chatId: chat.id, listTitle, fileName: att.localName || 'doc.md' };
                                                chatAssetTasks.push(mdTask);
                                            }
                                            continue;
                                        }

                                        queueAsset(att, false);
                                    }
                                }

                                if (m.images && m.images.length) {
                                    for (const img of m.images) {
                                        queueAsset(img, true);
                                    }
                                }
                            }
                        }

                        // P1-8/P1-9: parser 诊断随 chat 透出，不在生产环境静默
                        const chatDrift = extractChatParseDrift(chat);
                        const driftNotable = chatDrift.turnsRejected > 0 || chatDrift.schemaDrift.length > 0 || chatDrift.hasHeuristicDocs;

                        if (!mainWriteError) {
                            landedChats++;
                            onLog(getI18n().t('logExportSuccess', listTitle, fileName), 'info');
                            if (!chat.error && !chat._empty) {
                                if (driftNotable) {
                                    const bits: string[] = [];
                                    if (chatDrift.turnsRejected > 0) bits.push(`拒识 ${chatDrift.turnsRejected} 个 turn`);
                                    if (chatDrift.schemaDrift.length > 0) bits.push(`${chatDrift.schemaDrift.length} 条 schema 漂移告警`);
                                    if (chatDrift.hasHeuristicDocs) bits.push(`含启发式拼凑文档`);
                                    const driftStatus = chatRecordStatusWithDrift('ok', chatDrift);
                                    const statusNote = driftStatus === 'partial' ? '，已记为部分导出' : '（仅告警，导出记录仍为正常）';
                                    onLog(`[${listTitle}] 解析异常（${bits.join("；")}）${statusNote}`, 'warn');
                                    parseDriftChats.push({
                                        id: chat.id || nid,
                                        title: listTitle,
                                        schemaDrift: chatDrift.schemaDrift,
                                        turnsRejected: chatDrift.turnsRejected,
                                        hasHeuristicDocs: chatDrift.hasHeuristicDocs
                                    });
                                }
                                const isChatTruncated = !!(chat.truncated || chat.isTruncated);
                                if (isChatTruncated) {
                                    onLog(`[${listTitle}] 会话内容超出最大拉取深度或检测到游标异常，已截断导出并标记为部分导出 (partial)`, 'warn');
                                }
                                const baseStatus = (actualMsgCount === 0 || chat.isEmpty) ? 'empty' : 'ok';
                                const driftStatus = chatRecordStatusWithDrift(baseStatus, chatDrift);
                                const statusOverride = isChatTruncated
                                    ? 'partial'
                                    : (driftStatus === 'partial' ? 'partial' : undefined);

                                const authoritativeChatTime = Math.max(
                                    computeAuthoritativeTimestamp(listC) || 0,
                                    computeAuthoritativeTimestamp(chat) || 0
                                ) || undefined;

                                const completion = buildExportCompletion({
                                    conversation: chat,
                                    conversationId: nid,
                                    format: options.format || 'markdown',
                                    exportedAt: new Date().toISOString(),
                                    titleCandidate: listTitle,
                                    titleProvenance: resolveReliableTitleSource(chat.titleSource, listC?.titleSource),
                                    titles: { ...(listC?.titles || {}), ...(chat.titles || {}) },
                                    messageCount: actualMsgCount,
                                    chatTime: authoritativeChatTime,
                                    statusOverride,
                                    isTruncated: isChatTruncated,
                                    truncateReason: isChatTruncated ? (chat.truncateReason || 'truncated') : undefined
                                });

                                chatRecordsMap.set(nid, {
                                    ...completion.exportRecord,
                                    exportRecord: completion.exportRecord,
                                    conversationUpdate: completion.conversationUpdate,
                                    targetId: completion.targetId
                                });
                                if (queuedAssetsForThisChat === 0) {
                                    await finalizeChatExport(chat.id);
                                } else {
                                    pendingAssetsPerChat.set(nid, queuedAssetsForThisChat);
                                    try {
                                        onItemPendingAssets(chat.id, queuedAssetsForThisChat);
                                    } catch { /* intentional */ }
                                    for (const task of chatAssetTasks) {
                                        const enqueued = attachmentQueue.push(task);
                                        if (!enqueued) {
                                            chatFailedAssetsSet.add(nid);
                                            const meta = (task as any)?.__assetMeta;
                                            if (meta) {
                                                failedAttachments.push({
                                                    chatId: meta.chatId,
                                                    chatTitle: meta.listTitle,
                                                    file: meta.fileName,
                                                    error: 'Queue closed / export cancelled'
                                                });
                                            }
                                            const left = (pendingAssetsPerChat.get(nid) || 1) - 1;
                                            pendingAssetsPerChat.set(nid, left);
                                            if (left === 0) {
                                                await finalizeChatExport(chat.id);
                                            }
                                        }
                                    }
                                }
                            }
                        } else {
                            // B3: 区分用户取消 vs 权限被收回 —— 取消是用户意图，不记失败；
                            // 权限被收回是真实失败（writeFileDirect 已 abort 并记日志），保留失败记录。
                            const errObj = mainWriteError as any;
                            const userCancelled = errObj?.name === 'AbortError';
                            if (userCancelled) {
                                onLog(`[${listTitle}] 导出已取消`, 'warn');
                                break;
                            }
                            const permissionRevoked = errObj instanceof ExportPipelineError && !!errObj.isPermissionRevoked;
                            const failReason = permissionRevoked
                                ? 'Aborted due to permission revocation'
                                : getErrorMessage(mainWriteError);
                            failedChats.push({
                                id: chat.id || nid,
                                title: listTitle,
                                error: failReason
                            });
                        }

                        metaResults.push({
                            id: chat.id,
                            title: listTitle,
                            url: chat.url || `https://gemini.google.com/app/${chat.id}`,
                            createdAt: toIso(chat.createdAt || chat.timestamp || listC?.timestamp),
                            updatedAt: toIso(chat.updatedAt || chat.timestamp || listC?.timestamp),
                            messageCount: computeExportMessageCount(chat),
                            attachmentCount: queuedAssetsForThisChat || chat.attachmentCount || 0,
                            exportFile: fileName,
                            status: mainWriteError ? 'failed' : 'success',
                            ...(driftNotable ? {
                                parseStatus: chatRecordStatusWithDrift('ok', chatDrift),
                                schemaDrift: chatDrift.schemaDrift,
                                turnsRejected: chatDrift.turnsRejected,
                                hasHeuristicDocs: chatDrift.hasHeuristicDocs || void 0
                            } : {})
                        });

                        completedCount++;
                        updateProgress(completedCount, listTitle);

                        if (recovery && recovery.updateSessionStatus) {
                            await recovery.updateSessionStatus({
                                status: 'running',
                                slot,
                                total: totalChats,
                                current: completedCount,
                                lastChatId: chat.id,
                                lastChatTitle: listTitle,
                                format,
                                useZip
                            });
                        } else {
                            try {
                                await SessionStore.setSession({
                                    status: 'running',
                                    slot,
                                    total: totalChats,
                                    current: completedCount,
                                    lastChatId: chat.id,
                                    lastChatTitle: listTitle,
                                    format,
                                    useZip
                                });
                            } catch (e) { if (typeof console !== 'undefined' && console.debug) console.debug('[GemExporter:exportOrchestrator.ts]', e); }
                        }
                    } catch (e) {
                        // B3: AbortError = 用户取消（资产任务/写文件向上抛）—— 不记失败，直接结束
                        if ((e as any)?.name === 'AbortError') {
                            onLog(`[${requestedItem.title || requestedItem.id}] 导出已取消`, 'warn');
                            break;
                        }
                        const errMsg = typeof e === 'object' && e !== null && 'message' in (e as any) ? String((e as any).message) : String(e);
                        const failId = requestedItem.id || 'unknown';
                        const title = requestedItem.title || failId;
                        onLog(`[${title}] export failed, skipped: ${errMsg}`, 'error');
                        if (typeof console !== 'undefined' && console.warn) {
                            console.warn('[GemExporter:exportOrchestrator.ts] per-chat export failed for', failId, e);
                        }
                        failedChats.push({ id: failId, title, error: errMsg });
                        completedCount++;
                        try { updateProgress(completedCount, title); } catch (_) { /* intentional */ }
                    }
                }
            };

            const exportWorkers: Promise<void>[] = [];
            const workerCount = Math.min(CONCURRENCY, payloadIds.length);
            for (let w = 0; w < workerCount; w++) {
                exportWorkers.push(exportWorker());
            }
            try {
                await Promise.all(exportWorkers);
            } catch (e) {
                onLog(`导出调度异常: ${typeof e === 'object' && e !== null && 'message' in (e as any) ? (e as any).message : String(e)}`, 'error');
                throw e;
            }

            attachmentQueue.close();
            try {
                await Promise.all(consumerPool);
            } catch (e) {
                if (this.aborted) onLog(getI18n().t('logAssetsAborted'), 'warn');
            }

            if (includeIndex && metaResults.length > 0) {
                if (recovery && recovery.writeIndexAndMeta) {
                    try {
                        await recovery.writeIndexAndMeta(metaResults, landedChats, downloadedAssets, totalAssets, writer);
                    } catch (e) {
                        // index 写崩 = 导出契约不完整：记用户可见错误后 fail-closed 外抛
                        onLog(getErrorMessage(e), 'error');
                        throw e;
                    }
                }
            }

            const isDevMode = Storage && typeof Storage.isDevMode === 'function'
                ? await Storage.isDevMode()
                : false;

            // B3: 取消时不写 _export_errors.json —— 取消是用户意图，不是失败
            // P1-8: parser 漂移同样触发诊断文件（成功但 partial 的会话不能静默）
            if ((isDevMode || failedChats.length > 0 || failedAttachments.length > 0 || parseDriftChats.length > 0)
                && !this.aborted && !(abortSignal && abortSignal.aborted)) {
                let fullLogText = '';
                if (recovery && recovery.buildSessionLogText) {
                    fullLogText = recovery.buildSessionLogText({
                        landedChats,
                        totalChats,
                        downloadedAssets,
                        totalAssets,
                        skipped,
                        failedChats,
                        failedAttachments,
                        parseDrift: parseDriftChats,
                        isDevMode
                    });
                }

                const sessionJson = {
                    exportedAt: new Date().toISOString(),
                    isDevMode,
                    summary: {
                        total: totalChats,
                        landed: landedChats,
                        failed: failedChats.length,
                        skipped,
                        assetsTotal: totalAssets,
                        assetsDownloaded: downloadedAssets,
                        assetsFailed: failedAttachments.length
                    },
                    failedChats,
                    failedAttachments,
                    parseDrift: parseDriftChats
                };

                if (recovery && recovery.writeDiagnostics) {
                    try {
                        await recovery.writeDiagnostics(isDevMode, sessionJson, fullLogText, writer, onLog);
                    } catch (e) {
                        // 诊断文件是 best-effort：记用户可见错误但不外抛，
                        // 避免"写错误报告失败后再写错误报告"的递归
                        onLog(getErrorMessage(e), 'error');
                    }
                }
            }

            // B3: 取消后跳过打包/下载（同 _packageAndDownload 首行判定）—— 无下载回调
            if (!this.aborted && !(abortSignal && abortSignal.aborted) && useZip) {
                if (landedChats === 0 && skipped > 0 && failedChats.length === 0) {
                    onLog(getI18n().t('logExportSkippedAllNoZip'), 'info');
                } else {
                    await this._packageAndDownload(zipWriter || zip, payloadIds, downloadedAssets, totalAssets, options, onLog, onProgress);
                }
            }

            if (recovery && recovery.updateSessionStatus) {
                await recovery.updateSessionStatus({
                    status: this.aborted ? 'aborted' : (failedChats.length > 0 ? 'completed_with_errors' : 'completed'),
                    slot,
                    total: totalChats,
                    current: landedChats + skipped,
                    failedCount: failedChats.length,
                    skipped
                });
            }

            return {
                landedChats,
                exportedCount: landedChats,
                failedChats,
                failedAttachments,
                skipped,
                totalAssets,
                downloadedAssets,
                aborted: this.aborted
            };
        }
    }

export {
    ExportOrchestrator,
    AsyncQueue,
    ensureSubDir
};

export const ExportOrchestratorModule = {
    ExportOrchestrator,
    AsyncQueue,
    ensureSubDir,
    sanitizeFileName,
    sanitizeZipPath,
    getExtensionVersion
};

export type ExportOrchestratorModule = typeof ExportOrchestratorModule;

export default ExportOrchestratorModule;
