// src/core/utils/i18n.ts - Complete, centralized internationalization engine for Gemini Exporter

import type { I18nModule, LocaleDictionary } from '../../types/utils.js';

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
                const data = await chrome.storage.local.get('gemini_exporter_lang');
                const savedLang = typeof data?.gemini_exporter_lang === 'string' ? (data.gemini_exporter_lang as string) : null;
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
        try {
            if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
                await chrome.storage.local.set({ gemini_exporter_lang: lang });
            }
        } catch (e) { console.warn("[GemExporter:storage] Storage operation failed:", e); }
        applyI18n();
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

    function _setSafeFormattedContent(el: Element, val: string): void {
        el.textContent = '';
        if (!val || typeof val !== 'string') return;
        const parts = val.split(/(<b>.*?<\/b>|<strong>.*?<\/strong>|<i>.*?<\/i>|<em>.*?<\/em>|<br\s*\/?>)/gi);
        for (const part of parts) {
            if (!part) continue;
            const lower = part.toLowerCase();
            if (lower.startsWith('<b>') && lower.endsWith('</b>')) {
                const b = document.createElement('b');
                b.textContent = part.slice(3, -4);
                el.appendChild(b);
            } else if (lower.startsWith('<strong>') && lower.endsWith('</strong>')) {
                const strong = document.createElement('strong');
                strong.textContent = part.slice(8, -9);
                el.appendChild(strong);
            } else if (lower.startsWith('<i>') && lower.endsWith('</i>')) {
                const i = document.createElement('i');
                i.textContent = part.slice(3, -4);
                el.appendChild(i);
            } else if (lower.startsWith('<em>') && lower.endsWith('</em>')) {
                const em = document.createElement('em');
                em.textContent = part.slice(4, -5);
                el.appendChild(em);
            } else if (lower === '<br>' || lower === '<br/>' || lower === '<br />') {
                el.appendChild(document.createElement('br'));
            } else {
                el.appendChild(document.createTextNode(part));
            }
        }
    }

    function applyI18n(container?: Element | Document): void {
        if (typeof document === 'undefined') return;
        const root: any = container || document;

        const applyToElement = (el: any) => {
            if (!el || !el.getAttribute) return;
            const textKey = el.getAttribute('data-i18n');
            if (textKey) {
                const val = t(textKey);
                if (val) el.textContent = val;
            }
            const htmlKey = el.getAttribute('data-i18n-html');
            if (htmlKey) {
                const val = t(htmlKey);
                if (val) _setSafeFormattedContent(el, val);
            }
            const titleKey = el.getAttribute('data-i18n-title');
            if (titleKey) {
                const val = t(titleKey);
                if (val) el.title = val;
            }
            const placeholderKey = el.getAttribute('data-i18n-placeholder');
            if (placeholderKey) {
                const val = t(placeholderKey);
                if (val) el.placeholder = val;
            }
        };

        if (root !== document && root.nodeType === 1) {
            applyToElement(root);
        }

        if (root.querySelectorAll) {
            root.querySelectorAll('[data-i18n], [data-i18n-html], [data-i18n-title], [data-i18n-placeholder]').forEach(applyToElement);
        }
    }

    // Update language toggle UI if elements are present (or passed in options).
    // Pure utility: accepts explicit element references or falls back to standard IDs.
    function _applyLangToggleUI(opts: {
        toggle?: HTMLInputElement | null;
        labelZh?: HTMLElement | null;
        labelEn?: HTMLElement | null;
    } = {}): void {
        const hasDoc = typeof document !== 'undefined';
        if (!hasDoc && !opts.toggle && !opts.labelZh && !opts.labelEn) return;
        const langToggle = opts.toggle || (hasDoc ? (document.getElementById('langToggle') as HTMLInputElement | null) : null);
        if (langToggle) {
            langToggle.checked = (currentLang === 'en');
        }
        const labelZh = opts.labelZh || (hasDoc ? document.getElementById('labelLangZh') : null);
        const labelEn = opts.labelEn || (hasDoc ? document.getElementById('labelLangEn') : null);
        if (labelZh && labelZh.style) {
            labelZh.style.color = currentLang === 'zh' ? 'var(--text, #f1f3fc)' : 'var(--muted, #8a92b2)';
            labelZh.style.opacity = currentLang === 'zh' ? '1' : '0.6';
        }
        if (labelEn && labelEn.style) {
            labelEn.style.color = currentLang === 'en' ? 'var(--text, #f1f3fc)' : 'var(--muted, #8a92b2)';
            labelEn.style.opacity = currentLang === 'en' ? '1' : '0.6';
        }
    }

export {
    _applyLangToggleUI as applyLangToggleUI,
    initLanguage,
    getLang,
    setLang,
    onLanguageChange,
    t,
    applyI18n
};

export const I18n: I18nModule = {
    applyLangToggleUI: _applyLangToggleUI,
    LOCALES,
    initLanguage,
    getLang,
    setLang,
    onLanguageChange,
    t,
    applyI18n
};

if (typeof globalThis !== 'undefined') (globalThis as any).I18n = I18n;
if (typeof module === 'object' && module.exports) module.exports = I18n;

export default I18n;

