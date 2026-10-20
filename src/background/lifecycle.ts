import { FEEDBACK_URL } from '../core/utils/constants.js';

export { FEEDBACK_URL };

/**
 * Configure chrome.storage.session access level so content scripts can access
 * memory-scoped CSRF credentials without disk persistence.
 */
export function initSessionAccessLevel(): void {
    try {
        if (typeof chrome !== 'undefined' && chrome.storage && (chrome.storage as any).session && (chrome.storage as any).session.setAccessLevel) {
            (chrome.storage as any).session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' }).catch(() => {});
        }
    } catch (e) {
        if (typeof console !== 'undefined' && console.debug) console.debug('[GemExporter:lifecycle]', e);
    }
}

export function initUninstallUrl(): void {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.setUninstallURL) {
        try {
            chrome.runtime.setUninstallURL(FEEDBACK_URL, () => {
                if (chrome.runtime.lastError) {
                    console.warn('[Gemini Exporter] Failed to set uninstall URL:', chrome.runtime.lastError.message);
                }
            });
        } catch (err) {
            console.warn('[Gemini Exporter] Error calling setUninstallURL:', err);
        }
    }
}

export function initLifecycleListeners(): void {
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.onInstalled) return;

    chrome.runtime.onInstalled.addListener((details) => {
        initUninstallUrl();
        if (details.reason === 'install') {
            void chrome.tabs.create({
                url: chrome.runtime.getURL('src/ui/options/options.html')
            });
        }
    });
}
