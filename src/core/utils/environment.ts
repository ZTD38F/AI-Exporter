/**
 * Determines whether the extension is running in an unpacked local development environment.
 * In Chrome/Chromium, extensions published via the Chrome Web Store always have an `update_url`
 * injected into their manifest by Google. Unpacked extensions loaded locally (via developer mode)
 * do not have `update_url`.
 */
export function isLocalDevelopment(): boolean {
    try {
        if (typeof chrome === 'undefined' || !chrome.runtime || typeof chrome.runtime.getManifest !== 'function') {
            return true;
        }
        const manifest = chrome.runtime.getManifest();
        if (!manifest) return true;

        if (typeof window !== 'undefined' && window.location && window.location.search) {
            const params = new URLSearchParams(window.location.search);
            if (params.get('dev') === '1') return true;
            if (params.get('prod') === '1') return false;
        }

        return !manifest.update_url;
    } catch {
        return false;
    }
}
