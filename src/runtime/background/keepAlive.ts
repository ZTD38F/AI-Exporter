/**
 * Pings chrome.runtime to prevent Manifest V3 service worker inactivity termination
 * during long-running tasks.
 */
export function startKeepAlive(): () => void {
    // KeepAlive is strictly scoped to the running export and only useful
    // when the corresponding Chrome API exists in this Worker.
    if (typeof chrome === 'undefined' || !chrome.runtime?.getPlatformInfo) return () => {};
    const interval = setInterval(() => {
        try {
            chrome.runtime?.getPlatformInfo?.(() => {});
        } catch (e) {
            console.debug('[GemExporter:keepAlive]', e);
        }
    }, 20000);
    return () => clearInterval(interval);
}
