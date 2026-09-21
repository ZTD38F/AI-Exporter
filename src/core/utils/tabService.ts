// src/core/utils/tabService.ts - Unified Gemini Tab Discovery & Communication Service

import type { TabServiceModule, TabStatusResult } from '../../types/utils.js';



    async function getGeminiTab(slot?: string): Promise<chrome.tabs.Tab | null> {
        if (typeof chrome === 'undefined' || !chrome.tabs || !chrome.tabs.query) return null;
        const tabs = await chrome.tabs.query({ url: 'https://gemini.google.com/*' });
        if (!tabs || !tabs.length) return null;
        if (slot && slot !== 'u0') {
            const slotNum = slot.replace('u', '');
            const match = tabs.find(t => t.url && t.url.includes(`/u/${slotNum}/`));
            return match || null;
        } else if (slot === 'u0') {
            const defMatch = tabs.find(t => t.url && (!t.url.match(/\/u\/\d+\//) || t.url.includes('/u/0/')));
            return defMatch || tabs.find(t => t.active) || tabs[0];
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
        if (slot && slot !== 'u0') {
            const slotNum = slot.replace('u', '');
            candidates = tabs.filter(t => t.url && t.url.includes(`/u/${slotNum}/`));
            if (!candidates.length) {
                throw new Error(`未找到多账号 slot ${slot} 对应的 Gemini 标签页，请在浏览器中打开该账号标签页`);
            }
        } else if (slot === 'u0') {
            candidates = tabs.filter(t => t.url && (!t.url.match(/\/u\/\d+\//) || t.url.includes('/u/0/')));
            if (!candidates.length) candidates = tabs;
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
                const slotNum = slot.replace('u', '');
                targetTab = tabs.find(t => t.url && t.url.includes(`/u/${slotNum}/`)) || null;
            } else if (slot === 'u0') {
                targetTab = tabs.find(t => t.url && (!t.url.match(/\/u\/\d+\//) || t.url.includes('/u/0/'))) || null;
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

                chrome.tabs.sendMessage(targetTab.id, { action: 'ping' }, (response) => {
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
            return chrome.runtime.sendMessage({ action: 'openGeminiPage' });
        } else if (typeof window !== 'undefined') {
            window.open('https://gemini.google.com/app', '_blank');
        }
    }

    async function reloadGeminiTab(tabId?: number): Promise<any> {
        if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.reload && tabId) {
            return chrome.tabs.reload(tabId);
        } else if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
            return chrome.runtime.sendMessage({ action: 'reloadGeminiTab', tabId });
        }
    }

export {
    getGeminiTab,
    sendToGeminiTab,
    checkGeminiStatus,
    openGeminiPage,
    reloadGeminiTab
};

export const TabService: TabServiceModule = {
    getGeminiTab,
    sendToGeminiTab,
    checkGeminiStatus,
    openGeminiPage,
    reloadGeminiTab
};

if (typeof globalThis !== 'undefined' && !(globalThis as any).TabService) (globalThis as any).TabService = TabService;
if (typeof module === 'object' && module.exports) module.exports = TabService;

export default TabService;

