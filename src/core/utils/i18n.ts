
import type { I18nModule, LocaleDictionary } from '../../types/utils.js';
import { STORAGE_KEYS } from './constants.js';
import { setLanguagePreference } from '../storage/storageService.js';

import zhDict from './locales/zh.js';
import enDict from './locales/en.js';

export const LOCALES: Record<string, LocaleDictionary> = {
    zh: zhDict,
    en: enDict
};

function ensureLocales(): void {
    if (!LOCALES.zh) LOCALES.zh = zhDict;
    if (!LOCALES.en) LOCALES.en = enDict;
}

let currentLang: string = 'en';
const langChangeListeners: Set<(lang: string) => void> = new Set();

async function initLanguage(): Promise<string> {
    ensureLocales();
    try {
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
            const data = await chrome.storage.local.get(STORAGE_KEYS.LANG);
            const savedLang = typeof data?.[STORAGE_KEYS.LANG] === 'string' ? (data[STORAGE_KEYS.LANG] as string) : null;
            if (savedLang && LOCALES[savedLang]) {
                currentLang = savedLang;
            } else {
                const sys = (typeof navigator !== 'undefined' ? navigator.language || '' : '').toLowerCase();
                currentLang = sys.startsWith('zh') ? 'zh' : 'en';
            }
        } else {
            const sys = (typeof navigator !== 'undefined' ? navigator.language || '' : '').toLowerCase();
            currentLang = sys.startsWith('zh') ? 'zh' : 'en';
        }
    } catch {
        currentLang = 'en';
    }
    return currentLang;
}

function getLang(): string {
    return currentLang;
}

async function setLang(lang: string): Promise<void> {
    ensureLocales();
    if (!LOCALES[lang]) return;
    currentLang = lang;
    await setLanguagePreference(lang);
    for (const listener of langChangeListeners) {
        try { listener(currentLang); } catch (e) { console.error('langChangeListener err', e); }
    }
}

function onLanguageChange(fn: (lang: string) => void): void {
    if (typeof fn === 'function') langChangeListeners.add(fn);
}

function t(key: string, ...args: any[]): string {
    ensureLocales();
    let str: any = LOCALES[currentLang]?.[key] || LOCALES['zh']?.[key] || LOCALES['en']?.[key] || key;
    if (typeof str !== 'string') return String(str);
    if (args.length) {
        args.forEach((val, idx) => {
            str = str.replace(new RegExp(`\\{${idx}\\}`, 'g'), val != null ? String(val) : '');
        });
    }
    return str;
}

export {
    initLanguage,
    getLang,
    setLang,
    onLanguageChange,
    t
};

export const I18n: I18nModule = {
    LOCALES,
    initLanguage,
    getLang,
    setLang,
    onLanguageChange,
    t
};

export default I18n;
