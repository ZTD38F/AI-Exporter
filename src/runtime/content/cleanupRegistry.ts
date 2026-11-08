// Runs cleanups before re-injected bundles register new listeners.

/**
 * Register a cleanup to run before the next bundle (re-)initializes.
 * The cleanup typically removes a listener/timer/observer this bundle added.
 */
export function registerCleanup(fn: () => void): () => void {
    if (!Array.isArray(window.__gemExporterCleanups)) window.__gemExporterCleanups = [];
    window.__gemExporterCleanups.push(fn);
    return () => {
        const list = window.__gemExporterCleanups;
        const index = list?.indexOf(fn) ?? -1;
        if (list && index >= 0) list.splice(index, 1);
    };
}

/**
 * Run and clear all cleanups registered by the previous bundle.
 * Called once at the top of the content-script re-init path.
 */
export function runCleanups(): void {
    const fns: Array<() => void> = Array.isArray(window.__gemExporterCleanups) ? window.__gemExporterCleanups : [];
    window.__gemExporterCleanups = [];
    for (const fn of fns) {
        try {
            fn();
        } catch {
            /* intentional: best-effort cleanup must never break init */
        }
    }
}

