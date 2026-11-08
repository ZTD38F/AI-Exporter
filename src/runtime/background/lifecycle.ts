import { ensureV2Ready } from './readiness.js';
import { getSettings, updateSettings } from '../../application/settings/index.js';
import { UNINSTALL_FEEDBACK_URL } from '../../shared/utils/constants.js';

/**
 * Configure chrome.storage.session access level so content scripts can access
 * memory-scoped CSRF credentials without disk persistence.
 */
export function initSessionAccessLevel(): void {
    try {
        if (chrome.storage?.session?.setAccessLevel) {
            chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' }).catch(() => {});
        }
    } catch (e) {
        console.debug('[GemExporter:lifecycle]', e);
    }
}

export function initUninstallUrl(): void {
    if (chrome.runtime?.setUninstallURL) {
        try {
            chrome.runtime.setUninstallURL(UNINSTALL_FEEDBACK_URL, () => {
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
    if (!chrome.runtime?.onInstalled) return;

    chrome.runtime.onInstalled.addListener((details) => {
        initUninstallUrl();
        void (async () => {
            await ensureV2Ready();
            const currentVersion = chrome.runtime.getManifest().version;
            if (details.reason === 'install') {
                const settings = await getSettings();
                if (!settings.lastSeenFeatureVersion) await updateSettings({ lastSeenFeatureVersion: currentVersion });
                if (!settings.theme) await updateSettings({ theme: 'light' });
                await chrome.tabs.create({ url: chrome.runtime.getURL('src/ui/options/options.html') + '?startTour=1' });
            } else if (details.reason === 'update') {
                const settings = await getSettings();
                const patch = !settings.lastSeenFeatureVersion ? {
                    lastSeenFeatureVersion: details.previousVersion && /^\d+\.\d+\.\d+(?:\.\d+)?$/.test(details.previousVersion)
                        ? details.previousVersion : currentVersion
                } : {};
                await updateSettings(patch);
            }
        })().catch(error => console.error('[Runtime] Installation initialization failed', error));
    });
}
