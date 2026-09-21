// src/background/keepAlive.ts - MV3 Service Worker heartbeat mechanism

/**
 * Periodically ping chrome.runtime to keep the Manifest V3 service worker active
 * during long-running tasks like deep scanning or batch fetching.
 * Returns a cleanup function that cancels the keepalive interval.
 */
export function startKeepAlive(): () => void {
    if (typeof chrome === 'undefined' || !chrome.runtime) return () => {};
    const interval = setInterval(() => {
        try {
            if (chrome.runtime.getPlatformInfo) {
                chrome.runtime.getPlatformInfo(() => {});
            }
        } catch (e) {
            if (typeof console !== 'undefined' && console.debug) console.debug('[GemExporter:keepAlive]', e);
        }
    }, 20000);
    return () => clearInterval(interval);
}
