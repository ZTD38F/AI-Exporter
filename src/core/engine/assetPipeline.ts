import type { IExportWriter } from "./writers/writerInterface.js";

export interface ProcessAssetOptions {
    isImage?: boolean;
    listTitle?: string;
    timeoutMs?: number;
    signal?: AbortSignal | null;
    maxRetries?: number;
}

export interface ProcessAssetResult {
    saved: boolean;
    failReason: string;
    recoveredFromTakeout: boolean;
    localName: string;
}

export interface AcquireAssetBytesResult {
    ok: boolean;
    bytes: Uint8Array | null;
    base64?: string | null;
    fromBuffer?: boolean;
    mimeType?: string;
    failReason: string;
    recoveredFromTakeout: boolean;
    localName: string;
}

export interface AssetPipelineOptions {
    currentSlot?: string;
    useZip?: boolean;
    writer?: IExportWriter | null;
    writeFileDirect?: (path: string, content: any) => Promise<void>;
    takeoutEngine?: any;
    getGeminiTab?: (slot?: string) => Promise<any>;
    sendToGeminiTab?: (message: any, slot?: string, timeoutMs?: number) => Promise<any>;
    fetchAssetDelegate?: (params: any) => Promise<any>;
    fetchAsset?: (params: any) => Promise<any>;
    onLog?: (msg: string, level?: string) => void;
    downloadTimeoutMs?: number;
}

export interface AssetPipelineClass {
    new (options?: AssetPipelineOptions): AssetPipelineInstance;
    sanitizeZipPath?: (p?: string | null) => string;
}

export interface AssetPipelineInstance {
    currentSlot: string;
    useZip: boolean;

    writer: IExportWriter | null;
    writeFileDirect: ((path: string, content: any) => Promise<void>) | null;
    takeoutEngine: any;
    getGeminiTab: ((slot?: string) => Promise<any>) | null;
    sendToGeminiTab: ((message: any, slot?: string, timeoutMs?: number) => Promise<any>) | null;
    fetchAssetDelegate: ((params: any) => Promise<any>) | null;
    onLog: (msg: string, level?: string) => void;
    downloadTimeoutMs: number;
    acquireAssetBytes: (item: any, chat: any, opts?: ProcessAssetOptions) => Promise<AcquireAssetBytesResult>;
    processAsset: (item: any, chat: any, opts?: ProcessAssetOptions) => Promise<ProcessAssetResult>;
}

import { sanitizeRelativePath } from "../utils/utils.js";
import { I18n as I18nStatic } from "../utils/i18n.js";
import { __resolveModule } from "../utils/moduleOverrides.js";
import { calculateBackoff } from "./export/rateLimiter.js";
import { interruptibleSleep } from "../api/client/retryPolicy.js";
import { getErrorMessage } from "../utils/messaging.js";

export function sanitizeZipPath(p?: string | null): string {
    if (!p) return '';
    return sanitizeRelativePath(p, 'file');
}

function hasValidBuffer(r: any): boolean {
    return !!(r && r.dataBuffer && (
        (typeof ArrayBuffer !== 'undefined' && r.dataBuffer instanceof ArrayBuffer && r.dataBuffer.byteLength > 0) ||
        (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(r.dataBuffer) && (r.dataBuffer as any).byteLength > 0)
    ));
}

function hasValidB64(r: any): boolean {
    return !!(r && (r.dataBase64 || r.blobBase64 || (typeof r.dataUrl === 'string' && r.dataUrl.includes(','))));
}

function decodeBase64ToBytes(b64: string): Uint8Array {
    const clean = b64.replace(/\s+/g, '');
    if (typeof Buffer !== 'undefined' && typeof Buffer.from === 'function') {
        const buf = Buffer.from(clean, 'base64');
        return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    }
    const binStr = atob(clean);
    const len = binStr.length;
    const out = new Uint8Array(len);
    for (let k = 0; k < len; k++) out[k] = binStr.charCodeAt(k);
    return out;
}

