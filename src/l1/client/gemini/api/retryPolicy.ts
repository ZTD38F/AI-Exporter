import { GeminiClientCredentialManager, type GeminiCredentials, type GeminiClientCredentialManagerModule } from "./credentialManager.js";
import { calculateBackoff, abortableSleep } from "../../../../shared/utils/retryUtils.js";

interface Http400Params {
    resp: { status: number };
    snippet?: string;
    cred?: Partial<GeminiCredentials> | null;
    isRetried?: boolean;
    getAtFromPage?: () => string;
    getBlFromPage?: () => string | null;
    updateCredential?: GeminiClientCredentialManagerModule['updateCredential'];
}

interface Http400Result {
    shouldRetry: boolean;
    freshAt?: string;
    freshBl?: string | null;
}

interface Http401Params {
    cred?: Partial<GeminiCredentials> | null;
    updateCredential?: GeminiClientCredentialManagerModule['updateCredential'];
    refreshAtFromPage?: () => string | null;
}

interface Http429Params {
    resp: { status: number; headers?: { get?: (header: string) => string | null } };
    retryCount?: number;
    maxRetries?: number;
    label?: string;
    signal?: AbortSignal | null;
    retryAfterMs?: number;
}

interface Http429Result {
    shouldRetry: boolean;
    delayMs?: number;
    nextRetryCount?: number;
    aborted?: boolean;
}

interface GeminiClientRetryPolicyModule {
    handleHttp400: (params: Http400Params) => Promise<Http400Result>;
    handleHttp401: (params: Http401Params) => Promise<void>;
    handleHttp429: (params: Http429Params) => Promise<Http429Result>;
    interruptibleSleep: (ms: number, signal?: AbortSignal | null, isAborted?: () => boolean) => Promise<boolean>;
    parseRetryAfterMs: (value: string | null | undefined) => number | undefined;
}

    async function handleHttp400(params: Http400Params): Promise<Http400Result> {
        const { resp, snippet, cred, isRetried, getAtFromPage, getBlFromPage, updateCredential } = params;
        if (resp.status !== 400 || isRetried) return { shouldRetry: false };

        const mXsrf = snippet && snippet.includes("xsrf") ? snippet.match(/"xsrf"\s*,\s*"([^"]+)"/) : null;
        const atFn = getAtFromPage || GeminiClientCredentialManager.getAtFromPage;
        const blFn = getBlFromPage || GeminiClientCredentialManager.getBlFromPage;

        const freshAt = (mXsrf && mXsrf[1]) ? mXsrf[1] : (atFn ? atFn() : null);
        const freshBl = blFn ? blFn() : null;

        if ((freshAt && freshAt !== cred?.at) || (freshBl && freshBl !== cred?.bl)) {
            try {
                if (cred?.sid) {
                    const update = updateCredential ?? GeminiClientCredentialManager.updateCredential;
                    await update(cred.sid, () => ({ patch: { ...(freshAt ? { at: freshAt } : {}), ...(freshBl ? { bl: freshBl } : {}) } }));
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

    async function handleHttp401(params: Http401Params): Promise<void> {
        const { cred, updateCredential, refreshAtFromPage } = params;
        if (!cred?.sid) return;
        const sidTag = String(cred.sid).slice(0, 6) + '…';
        const update = updateCredential ?? GeminiClientCredentialManager.updateCredential;
        try {
            // Observe rotation inside the same lock as the storage update.
            await update(cred.sid, () => {
                const atFn = refreshAtFromPage ?? GeminiClientCredentialManager.getAtFromPage;
                let freshAt: string | null = null;
                try { freshAt = atFn(); } catch { /* page extraction is best-effort */ }
                if (freshAt && freshAt !== cred.at) {
                    console.warn(`[Gemini Exporter] 401 for ${sidTag}: 页面 at 已轮换，刷新凭证后保留（不删除）`);
                    return { patch: { at: freshAt }, clearLocal: false };
                }
                console.warn(`[Gemini Exporter] 401 for ${sidTag}: 页面无更新的 at，删除过期凭证`);
                return { patch: null };
            });
        } catch { /* best-effort 401 cleanup */ }
    }

    const MAX_RETRY_AFTER_MS = 30000;

    async function interruptibleSleep(ms: number, signal?: AbortSignal | null, isAborted?: () => boolean): Promise<boolean> {
        if (!isAborted) {
            return abortableSleep(ms, signal);
        }
        if (ms <= 0) return !!signal?.aborted || !!isAborted();
        if (signal?.aborted || isAborted()) return true;
        return await new Promise<boolean>((resolve) => {
            let done = false;
            let poll: ReturnType<typeof setInterval> | null = null;
            const onAbort = () => finish(true);
            const cleanup = () => {
                if (poll !== null) { clearInterval(poll); poll = null; }
                clearTimeout(timer);
                try { signal?.removeEventListener?.("abort", onAbort); } catch (_) { /* noop */ }
            };
            const finish = (aborted: boolean) => {
                if (done) return;
                done = true;
                cleanup();
                resolve(aborted);
            };
            const timer = setTimeout(() => finish(!!signal?.aborted || !!isAborted()), ms);
            if (signal && typeof signal.addEventListener === "function") {
                signal.addEventListener("abort", onAbort, { once: true });
            }
            poll = setInterval(() => { if (isAborted()) finish(true); }, 50);
        });
    }

    function parseRetryAfterMs(value: string | null | undefined): number | undefined {
        if (!value) return undefined;
        const s = parseInt(value, 10);
        if (!isNaN(s) && s > 0) return Math.min(s * 1000, MAX_RETRY_AFTER_MS);
        const t = Date.parse(value);
        if (!isNaN(t)) {
            const delta = t - Date.now();
            if (delta > 0) return Math.min(delta, MAX_RETRY_AFTER_MS);
        }
        return undefined;
    }

    async function handleHttp429(params: Http429Params): Promise<Http429Result> {
        const { resp, retryCount = 0, maxRetries = 3, label = "request", signal = null, retryAfterMs: explicitRetryAfterMs } = params;
        if (resp.status !== 429 || retryCount >= maxRetries) return { shouldRetry: false };
        if (signal?.aborted) return { shouldRetry: false, aborted: true };

        const headerVal = resp.headers?.get ? resp.headers.get("retry-after") : null;
        const retryAfterMs = (typeof explicitRetryAfterMs === "number" && explicitRetryAfterMs > 0)
            ? Math.min(explicitRetryAfterMs, MAX_RETRY_AFTER_MS)
            : parseRetryAfterMs(headerVal);
        const delayMs = calculateBackoff(retryCount, {
            initialDelayMs: 2000,
            maxDelayMs: 30000,
            jitterMs: 1000,
            retryAfterMs,
        });

        console.warn(`[Gemini Exporter Client] ${label} 429 rate limited, backoff ${delayMs}ms (attempt ${retryCount + 1}/${maxRetries})`);
        const wasAborted = await interruptibleSleep(delayMs, signal);
        if (wasAborted) return { shouldRetry: false, aborted: true };

        return {
            shouldRetry: true,
            delayMs,
            nextRetryCount: retryCount + 1
        };
    }

export { handleHttp400, handleHttp429, interruptibleSleep, parseRetryAfterMs };

const GeminiClientRetryPolicy: GeminiClientRetryPolicyModule = {
    handleHttp400,
    handleHttp401,
    handleHttp429,
    interruptibleSleep,
    parseRetryAfterMs
};

export default GeminiClientRetryPolicy;
