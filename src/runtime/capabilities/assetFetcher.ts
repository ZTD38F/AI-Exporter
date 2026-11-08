interface AssetFetchRequest {
    url?: string;
    candidates?: string[];
    fileName?: string;
    preferBuffer?: boolean;
}
export interface AssetFetchResponse {
    success: boolean;
    dataUrl?: string;
    dataBuffer?: ArrayBuffer;
    blobBuffer?: ArrayBuffer;
    dataBase64?: string;
    blobBase64?: string;
    mime?: string;
    mimeType?: string;
    size?: number;
    url?: string;
    error?: string;
}
import { contentContext } from '../content/contentContext.js';
import { getErrorMessage } from '../../shared/utils/errorText.js';

const MAX_BASE64_BLOB_SIZE = 50 * 1024 * 1024;
// Chrome JSON IPC has its own limit: base64 expands by 4/3,
// and the image response currently repeats the encoded value in three fields.
// Reject oversized blobs before allocating their encoded copies.
const MAX_IPC_FILE_BLOB_SIZE = 44 * 1024 * 1024;
const MAX_IPC_IMAGE_BLOB_SIZE = 14 * 1024 * 1024;
const GG_CHAIN_MAX_HOPS = 5;

function ensureAlr(url: string): string {
    if (!url) return url;
    if (url.includes('alr=yes')) return url;
    return url.includes('?') ? url + '&alr=yes' : url + '?alr=yes';
}

function isGgChainUrl(url: string): boolean {
    if (!url) return false;
    return url.includes('/gg/') || url.includes('/rd-gg/');
}

async function fetchWithCredentialFallback(
    url: string,
    init?: RequestInit,
    customFetch?: typeof fetch
): Promise<Response> {
    const doFetch = customFetch || fetch;
    const baseInit = init || {};
    const primaryCredentials = baseInit.credentials ?? 'include';
    const primaryInit: RequestInit = {
        ...baseInit,
        credentials: primaryCredentials,
    };

    try {
        return await doFetch(url, primaryInit);
    } catch (err) {
        if (baseInit.signal?.aborted) {
            throw err;
        }

        if (primaryCredentials === 'include') {
            const fallbackInit: RequestInit = {
                ...baseInit,
                credentials: 'omit',
            };
            try {
                return await doFetch(url, fallbackInit);
            } catch {
                throw err;
            }
        }
        throw err;
    }
}

