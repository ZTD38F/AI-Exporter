// src/content/assetFetcher.ts - In-page authenticated blob and asset fetching handler
import { contentContext } from './contentContext.js';

const MAX_BASE64_BLOB_SIZE = 50 * 1024 * 1024; // 超过50MB避免 FileReader base64 内存翻倍，交由 Takeout 兜底
const LARGE_FILE_WARN_SIZE = 30 * 1024 * 1024;
const GG_CHAIN_MAX_HOPS = 5;

export function ensureAlr(url: string): string {
    if (!url || typeof url !== 'string') return url;
    if (url.includes('alr=yes')) return url;
    return url.includes('?') ? url + '&alr=yes' : url + '?alr=yes';
}

export function isGgChainUrl(url: string): boolean {
    if (!url || typeof url !== 'string') return false;
    return url.includes('/gg/') || url.includes('/rd-gg/');
}

export async function fetchGgChain(url: string, init?: RequestInit): Promise<Response> {
    let current = ensureAlr(url);
    let lastRes: Response | null = null;
    const baseInit = init || {};

    for (let i = 0; i < GG_CHAIN_MAX_HOPS; i++) {
        try {
            const res = await fetch(current, { ...baseInit, signal: AbortSignal.timeout(8000) });
            lastRes = res;
            if (!res.ok) return res;

            const ct = (res.headers.get('content-type') || '').toLowerCase();
            if (ct.startsWith('image/')) return res;

            // gg/rd-gg chain: text/plain or text/html body contains next redirect URL
            if (ct.includes('text/plain') || ct.includes('text/html')) {
                let txt = '';
                try {
                    txt = await res.clone().text();
                } catch {
                    return res;
                }
                const next = extractLh3(txt);
                if (next && next !== current) {
                    current = ensureAlr(next);
                    continue;
                }
            }
            return res;
        } catch (err) {
            if (contentContext.isDevMode()) {
                console.debug('[GemExporter:assetFetcher] fetchGgChain hop error', i, current.slice(0, 80), err);
            }
            // If hop threw without alr, retry once with ensureAlr
            const withAlr = ensureAlr(current);
            if (withAlr !== current) {
                current = withAlr;
                continue;
            }
            break;
        }
    }
    return lastRes!;
}

export function toHighRes(url: string, variant = 's1024-rj'): string {
    try {
        if (!url) return url;
        if (url.includes('/gg/')) {
            return url.includes('?') ? (url.includes('alr=yes') ? url : url + '&alr=yes') : url + '?alr=yes';
        }
        const [base, q = ''] = url.split('?');
        const stripped = base.replace(/=s\d+(?:-[a-z0-9]+)*/i, '');
        const suffix = q ? q + '&alr=yes' : 'alr=yes';
        return stripped + '=' + variant + '?' + suffix;
    } catch {
        return url;
    }
}

export function toDataUrl(blob: Blob): Promise<string> {
    if (typeof FileReader === 'undefined') {
        if (typeof Buffer !== 'undefined' && typeof (blob as any).arrayBuffer === 'function') {
            return (blob as any).arrayBuffer().then((buf: ArrayBuffer) => {
                const b64 = Buffer.from(buf).toString('base64');
                const type = blob.type || 'application/octet-stream';
                return `data:${type};base64,${b64}`;
            });
        }
    }
    return new Promise((res, rej) => {
        const fr = new FileReader();
        fr.onloadend = () => res(String(fr.result || ''));
        fr.onerror = () => rej(fr.error || new Error('read fail'));
        fr.readAsDataURL(blob);
    });
}

