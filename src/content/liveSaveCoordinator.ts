import { StorageService } from '../core/storage/storageService.js';
import { detectSlotFromUrl } from '../core/utils/pathUtils.js';
import { getEffectiveTimestamp, toTimestampMs } from '../core/utils/titleUtils.js';
import { contentContext } from './contentContext.js';
import { LiveStorageManager, isLiveSaveFormatSupported } from '../core/storage/liveStorageManager.js';
import { DomScraper } from './domScraper.js';
import { ChatFormatter } from '../core/engine/chatFormatter.js';
import { FsWriter } from '../core/engine/writers/fsWriter.js';
import { buildExportFileName, shortId, normId, sanitizeFileName } from '../core/utils/pathUtils.js';
import type { GeminiAPIClient } from '../core/api/geminiClient.js';
import { resolveProvider } from '../core/provider/providerResolver.js';
import { BadgeView } from './badgeView.js';
import { AssetFetcher, inferImageExt } from './assetFetcher.js';
import { createLiveSaveWriter, writeLiveSaveMarkdown } from '../core/engine/liveSaveWriter.js';
import { GeminiUtils } from '../core/utils/utils.js';
import { completeConversationExport } from '../core/engine/export/exportCompletion.js';
import type { LiveSaveConfig } from '../types/liveSave.js';

export interface LiveSaveCoordinatorDeps {
    storageManager?: typeof LiveStorageManager;
    exportRecordStore?: Pick<typeof StorageService, 'saveExportRecord'> & Partial<Pick<typeof StorageService, 'finalizeConversationExport'>>;
    completeExport?: typeof completeConversationExport;
    scraper?: typeof DomScraper;
    formatter?: typeof ChatFormatter;
    fsWriterClass?: typeof FsWriter;
    utils?: typeof GeminiUtils;
    clientClass?: typeof GeminiAPIClient;
    badge?: typeof BadgeView;
    assetFetcher?: typeof AssetFetcher;
}

let _deps: LiveSaveCoordinatorDeps = {};
let _isSaving = false;
let _saveQueue = Promise.resolve<any>(null);

function getStorage() {
    return _deps.storageManager || LiveStorageManager;
}

function getScraper() {
    return _deps.scraper || DomScraper;
}

function getFormatter() {
    return _deps.formatter || ChatFormatter;
}

function getFsWriterClass() {
    return _deps.fsWriterClass || FsWriter;
}

function getUtils() {
    return _deps.utils || GeminiUtils;
}

function getBadge() {
    return _deps.badge || BadgeView;
}

function getAssetFetcher() {
    return _deps.assetFetcher || AssetFetcher;
}

function isDev(): boolean {
    return contentContext.isDevMode();
}

function notifyLiveSaveWarning(errorType: 'dir_deleted' | 'permission_not_granted' | 'no_dir_handle' | 'payload_too_large' | 'permission_prompt_needed' | 'assets_partial'): void {
    const isZh = contentContext.isZh();
    const Badge = getBadge();
    let warnMsg = isZh ? '⚠ 目标目录已删除，实时同步已暂停' : '⚠ Folder deleted, sync paused';
    if (errorType === 'permission_not_granted') {
        warnMsg = isZh ? '⚠ 目录未授权，实时同步已暂停' : '⚠ Folder permission denied, sync paused';
    } else if (errorType === 'permission_prompt_needed') {
        warnMsg = isZh ? '⚠ 目录权限待续期，已暂存下载目录' : '⚠ Folder permission degraded, saved to Downloads';
    } else if (errorType === 'no_dir_handle') {
        warnMsg = isZh ? '⚠ 目录未就绪，实时同步已暂停' : '⚠ Folder not ready, sync paused';
    } else if (errorType === 'payload_too_large') {
        warnMsg = isZh ? '⚠ 实时保存载荷过大，已跳过本次保存' : '⚠ Live-save payload too large, save skipped';
    } else if (errorType === 'assets_partial') {
        warnMsg = isZh ? '⚠ 部分附件保存失败，下次增量同步将重试' : '⚠ Some attachments failed to save, will retry on next incremental sync';
    }
    if (Badge && typeof (Badge as any).showLiveSaveWarning === 'function') {
        (Badge as any).showLiveSaveWarning(warnMsg, isZh);
    } else if (Badge && typeof (Badge as any).showLiveSaveFeedback === 'function') {
        (Badge as any).showLiveSaveFeedback(warnMsg);
    }
}

