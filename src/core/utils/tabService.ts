
import type { TabServiceModule, TabStatusResult } from '../../types/utils.js';
import type { PingMessage, OpenGeminiPageMessage, ReloadGeminiTabMessage } from '../../types/messages.js';
import { detectSlotFromUrl } from './pathUtils.js';

    function filterTabsBySlot(tabs: chrome.tabs.Tab[], slot?: string): chrome.tabs.Tab[] {
        if (!tabs || !tabs.length) return [];
        if (!slot) return tabs;
        return tabs.filter(t => t.url && detectSlotFromUrl(t.url) === slot);
    }

    async function getGeminiTab(slot?: string): Promise<chrome.tabs.Tab | null> {
        if (typeof chrome === 'undefined' || !chrome.tabs || !chrome.tabs.query) return null;
        const tabs = await chrome.tabs.query({ url: 'https://gemini.google.com/*' });
        if (!tabs || !tabs.length) return null;
        if (slot) {
            const match = filterTabsBySlot(tabs, slot);
            if (match.length > 0) {
                return match.find(t => t.active) || match[0];
            }
            if (slot === 'u0') {
                const nonOtherSlotTabs = tabs.filter(t => !t.url || detectSlotFromUrl(t.url) === 'u0');
                if (nonOtherSlotTabs.length > 0) {
                    return nonOtherSlotTabs.find(t => t.active) || nonOtherSlotTabs[0];
                }
            }
            return null;
        }
        return tabs.find(t => t.active) || tabs[0];
    }

    async function sendToGeminiTab(msg: any, slot?: string, timeoutMs?: number): Promise<any> {
        if (typeof chrome === 'undefined' || !chrome.tabs || !chrome.tabs.query) {
            throw new Error('chrome.tabs API 不可用');
        }
        if (!timeoutMs || typeof timeoutMs !== 'number') {
            timeoutMs = (msg && msg.action === 'deepScan') ? 300000 : 25000;
        }
        const tabs = await chrome.tabs.query({ url: 'https://gemini.google.com/*' });
        if (!tabs || !tabs.length) throw new Error('未找到 Gemini 标签页，请先打开 gemini.google.com');

        let candidates: chrome.tabs.Tab[] = [];
        if (slot) {
            candidates = filterTabsBySlot(tabs, slot);
            if (!candidates.length && slot === 'u0') {
                candidates = tabs.filter(t => !t.url || detectSlotFromUrl(t.url) === 'u0');
            }
            if (!candidates.length) {
                throw new Error(`未找到多账号 slot ${slot} 对应的 Gemini 标签页，请在浏览器中打开该账号标签页`);
            }
        } else {
            candidates = tabs;
        }
        candidates.sort((a, b) => (b.active ? 1 : 0) - (a.active ? 1 : 0));

        let lastError: any = null;
        for (const tab of candidates) {
            if (tab.id == null) continue;
            try {
                const res = await new Promise((resolve, reject) => {
                    let settled = false;
                    const timer = setTimeout(() => {
                        if (!settled) {
                            settled = true;
                            reject(new Error(`与 Gemini 页面通信超时 (${timeoutMs}ms)`));
                        }
                    }, timeoutMs);
                    chrome.tabs.sendMessage(tab.id!, msg, (r) => {
                        if (!settled) {
                            settled = true;
                            clearTimeout(timer);
                            if (chrome.runtime.lastError) {
                                reject(new Error(chrome.runtime.lastError.message || ''));
                            } else {
                                resolve(r);
                            }
                        }
                    });
                });
                return res;
            } catch (e: any) {
                lastError = e;
                const errStr = String(e?.message || '');
                if (errStr.includes('Receiving end does not exist') || errStr.includes('Could not establish connection')) {
                    continue;
                }
                throw e;
            }
        }
        if (lastError) {
            const errStr = String(lastError?.message || '');
            if (errStr.includes('Receiving end does not exist') || errStr.includes('Could not establish connection')) {
                throw new Error('未能与 Gemini 建立连接，请刷新 gemini.google.com 页面后重试: Receiving end does not exist');
            }
            throw lastError;
        }
        throw new Error('未能与任何 Gemini 标签页成功建立通信，请先打开或刷新 gemini.google.com 页面');
    }

    async function checkGeminiStatus(slot?: string): Promise<TabStatusResult> {
        if (typeof chrome === 'undefined' || !chrome.tabs || !chrome.tabs.query) {
            return { status: 'NO_TABS_API', tab: null };
        }
        try {
            const tabs = await chrome.tabs.query({ url: 'https://gemini.google.com/*' });
            if (!tabs || !tabs.length) {
                return { status: 'NO_TAB', tab: null };
            }
            let targetTab: chrome.tabs.Tab | null = null;
            if (slot && slot !== 'u0') {
                const matched = filterTabsBySlot(tabs, slot);
                targetTab = matched[0] || null;
            } else if (slot === 'u0') {
                const matched = filterTabsBySlot(tabs, 'u0');
                targetTab = matched[0] || null;
            }
            if (!targetTab) targetTab = tabs.find(t => t.active) || tabs[0];

            return await new Promise((resolve) => {
                let settled = false;
                const timer = setTimeout(() => {
                    if (!settled) {
                        settled = true;
                        resolve({ status: 'NEED_REFRESH', tab: targetTab, reason: 'timeout' });
                    }
                }, 1500);

                if (!targetTab || targetTab.id == null) {
                    settled = true;
                    clearTimeout(timer);
                    resolve({ status: 'NO_TAB', tab: null });
                    return;
                }

                const pingMsg: PingMessage = { action: 'ping' };
                chrome.tabs.sendMessage(targetTab.id, pingMsg, (response) => {
                    if (!settled) {
                        settled = true;
                        clearTimeout(timer);
                        if (chrome.runtime.lastError || !response || !response.ok) {
                            resolve({ status: 'NEED_REFRESH', tab: targetTab, error: chrome.runtime.lastError?.message });
                        } else {
                            resolve({ status: 'CONNECTED', tab: targetTab, response });
                        }
                    }
                });
            });
        } catch (e: any) {
            return { status: 'ERROR', error: e?.message, tab: null };
        }
    }

    async function openGeminiPage(): Promise<any> {
        if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.create) {
            return chrome.tabs.create({ url: 'https://gemini.google.com/app' });
        } else if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
            const msg: OpenGeminiPageMessage = { action: 'openGeminiPage' };
            return chrome.runtime.sendMessage(msg);
        } else if (typeof window !== 'undefined') {
            window.open('https://gemini.google.com/app', '_blank');
        }
    }

    async function reloadGeminiTab(tabId?: number): Promise<any> {
        if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.reload && tabId) {
            return chrome.tabs.reload(tabId);
        } else if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
            const msg: ReloadGeminiTabMessage = { action: 'reloadGeminiTab', tabId };
            return chrome.runtime.sendMessage(msg);
        }
    }

    async function getAITab(providerIdOrPattern?: string, slot?: string): Promise<chrome.tabs.Tab | null> {
        if (!providerIdOrPattern || providerIdOrPattern === 'gemini') {
            return getGeminiTab(slot);
        }
        if (typeof chrome === 'undefined' || !chrome.tabs || !chrome.tabs.query) return null;
        // Strict provider routing: never pass unknown strings directly into tabs.query.
        const knownProviders = new Set(['chatgpt', 'claude', 'deepseek']);
        if (!knownProviders.has(providerIdOrPattern)) return null;
        let pattern = providerIdOrPattern;
        if (providerIdOrPattern === 'chatgpt') {
            pattern = 'https://chatgpt.com/*';
        } else if (providerIdOrPattern === 'claude') {
            pattern = 'https://claude.ai/*';
        } else if (providerIdOrPattern === 'deepseek') {
            pattern = 'https://chat.deepseek.com/*';
        }
        const tabs = await chrome.tabs.query({ url: pattern });
        if (!tabs || !tabs.length) return null;
        return tabs.find(t => t.active) || tabs[0];
    }

    async function sendToAITab(providerIdOrPattern: string, msg: any, slot?: string, timeoutMs?: number): Promise<any> {
        if (!providerIdOrPattern || providerIdOrPattern === 'gemini') {
            return sendToGeminiTab(msg, slot, timeoutMs);
        }
        if (typeof chrome === 'undefined' || !chrome.tabs || !chrome.tabs.query) {
            throw new Error('chrome.tabs API 不可用');
        }
        if (!new Set(['chatgpt', 'claude', 'deepseek']).has(providerIdOrPattern)) {
            throw new Error(`no registered browser tab patterns for ${providerIdOrPattern}`);
        }
        const tab = await getAITab(providerIdOrPattern, slot);
        if (!tab || tab.id == null) {
            throw new Error(`未找到 ${providerIdOrPattern} 标签页，请先在浏览器中打开对应页面`);
        }
        const timeout = timeoutMs || 25000;
        return new Promise((resolve, reject) => {
            let settled = false;
            const timer = setTimeout(() => {
                if (!settled) {
                    settled = true;
                    reject(new Error(`与 ${providerIdOrPattern} 页面通信超时 (${timeout}ms)`));
                }
            }, timeout);
            chrome.tabs.sendMessage(tab.id!, msg, (r) => {
                if (!settled) {
                    settled = true;
                    clearTimeout(timer);
                    if (chrome.runtime.lastError) {
                        reject(new Error(chrome.runtime.lastError.message || ''));
                    } else {
                        resolve(r);
                    }
                }
            });
        });
    }

export {
    getGeminiTab,
    sendToGeminiTab,
    checkGeminiStatus,
    openGeminiPage,
    reloadGeminiTab,
    getAITab,
    sendToAITab
};

export const TabService: TabServiceModule = {
    getGeminiTab,
    sendToGeminiTab,
    checkGeminiStatus,
    openGeminiPage,
    reloadGeminiTab,
    getAITab,
    sendToAITab
};

export default TabService;

