// retryPolicy.ts - Centralized HTTP 400 XSRF recovery, 401 cleanup, and 429 backoff policy
import type { GeminiClientCredentialManagerModule } from "./credentialManager.js";

export interface Http400Params {
    resp: { status: number; [key: string]: any };
    snippet?: string;
    cred?: any;
    isRetried?: boolean;
    getAtFromPage?: () => string;
    getBlFromPage?: () => string | null;
    loadCredMap?: () => Promise<any>;
    getCredStorage?: () => any;
}

export interface Http400Result {
    shouldRetry: boolean;
    freshAt?: string;
    freshBl?: string | null;
}

export interface Http401Params {
    cred?: any;
    loadCredMap?: () => Promise<any>;
    getCredStorage?: () => any;
}

export interface Http429Params {
    resp: { status: number; headers?: { get?: (header: string) => string | null }; [key: string]: any };
    retryCount?: number;
    maxRetries?: number;
    label?: string;
}

export interface Http429Result {
    shouldRetry: boolean;
    delayMs?: number;
    nextRetryCount?: number;
}

export interface GeminiClientRetryPolicyModule {
    handleHttp400: (params: Http400Params) => Promise<Http400Result>;
    handleHttp401: (params: Http401Params) => Promise<void>;
    handleHttp429: (params: Http429Params) => Promise<Http429Result>;
}

declare global {
    var GeminiClientRetryPolicy: GeminiClientRetryPolicyModule;
}



    function getCredentialManager(): GeminiClientCredentialManagerModule | null {
        if (typeof GeminiClientCredentialManager !== "undefined") return GeminiClientCredentialManager;
        if (typeof globalThis !== "undefined" && (globalThis as any).GeminiClientCredentialManager) return (globalThis as any).GeminiClientCredentialManager;
        return null;
    }

    /**
     * Attempts automatic XSRF credential recovery on HTTP 400
     */
    async function handleHttp400(params: Http400Params): Promise<Http400Result> {
        const { resp, snippet, cred, isRetried, getAtFromPage, getBlFromPage, loadCredMap, getCredStorage } = params;
        if (resp.status !== 400 || isRetried) return { shouldRetry: false };

        const mXsrf = snippet && snippet.includes("xsrf") ? snippet.match(/"xsrf"\s*,\s*"([^"]+)"/) : null;
        const atFn = getAtFromPage || getCredentialManager()?.getAtFromPage;
        const blFn = getBlFromPage || getCredentialManager()?.getBlFromPage;

        const freshAt = (mXsrf && mXsrf[1]) ? mXsrf[1] : (atFn ? atFn() : null);
        const freshBl = blFn ? blFn() : null;

        if ((freshAt && freshAt !== cred?.at) || (freshBl && freshBl !== cred?.bl)) {
            try {
                const loadMapFn = loadCredMap || getCredentialManager()?.loadCredMap;
                const getStorageFn = getCredStorage || getCredentialManager()?.getCredStorage;

                if (loadMapFn && getStorageFn) {
                    let map = await loadMapFn();
                    if (cred?.sid && map[cred.sid]) {
                        if (freshAt) map[cred.sid].at = freshAt;
                        if (freshBl) map[cred.sid].bl = freshBl;
                        const storage = getStorageFn();
                        if (storage) {
                            await storage.set({ gemini_credentials_map: map });
                            if (typeof chrome !== "undefined" && storage !== chrome.storage.local && chrome.storage.local) {
                                await chrome.storage.local.remove(["gemini_credentials_map", "gemini_credentials"]);
                            }
                        }
                    }
                }
            } catch (e) {
                console.warn("[GemExporter:storage] Storage operation failed:", e);
            }
            return {
                shouldRetry: true,
                freshAt: freshAt || cred?.at,
                freshBl: freshBl || cred?.bl
            };
        }
        return { shouldRetry: false };
    }

    /**
     * Cleans up expired credentials on HTTP 401
     */
    async function handleHttp401(params: Http401Params): Promise<void> {
        const { cred, loadCredMap, getCredStorage } = params;
        try {
            const loadMapFn = loadCredMap || getCredentialManager()?.loadCredMap;
            const getStorageFn = getCredStorage || getCredentialManager()?.getCredStorage;

            if (loadMapFn && getStorageFn && cred?.sid) {
                let map = await loadMapFn();
                if (map[cred.sid]) {
                    delete map[cred.sid];
                    const storage = getStorageFn();
                    if (storage) {
                        await storage.set({ gemini_credentials_map: map });
                        if (typeof chrome !== "undefined" && storage !== chrome.storage.local && chrome.storage.local) {
                            await chrome.storage.local.remove(["gemini_credentials_map", "gemini_credentials"]);
                        }
                    }
                }
            }
        } catch (_) { /* intentional: best-effort 401 cleanup */ }
    }

    /**
     * Handles HTTP 429 rate limit backoff and wait
     */
    async function handleHttp429(params: Http429Params): Promise<Http429Result> {
        const { resp, retryCount = 0, maxRetries = 3, label = "request" } = params;
        if (resp.status !== 429 || retryCount >= maxRetries) return { shouldRetry: false };

        const retryAfter = resp.headers?.get ? resp.headers.get("retry-after") : null;
        let delayMs = Math.min(30000, 2000 * Math.pow(2, retryCount) + Math.floor(Math.random() * 1000));
        if (retryAfter) {
            const s = parseInt(retryAfter, 10);
            if (!isNaN(s) && s > 0) delayMs = Math.max(delayMs, s * 1000);
        }

        console.warn(`[Gemini Exporter Client] ${label} 429 rate limited, backoff ${delayMs}ms (attempt ${retryCount + 1}/${maxRetries})`);
        await new Promise(r => setTimeout(r, delayMs));

        return {
            shouldRetry: true,
            delayMs,
            nextRetryCount: retryCount + 1
        };
    }

export {
    handleHttp400,
    handleHttp401,
    handleHttp429
};

export const GeminiClientRetryPolicy: GeminiClientRetryPolicyModule = {
    handleHttp400,
    handleHttp401,
    handleHttp429
};

if (typeof globalThis !== 'undefined') (globalThis as any).GeminiClientRetryPolicy = GeminiClientRetryPolicy;
if (typeof module === 'object' && module.exports) module.exports = GeminiClientRetryPolicy;

export default GeminiClientRetryPolicy;

