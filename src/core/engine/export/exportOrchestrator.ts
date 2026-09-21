
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

export interface ExportOrchestratorModule {
    ExportOrchestrator: any;
    AsyncQueue: any;
    ensureSubDir: (root: any, subPath: string) => Promise<any>;
    sanitizeFileName: (name?: string | null, fallback?: string) => string;
    sanitizeZipPath: (p?: string | null) => string;
    getExtensionVersion: () => string;
}

declare global {
    var ExportOrchestrator: any;
}

import GeminiUtils, {
    type GeminiUtilsModule,
    sanitizeFileName as utilsSanitizeFileName,
    normId as utilsNormId,
    sanitizeRelativePath,
    getErrorMessage
} from "../../utils/utils.js";
import { ExportPipelineError } from "../../../types/errors.js";
import BatchWorker, { type BatchWorkerModule } from "./batchWorker.js";
import SessionRecovery, { type SessionRecoveryModule } from "./sessionRecovery.js";
import rateLimitModule, { RateLimitManager, type RateLimitModule } from "./rateLimiter.js";
import progressReporterModule, { ProgressReporter, type ProgressReporterModule } from "./progressReporter.js";

export const EXT_VERSION: string = typeof __EXT_VERSION__ !== 'undefined' ? __EXT_VERSION__ : '1.4.3';
export function getExtensionVersion(): string {
    try {
        if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest) {
            return chrome.runtime.getManifest().version || EXT_VERSION;
        }
    } catch (e) {
        if (typeof console !== 'undefined' && console.debug) console.debug('[GemExporter:exportOrchestrator.ts]', e);
    }
    return EXT_VERSION;
}

const getUtils = (): GeminiUtilsModule | null => {
    if (typeof (globalThis as any).GeminiUtils !== 'undefined') return (globalThis as any).GeminiUtils;
    return GeminiUtils;
};

const getProgressReporter = (): any => {
    if (typeof (globalThis as any).ProgressReporter !== 'undefined') return (globalThis as any).ProgressReporter;
    return progressReporterModule;
};

const getBatchWorker = (): BatchWorkerModule => {
    if (typeof (globalThis as any).BatchWorker !== 'undefined') return (globalThis as any).BatchWorker;
    return BatchWorker;
};

const getSessionRecovery = (): SessionRecoveryModule => {
    if (typeof (globalThis as any).SessionRecovery !== 'undefined') return (globalThis as any).SessionRecovery;
    return SessionRecovery;
};

const getRateLimiter = (): RateLimitModule => {
    if (typeof (globalThis as any).RateLimitModule !== 'undefined') return (globalThis as any).RateLimitModule;
    return rateLimitModule;
};

export const sanitizeFileName = (name?: string | null, fallback?: string): string => {
    if (typeof (globalThis as any).GeminiUtils?.sanitizeFileName === 'function') {
        return (globalThis as any).GeminiUtils.sanitizeFileName(name, fallback);
    }
    return utilsSanitizeFileName(name, fallback);
};

export const normId = (id?: string | number | null): string => {
    if (typeof (globalThis as any).GeminiUtils?.normId === 'function') {
        return (globalThis as any).GeminiUtils.normId(id);
    }
    return utilsNormId(id);
};

