/**
 * src/shared/utils/retryUtils.ts
 *
 * Core timing, retry, and backoff primitives.
 * Provides pure utilities for calculating exponential backoff and abortable delays
 * without creating circular dependencies or coupling to export engine state.
 */

interface BackoffOptions {
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

/**
 * Calculates exponential backoff with optional jitter and Retry-After floor.
 *
 * delay = min(maxDelayMs, initialDelayMs * 2^retryCount + random(0, jitterMs))
 * If retryAfterMs is provided and positive, delay is max(delay, retryAfterMs).
 */
export function calculateBackoff(retryCount: number, options?: BackoffOptions): number {
    const initial = options?.initialDelayMs ?? 2000;
    const max = options?.maxDelayMs ?? 30000;
    const jitter = options?.jitterMs ?? 1000;
    const delay = initial * Math.pow(2, retryCount) + Math.floor(Math.random() * jitter);
    const capped = Math.min(max, delay);
    return Math.max(capped, options?.retryAfterMs || 0);
}

/**
 * Sleep that can be cut short by an AbortSignal.
 * Resolves true when the wait was cut short by abort, false when the full duration elapsed.
 */
export function abortableSleep(ms: number, signal?: AbortSignal | null): Promise<boolean> {
    if (ms <= 0) return Promise.resolve(!!(signal && signal.aborted));
    if (!signal) return new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms));
    if (signal.aborted) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        const onAbort = () => {
            if (timer !== null) {
                clearTimeout(timer);
                timer = null;
            }
            signal.removeEventListener('abort', onAbort);
            resolve(true);
        };
        timer = setTimeout(() => {
            timer = null;
            signal.removeEventListener('abort', onAbort);
            resolve(false);
        }, ms);
        signal.addEventListener('abort', onAbort, { once: true });
    });
}