export function init(deps: LiveSaveCoordinatorDeps = {}): void {
    _deps = deps;
    if (isDev()) console.log('[LiveSaveCoordinator] Initialized');
}

export async function resolveConversationDetail(cid: string): Promise<any> {
    const nid = normId(cid);
    // DI seam kept: an explicitly injected client class still uses the legacy
    // construction path. Default now resolves through the provider registry.
    const InjectedClass = typeof _deps.clientClass !== 'undefined' ? _deps.clientClass : null;
    const provider = InjectedClass ? null : resolveProvider();

    if (InjectedClass || provider) {
        try {
            const detail = InjectedClass
                ? await new InjectedClass().getConversationDetail(nid)
                : await provider!.fetchConversationDetail(nid);
            if (detail && Array.isArray(detail.messages) && detail.messages.length > 0) {
                if (!detail.chatTime || !Number.isFinite(Number(detail.chatTime))) {
                    const times = detail.messages
                        .map((m: any) => toTimestampMs(m?.timestamp))
                        .filter((t: any): t is number => typeof t === 'number' && Number.isFinite(t) && t > 0);
                    if (times.length > 0) {
                        const maxTs = Math.max(...times);
                        detail.chatTime = maxTs;
                        detail.updatedAt = detail.updatedAt || maxTs;
                        detail.timestamp = detail.timestamp || maxTs;
                    }
                }
                return detail;
            }
        } catch (e) {
            if (isDev()) console.debug('[LiveSaveCoordinator] RPC fetch detail fallback to DOM:', e);
        }
    }

    const Scraper = getScraper();
    if (Scraper && typeof Scraper.parseDoc === 'function') {
        const doc = typeof document !== 'undefined' ? document : null;
        try {
            const docResult = Scraper.parseDoc(doc as any, nid);
            if (docResult && Array.isArray(docResult.messages) && docResult.messages.length > 0) {
                return docResult;
            }
        } catch {
            /* intentional */
        }
    }

    return null;
}

