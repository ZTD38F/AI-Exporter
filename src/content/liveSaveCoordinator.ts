// src/content/liveSaveCoordinator.ts - Coordinator for live auto-saving (IndexedDB + Disk FsWriter)
import { contentContext } from './contentContext.js';
import { LiveStorageManager } from '../core/storage/liveStorageManager.js';
import { DomScraper } from './domScraper.js';
import { ChatFormatter } from '../core/engine/chatFormatter.js';
import { FsWriter } from '../core/engine/writers/fsWriter.js';
import { GeminiUtils } from '../core/utils/utils.js';
import { GeminiAPIClient } from '../core/api/geminiClient.js';
import { BadgeView } from './badgeView.js';
import { AssetFetcher, inferImageExt } from './assetFetcher.js';
import type { LiveConversationRecord, LiveSaveConfig } from '../types/liveSave.js';

export interface LiveSaveCoordinatorDeps {
    storageManager?: typeof LiveStorageManager;
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

function getClientClass() {
    return typeof _deps.clientClass !== 'undefined' ? _deps.clientClass : GeminiAPIClient;
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

export function init(deps: LiveSaveCoordinatorDeps = {}): void {
    _deps = deps;
    if (isDev()) console.log('[LiveSaveCoordinator] Initialized');
}

/**
 * Fetch full conversation detail by ID using Client RPC first, then fallback to DOM.
 */
export async function resolveConversationDetail(cid: string): Promise<any> {
    const nid = String(cid).replace(/^c_/, '').trim();
    const ClientClass = getClientClass();

    if (ClientClass) {
        try {
            const client = new ClientClass();
            const detail = await client.getConversationDetail(nid);
            if (detail && Array.isArray(detail.messages) && detail.messages.length > 0) {
                return detail;
            }
        } catch (e) {
            if (isDev()) console.debug('[LiveSaveCoordinator] RPC fetch detail fallback to DOM:', e);
        }
    }

    // Fallback to DOM scraper
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

/**
 * Execute a live auto-save cycle for the specified conversation.
 */
export async function executeLiveSave(cid: string, reason = 'turn_complete', options: { mockMode?: boolean } = {}): Promise<boolean> {
    if (!cid) return false;
    const nid = String(cid).replace(/^c_/, '').trim();

    // Serialize live save operations to prevent I/O race conditions
    _saveQueue = _saveQueue.then(async () => {
        try {
            _isSaving = true;

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

            // If Disk save is not enabled, do nothing
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
            const now = Date.now();

            let writeSucceeded = false;
            const dirHandle = await Storage.getLiveDirHandle();

            if (dirHandle) {
                // 1. Direct Disk Write via local FileSystem Access API
                try {
                    await writeConversationToDisk(chat, safeTitle, nid, dirHandle, config);
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
                        const isZh = contentContext.isZh();
                        const Badge = getBadge();
                        const warnMsg = isZh ? '⚠ 目标目录已删除，实时同步已暂停' : '⚠ Folder deleted, sync paused';
                        if (Badge && typeof (Badge as any).showLiveSaveWarning === 'function') {
                            (Badge as any).showLiveSaveWarning(warnMsg, isZh);
                        } else if (Badge && typeof (Badge as any).showLiveSaveFeedback === 'function') {
                            (Badge as any).showLiveSaveFeedback(warnMsg);
                        }
                        return false;
                    }
                    throw err;
                }
            } else {
                // 2. Delegate to extension options page holding the directory handle
                if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
                    try {
                        let collectedAssets: any[] = [];
                        if (config.includeAssets !== false) {
                            collectedAssets = await processAndSaveImages(chat, nid, null);
                        }
                        const resp = await new Promise<any>((resolve) => {
                            chrome.runtime.sendMessage({
                                action: 'liveSaveViaHandle',
                                payload: {
                                    chat,
                                    safeTitle,
                                    nid,
                                    config,
                                    assets: collectedAssets.map(a => ({
                                        fileName: a.fileName,
                                        subDir: a.subDir || 'assets',
                                        base64: a.base64 || (a.buffer ? arrayBufferToBase64(a.buffer) : '')
                                    }))
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
                        } else if (resp && (resp.error === 'dir_not_found' || resp.error === 'permission_not_granted' || (resp.error === 'no_dir_handle' && config.dirName))) {
                            console.warn(`[LiveSaveCoordinator] Directory handle unavailable (${resp.error}). Aborting live save to avoid polluting Downloads.`);
                            const isZh = contentContext.isZh();
                            const Badge = getBadge();
                            let warnMsg = isZh ? '⚠ 目标目录已删除，实时同步已暂停' : '⚠ Folder deleted, sync paused';
                            if (resp.error === 'permission_not_granted') {
                                warnMsg = isZh ? '⚠ 目录未授权，实时同步已暂停' : '⚠ Folder permission denied, sync paused';
                            } else if (resp.error === 'no_dir_handle') {
                                warnMsg = isZh ? '⚠ 目录未就绪，实时同步已暂停' : '⚠ Folder not ready, sync paused';
                            }
                            if (Badge && typeof (Badge as any).showLiveSaveWarning === 'function') {
                                (Badge as any).showLiveSaveWarning(warnMsg, isZh);
                            } else if (Badge && typeof (Badge as any).showLiveSaveFeedback === 'function') {
                                (Badge as any).showLiveSaveFeedback(warnMsg);
                            }
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

            // 3. Update configuration metadata
            await Storage.setLiveConfig({
                lastSavedAt: now,
                lastSavedTitle: safeTitle
            });

            // 4. Visual Feedback via Badge
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
export async function processAndSaveImages(chat: any, nid: string, writer?: any): Promise<Array<{ fileName: string; subDir: string; buffer?: any; base64?: string }>> {
    if (!chat || !Array.isArray(chat.messages) || chat.messages.length === 0) return [];

    const Utils = getUtils();
    const cid6 = nid.slice(-6);
    const targets = new Map<string, ImageDownloadTarget>();

    let imgCounter = 0;

    const registerTarget = (rawUrl: string, candidateName?: string, altText?: string, turnIndex = 0) => {
        if (!rawUrl || typeof rawUrl !== 'string' || !rawUrl.startsWith('http')) return;
        if (targets.has(rawUrl)) return;

        imgCounter++;
        const hash4 = Math.abs(hashString(rawUrl)).toString(36).slice(0, 4);
        let ext = inferImageExt('', rawUrl);

        let finalName = '';
        if (candidateName && candidateName.trim() && !/^(?:image|photo|picture|img|file)(?:\.[a-z0-9]+)?$/i.test(candidateName.trim())) {
            const sanitized = Utils?.sanitizeFileName
                ? Utils.sanitizeFileName(candidateName.trim())
                : candidateName.trim().replace(/[\\/:*?"<>|]/g, '_');
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

        // a) m.attachments
        if (Array.isArray(m.attachments)) {
            for (const att of m.attachments) {
                if (att && (att.type === 'image' || att.isImage)) {
                    const u = att.src || att.originalUrl || att.url || att.sourceUrl;
                    registerTarget(u, att.fileName || att.name, att.alt || att.name, i);
                }
            }
        }

        // b) m.images
        if (Array.isArray(m.images)) {
            for (const img of m.images) {
                if (img) {
                    const u = img.resolvedUrl || img.sourceUrl || img.url || img.src;
                    registerTarget(u, img.fileName || img.name, img.alt || img.name, i);
                }
            }
        }

        // c) Inline markdown images: ![alt](url)
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

    // 2. Concurrently fetch and persist images
    const targetList = Array.from(targets.values());
    const fetcher = getAssetFetcher();
    const collectedAssets: Array<{ fileName: string; subDir: string; buffer?: any; base64?: string }> = [];

    await Promise.allSettled(targetList.map(async (target) => {
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
            } else if (isDev()) {
                console.warn('[LiveSaveCoordinator] Failed to fetch image asset, skipping relative rewrite:', target.url);
            }
        } catch (err) {
            if (isDev()) {
                console.warn('[LiveSaveCoordinator] Error saving image asset:', target.url, err);
            }
        }
    }));

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

/**
 * Write formatted conversation and optional assets to disk via FsWriter.
 */
async function writeConversationToDisk(
    chat: any,
    safeTitle: string,
    nid: string,
    dirHandle: any,
    config: LiveSaveConfig
): Promise<void> {
    const WriterCls = getFsWriterClass();
    const Utils = getUtils();
    const Formatter = getFormatter();

    // Use gemini_export folder consistently with manual folder export
    const writer = new WriterCls(dirHandle, 'gemini_export');
    await writer.init();

    // 1. Process and save multimodal image assets to assets/ if enabled
    if (config.includeAssets !== false) {
        await processAndSaveImages(chat, nid, writer);
    }

    // 2. Target filename format: CleanTitle_Cid6.md (consistent with manual export)
    const sanitizedTitle = Utils?.sanitizeFileName ? Utils.sanitizeFileName(safeTitle) : safeTitle.replace(/[\\/:*?"<>|]/g, '_');
    const cid6 = nid.slice(-6);
    const fileName = `${sanitizedTitle}_${cid6}.md`;

    // 3. Format content with full YAML frontmatter & markdown standards
    const markdown = Formatter?.toMarkdown
        ? Formatter.toMarkdown({ ...chat, title: safeTitle, id: nid })
        : `# ${safeTitle}\n\n${JSON.stringify(chat.messages, null, 2)}`;

    await writer.writeFile('', fileName, markdown);
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

declare global {
    var LiveSaveCoordinator: any;
}

if (typeof globalThis !== 'undefined') {
    (globalThis as any).LiveSaveCoordinator = LiveSaveCoordinator;
}

export default LiveSaveCoordinator;
