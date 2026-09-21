/**
 * src/types/utils.ts
 * Type definitions for tab discovery, messaging, internationalization, and utility services.
 */

export type TabStatus = 'NO_TABS_API' | 'NO_TAB' | 'NEED_REFRESH' | 'CONNECTED' | 'ERROR';

export interface TabStatusResult {
    status: TabStatus;
    tab: chrome.tabs.Tab | null;
    response?: any;
    error?: string;
    reason?: string;
}

export interface TabServiceModule {
    getGeminiTab(slot?: string): Promise<chrome.tabs.Tab | null>;
    sendToGeminiTab(msg: any, slot?: string, timeoutMs?: number): Promise<any>;
    checkGeminiStatus(slot?: string): Promise<TabStatusResult>;
    openGeminiPage(): Promise<any>;
    reloadGeminiTab(tabId?: number): Promise<any>;
}

export type SupportedLang = 'zh' | 'en';

export type LocaleDictionary = Record<string, string>;

export interface I18nModule {
    applyLangToggleUI(opts?: {
        toggle?: HTMLInputElement | null;
        labelZh?: HTMLElement | null;
        labelEn?: HTMLElement | null;
    }): void;
    LOCALES: Record<string, LocaleDictionary | null>;
    initLanguage(): Promise<string>;
    getLang(): string;
    setLang(lang: string): Promise<void>;
    onLanguageChange(fn: (lang: string) => void): void;
    t(key: string, ...args: any[]): string;
    applyI18n(container?: Element | Document): void;
}
