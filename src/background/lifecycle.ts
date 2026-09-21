// src/background/lifecycle.ts - Service Worker lifecycle, installation, and permissions management

import { GeminiConstants } from '../core/utils/constants.js';

export const FEEDBACK_URL = (typeof GeminiConstants !== 'undefined' && GeminiConstants.FEEDBACK_URL)
    ? GeminiConstants.FEEDBACK_URL
    : ((typeof (globalThis as any).GeminiConstants !== 'undefined' && (globalThis as any).GeminiConstants.FEEDBACK_URL)
        ? (globalThis as any).GeminiConstants.FEEDBACK_URL
        : 'https://tally.so/r/Y56ZBB');

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

/**
 * Set uninstallation survey URL.
 */
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

/**
 * Register onInstalled listener to open options welcome page on initial install.
 */
export function initLifecycleListeners(): void {
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.onInstalled) return;

    chrome.runtime.onInstalled.addListener((details) => {
        initUninstallUrl();
        if (details.reason === 'install') {
            chrome.tabs.create({
                url: chrome.runtime.getURL('src/ui/options/options.html?welcome=1')
            });
        }
    });
}
