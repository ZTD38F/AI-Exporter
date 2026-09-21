// src/background/tabAction.ts - Tab action icon contextual state management (color on Gemini, grayscale elsewhere)

export const ACTION_COLOR_ICONS: Record<number, string> = {
    16: 'icons/icon16.png',
    48: 'icons/icon48.png',
    128: 'icons/icon128.png'
};

export const ACTION_GRAY_ICONS: Record<number, string> = {
    16: 'icons/icon16_gray.png',
    48: 'icons/icon48_gray.png',
    128: 'icons/icon128_gray.png'
};

/**
 * Determine if a given URL belongs to the Gemini web domain.
 */
export function isGeminiTabUrl(urlStr?: string | null): boolean {
    if (!urlStr || typeof urlStr !== 'string') return false;
    try {
        const u = new URL(urlStr);
        return u.hostname === 'gemini.google.com';
    } catch {
        return false;
    }
}

/**
 * Update the extension browser action icon and tooltip based on the current tab URL.
 */
export function updateTabActionState(tabId?: number | null, url?: string | null): void {
    if (typeof chrome === 'undefined' || !chrome.action || !tabId) return;
    const isGemini = isGeminiTabUrl(url);
    const icons = isGemini ? ACTION_COLOR_ICONS : ACTION_GRAY_ICONS;
    const title = isGemini ? 'Gemini Exporter (Active)' : 'Gemini Exporter (未激活 - 当前非 Gemini 页面)';
    try {
        chrome.action.setIcon({ tabId, path: icons }).catch(() => {});
        chrome.action.setTitle({ tabId, title }).catch(() => {});
    } catch {
        /* intentional fallback */
    }
}

/**
 * Initialize tab activation and URL update listeners to automatically update action icons.
 */
export function initTabActionListeners(): void {
    if (typeof chrome === 'undefined' || !chrome.tabs) return;
    try {
        if (chrome.tabs.onActivated) {
            chrome.tabs.onActivated.addListener((activeInfo) => {
                chrome.tabs.get(activeInfo.tabId, (tab) => {
                    if (chrome.runtime?.lastError || !tab) return;
                    updateTabActionState(activeInfo.tabId, tab.url);
                });
            });
        }
        if (chrome.tabs.onUpdated) {
            chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
                const url = changeInfo.url || tab?.url;
                if (url) {
                    updateTabActionState(tabId, url);
                }
            });
        }
        // Initial tab check on service worker startup
        if (chrome.tabs.query) {
            chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                if (tabs && tabs[0]?.id) {
                    updateTabActionState(tabs[0].id, tabs[0].url);
                }
            });
        }
    } catch (e) {
        if (typeof console !== 'undefined' && console.debug) console.debug('[GemExporter:tabAction] init tab action state error', e);
    }
}
