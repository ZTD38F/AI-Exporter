// rateLimiter.ts - Rate limiting state management and exponential backoff for Gemini export pipeline

export interface RateLimiterOptions {
    maxRetries?: number;
    initialDelayMs?: number;
    maxDelayMs?: number;
    jitterMs?: number;
}

export interface RateLimitModule {
    RateLimitManager: typeof RateLimitManager;
    isRateLimited: (res: any) => boolean;
    calculateBackoff: (retryCount: number, options?: RateLimiterOptions) => number;
}

/**
 * Check if a response result indicates rate limit (HTTP 429 or quota exceeded).
 */
export function isRateLimited(res: any): boolean {
    if (!res) return false;
    if (res.success) return false;
    if (res.status === 429) return true;
    const err = String(res.error || '');
    return /429|rate\s*limit|quota|too\s*many\s*requests/i.test(err);
}

/**
 * Calculate exponential backoff delay with jitter.
 */
export function calculateBackoff(retryCount: number, options?: RateLimiterOptions): number {
    const initial = options?.initialDelayMs ?? 2000;
    const max = options?.maxDelayMs ?? 30000;
    const jitter = options?.jitterMs ?? 1000;
    const delay = initial * Math.pow(2, retryCount) + Math.floor(Math.random() * jitter);
    return Math.min(max, delay);
}

/**
 * RateLimitManager - Manages circuit cooldown, retry counts, and backoff for batch export workers.
 */
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

    async waitForCooldown(abortSignal?: AbortSignal | null): Promise<boolean> {
        if (this.rateLimitCooldownUntil && Date.now() < this.rateLimitCooldownUntil) {
            const waitMs = Math.max(0, this.rateLimitCooldownUntil - Date.now());
            if (waitMs > 0) {
                await new Promise(r => setTimeout(r, waitMs));
                if (abortSignal && abortSignal.aborted) return false;
            }
        }
        return true;
    }

    reset(): void {
        this.rateLimitCooldownUntil = 0;
    }
}

declare global {
    var RateLimitManager: any;
    var RateLimitModule: RateLimitModule;
}

export const rateLimitModule: RateLimitModule = {
    RateLimitManager,
    isRateLimited,
    calculateBackoff
};

(rateLimitModule as any).RateLimitManager = RateLimitManager;
(rateLimitModule as any).RateLimitModule = rateLimitModule;
(rateLimitModule as any).default = rateLimitModule;

if (typeof globalThis !== 'undefined') {
    (globalThis as any).RateLimitManager = RateLimitManager;
    (globalThis as any).RateLimitModule = rateLimitModule;
}
if (typeof module === 'object' && module.exports) {
    module.exports = rateLimitModule;
}

export default rateLimitModule;