export function extractLh3(text: string): string | null {
    if (!text || typeof text !== 'string') return null;
    const clean = text
        .replace(/\\\//g, '/')
        .replace(/\\u003d/gi, '=')
        .replace(/\\u0026/gi, '&');
    const m = clean.match(/https:\/\/lh[3-6]\.google(?:usercontent)?\.com\/[^\s"'<>\\]+/i);
    return m ? m[0] : null;
}

export function extractGucUrl(text: string): string | null {
    const m = text.match(/https:\/\/[^\s"'<>]*googleusercontent[^\s"'<>]*download[^\s"'<>]*/i);
    if (m) return m[0].replace(/\\u003d/g, '=').replace(/\\u0026/g, '&');
    const m2 = text.match(/https:\/\/lh3\.google(?:usercontent)?\.com\/[^\s"'<>\\]+/i);
    return m2 ? m2[0].replace(/\\u003d/g, '=').replace(/\\u0026/g, '&') : null;
}

export async function handleGetFileBlob(msg: any, sendResponse: (resp: any) => void): Promise<void> {
    try {
        let candidates: string[] = [];
        if (msg.candidates && Array.isArray(msg.candidates)) candidates.push(...msg.candidates);
        if (msg.url) candidates.unshift(msg.url);

        try {
            if (typeof document !== 'undefined') {
                const links = document.querySelectorAll('a[href*="googleusercontent"], a[href*="drive.google"], a[download]');
                for (const a of Array.from(links)) {
                    const href = (a as HTMLAnchorElement).href || a.getAttribute('href') || '';
                    const txt = (a.textContent || a.getAttribute('aria-label') || '').trim();
                    if (!href) continue;
                    if (msg.fileName && (txt.includes(msg.fileName) || href.includes(encodeURIComponent(msg.fileName)))) candidates.push(href);
                    else if (href.includes('googleusercontent') && href.includes('download')) candidates.push(href);
                }
            }
        } catch (e) {
            if (contentContext.isDevMode()) console.debug('[GemExporter:assetFetcher.ts]', e);
        }

        try {
            if (typeof document !== 'undefined') {
                const html = document.documentElement?.innerHTML || '';
                const m = html.match(/https:\/\/[^\s"'<>]*googleusercontent[^\s"'<>]*download[^\s"'<>]*/i);
                if (m) candidates.push(m[0].replace(/\\u003d/g, '=').replace(/\\u0026/g, '&'));
            }
        } catch (e) {
            if (contentContext.isDevMode()) console.debug('[GemExporter:assetFetcher.ts]', e);
        }

        candidates = [...new Set(candidates.filter(Boolean))];
        if (!candidates.length) {
            sendResponse({
                success: false,
                error: 'no file candidates (need Gemini page with login)'
            });
            return;
        }

        const seen = new Set<string>();
        const queue = [...candidates];
        const reasons: string[] = [];

        while (queue.length) {
            const u = queue.shift();
            if (!u || seen.has(u)) continue;
            seen.add(u);

            try {
                const res = await fetch(u, { credentials: 'include', signal: AbortSignal.timeout(15000) });
                if (!res.ok) {
                    reasons.push(`${u} -> HTTP ${res.status}`);
                    continue;
                }
                const blob = await res.blob();
                if (blob.size === 0) {
                    reasons.push(`${u} -> empty blob`);
                    continue;
                }
                const dataUrl = await toDataUrl(blob);
                sendResponse({
                    success: true,
                    dataUrl,
                    mimeType: blob.type || 'application/octet-stream',
                    size: blob.size,
                    url: u
                });
                return;
            } catch (err: any) {
                const isTimeout = err?.name === 'TimeoutError' || /timeout|aborted/i.test(err?.message || '');
                reasons.push(`${u} -> ${isTimeout ? 'timeout' : ''}${err?.message || err}`);
            }
        }

        sendResponse({
            success: false,
            error: 'All fetch candidates failed: ' + reasons.join('; ')
        });
    } catch (e: any) {
        sendResponse({
            success: false,
            error: 'fetchFileBlob fatal: ' + (e?.message || e)
        });
    }
}

export async function handleGetImageBlob(msg: any, sendResponse: (resp: any) => void): Promise<void> {
    try {
        const rawUrl = msg.url;
        if (!rawUrl) {
            sendResponse({ success: false, error: 'no url provided' });
            return;
        }

        const highResUrl = toHighRes(rawUrl);
        const urlsToTry = [highResUrl];
        if (highResUrl !== rawUrl) urlsToTry.push(rawUrl);

        let lastErr = '';
        for (const u of urlsToTry) {
            try {
                const init: RequestInit = { credentials: 'include', signal: AbortSignal.timeout(15000) };
                if (contentContext.isDevMode()) console.debug('[GemExporter:assetFetcher] try image', u.slice(0, 120));
                const res = isGgChainUrl(u) ? await fetchGgChain(u, init) : await fetch(u, init);
                if (contentContext.isDevMode()) console.debug('[GemExporter:assetFetcher] res image', u.slice(0, 60), res?.status, res?.headers?.get('content-type'));
                if (!res || !res.ok) {
                    lastErr = `HTTP ${res?.status || 'unknown'}`;
                    continue;
                }
                const ct0 = (res.headers.get('content-type') || '').toLowerCase();
                // if chain ended on text/plain without image, treat as failure to try next candidate
                if (ct0.includes('text/plain') || ct0.includes('text/html')) {
                    // try to see if it's actually an image mis-labelled - check blob type
                    const blobProbe = await res.clone().blob().catch(() => null);
                    if (!blobProbe || !blobProbe.type.startsWith('image/')) {
                        lastErr = `unexpected ct ${ct0}`;
                        continue;
                    }
                }
                const blob = await res.blob();
                if (!blob || blob.size === 0) {
                    lastErr = 'empty blob';
                    continue;
                }
                if (msg.preferBuffer === true && typeof blob.arrayBuffer === 'function') {
                    try {
                        const dataBuffer = await blob.arrayBuffer();
                        sendResponse({
                            success: true,
                            dataBuffer,
                            blobBuffer: dataBuffer,
                            mime: blob.type || 'image/jpeg',
                            mimeType: blob.type || 'image/jpeg',
                            size: blob.size,
                            url: u
                        });
                        return;
                    } catch (e) {
                        if (contentContext.isDevMode()) console.debug('[GemExporter:assetFetcher.ts]', e);
                    }
                }
                const dataUrl = await toDataUrl(blob);
                sendResponse({
                    success: true,
                    dataUrl,
                    dataBase64: dataUrl.split(',')[1],
                    blobBase64: dataUrl.split(',')[1],
                    mime: blob.type || 'image/jpeg',
                    mimeType: blob.type || 'image/jpeg',
                    size: blob.size,
                    url: u
                });
                return;
            } catch (e: any) {
                lastErr = e?.message || String(e);
            }
        }

        sendResponse({
            success: false,
            error: 'Failed to fetch image: ' + lastErr
        });
    } catch (e: any) {
        sendResponse({
            success: false,
            error: 'handleGetImageBlob fatal: ' + (e?.message || e)
        });
    }
}

export async function downloadAssetDirect(msg: any, sendResponse: (resp: any) => void): Promise<void> {
    try {
        const url = msg.url;
        if (!url) {
            sendResponse({ success: false, error: 'no url' });
            return;
        }

        try {
            const init2: RequestInit = {
                credentials: 'include',
                headers: { Accept: '*/*' },
                signal: AbortSignal.timeout(15000)
            };
            const isGg = isGgChainUrl(url);
            const r = isGg ? await fetchGgChain(url, init2) : await fetch(url, init2);
            if (r && r.ok) {
                const ct = (r.headers.get('content-type') || '').toLowerCase();
                const isTextResponse = ct.startsWith('text/plain') || ct.startsWith('text/html');
                if (!isGg || !isTextResponse) {
                    const blob = await r.blob();
                    if (blob.size > MAX_BASE64_BLOB_SIZE) {
                        sendResponse({
                            success: false,
                            error: `asset too large (${(blob.size / 1024 / 1024).toFixed(1)}MB > ${MAX_BASE64_BLOB_SIZE / 1024 / 1024}MB cap); use Google Takeout import`
                        });
                        return;
                    } else if (blob.size > 0 && (!isTextResponse || blob.size > 2000)) {
                        if (msg.preferBuffer === true && typeof blob.arrayBuffer === 'function') {
                            try {
                                const dataBuffer = await blob.arrayBuffer();
                                sendResponse({
                                    success: true,
                                    dataBuffer: dataBuffer,
                                    mime: blob.type || ct,
                                    size: blob.size
                                });
                                return;
                            } catch (e) {
                                if (contentContext.isDevMode()) console.debug('[GemExporter:assetFetcher.ts]', e);
                            }
                        }
                        const dataUrl = await toDataUrl(blob);
                        sendResponse({
                            success: true,
                            dataBase64: dataUrl.split(',')[1],
                            mime: blob.type || ct,
                            size: blob.size
                        });
                        return;
                    }
                }
            }
        } catch (e) {
            if (contentContext.isDevMode()) console.debug('[GemExporter:assetFetcher.ts]', e);
        }

        handleGetImageBlob(msg, (res) => {
            if (res && res.success && (res.dataBuffer || res.blobBuffer || res.dataBase64 || res.blobBase64)) {
                sendResponse({
                    success: true,
                    dataBuffer: res.dataBuffer || res.blobBuffer,
                    blobBuffer: res.dataBuffer || res.blobBuffer,
                    dataUrl: res.dataUrl,
                    dataBase64: res.dataBase64 || res.blobBase64,
                    blobBase64: res.dataBase64 || res.blobBase64,
                    mime: res.mime || res.mimeType,
                    size: res.size
                });
            } else {
                handleGetFileBlob(msg, sendResponse);
            }
        });
    } catch (err: any) {
        sendResponse({ success: false, error: err?.message || String(err) });
    }
}

export interface FetchedImageAsset {
    buffer: ArrayBuffer;
    mimeType: string;
    ext: string;
}

export function inferImageExt(mimeType?: string, url?: string): string {
    const mime = (mimeType || '').toLowerCase();
    if (mime.includes('png')) return 'png';
    if (mime.includes('webp')) return 'webp';
    if (mime.includes('gif')) return 'gif';
    if (mime.includes('svg')) return 'svg';
    if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg';
    if (url) {
        const clean = url.split('?')[0].split('#')[0];
        const m = clean.match(/\.(png|jpe?g|webp|gif|svg)$/i);
        if (m) return m[1].toLowerCase().replace('jpeg', 'jpg');
    }
    return 'jpg';
}

export async function fetchImageBuffer(url: string, timeoutMs = 12000): Promise<FetchedImageAsset | null> {
    if (!url || typeof url !== 'string') return null;
    return new Promise((resolve) => {
        let timer: any = null;
        let settled = false;

        const cleanup = () => {
            if (timer) clearTimeout(timer);
        };

        if (timeoutMs > 0) {
            timer = setTimeout(() => {
                if (!settled) {
                    settled = true;
                    resolve(null);
                }
            }, timeoutMs);
        }

        handleGetImageBlob({ url, preferBuffer: true }, (res: any) => {
            cleanup();
            if (settled) return;
            settled = true;
            if (res && res.success && res.dataBuffer) {
                const mimeType = res.mimeType || res.mime || 'image/jpeg';
                const ext = inferImageExt(mimeType, res.url || url);
                resolve({
                    buffer: res.dataBuffer,
                    mimeType,
                    ext
                });
            } else if (res && res.success && (res.dataBase64 || res.blobBase64)) {
                try {
                    const b64 = res.dataBase64 || res.blobBase64;
                    const binStr = atob(b64);
                    const len = binStr.length;
                    const bytes = new Uint8Array(len);
                    for (let i = 0; i < len; i++) bytes[i] = binStr.charCodeAt(i);
                    const mimeType = res.mimeType || res.mime || 'image/jpeg';
                    const ext = inferImageExt(mimeType, res.url || url);
                    resolve({
                        buffer: bytes.buffer,
                        mimeType,
                        ext
                    });
                } catch {
                    resolve(null);
                }
            } else {
                resolve(null);
            }
        });
    });
}

export const AssetFetcher = {
    ensureAlr,
    toHighRes,
    toDataUrl,
    extractLh3,
    extractGucUrl,
    handleGetFileBlob,
    handleGetImageBlob,
    downloadAssetDirect,
    fetchGgChain,
    isGgChainUrl,
    fetchImageBuffer,
    inferImageExt
};


(AssetFetcher as any).AssetFetcher = AssetFetcher;
(AssetFetcher as any).default = AssetFetcher;

if (typeof globalThis !== 'undefined') {
    (globalThis as any).AssetFetcher = AssetFetcher;
}
if (typeof module !== 'undefined' && (module as any).exports) {
    (module as any).exports = AssetFetcher;
}

export default AssetFetcher;