export async function executeLiveSave(cid: string, reason = 'turn_complete', options: { mockMode?: boolean } = {}): Promise<boolean> {
    if (!cid) return false;
    const nid = normId(cid);

    // Serialize live save operations to prevent I/O race conditions
    _saveQueue = _saveQueue.then(async () => {
        try {
            _isSaving = true;
            if (!await isLiveSaveFormatSupported()) return false;

            // In mockMode (e.g. headless/test environments without native filesystem handles), simulate live save feedback
            if (options.mockMode) {
                const chat = await resolveConversationDetail(nid);
                const rawTitle = chat?.title || (typeof document !== 'undefined' ? document.title : '') || 'Untitled';
                const Utils = getUtils();
                const safeTitle = Utils?.cleanTitle ? Utils.cleanTitle(rawTitle) : rawTitle.trim();
                const Badge = getBadge();
                if (Badge && typeof (Badge as any).showLiveSaveFeedback === 'function') {
                    (Badge as any).showLiveSaveFeedback(safeTitle);
                }
                return true;
            }

            const Storage = getStorage();
            const config: LiveSaveConfig = await Storage.getLiveConfig();

            if (!config.enabledDisk) {
                return false;
            }

            const chat = await resolveConversationDetail(nid);
            if (!chat || !Array.isArray(chat.messages) || chat.messages.length === 0) {
                if (isDev()) console.warn('[LiveSaveCoordinator] No messages extracted for', nid);
                return false;
            }

            const Utils = getUtils();
            const rawTitle = chat.title || (typeof document !== 'undefined' ? document.title : '') || 'Untitled';
            const safeTitle = Utils?.cleanTitle ? Utils.cleanTitle(rawTitle) : rawTitle.trim();
            let failedAssets: Array<{ file: string; error: string }> = [];

            let writeSucceeded = false;
            const dirHandle = await Storage.getLiveDirHandle();

            if (dirHandle) {
                try {
                    failedAssets = await writeConversationToDisk(chat, safeTitle, nid, dirHandle, config);
                    writeSucceeded = true;
                } catch (err: any) {
                    const isNotFound = err?.name === 'NotFoundError' || err?.message?.includes('not found') || err?.message?.includes('could not be found');
                    if (isNotFound) {
                        console.warn('[LiveSaveCoordinator] Native directory handle is dead (NotFoundError). Clearing handle.');
                        try {
                            const Storage = getStorage();
                            await Storage.saveLiveDirHandle(null);
                            await Storage.setLiveConfig({ enabledDisk: false, dirName: '', dirError: 'not_found' });
                        } catch { /* best effort */ }
                        notifyLiveSaveWarning('dir_deleted');
                        return false;
                    }
                    throw err;
                }
            } else {
                if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
                    try {
                        let collectedAssets: any[] = [];
                        if (config.includeAssets !== false) {
                            collectedAssets = await processAndSaveImages(chat, nid, null, failedAssets);
                        }
                        const assetsPayload = collectedAssets.map(a => ({
                            fileName: a.fileName,
                            subDir: a.subDir || 'assets',
                            base64: a.base64 || (a.buffer ? arrayBufferToBase64(a.buffer) : '')
                        }));
                        // Payload size cap to prevent message serialization failure
                        const LIVE_SAVE_PAYLOAD_CAP = 48 * 1024 * 1024;
                        let estPayloadSize = 0;
                        try {
                            estPayloadSize = JSON.stringify(chat).length;
                            for (const a of assetsPayload) {
                                estPayloadSize += (a.base64 || '').length + (a.fileName || '').length + 64;
                            }
                        } catch {
                            estPayloadSize = Number.MAX_SAFE_INTEGER;
                        }
                        if (estPayloadSize > LIVE_SAVE_PAYLOAD_CAP) {
                            const sizeMb = (estPayloadSize / 1024 / 1024).toFixed(1);
                            console.warn(`[LiveSaveCoordinator] live-save payload ~${sizeMb}MB exceeds ${(LIVE_SAVE_PAYLOAD_CAP / 1024 / 1024).toFixed(0)}MB cap; refusing to send oversized message for ${nid}`);
                            notifyLiveSaveWarning('payload_too_large');
                            return false;
                        }
                        const resp = await new Promise<any>((resolve) => {
                            chrome.runtime.sendMessage({
                                action: 'liveSaveViaHandle',
                                payload: {
                                    chat,
                                    safeTitle,
                                    nid,
                                    config,
                                    assets: assetsPayload,
                                    failedAssets
                                }
                            }, (r) => {
                                if (chrome.runtime.lastError) {
                                    resolve(null);
                                } else {
                                    resolve(r);
                                }
                            });
                        });
                        if (resp && resp.ok) {
                            writeSucceeded = true;
                            if (isDev()) {
                                console.log(`[LiveSaveCoordinator] Conversation ${nid} persisted via options handle (${resp.handleName})`);
                            }
                        } else if (resp && resp.ok === false && Array.isArray(resp.failedAssets) && resp.failedAssets.length > 0) {
                            // Phase A (P1-2): 主 md 已落盘、部分附件失败 -> partial。
                            // 本次视为已保存（partial 记录已写，下次增量 checkIsUpdated 判 true 重试），打 badge 警告。
                            writeSucceeded = true;
                            notifyLiveSaveWarning('assets_partial');
                            // CodeQL js/tainted-format-string: 污点数据（nid 等）不进 format string，做独立参数
                            if (isDev()) console.warn('[LiveSaveCoordinator] live-saved with failed assets:', nid, resp.failedAssets.length, resp.failedAssets);
                        } else if (resp && (resp.error === 'dir_not_found' || resp.error === 'permission_not_granted' || resp.error === 'permission_prompt_needed' || (resp.error === 'no_dir_handle' && config.dirName))) {
                            console.warn(`[LiveSaveCoordinator] Directory handle unavailable (${resp.error}).`);
                            const errType = (resp.error === 'permission_not_granted' || resp.error === 'permission_prompt_needed')
                                ? 'permission_prompt_needed'
                                : (resp.error === 'no_dir_handle' ? 'no_dir_handle' : 'dir_deleted');
                            notifyLiveSaveWarning(errType);
                            return false;
                        }
                    } catch (e) {
                        if (isDev()) console.warn('[LiveSaveCoordinator] liveSaveViaHandle error:', e);
                    }
                }
            }

            if (!writeSucceeded) {
                return false;
            }

            // 3. Update configuration metadata if direct disk write occurred (background updates its own)
            if (dirHandle) {
                const now = Date.now();
                const records = _deps.exportRecordStore || StorageService;
                const slot = detectSlotFromUrl(typeof location !== 'undefined' ? location.href : undefined);
                const doComplete = _deps.completeExport || completeConversationExport;
                try {
                    await doComplete(
                        records,
                        slot,
                        {
                            conversation: chat,
                            conversationId: nid,
                            format: 'markdown',
                            exportedAt: now,
                            failedAssets,
                            titleCandidate: safeTitle,
                            titleProvenance: (chat as any)?.titleSource,
                            titles: (chat as any)?.titles
                        }
                    );
                } catch (err) {
                    console.warn('[LiveSaveCoordinator] Failed to complete conversation export:', err);
                }
                if (failedAssets.length) notifyLiveSaveWarning('assets_partial');
                await Storage.setLiveConfig({
                    lastSavedAt: now,
                    lastSavedTitle: safeTitle
                });
            }

            const Badge = getBadge();
            if (Badge && typeof (Badge as any).showLiveSaveFeedback === 'function') {
                (Badge as any).showLiveSaveFeedback(safeTitle);
            }

            if (isDev()) {
                console.log(`[LiveSaveCoordinator] Successfully live-saved conversation ${nid} ("${safeTitle}")`);
            }
            return true;
        } catch (err) {
            console.error('[LiveSaveCoordinator] executeLiveSave failed for', nid, err);
            return false;
        } finally {
            _isSaving = false;
        }
    });

    return _saveQueue;
}

