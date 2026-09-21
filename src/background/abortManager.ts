// src/background/abortManager.ts - Per-slot abort state management with chrome.storage.session persistence

export const __bgAborts: Map<string, boolean> = new Map();
let _restorePromise: Promise<void> | null = null;

/**
 * Restore persisted abort flags after MV3 worker restarts
 * (setSlotAborted mirrors every transition into chrome.storage.session).
 */
export async function restoreAbortFlags(): Promise<void> {
    const p = (async () => {
        try {
            if (typeof chrome !== 'undefined' && chrome.storage && (chrome.storage as any).session && (chrome.storage as any).session.get) {
                const data = await (chrome.storage as any).session.get(null);
                for (const k of Object.keys(data || {})) {
                    const m = k.match(/^gemini_abort_(.+)$/);
                    if (m && data[k]) {
                        __bgAborts.set(m[1], true);
                    }
                }
            }
        } catch {
            /* intentional: best-effort abort restore */
        }
    })();
    _restorePromise = p;
    await p;
    _restorePromise = null;
}

/**
 * Check if a specific account slot has an active abort flag.
 */
export function isSlotAborted(slot: string = 'u0'): boolean {
    return !!__bgAborts.get(slot || 'u0');
}

/**
 * Set or clear abort flag for a specific account slot, syncing with chrome.storage.session.
 */
export async function setSlotAborted(slot: string = 'u0', val: boolean = true): Promise<void> {
    if (_restorePromise) {
        await _restorePromise;
    }
    const s = slot || 'u0';
    if (val) {
        __bgAborts.set(s, true);
        try {
            if (typeof chrome !== 'undefined' && chrome.storage && (chrome.storage as any).session) {
                (chrome.storage as any).session.set({ [`gemini_abort_${s}`]: true }).catch(() => {});
            }
        } catch {
            /* intentional: session storage fallback */
        }
    } else {
        __bgAborts.delete(s);
        try {
            if (typeof chrome !== 'undefined' && chrome.storage && (chrome.storage as any).session) {
                (chrome.storage as any).session.remove([`gemini_abort_${s}`]).catch(() => {});
            }
        } catch {
            /* intentional: session storage fallback */
        }
    }
}

/**
 * Clear all abort flags in memory.
 */
export function clearAllAborts(): void {
    __bgAborts.clear();
}
