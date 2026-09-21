// src/content/pageObserver.ts - Page lifecycle, URL mutation watcher, and timer cleanup
import { contentContext } from './contentContext.js';

let __syncDebounceTimer: any = null;
let __lastObservedUrl = typeof location !== 'undefined' ? location.href : '';

export function cleanup(): void {
    contentContext.clearTimer('urlWatcher');
    contentContext.clearTimer('syncInterval');
    contentContext.clearTimer('titleObserver');
    contentContext.clearTimer('debounceTimer');
    contentContext.clearTimer('liveSaveObserver');
    contentContext.clearTimer('liveSaveDebounce');

    if (__syncDebounceTimer) {
        clearTimeout(__syncDebounceTimer);
        __syncDebounceTimer = null;
    }

    if (typeof window !== 'undefined') {
        const w = window as any;
        w.__gemExporterUrlWatcher = null;
        w.__gemExporterSyncInterval = null;
        w.__gemExporterTitleObserver = null;
        w.__gemExporterDebounceTimer = null;
    }
}

export function debouncedSync(syncCallback?: () => void, delay = 350): void {
    if (__syncDebounceTimer) {
        clearTimeout(__syncDebounceTimer);
        __syncDebounceTimer = null;
    }
    __syncDebounceTimer = setTimeout(() => {
        __syncDebounceTimer = null;
        contentContext.clearTimer('debounceTimer');
        if (contentContext.getDeepScanPromise()) return;
        if (typeof syncCallback === 'function') syncCallback();
    }, delay);

    contentContext.registerTimer('debounceTimer', __syncDebounceTimer);
}

export function hookHistoryEvents(onUrlChanged: () => void): void {
    if (typeof window === 'undefined' || typeof history === 'undefined') return;

    const w = window as any;
    if (!w.__gemExporterHistoryHooked) {
        w.__gemExporterHistoryHooked = true;
        const originalPushState = history.pushState;
        const originalReplaceState = history.replaceState;

        history.pushState = function(...args: any[]) {
            const res = originalPushState.apply(this, args as unknown as [any, string, string | undefined]);
            window.dispatchEvent(new Event('gemini:locationchange'));
            return res;
        };

        history.replaceState = function(...args: any[]) {
            const res = originalReplaceState.apply(this, args as unknown as [any, string, string | undefined]);
            window.dispatchEvent(new Event('gemini:locationchange'));
            return res;
        };

        const handleLocationChange = () => {
            if (typeof location === 'undefined') return;
            if (location.href !== __lastObservedUrl) {
                __lastObservedUrl = location.href;
                onUrlChanged();
            }
        };

        window.addEventListener('popstate', handleLocationChange);
        window.addEventListener('gemini:locationchange', handleLocationChange);
    }
}

export function observeTitleChanges(onTitleChanged: () => void): void {
    if (typeof document === 'undefined') return;
    try {
        const titleEl = document.querySelector('title');
        if (titleEl) {
            const observer = new MutationObserver(() => {
                onTitleChanged();
            });
            observer.observe(titleEl, { childList: true, characterData: true, subtree: true });
            contentContext.registerTimer('titleObserver', observer);
        }
    } catch (e) {
        if (contentContext.isDevMode()) console.debug('[GemExporter:pageObserver]', e);
    }
}

export function startPeriodicSync(syncCallback?: () => void, intervalMs = 15000): void {
    if (typeof window === 'undefined') return;
    contentContext.clearTimer('syncInterval');
    const syncInterval = setInterval(() => {
        if (contentContext.getDeepScanPromise()) return;
        if (typeof syncCallback === 'function') syncCallback();
    }, intervalMs);
    contentContext.registerTimer('syncInterval', syncInterval);
}

export function init({ onSync }: { onSync?: () => void } = {}): { cleanup: () => void; debouncedSync: typeof debouncedSync } {
    cleanup();

    const triggerSync = (delay = 350) => debouncedSync(onSync, delay);

    hookHistoryEvents(() => triggerSync(400));
    observeTitleChanges(() => triggerSync(500));
    startPeriodicSync(onSync, 15000);

    return {
        cleanup,
        debouncedSync
    };
}

export const PageObserver = {
    init,
    cleanup,
    debouncedSync,
    hookHistoryEvents,
    observeTitleChanges,
    startPeriodicSync
};


(PageObserver as any).PageObserver = PageObserver;
(PageObserver as any).default = PageObserver;

if (typeof globalThis !== 'undefined') {
    (globalThis as any).PageObserver = PageObserver;
}
if (typeof module !== 'undefined' && (module as any).exports) {
    (module as any).exports = PageObserver;
}

export default PageObserver;
