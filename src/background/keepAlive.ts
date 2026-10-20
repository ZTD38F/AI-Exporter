/**
 * Pings chrome.runtime to prevent Manifest V3 service worker inactivity termination
 * during long-running tasks.
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
