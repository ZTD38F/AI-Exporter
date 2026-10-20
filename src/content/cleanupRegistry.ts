// Runs cleanups before re-injected bundles register new listeners.
const KEY = '__gemExporterCleanups';

/**
 * Register a cleanup to run before the next bundle (re-)initializes.
 * The cleanup typically removes a listener/timer/observer this bundle added.
 */
export function registerCleanup(fn: () => void): void {
    if (typeof window === 'undefined') return;
    const w = window as any;
    if (!Array.isArray(w[KEY])) w[KEY] = [];
    w[KEY].push(fn);
}

/**
 * Run and clear all cleanups registered by the previous bundle.
 * Called once at the top of the content-script re-init path.
 */
export function runCleanups(): void {
    if (typeof window === 'undefined') return;
    const w = window as any;
    const fns: Array<() => void> = Array.isArray(w[KEY]) ? w[KEY] : [];
    w[KEY] = [];
    for (const fn of fns) {
        try {
            fn();
        } catch {
            /* intentional: best-effort cleanup must never break init */
        }
    }
}

export function pendingCleanupCount(): number {
    if (typeof window === 'undefined') return 0;
    const w = window as any;
    return Array.isArray(w[KEY]) ? w[KEY].length : 0;
}