interface ImageDownloadTarget {
    url: string;
    fileName: string;
    localName: string;
    alt: string;
    saved?: boolean;
}

function hashString(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = (hash << 5) - hash + str.charCodeAt(i);
        hash |= 0;
    }
    return hash;
}

export function arrayBufferToBase64(buffer: ArrayBuffer | Uint8Array | any): string {
    if (!buffer) return '';
    let bytes: Uint8Array;
    if (buffer instanceof Uint8Array) {
        bytes = buffer;
    } else if (buffer instanceof ArrayBuffer) {
        bytes = new Uint8Array(buffer);
    } else if (ArrayBuffer.isView(buffer)) {
        bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    } else if (typeof Buffer !== 'undefined' && Buffer.isBuffer && Buffer.isBuffer(buffer)) {
        return buffer.toString('base64');
    } else {
        return '';
    }

    if (typeof Buffer !== 'undefined' && typeof (Buffer as any).from === 'function') {
        return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
    }

    const chunkSize = 8192;
    let binary = '';
    for (let i = 0; i < bytes.length; i += chunkSize) {
        const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
        binary += String.fromCharCode.apply(null, chunk as any);
    }
    return btoa(binary);
}

/**
 * Sniff, download, and persist all multimodal images to assets/ subfolder,
 * and rewrite references in chat to local relative paths.
 */