async function fetchGgChain(url: string, init?: RequestInit): Promise<Response> {
    let current = ensureAlr(url);
    let lastRes: Response | null = null;
    const baseInit = init || {};

    for (let i = 0; i < GG_CHAIN_MAX_HOPS; i++) {
        try {
            const signal = baseInit.signal
                ? AbortSignal.any([baseInit.signal, AbortSignal.timeout(8000)])
                : AbortSignal.timeout(8000);
            const res = await fetchWithCredentialFallback(current, { ...baseInit, signal });
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
            if (baseInit.signal?.aborted) throw err;
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
    if (!lastRes) throw new Error('Source redirect chain unavailable');
    return lastRes;
}

function toHighRes(url: string, variant = 's1024-rj'): string {
    try {
        if (!url) return url;
        const hostname = new URL(url).hostname;
        if (hostname === 'gstatic.com' || hostname.endsWith('.gstatic.com')) return url;
        if (url.includes('/gg/') || url.includes('/rd-gg/')) {
            const [base, q = ''] = url.split('?');
            const suffix = q ? (q.includes('alr=yes') ? q : q + '&alr=yes') : 'alr=yes';
            let normBase = base;
            if (/=[sw]\d+/i.test(base)) {
                normBase = base.replace(/=[sw]\d+(?:-[a-z0-9]+)*/i, '=s0');
            } else if (!normBase.endsWith('=s0')) {
                normBase = normBase + '=s0';
            }
            return normBase + '?' + suffix;
        }
        const [base, q = ''] = url.split('?');
        const stripped = base.replace(/=s\d+(?:-[a-z0-9]+)*/i, '');
        const suffix = q ? q + '&alr=yes' : 'alr=yes';
        return stripped + '=' + variant + '?' + suffix;
    } catch {
        return url;
    }
}

function toDataUrl(blob: Blob): Promise<string> {
    return new Promise((res, rej) => {
        const fr = new FileReader();
        fr.onloadend = () => res(String(fr.result || ''));
        fr.onerror = () => rej(fr.error || new Error('read fail'));
        fr.readAsDataURL(blob);
    });
}

function extractLh3(text: string): string | null {
    if (!text) return null;
    const clean = text
        .replace(/\\\//g, '/')
        .replace(/\\u003d/gi, '=')
        .replace(/\\u0026/gi, '&');
    const m = clean.match(/https:\/\/lh[3-6]\.google(?:usercontent)?\.com\/[^\s"'<>\\]+/i);
    return m ? m[0] : null;
}

function extractGucUrl(text: string): string | null {
    const m = text.match(/https:\/\/[^\s"'<>]*(?:googleusercontent|usercontent\.google)[^\s"'<>]*download[^\s"'<>]*/i);
    if (m) return m[0].replace(/\\u003d/g, '=').replace(/\\u0026/g, '&');
    const m2 = text.match(/https:\/\/lh3\.google(?:usercontent)?\.com\/[^\s"'<>\\]+/i);
    return m2 ? m2[0].replace(/\\u003d/g, '=').replace(/\\u0026/g, '&') : null;
}

async function handleGetFileBlob(msg: AssetFetchRequest, sendResponse: (resp: AssetFetchResponse) => void): Promise<void> {
    try {
        // L1 supplies the locators. Runtime must not search the entire Gemini page
        // for an unrelated file when one selected asset's fetch fails.
        let candidates = [msg.url, ...(Array.isArray(msg.candidates) ? msg.candidates : [])].filter((value): value is string => typeof value === 'string' && value.length > 0);

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
                const res = await fetchWithCredentialFallback(u, { credentials: 'include', signal: AbortSignal.timeout(15000) });
                if (!res.ok) {
                    reasons.push(`${u} -> HTTP ${res.status}`);
                    continue;
                }
                const blob = await res.blob();
                if (blob.size === 0) {
                    reasons.push(`${u} -> empty blob`);
                    continue;
                }
                if (blob.size > MAX_IPC_FILE_BLOB_SIZE) {
                    reasons.push(`${u} -> asset too large for Chrome IPC`);
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
            } catch (err: unknown) {
                const isTimeout = (err instanceof Error && err.name === 'TimeoutError') || /timeout|aborted/i.test(err instanceof Error ? err.message : '');
                reasons.push(`${u} -> ${isTimeout ? 'timeout' : ''}${getErrorMessage(err) || String(err)}`);
            }
        }

        sendResponse({
            success: false,
            error: 'All fetch candidates failed: ' + reasons.join('; ')
        });
    } catch (e: unknown) {
        sendResponse({
            success: false,
            error: 'fetchFileBlob fatal: ' + (getErrorMessage(e) || String(e))
        });
    }
}

export async function handleGetImageBlob(msg: AssetFetchRequest, sendResponse: (resp: AssetFetchResponse) => void): Promise<void> {
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
                const res = isGgChainUrl(u) ? await fetchGgChain(u, init) : await fetchWithCredentialFallback(u, init);
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
                if (msg.preferBuffer === true) {
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
                // Reject before encoding repeated base64 fields into the Chrome JSON IPC response.
                if (blob.size > MAX_IPC_IMAGE_BLOB_SIZE) {
                    lastErr = `asset too large (${(blob.size / 1024 / 1024).toFixed(1)}MB > ${MAX_IPC_IMAGE_BLOB_SIZE / 1024 / 1024}MB Chrome IPC cap); use Google Takeout import`;
                    continue;
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
            } catch (e: unknown) {
                lastErr = getErrorMessage(e) || String(e);
            }
        }

        sendResponse({
            success: false,
            error: 'Failed to fetch image: ' + lastErr
        });
    } catch (e: unknown) {
        sendResponse({
            success: false,
            error: 'handleGetImageBlob fatal: ' + (getErrorMessage(e) || String(e))
        });
    }
}

async function downloadAssetDirect(msg: AssetFetchRequest, sendResponse: (resp: AssetFetchResponse) => void): Promise<void> {
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
            const r = isGg ? await fetchGgChain(url, init2) : await fetchWithCredentialFallback(url, init2);
            if (r && r.ok) {
                const ct = (r.headers.get('content-type') || '').toLowerCase();
                const isTextResponse = ct.startsWith('text/plain') || ct.startsWith('text/html');
                if (!isGg || !isTextResponse) {
                    const blob = await r.blob();
                    if (blob.size > 0 && (!isTextResponse || blob.size > 2000)) {
                        if (msg.preferBuffer === true) {
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
                        if (blob.size > MAX_BASE64_BLOB_SIZE) {
                            sendResponse({
                                success: false,
                                error: `asset too large (${(blob.size / 1024 / 1024).toFixed(1)}MB > ${MAX_BASE64_BLOB_SIZE / 1024 / 1024}MB cap); use Google Takeout import`
                            });
                            return;
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

        void handleGetImageBlob(msg, (res) => {
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
                void handleGetFileBlob(msg, sendResponse);
            }
        });
    } catch (err: unknown) {
        sendResponse({ success: false, error: getErrorMessage(err) || String(err) });
    }
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
    fetchWithCredentialFallback
};
