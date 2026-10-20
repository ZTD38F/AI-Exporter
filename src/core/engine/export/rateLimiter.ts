export interface RateLimiterOptions {
    maxRetries?: number;
    initialDelayMs?: number;
    maxDelayMs?: number;
    jitterMs?: number;
    /**
     * Honor a server-sent Retry-After: the computed delay is raised to at
     * least this value (may exceed maxDelayMs, matching previous behavior
     * in retryPolicy.handleHttp429).
     */
    retryAfterMs?: number;
}

export interface RetryOptions extends RateLimiterOptions {
    onRetry?: (retryCount: number, delayMs: number, errorOrRes: any) => void;
    signal?: AbortSignal | null;
    isAborted?: () => boolean;
}

export interface RateLimitModule {
    RateLimitManager: typeof RateLimitManager;
    isRateLimited: (res: any) => boolean;
    calculateBackoff: (retryCount: number, options?: RateLimiterOptions) => number;
    withRateLimitRetry: <T>(operation: () => Promise<T>, options?: RetryOptions) => Promise<T>;
    abortableSleep: (ms: number, signal?: AbortSignal | null) => Promise<boolean>;
}

/**
 * Check if a response result or error indicates rate limit (HTTP 429 or quota exceeded).
 *
 * Canonical predicate for the whole codebase: previously inlined variants
 * lived in exportOrchestrator.ts, types/errors.ts (GeminiRpcError),
 * content/messageRouter.ts (BardErrorInfo / 1096 / resource_exhausted),
 * syncController.ts (服务端上限), and pagination.ts.
 * All call sites now converge here so the semantics cannot drift again.
 */
export function isRateLimited(res: any): boolean {
    if (!res) return false;
    if (typeof res === 'string') {
        if (/429|rate\s*limit|quota|too\s*many\s*requests|resource_exhausted/i.test(res)) return true;
        return res.includes('BardErrorInfo') || res.includes('1096') || res.includes('服务端上限');
    }
    if (res instanceof Error) {
        return isRateLimited(res.message);
    }
    if (res.success === true) return false;
    if (res.status === 429) return true;
    const err = String(res.error || res.message || '');
    if (/429|rate\s*limit|quota|too\s*many\s*requests|resource_exhausted/i.test(err)) return true;
    return err.includes('BardErrorInfo') || err.includes('1096') || err.includes('服务端上限');
}

export function calculateBackoff(retryCount: number, options?: RateLimiterOptions): number {
    const initial = options?.initialDelayMs ?? 2000;
    const max = options?.maxDelayMs ?? 30000;
    const jitter = options?.jitterMs ?? 1000;
    const delay = initial * Math.pow(2, retryCount) + Math.floor(Math.random() * jitter);
    const capped = Math.min(max, delay);
    const retryAfterMs = options?.retryAfterMs;
    if (typeof retryAfterMs === 'number' && retryAfterMs > 0) {
        return Math.max(capped, retryAfterMs);
    }
    return capped;
}

export async function withRateLimitRetry<T>(
    operation: () => Promise<T>,
    options?: RetryOptions
): Promise<T> {
    const maxRetries = options?.maxRetries ?? 3;
    let retryCount = 0;

    while (true) {
        if (options?.signal?.aborted || options?.isAborted?.()) {
            throw new Error('Operation aborted');
        }

        try {
            const res = await operation();
            if (isRateLimited(res) && retryCount < maxRetries) {
                const delayMs = calculateBackoff(retryCount, options);
                if (options?.onRetry) {
                    options.onRetry(retryCount, delayMs, res);
                }
                await new Promise(resolve => setTimeout(resolve, delayMs));
                if (options?.signal?.aborted || options?.isAborted?.()) {
                    throw new Error('Operation aborted');
                }
                retryCount++;
                continue;
            }
            return res;
        } catch (err: any) {
            if (options?.signal?.aborted || options?.isAborted?.()) {
                throw err;
            }
            if (isRateLimited(err) && retryCount < maxRetries) {
                const delayMs = calculateBackoff(retryCount, options);
                if (options?.onRetry) {
                    options.onRetry(retryCount, delayMs, err);
                }
                await new Promise(resolve => setTimeout(resolve, delayMs));
                if (options?.signal?.aborted || options?.isAborted?.()) {
                    throw new Error('Operation aborted');
                }
                retryCount++;
                continue;
            }
            throw err;
        }
    }
}

/**
 * Sleep that can be cut short by an AbortSignal.
 * Resolves true when the wait was cut short by abort, false when the full
 * duration elapsed.
 *
 * Note: retryPolicy.ts ships its own copy (interruptibleSleep). It is not
 * imported here on purpose: retryPolicy already imports calculateBackoff
 * from this module, so importing back would create an import cycle.
 */
export function abortableSleep(ms: number, signal?: AbortSignal | null): Promise<boolean> {
    if (ms <= 0) return Promise.resolve(!!(signal && signal.aborted));
    if (!signal) return new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms));
    if (signal.aborted) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve(false);
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            signal.removeEventListener('abort', onAbort);
            resolve(true);
        };
        signal.addEventListener('abort', onAbort, { once: true });
    });
}

export class RateLimitManager {
    rateLimitCooldownUntil: number;
    maxRetries: number;
    initialDelayMs: number;
    maxDelayMs: number;
    jitterMs: number;

    constructor(options?: RateLimiterOptions) {
        this.rateLimitCooldownUntil = 0;
        this.maxRetries = options?.maxRetries ?? 3;
        this.initialDelayMs = options?.initialDelayMs ?? 2000;
        this.maxDelayMs = options?.maxDelayMs ?? 30000;
        this.jitterMs = options?.jitterMs ?? 1000;
    }

    isRateLimited(res: any): boolean {
        return isRateLimited(res);
    }

    calculateBackoff(retryCount: number): number {
        return calculateBackoff(retryCount, {
            initialDelayMs: this.initialDelayMs,
            maxDelayMs: this.maxDelayMs,
            jitterMs: this.jitterMs
        });
    }

    recordRateLimit(delayMs: number): void {
        this.rateLimitCooldownUntil = Date.now() + delayMs;
    }

    /**
     * Wait until shared cooldown expires, with random stagger to avoid thundering herd.
     * @returns true when cooldown elapsed, false when aborted.
     */
    async waitForCooldown(abortSignal?: AbortSignal | null, staggerMs: number = 1000): Promise<boolean> {
        if (this.rateLimitCooldownUntil && Date.now() < this.rateLimitCooldownUntil) {
            const waitMs = Math.max(0, this.rateLimitCooldownUntil - Date.now());
            if (waitMs > 0) {
                if (await abortableSleep(waitMs, abortSignal)) return false;
            }
            const stagger = Math.floor(Math.random() * Math.max(0, staggerMs));
            if (stagger > 0) {
                if (await abortableSleep(stagger, abortSignal)) return false;
            }
        }
        if (abortSignal && abortSignal.aborted) return false;
        return true;
    }

    reset(): void {
        this.rateLimitCooldownUntil = 0;
    }
}

export const rateLimitModule: RateLimitModule = {
    RateLimitManager,
    isRateLimited,
    calculateBackoff,
    withRateLimitRetry,
    abortableSleep
};

export default rateLimitModule;
