// src/core/engine/assetPipeline.ts - Dedicated Asset Download & Persistence Pipeline
import type { GeminiUtilsModule } from "../utils/utils.js";

export interface ProcessAssetOptions {
    isImage?: boolean;
    listTitle?: string;
    timeoutMs?: number;
}

export interface ProcessAssetResult {
    saved: boolean;
    failReason: string;
    recoveredFromTakeout: boolean;
    localName: string;
}

export interface AssetPipelineOptions {
    currentSlot?: string;
    useZip?: boolean;
    folder?: any;
    writeFileDirect?: (path: string, content: any) => Promise<boolean>;
    takeoutEngine?: any;
    getGeminiTab?: (slot?: string) => Promise<any>;
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
    folder: any;
    writeFileDirect: ((path: string, content: any) => Promise<boolean>) | null;
    takeoutEngine: any;
    getGeminiTab: ((slot?: string) => Promise<any>) | null;
    fetchAssetDelegate: ((params: any) => Promise<any>) | null;
    onLog: (msg: string, level?: string) => void;
    downloadTimeoutMs: number;
    processAsset: (item: any, chat: any, opts?: ProcessAssetOptions) => Promise<ProcessAssetResult>;
}

declare global {
    var AssetPipeline: AssetPipelineClass;
}

import { sanitizeRelativePath } from "../utils/utils.js";