export const sanitizeZipPath = (p?: string | null): string => {
    if (typeof (globalThis as any).GeminiUtils?.sanitizeRelativePath === 'function') {
        return (globalThis as any).GeminiUtils.sanitizeRelativePath(p, 'file');
    }
    return sanitizeRelativePath(p, 'file');
};

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

        push(task: any): void {
            if (this._closed) return;
            if (this._waiters.length > 0) {
                const waiter = this._waiters.shift()!;
                waiter(task);
            } else {
                this._queue.push(task);
            }
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

    async function ensureSubDir(root: any, subPath: string): Promise<any> {
        const FsWriter = (globalThis as any).FsWriter;
        if (typeof FsWriter !== 'undefined' && FsWriter.ensureSubDir) {
            return await FsWriter.ensureSubDir(root, subPath);
        }
        let cur = root;
        const parts = subPath.split('/').filter(Boolean).filter(p => p !== '.' && p !== '..').map(p => sanitizeFileName(p, 'dir'));
        for (let p of parts) {
            if (!p || p === '.' || p === '..') continue;
            cur = await cur.getDirectoryHandle(p, { create: true });
        }
        return cur;
    }

    async function getGeminiTab(slot?: string): Promise<any> {
        const TabService = (globalThis as any).TabService;
        if (typeof TabService !== 'undefined' && TabService.getGeminiTab) {
            return await TabService.getGeminiTab(slot);
        }
        if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.query) {
            return chrome.tabs.query({ url: 'https://gemini.google.com/*' }).then((tabs: any[]) => tabs?.[0] || null);
        }
        return null;
    }

    const getAssetPipelineClass = (): any => {
        if (typeof (globalThis as any).AssetPipeline !== 'undefined') return (globalThis as any).AssetPipeline;
        return null;
    };

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
                recovery.updateSessionStatus({ status: 'aborted' });
            } else {
                try {
                    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
                        chrome.storage.local.get(['gemini_last_export_session'], (data: any) => {
                            if (data?.gemini_last_export_session) {
                                chrome.storage.local.set({
                                    gemini_last_export_session: {
                                        ...data.gemini_last_export_session,
                                        status: 'aborted',
                                        updatedAt: Date.now()
                                    }
                                });
                            }
                        });
                    }
                } catch (e) { if (typeof console !== 'undefined' && console.debug) console.debug('[GemExporter:exportOrchestrator.ts]', e); }
            }
        }

        async _initSession(options: ExportOptions, _callbacks: ExportCallbacks = {}): Promise<any> {
            const {
                selected = [],
                format = 'markdown',
                useZip = true,
                currentSlot = 'u0'
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

            const payloadIds = selected.map((s: any) => ({
                id: s.id,
                title: s.title,
                url: s.url || s.href || `https://gemini.google.com/app/${s.id}`,
                timestamp: s.timestamp,
                lastSeen: s.lastSeen
            }));

            const slot = currentSlot || 'u0';
            const Storage = (typeof (globalThis as any).StorageService !== 'undefined') ? (globalThis as any).StorageService : ((globalThis as any).StorageService || null);
            let curIds = Storage ? await Storage.getExportedIds(slot) : {};
            if (!Storage && typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
                const expKey = slot === 'u0' ? 'exportedIds' : `gemini_exported_${slot}`;
                const store = await chrome.storage.local.get([expKey]);
                curIds = store[expKey] || {};
            }

            const recovery = getSessionRecovery();
            if (recovery && recovery.updateSessionStatus) {
                await recovery.updateSessionStatus({
                    status: 'running',
                    slot,
                    total: payloadIds.length,
                    current: 0,
                    format,
                    useZip,
                    startTime: Date.now()
                });
            } else {
                try {
                    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
                        await chrome.storage.local.set({
                            gemini_last_export_session: {
                                status: 'running',
                                slot,
                                total: payloadIds.length,
                                current: 0,
                                format,
                                useZip,
                                startTime: Date.now(),
                                updatedAt: Date.now()
                            }
                        });
                    }
                } catch (e) { if (typeof console !== 'undefined' && console.debug) console.debug('[GemExporter:exportOrchestrator.ts]', e); }
            }

            return {
                payloadIds,
                slot,
                Storage,
                curIds,
                abortSignal
            };
        }

        async _initWriter(options: ExportOptions, onLog: (msg: string, level?: string) => void): Promise<any> {
            const { useZip = true, dirHandle = null } = options;
            const exportFolderName = 'gemini_export';
            let batchDirHandle: any = null;
            let zip: any = null;
            let folder: any = null;
            let zipWriter: any = null;
            let fsWriter: any = null;

            if (useZip) {
                const ZipWriterModule = (globalThis as any).ZipWriter;
                const ZipWriterClass = (typeof ZipWriterModule !== 'undefined' && ZipWriterModule.ZipWriter)
                    ? ZipWriterModule.ZipWriter
                    : (typeof ZipWriterModule === 'function' ? ZipWriterModule : null);
                if (ZipWriterClass) {
                    zipWriter = new ZipWriterClass(exportFolderName);
                    zip = zipWriter.zip;
                    folder = zipWriter.folder;
                } else {
                    const JSZip = (globalThis as any).JSZip;
                    if (typeof JSZip === 'undefined') throw new Error('JSZip library not found');
                    zip = new JSZip();
                    folder = zip.folder(exportFolderName);
                }
            } else {
                if (!dirHandle) throw new Error('Directory handle not provided');
                try {
                    const FsWriterModule = (globalThis as any).FsWriter;
                    const FsWriterClass = (typeof FsWriterModule !== 'undefined' && FsWriterModule.FsWriter)
                        ? FsWriterModule.FsWriter
                        : (typeof FsWriterModule === 'function' ? FsWriterModule : null);
                    if (FsWriterClass) {
                        fsWriter = new FsWriterClass(dirHandle, exportFolderName);
                        batchDirHandle = await fsWriter.init();
                    } else {
                        if (dirHandle.queryPermission) {
                            const perm = await dirHandle.queryPermission({ mode: 'readwrite' });
                            if (perm !== 'granted') {
                                const req = dirHandle.requestPermission ? await dirHandle.requestPermission({ mode: 'readwrite' }) : perm;
                                if (req !== 'granted') throw new Error('Directory permission not granted: ' + req);
                            }
                        }
                        if (dirHandle.name === exportFolderName) {
                            batchDirHandle = dirHandle;
                        } else {
                            batchDirHandle = await dirHandle.getDirectoryHandle(exportFolderName, { create: true });
                        }
                    }
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

            const writeFileDirect = async (localName: string, data: any): Promise<boolean> => {
                if (this.aborted) return false;
                try {
                    const cleanPath = sanitizeZipPath(localName);
                    if (fsWriter) {
                        await fsWriter.writeFile(cleanPath, data);
                        return true;
                    }
                    const parts = cleanPath.split('/').filter(Boolean);
                    let fileName = parts.pop() || 'file';
                    const dirPath = parts.join('/');
                    let targetDir = batchDirHandle;
                    if (dirPath) {
                        targetDir = await ensureSubDir(batchDirHandle, dirPath);
                    }
                    const fh = await targetDir.getFileHandle(fileName, { create: true });
                    const wr = await fh.createWritable();
                    await wr.write(data);
                    await wr.close();
                    return true;
                } catch (e: unknown) {
                    const errMsg = getErrorMessage(e);
                    const errObj = e as any;
                    const isPermissionRevoked = errObj?.name === 'NotAllowedError'
                        || /permission|not\s*allowed/i.test(errMsg);
                    if (isPermissionRevoked) {
                        const I18n = (globalThis as any).I18n;
                        const permMsg = typeof I18n !== 'undefined'
                            ? I18n.t('fsPermissionRevoked')
                            : '文件夹访问权限已失效或被撤销，导出已中止';
                        onLog(permMsg, 'error');
                        this.abort();
                        return false;
                    }
                    onLog(`保存文件失败 (${localName}): ${errMsg}`, 'error');
                    return false;
                }
            };

            return { zip, folder, zipWriter, batchDirHandle, fsWriter, writeFileDirect };
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
            const zipFileName = `gemini_export_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.zip`;
            const I18n = (globalThis as any).I18n;
            onLog(typeof I18n !== 'undefined' ? I18n.t('logPackagingZip') : '正在打包 ZIP 压缩包…', 'info');
            const onUpdate = (percent: number) => {
                onProgress({
                    current: payloadIds.length,
                    total: payloadIds.length,
                    pct: Math.floor(percent),
                    title: typeof I18n !== 'undefined' ? I18n.t('progPackagingZip', Math.floor(percent)) : `打包 ZIP 中 (${Math.floor(percent)}%)`,
                    assetsDownloaded: downloadedAssets,
                    assetsTotal: totalAssets
                });
            };
            const blob = (zipWriterOrZip && typeof zipWriterOrZip.generateBlob === 'function')
                ? await zipWriterOrZip.generateBlob(onUpdate)
                : await zipWriterOrZip.generateAsync({ type: 'blob' }, (metadata: any) => onUpdate(metadata.percent));

            if (options.downloadHandler && typeof options.downloadHandler === 'function') {
                await options.downloadHandler(blob, zipFileName);
            } else if (typeof document !== 'undefined' && document.createElement && document.body) {
                const blobUrl = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = blobUrl;
                a.download = zipFileName;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                setTimeout(() => URL.revokeObjectURL(blobUrl), 30000);
            }
        }

        async run(options: ExportOptions, callbacks: ExportCallbacks = {}): Promise<ExportResult> {
            const onProgress = callbacks.onProgress || (() => {});
            const onLog = callbacks.onLog || (() => {});
            const onTitleUpdated = callbacks.onTitleUpdated || (() => {});
            const onItemExported = callbacks.onItemExported || (() => {});

            const session = await this._initSession(options, callbacks);
            const { payloadIds, slot, Storage, curIds, abortSignal } = session;

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

            const { zip, folder, zipWriter, writeFileDirect } = await this._initWriter(options, onLog);

            const AssetPipelineClass = getAssetPipelineClass();
            const assetPipeline = AssetPipelineClass ? new AssetPipelineClass({
                currentSlot,
                useZip,
                folder,
                writeFileDirect,
                takeoutEngine,
                getGeminiTab,
                onLog
            }) : null;

            let totalAssets = 0;
            let downloadedAssets = 0;
            let landedChats = 0;
            let failedChats: any[] = [];
            let failedAttachments: any[] = [];
            let skipped = 0;
            let metaResults: any[] = [];

            let currentExportTitle = '';
            let currentExportIdx = 0;

            const updateProgress = (chatIdx?: number, chatTitle?: string) => {
                if (typeof chatIdx === 'number') currentExportIdx = chatIdx;
                if (typeof chatTitle === 'string' && chatTitle) currentExportTitle = chatTitle;

                const totalChats = payloadIds.length;
                const current = Math.min(currentExportIdx, totalChats);
                let pct = totalChats ? Math.floor((current / totalChats) * 100) : 0;

                if (totalAssets > 0 && downloadedAssets > 0 && pct < 100) {
                    const chatWeight = 0.75;
                    const assetWeight = 0.25;
                    const chatFraction = totalChats ? (current / totalChats) : 0;
                    const assetFraction = Math.min(1, downloadedAssets / totalAssets);
                    pct = Math.min(99, Math.floor((chatFraction * chatWeight + assetFraction * assetWeight) * 100));
                }

                onProgress({
                    current,
                    total: totalChats,
                    pct,
                    title: currentExportTitle,
                    assetsDownloaded: downloadedAssets,
                    assetsTotal: totalAssets
                });
            };

            updateProgress(0, 'Preparing...');

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
                    return;
                }
                const targetNid = normId(targetId);
                if (finalizedChatsSet.has(targetNid)) return;
                const rec = chatRecordsMap.get(targetNid);
                if (!rec || chatFailedAssetsSet.has(targetNid)) return;
                finalizedChatsSet.add(targetNid);
                curIds[targetId] = rec;
                curIds[targetNid] = rec;
                curIds['c_' + targetNid] = rec;
                exportedIds[targetId] = rec;
                exportedIds[targetNid] = rec;
                exportedIds['c_' + targetNid] = rec;
                if (Storage) {
                    await Storage.saveExportRecord(slot, targetId, rec);
                } else if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
                    const expKey = slot === 'u0' ? 'exportedIds' : `gemini_exported_${slot}`;
                    chrome.storage.local.set({ [expKey]: curIds });
                }
                onItemExported(targetId, rec);
            }

            const CONCURRENCY = 3;
            let nextIndex = 0;
            let completedCount = 0;
            let convsNeedSave = false;

            const exportWorker = async () => {
                while (nextIndex < payloadIds.length && !this.aborted && !(abortSignal && abortSignal.aborted)) {
                    if (this.rateLimiter && typeof this.rateLimiter.waitForCooldown === 'function') {
                        const canProceed = await this.rateLimiter.waitForCooldown(abortSignal);
                        if (!canProceed || this.aborted || (abortSignal && abortSignal.aborted)) break;
                    } else if (this.rateLimitCooldownUntil && Date.now() < this.rateLimitCooldownUntil) {
                        const waitMs = Math.max(0, this.rateLimitCooldownUntil - Date.now());
                        if (waitMs > 0) {
                            await new Promise(r => setTimeout(r, waitMs));
                            if (this.aborted || (abortSignal && abortSignal.aborted)) break;
                        }
                    }

                    const currentIndex = nextIndex++;
                    const requestedItem = payloadIds[currentIndex];
                    if (!requestedItem) break;

                    const nid = normId(requestedItem.id);
                    let res: any = null;
                    let retryCount = 0;
                    const maxRateLimitRetries = 3;

                    const I18n = (globalThis as any).I18n;

                    while (retryCount <= maxRateLimitRetries && !this.aborted && !(abortSignal && abortSignal.aborted)) {
                        res = worker && worker.fetchChatDetail
                            ? await worker.fetchChatDetail(requestedItem, currentIndex, payloadIds.length, currentSlot, skip, format, abortSignal)
                            : null;

                        if (this.aborted || (abortSignal && abortSignal.aborted)) break;

                        const isLimited = (this.rateLimiter && typeof this.rateLimiter.isRateLimited === 'function')
                            ? this.rateLimiter.isRateLimited(res)
                            : (res && !res.success && (res.status === 429 || /429|rate\s*limit|quota|too\s*many\s*requests/i.test(res?.error || '')));

                        if (isLimited && retryCount < maxRateLimitRetries) {
                            const delayMs = (this.rateLimiter && typeof this.rateLimiter.calculateBackoff === 'function')
                                ? this.rateLimiter.calculateBackoff(retryCount)
                                : Math.min(30000, 2000 * Math.pow(2, retryCount) + Math.floor(Math.random() * 1000));
                            if (this.rateLimiter && typeof this.rateLimiter.recordRateLimit === 'function') {
                                this.rateLimiter.recordRateLimit(delayMs);
                            } else {
                                this.rateLimitCooldownUntil = Date.now() + delayMs;
                            }
                            onLog(typeof I18n !== 'undefined'
                                ? I18n.t('logRateLimitedBackoff', requestedItem.title || nid, (delayMs / 1000).toFixed(1))
                                : `[${requestedItem.title || nid}] ⚠️ 触发 Google 限频 (429)，退避等待 ${(delayMs / 1000).toFixed(1)} 秒后重试...`, 'warn');
                            await new Promise(r => setTimeout(r, delayMs));
                            retryCount++;
                            continue;
                        }
                        break;
                    }

                    if (this.aborted || (abortSignal && abortSignal.aborted)) break;

                    if (!res || !res.success) {
                        const fetchErr = res ? res.error : 'unknown';
                        onLog(typeof I18n !== 'undefined' ? I18n.t('logFetchFailed', fetchErr) : `抓取对话失败: ${fetchErr}`, 'warn');
                        failedChats.push({ id: requestedItem.id, title: requestedItem.title || requestedItem.id, error: fetchErr });
                        onLog(typeof I18n !== 'undefined' ? I18n.t('logExportSkipped', requestedItem.title || requestedItem.id, fetchErr) : `[${requestedItem.title || requestedItem.id}] 导出跳过: ${fetchErr}`, 'warn');
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

                    if (resolvedRes.convsNeedSave) convsNeedSave = true;

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

                    const ChatFormatter = (globalThis as any).ChatFormatter;
                    const formatted = typeof ChatFormatter !== 'undefined' && ChatFormatter.formatContent
                        ? ChatFormatter.formatContent(chat, format)
                        : { content: JSON.stringify(chat, null, 2), ext: 'json' };

                    const content = formatted.content;
                    const ext = formatted.ext;
                    const safeBase = sanitizeFileName(listTitle, chat.id);
                    const fileName = `${safeBase}_${chat.id.slice(-6)}.${ext}`;

                    let writeOk = true;
                    if (useZip) {
                        folder.file(fileName, content);
                    } else {
                        writeOk = await writeFileDirect(fileName, content);
                    }

                    let queuedAssetsForThisChat = 0;
                    const chatAssetTasks: (() => Promise<void>)[] = [];
                    const queueAsset = (item: any, isImage: boolean) => {
                        totalAssets++;
                        queuedAssetsForThisChat++;
                        updateProgress();
                        chatAssetTasks.push(async () => {
                            let assetRes = { saved: false, failReason: '', localName: item.localName || item.fileName || (isImage ? 'image.jpg' : 'file.bin') };
                            if (assetPipeline) {
                                assetRes = await assetPipeline.processAsset(item, chat, { isImage, listTitle });
                            }
                            if (assetRes.saved) {
                                downloadedAssets++;
                                updateProgress();
                                const left = (pendingAssetsPerChat.get(nid) || 1) - 1;
                                pendingAssetsPerChat.set(nid, left);
                                if (left === 0) finalizeChatExport(chat.id);
                            } else {
                                chatFailedAssetsSet.add(nid);
                                failedAttachments.push({ chatId: chat.id, chatTitle: listTitle || chat.title || chat.id, file: assetRes.localName, error: assetRes.failReason || 'CDN auth expired' });
                                const logKey = isImage ? 'logImageFailed' : 'logAssetFailed';
                                const fallbackMsg = isImage
                                    ? `[${chat.title || chat.id}] 图片获取失败 (${assetRes.localName}): ${assetRes.failReason || 'CDN鉴权过期或资源不可达'}`
                                    : `[${chat.title || chat.id}] 附件获取失败 (${assetRes.localName}): ${assetRes.failReason || 'CDN鉴权过期或资源不可达'}`;
                                onLog(typeof I18n !== 'undefined' ? I18n.t(logKey, chat.title || chat.id, assetRes.localName, assetRes.failReason || 'CDN auth expired') : fallbackMsg, 'warn');
                                const left = (pendingAssetsPerChat.get(nid) || 1) - 1;
                                pendingAssetsPerChat.set(nid, left);
                                if (left === 0) finalizeChatExport(chat.id);
                            }
                        });
                    };

                    if (includeAssets && chat.messages && writeOk) {
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
                                        if (att.contentMarkdown.includes('immersive_entry_chip') || att.contentMarkdown.includes('googleusercontent.com/immersive')) {
                                            continue;
                                        }
                                        if (useZip) {
                                            try {
                                                folder.file(sanitizeZipPath(att.localName), att.contentMarkdown);
                                                totalAssets++;
                                                downloadedAssets++;
                                                updateProgress();
                                            } catch (e) { if (typeof console !== 'undefined' && console.debug) console.debug('[GemExporter:exportOrchestrator.ts]', e); }
                                        } else {
                                            totalAssets++;
                                            queuedAssetsForThisChat++;
                                            updateProgress();
                                            chatAssetTasks.push(async () => {
                                                const ok = await writeFileDirect(att.localName || `${safeBase}_${chat.id.slice(-6)}.md`, att.contentMarkdown);
                                                if (ok) {
                                                    downloadedAssets++;
                                                    updateProgress();
                                                    const left = (pendingAssetsPerChat.get(nid) || 1) - 1;
                                                    pendingAssetsPerChat.set(nid, left);
                                                    if (left === 0) finalizeChatExport(chat.id);
                                                } else {
                                                    chatFailedAssetsSet.add(nid);
                                                    const left = (pendingAssetsPerChat.get(nid) || 1) - 1;
                                                    pendingAssetsPerChat.set(nid, left);
                                                    if (left === 0) finalizeChatExport(chat.id);
                                                }
                                            });
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

                    if (writeOk) {
                        landedChats++;
                        onLog(typeof I18n !== 'undefined' ? I18n.t('logExportSuccess', listTitle, fileName) : `[${listTitle}] ✓ 文本导出成功 (${fileName})`, 'info');
                        if (!chat.error && !chat._empty) {
                            let exportTs = listC?.timestamp || chat.timestamp || Date.now();
                            if (typeof exportTs === 'string') exportTs = new Date(exportTs).getTime();
                            const record = {
                                title: listTitle,
                                exportedAt: new Date().toISOString(),
                                messageCount: chat.messageCount || chat.messages?.length || 0,
                                chatTime: exportTs,
                                status: 'ok'
                            };
                            chatRecordsMap.set(nid, record);
                            if (queuedAssetsForThisChat === 0) {
                                finalizeChatExport(chat.id);
                            } else {
                                pendingAssetsPerChat.set(nid, queuedAssetsForThisChat);
                                for (const task of chatAssetTasks) {
                                    attachmentQueue.push(task);
                                }
                            }
                        }
                    } else {
                        const failReason = this.aborted ? 'Aborted due to permission revocation' : 'File write failed';
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
                        messageCount: chat.messages ? chat.messages.length : (chat.messageCount || 0),
                        attachmentCount: queuedAssetsForThisChat || chat.attachmentCount || 0,
                        exportFile: fileName,
                        status: writeOk ? 'success' : 'failed'
                    });

                    completedCount++;
                    updateProgress(completedCount, listTitle);

                    if (recovery && recovery.updateSessionStatus) {
                        await recovery.updateSessionStatus({
                            status: 'running',
                            slot,
                            total: payloadIds.length,
                            current: completedCount,
                            lastChatId: chat.id,
                            lastChatTitle: listTitle,
                            format,
                            useZip
                        });
                    } else {
                        try {
                            if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
                                await chrome.storage.local.set({
                                    gemini_last_export_session: {
                                        status: 'running',
                                        slot,
                                        total: payloadIds.length,
                                        current: completedCount,
                                        lastChatId: chat.id,
                                        lastChatTitle: listTitle,
                                        format,
                                        useZip,
                                        updatedAt: Date.now()
                                    }
                                });
                            }
                        } catch (e) { if (typeof console !== 'undefined' && console.debug) console.debug('[GemExporter:exportOrchestrator.ts]', e); }
                    }
                }
            };

            const exportWorkers: Promise<void>[] = [];
            const workerCount = Math.min(CONCURRENCY, payloadIds.length);
            for (let w = 0; w < workerCount; w++) {
                exportWorkers.push(exportWorker());
            }
            await Promise.all(exportWorkers);

            if (convsNeedSave) {
                if (Storage) {
                    await Storage.setConversations(slot, conversations);
                } else if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
                    const convKey = slot === 'u0' ? 'gemini_conversations' : `gemini_conversations_${slot}`;
                    chrome.storage.local.set({ [convKey]: conversations });
                }
            }

            attachmentQueue.close();
            try {
                await Promise.all(consumerPool);
            } catch (e) {
                const I18n = (globalThis as any).I18n;
                if (this.aborted) onLog(typeof I18n !== 'undefined' ? I18n.t('logAssetsAborted') : '附件下载因终止而中断', 'warn');
            }

            if (includeIndex && metaResults.length > 0) {
                if (recovery && recovery.writeIndexAndMeta) {
                    await recovery.writeIndexAndMeta(metaResults, landedChats, downloadedAssets, totalAssets, writeFileDirect, folder, useZip);
                }
            }

            let isDevMode = false;
            try {
                if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
                    const devData = await chrome.storage.local.get(['gemini_dev_mode']);
                    isDevMode = !!devData?.gemini_dev_mode;
                }
            } catch (e) {
                if (typeof console !== 'undefined' && console.warn) console.warn('[GemExporter:storage] Storage operation failed:', e);
            }

            if (isDevMode || failedChats.length > 0 || failedAttachments.length > 0) {
                let fullLogText = '';
                if (recovery && recovery.buildSessionLogText) {
                    fullLogText = recovery.buildSessionLogText({
                        landedChats,
                        totalChats: payloadIds.length,
                        downloadedAssets,
                        totalAssets,
                        skipped,
                        failedChats,
                        failedAttachments,
                        isDevMode
                    });
                }

                const sessionJson = {
                    exportedAt: new Date().toISOString(),
                    isDevMode,
                    summary: {
                        total: payloadIds.length,
                        landed: landedChats,
                        failed: failedChats.length,
                        skipped,
                        assetsTotal: totalAssets,
                        assetsDownloaded: downloadedAssets,
                        assetsFailed: failedAttachments.length
                    },
                    failedChats,
                    failedAttachments
                };

                if (recovery && recovery.writeDiagnostics) {
                    await recovery.writeDiagnostics(isDevMode, sessionJson, fullLogText, writeFileDirect, folder, useZip, onLog);
                }
            }

            if (useZip) {
                await this._packageAndDownload(zipWriter || zip, payloadIds, downloadedAssets, totalAssets, options, onLog, onProgress);
            }

            if (recovery && recovery.updateSessionStatus) {
                await recovery.updateSessionStatus({
                    status: this.aborted ? 'aborted' : (failedChats.length > 0 ? 'completed_with_errors' : 'completed'),
                    slot,
                    total: payloadIds.length,
                    current: landedChats,
                    failedCount: failedChats.length,
                    skipped
                });
            } else {
                try {
                    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
                        await chrome.storage.local.set({
                            gemini_last_export_session: {
                                status: this.aborted ? 'aborted' : (failedChats.length > 0 ? 'completed_with_errors' : 'completed'),
                                slot,
                                total: payloadIds.length,
                                current: landedChats,
                                failedCount: failedChats.length,
                                skipped,
                                updatedAt: Date.now()
                            }
                        });
                    }
                } catch (e) { if (typeof console !== 'undefined' && console.debug) console.debug('[GemExporter:exportOrchestrator.ts]', e); }
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

export const ExportOrchestratorModule: ExportOrchestratorModule = {
    ExportOrchestrator,
    AsyncQueue,
    ensureSubDir,
    sanitizeFileName,
    sanitizeZipPath,
    getExtensionVersion
};

(ExportOrchestratorModule as any).ExportOrchestrator = ExportOrchestrator;
(ExportOrchestratorModule as any).AsyncQueue = AsyncQueue;
(ExportOrchestratorModule as any).ensureSubDir = ensureSubDir;
(ExportOrchestratorModule as any).sanitizeFileName = sanitizeFileName;
(ExportOrchestratorModule as any).sanitizeZipPath = sanitizeZipPath;
(ExportOrchestratorModule as any).getExtensionVersion = getExtensionVersion;
(ExportOrchestratorModule as any).default = ExportOrchestratorModule;

if (typeof globalThis !== 'undefined') {
    if (!(globalThis as any).ExportOrchestrator) (globalThis as any).ExportOrchestrator = ExportOrchestrator;
}
if (typeof module === 'object' && module.exports) {
    module.exports = ExportOrchestratorModule;
}
export default ExportOrchestratorModule;
