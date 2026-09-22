// src/core/utils/tabService.ts - Provider-neutral AI Tab Discovery & Communication Service

import type { TabServiceModule, TabStatusResult } from '../../types/utils.js';

export type AITabProviderId = 'gemini' | string;

const AI_TAB_PATTERNS: Record<string, string[]> = {
    gemini: ['https://gemini.google.com/*'],
    chatgpt: ['https://chatgpt.com/*']
};

function providerLabel(providerId: AITabProviderId): string {
    if (providerId === 'gemini') return 'Gemini';
    if (providerId === 'chatgpt') return 'ChatGPT';
    return providerId;
}

function selectGeminiTabs(tabs: chrome.tabs.Tab[], slot?: string): chrome.tabs.Tab[] {
    if (slot && slot !== 'u0') {
        const slotNum = slot.replace('u', '');
        return tabs.filter(t => t.url && t.url.includes(`/u/${slotNum}/`));
    }
    if (slot === 'u0') {
        const scoped = tabs.filter(t => t.url && (!t.url.match(/\/u\/\d+\//) || t.url.includes('/u/0/')));
        return scoped.length ? scoped : tabs;
    }
    return tabs;
}

export async function getAITab(providerId: AITabProviderId, scope?: string): Promise<chrome.tabs.Tab | null> {
    if (typeof chrome === 'undefined' || !chrome.tabs || !chrome.tabs.query) return null;
    const patterns = AI_TAB_PATTERNS[providerId];
    if (!patterns?.length) return null;

    const batches = await Promise.all(patterns.map(url => chrome.tabs.query({ url })));
    let tabs = batches.flat();
    if (!tabs.length) return null;

    if (providerId === 'gemini') tabs = selectGeminiTabs(tabs, scope);
    if (!tabs.length) return null;

    return tabs.find(t => t.active) || tabs[0];
}

export async function sendToAITab(
    providerId: AITabProviderId,
    msg: any,
    scope?: string,
    timeoutMs?: number
): Promise<any> {
    if (typeof chrome === 'undefined' || !chrome.tabs || !chrome.tabs.query) {
        throw new Error('chrome.tabs API 不可用');
    }

    const patterns = AI_TAB_PATTERNS[providerId];
    if (!patterns?.length) {
        throw new Error(`Provider "${providerId}" has no registered browser tab patterns`);
    }

    if (!timeoutMs || typeof timeoutMs !== 'number') {
        timeoutMs = (msg && msg.action === 'deepScan') ? 300000 : 25000;
    }

    const batches = await Promise.all(patterns.map(url => chrome.tabs.query({ url })));
    let candidates = batches.flat();
    if (!candidates.length) {
        if (providerId === 'gemini') {
            throw new Error('未找到 Gemini 标签页，请先打开 gemini.google.com');
        }
        throw new Error(`No ${providerLabel(providerId)} tab found`);
    }

    if (providerId === 'gemini') {
        candidates = selectGeminiTabs(candidates, scope);
        if (!candidates.length && scope && scope !== 'u0') {
            throw new Error(`未找到多账号 slot ${scope} 对应的 Gemini 标签页，请在浏览器中打开该账号标签页`);
        }
    }

    candidates.sort((a, b) => (b.active ? 1 : 0) - (a.active ? 1 : 0));

    let lastError: any = null;
    for (const candidate of candidates) {
        if (candidate.id == null) continue;
        try {
            return await new Promise((resolve, reject) => {
                let settled = false;
                const timer = setTimeout(() => {
                    if (!settled) {
                        settled = true;
                        reject(new Error(`与 ${providerLabel(providerId)} 页面通信超时 (${timeoutMs}ms)`));
                    }
                }, timeoutMs);

                chrome.tabs.sendMessage(candidate.id!, msg, (response) => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    if (chrome.runtime.lastError) {
                        reject(new Error(chrome.runtime.lastError.message || ''));
                    } else {
                        resolve(response);
                    }
                });
            });
        } catch (error: any) {
            lastError = error;
            const message = String(error?.message || '');
            if (message.includes('Receiving end does not exist') || message.includes('Could not establish connection')) {
                continue;
            }
            throw error;
        }
    }

    if (providerId === 'gemini') {
        if (lastError) {
            const message = String(lastError?.message || '');
            if (message.includes('Receiving end does not exist') || message.includes('Could not establish connection')) {
                throw new Error('未能与 Gemini 建立连接，请刷新 gemini.google.com 页面后重试: Receiving end does not exist');
            }
            throw lastError;
        }
        throw new Error('未能与任何 Gemini 标签页成功建立通信，请先打开或刷新 gemini.google.com 页面');
    }

    if (lastError) throw lastError;
    throw new Error(`Could not communicate with any ${providerLabel(providerId)} tab`);
}

async function getGeminiTab(slot?: string): Promise<chrome.tabs.Tab | null> {
    return getAITab('gemini', slot);
}

async function sendToGeminiTab(msg: any, slot?: string, timeoutMs?: number): Promise<any> {
    return sendToAITab('gemini', msg, slot, timeoutMs);
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
    getAITab,
    sendToAITab,
    getGeminiTab,
    sendToGeminiTab,
    checkGeminiStatus,
    openGeminiPage,
    reloadGeminiTab
};

if (typeof globalThis !== 'undefined' && !(globalThis as any).TabService) (globalThis as any).TabService = TabService;
if (typeof module === 'object' && module.exports) module.exports = TabService;

export default TabService;