export function sanitizeZipPath(p?: string | null): string {
    if (!p) return '';
    return sanitizeRelativePath(p, 'file');
}

    class AssetPipeline implements AssetPipelineInstance {
        currentSlot: string;
        useZip: boolean;
        folder: any;
        writeFileDirect: ((path: string, content: any) => Promise<boolean>) | null;
        takeoutEngine: any;
        getGeminiTab: ((slot?: string) => Promise<any>) | null;
        fetchAssetDelegate: ((params: any) => Promise<any>) | null;
        onLog: (msg: string, level?: string) => void;
        downloadTimeoutMs: number;

        static sanitizeZipPath = sanitizeZipPath;

        constructor(options: AssetPipelineOptions = {}) {
            this.currentSlot = options.currentSlot || 'u0';
            this.useZip = options.useZip !== false;
            this.folder = options.folder || null;
            this.writeFileDirect = options.writeFileDirect || null;
            this.takeoutEngine = options.takeoutEngine || null;
            this.getGeminiTab = options.getGeminiTab || null;
            this.fetchAssetDelegate = options.fetchAssetDelegate || options.fetchAsset || null;
            this.onLog = options.onLog || (() => {});
            this.downloadTimeoutMs = options.downloadTimeoutMs || 15000;
        }

        /**
         * Download and persist an asset (image or attachment file)
         */
        async processAsset(item: any, chat: any, opts: ProcessAssetOptions = {}): Promise<ProcessAssetResult> {
            const isImage = !!opts.isImage;
            const targetUrl = isImage ? (item.resolvedUrl || item.sourceUrl || item.url) : ([item.url, item.sourceUrl, item.src].filter(Boolean)[0]);
            const localName = item.localName || item.fileName || item.title || (isImage ? 'image.jpg' : 'file.bin');
            let saved = false;
            let failReason = '';
            let recoveredFromTakeout = false;

            try {
                let r: any = null;
                const timeoutMs = opts.timeoutMs || this.downloadTimeoutMs;

                if (this.fetchAssetDelegate && targetUrl) {
                    r = await this.fetchAssetDelegate({
                        url: targetUrl,
                        referer: `https://gemini.google.com/app/${chat.id}`,
                        preferBuffer: true,
                        timeoutMs,
                        slot: this.currentSlot,
                        chat,
                        item
                    });
                } else {
                    const tab = this.getGeminiTab ? await this.getGeminiTab(this.currentSlot) : null;
                    if (tab && targetUrl && typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.sendMessage) {
                        r = await new Promise(resolve => {
                            let timer: any = null;
                            let settled = false;

                            if (timeoutMs > 0) {
                                timer = setTimeout(() => {
                                    if (!settled) {
                                        settled = true;
                                        resolve({ success: false, error: `tabs.sendMessage timed out after ${timeoutMs}ms` });
                                    }
                                }, timeoutMs);
                            }

                            chrome.tabs.sendMessage(tab.id, {
                                action: 'downloadAssetDirect',
                                url: targetUrl,
                                referer: `https://gemini.google.com/app/${chat.id}`,
                                preferBuffer: true
                            }, (resp: any) => {
                                if (timer) clearTimeout(timer);
                                if (!settled) {
                                    settled = true;
                                    if (chrome.runtime && chrome.runtime.lastError) {
                                        resolve({ success: false, error: chrome.runtime.lastError.message });
                                    } else {
                                        resolve(resp);
                                    }
                                }
                            });
                        });
                    }
                }

                // In Chrome extension IPC, ArrayBuffers passed via chrome.tabs.sendMessage get collapsed to {}
                // If dataBuffer is not a valid ArrayBuffer or lacks byteLength, and no base64 was sent, fall back to requesting Base64
                const hasValidBuffer = !!(r && r.dataBuffer && (
                    (typeof ArrayBuffer !== 'undefined' && r.dataBuffer instanceof ArrayBuffer && r.dataBuffer.byteLength > 0) ||
                    (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(r.dataBuffer) && (r.dataBuffer as any).byteLength > 0)
                ));
                const hasValidB64 = !!(r && (r.dataBase64 || r.blobBase64 || (typeof r.dataUrl === 'string' && r.dataUrl.includes(','))));

                if (r && r.success && !hasValidBuffer && !hasValidB64 && typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.sendMessage) {
                    const fallbackTab = this.getGeminiTab ? await this.getGeminiTab(this.currentSlot) : null;
                    if (fallbackTab && fallbackTab.id) {
                        r = await new Promise(resolve => {
                            let timer: any = null;
                            let settled = false;

                            if (timeoutMs > 0) {
                                timer = setTimeout(() => {
                                    if (!settled) {
                                        settled = true;
                                        resolve({ success: false, error: `tabs.sendMessage fallback timed out after ${timeoutMs}ms` });
                                    }
                                }, timeoutMs);
                            }

                            chrome.tabs.sendMessage(fallbackTab.id, {
                                action: 'downloadAssetDirect',
                                url: targetUrl,
                                referer: `https://gemini.google.com/app/${chat.id}`,
                                preferBuffer: false
                            }, (resp: any) => {
                                if (timer) clearTimeout(timer);
                                if (!settled) {
                                    settled = true;
                                    if (chrome.runtime && chrome.runtime.lastError) {
                                        resolve({ success: false, error: chrome.runtime.lastError.message });
                                    } else {
                                        resolve(resp);
                                    }
                                }
                            });
                        });
                    }
                }

                if (r && r.success) {
                    const isValidBuffer = !!(r.dataBuffer && (
                        (typeof ArrayBuffer !== 'undefined' && r.dataBuffer instanceof ArrayBuffer && r.dataBuffer.byteLength > 0) ||
                        (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(r.dataBuffer) && (r.dataBuffer as any).byteLength > 0)
                    ));
                    const bytes = isValidBuffer ? new Uint8Array(r.dataBuffer.buffer || r.dataBuffer) : null;
                    const b64 = (r.dataBase64 || r.blobBase64 || (typeof r.dataUrl === 'string' && r.dataUrl.includes(',') ? r.dataUrl.split(',')[1] : null));

                    if (this.useZip) {
                        if (this.folder) {
                            if (bytes && bytes.length > 0) {
                                this.folder.file(sanitizeZipPath(localName), bytes);
                                saved = true;
                            } else if (b64 && typeof b64 === 'string' && b64.length > 0) {
                                this.folder.file(sanitizeZipPath(localName), b64, { base64: true });
                                saved = true;
                            }
                        }
                    } else if (this.writeFileDirect) {
                        if (bytes && bytes.length > 0) {
                            saved = await this.writeFileDirect(localName, bytes);
                        } else if (b64 && typeof b64 === 'string' && b64.length > 0) {
                            const binStr = atob(b64);
                            const len = binStr.length;
                            const b = new Uint8Array(len);
                            for (let k = 0; k < len; k++) b[k] = binStr.charCodeAt(k);
                            saved = await this.writeFileDirect(localName, b);
                        }
                    }

                    if (!saved) {
                        failReason = r.error || 'Empty or unparseable binary/base64 payload';
                    }
                } else {
                    failReason = r ? r.error : (isImage ? 'image direct download failed' : 'downloadAssetDirect failed');
                }
            } catch (e: any) {
                failReason = e.message;
            }

            // Fallback: Takeout Offline Media Pool
            if (!saved && this.takeoutEngine) {
                try {
                    const offlineBin = await this.takeoutEngine.getTakeoutFallbackMedia(chat.id, localName, this.currentSlot);
                    if (offlineBin && offlineBin.length > 0) {
                        if (this.useZip && this.folder) {
                            this.folder.file(sanitizeZipPath(localName), offlineBin);
                            saved = true;
                        } else if (this.writeFileDirect) {
                            saved = await this.writeFileDirect(localName, offlineBin);
                        }
                        if (saved) {
                            recoveredFromTakeout = true;
                            const logKey = isImage ? 'logTakeoutImageRecovered' : 'logTakeoutAssetRecovered';
                            const defaultMsg = isImage
                                ? `[${chat.title || chat.id}] ⚡ 图片从 Takeout 离线池补全成功: ${localName}`
                                : `[${chat.title || chat.id}] ⚡ 附件从 Takeout 离线池补全成功: ${localName}`;
                            const I18n = (globalThis as any).I18n;
                            this.onLog(typeof I18n !== 'undefined' ? I18n.t(logKey, chat.title || chat.id, localName) : defaultMsg, 'info');
                        }
                    }
                } catch (e) {
                    if (typeof console !== "undefined" && console.debug) console.debug("[GemExporter:assetPipeline.ts]", e);
                }
            }

            return { saved, failReason, recoveredFromTakeout, localName };
        }
    }

export {
    AssetPipeline
};

(AssetPipeline as any).AssetPipeline = AssetPipeline;
(AssetPipeline as any).default = AssetPipeline;

if (typeof globalThis !== 'undefined' && !(globalThis as any).AssetPipeline) {
    (globalThis as any).AssetPipeline = AssetPipeline;
}
if (typeof module === 'object' && module.exports) {
    module.exports = AssetPipeline;
}
export default AssetPipeline;