export async function processAndSaveImages(chat: any, nid: string, writer?: any, failures: Array<{ file: string; error: string }> = []): Promise<Array<{ fileName: string; subDir: string; buffer?: any; base64?: string }>> {
    if (!chat || !Array.isArray(chat.messages) || chat.messages.length === 0) return [];

    const Utils = getUtils();
    const cid6 = Utils?.shortId ? Utils.shortId(nid) : shortId(nid);
    const targets = new Map<string, ImageDownloadTarget>();
    const allocatedNames = new Set<string>();

    let imgCounter = 0;

    const registerTarget = (rawUrl: string, candidateName?: string, altText?: string, turnIndex = 0) => {
        if (!rawUrl || typeof rawUrl !== 'string' || !rawUrl.startsWith('http')) return;
        if (targets.has(rawUrl)) return;

        imgCounter++;
        const hash4 = Math.abs(hashString(rawUrl)).toString(36).slice(0, 4);
        let ext = inferImageExt('', rawUrl);

        let finalName = '';
        if (candidateName && candidateName.trim() && !/^(?:image|photo|picture|img|file)(?:\.[a-z0-9]+)?$/i.test(candidateName.trim())) {
            const sanitized = (Utils?.sanitizeFileName || sanitizeFileName)(candidateName.trim());
            const dotIdx = sanitized.lastIndexOf('.');
            if (dotIdx !== -1) {
                ext = sanitized.slice(dotIdx + 1).toLowerCase();
                finalName = `${cid6}_t${turnIndex + 1}_${sanitized}`;
            } else {
                finalName = `${cid6}_t${turnIndex + 1}_${sanitized}.${ext}`;
            }
        } else {
            finalName = `${cid6}_t${turnIndex + 1}_img${imgCounter}_${hash4}.${ext}`;
        }

        if (allocatedNames.has(finalName)) {
            const dotIdx = finalName.lastIndexOf('.');
            const base = dotIdx !== -1 ? finalName.slice(0, dotIdx) : finalName;
            const fileExt = dotIdx !== -1 ? finalName.slice(dotIdx) : '';
            finalName = `${base}_${hash4}${fileExt}`;
            let dedupeIdx = 1;
            while (allocatedNames.has(finalName)) {
                finalName = `${base}_${dedupeIdx}${fileExt}`;
                dedupeIdx++;
            }
        }
        allocatedNames.add(finalName);

        targets.set(rawUrl, {
            url: rawUrl,
            fileName: finalName,
            localName: `assets/${finalName}`,
            alt: altText || 'Image'
        });
    };

    // 1. Discover all image targets across messages
    for (let i = 0; i < chat.messages.length; i++) {
        const m = chat.messages[i];
        if (!m) continue;

        if (Array.isArray(m.attachments)) {
            for (const att of m.attachments) {
                if (att && (att.type === 'image' || att.isImage)) {
                    const u = att.src || att.originalUrl || att.url || att.sourceUrl;
                    registerTarget(u, att.fileName || att.name, att.alt || att.name, i);
                }
            }
        }

        if (Array.isArray(m.images)) {
            for (const img of m.images) {
                if (img) {
                    const u = img.resolvedUrl || img.sourceUrl || img.url || img.src;
                    registerTarget(u, img.fileName || img.name, img.alt || img.name, i);
                }
            }
        }

        if (typeof m.content === 'string') {
            const matches = m.content.matchAll(/!\[([^\]]*)\]\((https?:\/\/[^\s\)]+)\)/g);
            for (const match of matches) {
                const alt = match[1];
                const u = match[2];
                registerTarget(u, undefined, alt, i);
            }
        }
    }

    if (targets.size === 0) return [];

    // 2. Fetch and persist images with bounded concurrency.
    const IMAGE_FETCH_CONCURRENCY = 4;
    const targetList = Array.from(targets.values());
    const fetcher = getAssetFetcher();
    const collectedAssets: Array<{ fileName: string; subDir: string; buffer?: any; base64?: string }> = [];

    const processOneTarget = async (target: any): Promise<void> => {
        try {
            const res = await (fetcher && typeof fetcher.fetchImageBuffer === 'function'
                ? fetcher.fetchImageBuffer(target.url, 12000)
                : null);

            const buf = res?.buffer;
            const hasBytes = buf && (buf.byteLength > 0 || (buf as any).length > 0);

            if (res && hasBytes) {
                if (res.ext && !target.fileName.toLowerCase().endsWith(`.${res.ext}`)) {
                    target.fileName = target.fileName.replace(/\.[a-z0-9]+$/i, `.${res.ext}`);
                    target.localName = `assets/${target.fileName}`;
                }
                if (writer && typeof writer.writeFile === 'function') {
                    await writer.writeFile('assets', target.fileName, res.buffer);
                }
                const b64 = (res as any).base64 || arrayBufferToBase64(res.buffer);
                collectedAssets.push({
                    fileName: target.fileName,
                    subDir: 'assets',
                    buffer: res.buffer,
                    base64: b64
                });
                target.saved = true;
                if (isDev()) {
                    console.log(`[LiveSaveCoordinator] Saved image asset ${target.fileName} (${res.buffer.byteLength || (res.buffer as any).length} bytes)`);
                }
            } else {
                failures.push({ file: target.fileName, error: 'image download returned no bytes' });
                console.warn('[LiveSaveCoordinator] Failed to fetch image asset, skipping relative rewrite:', target.fileName);
            }
        } catch (err) {
            failures.push({ file: target.fileName, error: err instanceof Error ? err.message : String(err) });
            if (isDev()) {
                console.warn('[LiveSaveCoordinator] Error saving image asset:', target.url, err);
            }
        }
    };

    {
        let next = 0;
        const workers: Promise<void>[] = [];
        const workerCount = Math.min(IMAGE_FETCH_CONCURRENCY, targetList.length);
        for (let w = 0; w < workerCount; w++) {
            workers.push((async () => {
                while (next < targetList.length) {
                    const target = targetList[next++];
                    await processOneTarget(target);
                }
            })());
        }
        await Promise.allSettled(workers);
    }

    // 3. Rewrite in-memory conversation references for successfully saved assets
    const savedMap = new Map<string, string>();
    for (const t of targetList) {
        if (t.saved) {
            savedMap.set(t.url, t.localName);
        }
    }

    if (savedMap.size === 0) return collectedAssets;

    for (const m of chat.messages) {
        if (!m) continue;

        if (Array.isArray(m.attachments)) {
            for (const att of m.attachments) {
                const u = att.src || att.originalUrl || att.url || att.sourceUrl;
                if (u && savedMap.has(u)) {
                    const local = savedMap.get(u)!;
                    att.localName = local;
                    att.src = local;
                }
            }
        }

        if (Array.isArray(m.images)) {
            for (const img of m.images) {
                const u = img.resolvedUrl || img.sourceUrl || img.url || img.src;
                if (u && savedMap.has(u)) {
                    const local = savedMap.get(u)!;
                    img.localName = local;
                    img.src = local;
                    img.url = local;
                }
            }
        }

        if (typeof m.content === 'string') {
            for (const [onlineUrl, localPath] of savedMap.entries()) {
                if (m.content.includes(onlineUrl)) {
                    m.content = m.content.split(onlineUrl).join(localPath);
                }
            }
        }
    }

    return collectedAssets;
}

async function writeConversationToDisk(
    chat: any,
    safeTitle: string,
    nid: string,
    dirHandle: any,
    config: LiveSaveConfig
): Promise<Array<{ file: string; error: string }>> {
    const Utils = getUtils();
    const failures: Array<{ file: string; error: string }> = [];

    const writer = await createLiveSaveWriter(dirHandle, { fsWriterClass: getFsWriterClass() });

    if (config.includeAssets !== false) {
        await processAndSaveImages(chat, nid, writer, failures);
    }

    await writeLiveSaveMarkdown(
        writer,
        { chat, safeTitle, nid },
        { formatter: getFormatter(), buildFileName: Utils?.buildExportFileName || buildExportFileName }
    );
    return failures;
}

export function isCurrentlySaving(): boolean {
    return _isSaving;
}

export const LiveSaveCoordinator = {
    init,
    resolveConversationDetail,
    executeLiveSave,
    processAndSaveImages,
    arrayBufferToBase64,
    isCurrentlySaving
};

export default LiveSaveCoordinator;