function sendTabAssetRequest(tabId: number, url: string, chatId: string, preferBuffer: boolean, timeoutMs: number, timeoutMsg: string, signal?: AbortSignal | null, extra?: any): Promise<any> {
    return new Promise(resolve => {
        let timer: any = null;
        let settled = false;
        const onAbort = () => done({ success: false, error: 'aborted' });
        const done = (val: any) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            try { signal?.removeEventListener?.("abort", onAbort); } catch (_) { /* noop */ }
            resolve(val);
        };

        if (signal?.aborted) {
            done({ success: false, error: 'aborted' });
            return;
        }
        if (signal && typeof signal.addEventListener === "function") {
            signal.addEventListener("abort", onAbort, { once: true });
        }

        if (timeoutMs > 0) {
            timer = setTimeout(() => {
                done({ success: false, error: `${timeoutMsg} after ${timeoutMs}ms` });
            }, timeoutMs);
        }

        chrome.tabs.sendMessage(tabId, {
            action: 'downloadAssetDirect',
            url,
            referer: `https://gemini.google.com/app/${chatId}`,
            preferBuffer,
            fileName: extra?.fileName,
            candidates: extra?.candidates
        }, (resp: any) => {
            if (chrome.runtime && chrome.runtime.lastError) {
                done({ success: false, error: chrome.runtime.lastError.message });
            } else {
                done(resp);
            }
        });
    });
}

    class AssetPipeline implements AssetPipelineInstance {
        currentSlot: string;
        useZip: boolean;
        writer: IExportWriter | null;
        writeFileDirect: ((path: string, content: any) => Promise<void>) | null;
        takeoutEngine: any;
        getGeminiTab: ((slot?: string) => Promise<any>) | null;
        sendToGeminiTab: ((message: any, slot?: string, timeoutMs?: number) => Promise<any>) | null;
        fetchAssetDelegate: ((params: any) => Promise<any>) | null;
        onLog: (msg: string, level?: string) => void;
        downloadTimeoutMs: number;

        static sanitizeZipPath = sanitizeZipPath;

        constructor(options: AssetPipelineOptions = {}) {
            this.currentSlot = options.currentSlot || 'u0';
            this.useZip = options.useZip !== false;
            this.writer = options.writer || null;
            this.writeFileDirect = options.writeFileDirect || null;
            this.takeoutEngine = options.takeoutEngine || null;
            this.getGeminiTab = options.getGeminiTab || null;
            this.sendToGeminiTab = options.sendToGeminiTab || null;
            this.fetchAssetDelegate = options.fetchAssetDelegate || options.fetchAsset || null;
            this.onLog = options.onLog || (() => {});
            this.downloadTimeoutMs = options.downloadTimeoutMs || 15000;
        }

        private async downloadOnce(targetUrl: string, chat: any, item: any, timeoutMs: number, signal: AbortSignal | null): Promise<any> {
            let r: any = null;
            // Search thumbnails are public media. Fetch from the extension origin,
            // whose host permission avoids Gemini page CORS restrictions.
            let mediaUrl: URL;
            try { mediaUrl = new URL(targetUrl); } catch { return { success: false, error: 'Invalid asset URL' }; }
            if (mediaUrl.protocol === 'http:' && /(^|\.)(googleusercontent\.com|gstatic\.com|usercontent\.google\.com)$/.test(mediaUrl.hostname)) {
                mediaUrl.protocol = 'https:';
                targetUrl = mediaUrl.href;
            }
            if (/^encrypted-tbn[0-3]\.gstatic\.com$/.test(mediaUrl.hostname)
                && ['http:', 'https:'].includes(mediaUrl.protocol)) {
                mediaUrl.protocol = 'https:';
                try {
                    const timeout = AbortSignal.timeout(timeoutMs);
                    const response = await fetch(mediaUrl.href, {
                        credentials: 'omit',
                        signal: signal ? AbortSignal.any([signal, timeout]) : timeout
                    });
                    if (!response.ok) throw new Error(`HTTP ${response.status}`);
                    const blob = await response.blob();
                    if (!blob.size || !blob.type.startsWith('image/')) throw new Error(`Invalid image response: ${blob.type}`);
                    return { success: true, dataBuffer: await blob.arrayBuffer(), mimeType: blob.type };
                } catch (error) {
                    if (signal?.aborted) return { success: false, error: 'aborted' };
                    r = { success: false, error: `Extension image fetch failed: ${getErrorMessage(error)}` };
                }
            }

            const extensionFailure = r?.error;
            const extra = {
                fileName: item?.fileName || item?.title,
                candidates: Array.isArray(item?.candidates) ? item.candidates : undefined
            };
            const requestFromTab = async (preferBuffer: boolean): Promise<any> => {
                const tab = this.getGeminiTab ? await this.getGeminiTab(this.currentSlot) : null;
                let response = tab && targetUrl && typeof chrome !== 'undefined' && chrome.tabs
                    ? await sendTabAssetRequest(tab.id, targetUrl, chat.id, preferBuffer, timeoutMs, 'tabs.sendMessage timed out', signal, extra)
                    : null;
                const noReceiver = response && !response.success &&
                    /Receiving end does not exist|Could not establish connection/i.test(String(response.error || ''));
                if (targetUrl && (!tab || noReceiver) && this.sendToGeminiTab && !signal?.aborted) {
                    try {
                        response = await this.sendToGeminiTab({
                            action: 'downloadAssetDirect',
                            url: targetUrl,
                            referer: `https://gemini.google.com/app/${chat.id}`,
                            preferBuffer,
                            ...extra
                        }, this.currentSlot, timeoutMs);
                    } catch (e) {
                        response = { success: false, error: getErrorMessage(e) };
                    }
                }
                return signal?.aborted ? { success: false, error: 'aborted' } : response;
            };

            if (this.fetchAssetDelegate && targetUrl) {
                r = await this.fetchAssetDelegate({
                    url: targetUrl,
                    referer: `https://gemini.google.com/app/${chat.id}`,
                    preferBuffer: true,
                    timeoutMs,
                    slot: this.currentSlot,
                    chat,
                    item,
                    signal,
                    ...extra
                });
            } else {
                r = await requestFromTab(true);
            }

            // In Chrome extension IPC, ArrayBuffers passed via chrome.tabs.sendMessage get collapsed to {}
            // If dataBuffer is not a valid ArrayBuffer or lacks byteLength, and no base64 was sent, fall back to requesting Base64
            if (r && (r.success || r.ok) && !hasValidBuffer(r) && !hasValidB64(r) && typeof chrome !== 'undefined' && chrome.tabs) {
                r = await requestFromTab(false);
            }
            if (extensionFailure && !r?.success && !r?.ok) {
                return { success: false, error: `${extensionFailure}; page fallback: ${r?.error || 'unavailable'}` };
            }
            return r;
        }

        private extractDownloadPayload(r: any, isImage: boolean): {
            ok: boolean;
            bytes: Uint8Array | null;
            base64: string | null;
            fromBuffer: boolean;
            mimeType?: string;
            failReason: string;
        } {
            if (!r || (!r.success && !r.ok)) {
                const defaultFail = isImage ? 'image direct download failed' : 'downloadAssetDirect failed';
                return {
                    ok: false,
                    bytes: null,
                    base64: null,
                    fromBuffer: false,
                    failReason: r ? (r.error || defaultFail) : defaultFail,
                };
            }
            const isValidBuffer = hasValidBuffer(r);
            const bufferBytes = isValidBuffer ? (
                typeof ArrayBuffer !== 'undefined' && r.dataBuffer instanceof ArrayBuffer
                    ? new Uint8Array(r.dataBuffer)
                    : (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(r.dataBuffer)
                        ? new Uint8Array(r.dataBuffer.buffer, r.dataBuffer.byteOffset, r.dataBuffer.byteLength)
                        : new Uint8Array(r.dataBuffer))
            ) : null;
            const rawB64 = r.dataBase64 || r.blobBase64 || (typeof r.dataUrl === 'string' && r.dataUrl.includes(',') ? r.dataUrl.split(',')[1] : null);
            const b64 = typeof rawB64 === 'string' && rawB64.length > 0 ? rawB64 : null;
            const mimeType = typeof (r.mimeType || r.mime) === 'string' && (r.mimeType || r.mime)
                ? String(r.mimeType || r.mime)
                : undefined;

            if (bufferBytes && bufferBytes.length > 0) {
                return {
                    ok: true,
                    bytes: bufferBytes,
                    base64: b64,
                    fromBuffer: true,
                    mimeType,
                    failReason: '',
                };
            }
            if (b64) {
                try {
                    const decoded = decodeBase64ToBytes(b64);
                    if (decoded.length > 0) {
                        return {
                            ok: true,
                            bytes: decoded,
                            base64: b64,
                            fromBuffer: false,
                            mimeType,
                            failReason: '',
                        };
                    }
                } catch {
                    // fall through to failure below
                }
            }
            return {
                ok: false,
                bytes: null,
                base64: null,
                fromBuffer: false,
                failReason: r.error || 'Empty or unparseable binary/base64 payload',
            };
        }

        private logTakeoutRecovery(chat: any, localName: string, isImage: boolean): void {
            const logKey = isImage ? 'logTakeoutImageRecovered' : 'logTakeoutAssetRecovered';
            const I18n = __resolveModule('I18n', I18nStatic);
            this.onLog(I18n.t(logKey, chat.title || chat.id, localName), 'info');
        }

        async acquireAssetBytes(item: any, chat: any, opts: ProcessAssetOptions = {}): Promise<AcquireAssetBytesResult> {
            const isImage = !!opts.isImage;
            const rawCandidates = [item.url, item.sourceUrl, item.src].filter(Boolean);
            const nonThumbCandidates = rawCandidates.filter((u: any) => typeof u === 'string' && !u.includes('/viewer/thumb'));
            const targetUrl = isImage
                ? (item.resolvedUrl || item.sourceUrl || item.url || item.src)
                : (nonThumbCandidates[0] || rawCandidates[0]);
            const localName = item.localName || item.fileName || item.title || (isImage ? 'image.jpg' : 'file.bin');
            const signal = opts.signal || null;
            const maxRetries = (typeof opts.maxRetries === "number" && opts.maxRetries >= 0) ? Math.floor(opts.maxRetries) : 3;
            const timeoutMs = opts.timeoutMs || this.downloadTimeoutMs;
            let failReason = '';

            const isRemoteTarget = typeof targetUrl === 'string' && /^(https?:|blob:|data:)/i.test(targetUrl);
            const canAttemptRemote = Boolean(targetUrl && (this.fetchAssetDelegate || isRemoteTarget));

            if (signal && signal.aborted) {
                return {
                    ok: false,
                    bytes: null,
                    base64: null,
                    fromBuffer: false,
                    failReason: 'aborted',
                    recoveredFromTakeout: false,
                    localName,
                };
            }

            if (canAttemptRemote) {
                try {
                    let attempt = 0;
                    for (;;) {
                        if (signal && signal.aborted) { failReason = 'aborted'; break; }
                        const r = await this.downloadOnce(targetUrl, chat, item, timeoutMs, signal);
                        if (signal && signal.aborted) { failReason = 'aborted'; break; }
                        const extracted = this.extractDownloadPayload(r, isImage);
                        if (extracted.ok && extracted.bytes && extracted.bytes.length > 0) {
                            return {
                                ok: true,
                                bytes: extracted.bytes,
                                base64: extracted.base64,
                                fromBuffer: extracted.fromBuffer,
                                ...(extracted.mimeType ? { mimeType: extracted.mimeType } : {}),
                                failReason: '',
                                recoveredFromTakeout: false,
                                localName,
                            };
                        }
                        failReason = extracted.failReason;
                        if (attempt >= maxRetries) break;
                        const delayMs = calculateBackoff(attempt, { initialDelayMs: 1000, maxDelayMs: 10000, jitterMs: 500 });
                        this.onLog(`[${chat.title || chat.id}] 附件下载失败，${delayMs}ms 后重试 (${attempt + 1}/${maxRetries}): ${localName}`, 'warn');
                        if (await interruptibleSleep(delayMs, signal)) { failReason = 'aborted'; break; }
                        attempt++;
                    }
                } catch (e: any) {
                    failReason = e.message;
                }
            } else {
                failReason = isImage ? 'image direct download failed' : 'downloadAssetDirect failed';
            }

            if (!(signal && signal.aborted) && this.takeoutEngine && typeof this.takeoutEngine.getTakeoutFallbackMedia === 'function') {
                try {
                    const offlineBin = await this.takeoutEngine.getTakeoutFallbackMedia(chat.id, localName, this.currentSlot, item.generation);
                    if (offlineBin && offlineBin.length > 0) {
                        const bytes = offlineBin instanceof Uint8Array
                            ? offlineBin
                            : (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(offlineBin)
                                ? new Uint8Array(offlineBin.buffer, offlineBin.byteOffset, offlineBin.byteLength)
                                : new Uint8Array(offlineBin));
                        if (!this.writer && !this.writeFileDirect) {
                            this.logTakeoutRecovery(chat, localName, isImage);
                        }
                        return {
                            ok: true,
                            bytes,
                            base64: null,
                            fromBuffer: true,
                            failReason: '',
                            recoveredFromTakeout: true,
                            localName,
                        };
                    }
                } catch (e) {
                    if (typeof console !== "undefined" && console.debug) console.debug("[GemExporter:assetPipeline.ts]", e);
                }
            }

            return {
                ok: false,
                bytes: null,
                base64: null,
                fromBuffer: false,
                failReason,
                recoveredFromTakeout: false,
                localName,
            };
        }

        async processAsset(item: any, chat: any, opts: ProcessAssetOptions = {}): Promise<ProcessAssetResult> {
            const isImage = !!opts.isImage;
            const acquired = await this.acquireAssetBytes(item, chat, opts);
            const localName = acquired.localName;
            if (!acquired.ok || !acquired.bytes || acquired.bytes.length === 0) {
                return {
                    saved: false,
                    failReason: acquired.failReason,
                    recoveredFromTakeout: false,
                    localName,
                };
            }

            let saved = false;
            let failReason = '';
            if (this.writer) {
                try {
                    if (acquired.fromBuffer || !acquired.base64) {
                        await this.writer.writeFile(sanitizeZipPath(localName), acquired.bytes);
                        saved = true;
                    } else {
                        await this.writer.writeFile(sanitizeZipPath(localName), acquired.base64, { base64: true });
                        saved = true;
                    }
                } catch (e) {
                    // Phase A (P0-1) 语义：writeFile 失败抛错，不静默记成功。
                    // 写入本地失败不再向 CDN 盲目重试网络拉取。
                    saved = false;
                    failReason = getErrorMessage(e);
                    if (!acquired.recoveredFromTakeout) {
                        this.onLog(`[${chat.title || chat.id}] 附件写入本地失败 (${localName}): ${failReason}`, 'warn');
                    } else if (typeof console !== "undefined" && console.debug) {
                        console.debug("[GemExporter:assetPipeline.ts] takeout fallback write failed", e);
                    }
                }
            } else if (this.writeFileDirect) {
                try {
                    await this.writeFileDirect(localName, acquired.bytes);
                    saved = true;
                } catch (e) {
                    saved = false;
                    failReason = getErrorMessage(e);
                    if (!acquired.recoveredFromTakeout) {
                        this.onLog(`[${chat.title || chat.id}] 附件写入本地失败 (${localName}): ${failReason}`, 'warn');
                    }
                }
            } else {
                failReason = 'Empty or unparseable binary/base64 payload';
            }

            const recoveredFromTakeout = saved && acquired.recoveredFromTakeout;
            if (recoveredFromTakeout) {
                this.logTakeoutRecovery(chat, localName, isImage);
            }

            return { saved, failReason, recoveredFromTakeout, localName };
        }
    }

export {
    AssetPipeline
};

export default AssetPipeline;
