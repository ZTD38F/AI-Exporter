// formatStore.ts - Pure format validation + storage sync, zero DOM requirement
// Depends on GeminiConstants (ALLOWED_FORMATS) if available, otherwise fallback
import type { GeminiConstantsModule } from "../utils/constants.js";

export type ExportFormat = 'markdown' | 'json_openai' | 'json' | 'json_raw' | string;

export interface FormatStoreLoadResult {
    format: string;
    isDev: boolean;
    stored: string | null;
}

export interface DevToggleResult {
    format: string;
    changed: boolean;
}

export interface FormatStoreModule {
    ALLOWED_FORMATS: string[];
    DEFAULT_FORMAT: string;
    isAllowed: (val: string) => boolean;
    normalizeFormat: (val: string, isDev?: boolean) => string;
    validateAgainstSelect: (val: string, selectEl: any) => boolean;
    loadFormat: (selectEl?: any) => Promise<FormatStoreLoadResult>;
    saveFormat: (val: string) => Promise<string>;
    getCurrentFormat: (isDev?: boolean, currentVal?: string) => string;
    getFormatFromSelect: (selectEl: any, isDev?: boolean) => string;
    bindFormatSelect: (selectEl: any) => void;
    handleDevToggle: (devOn: boolean, currentFormatOrSelect: any) => DevToggleResult;
}

declare global {
    var FormatStore: FormatStoreModule;
}

import { ALLOWED_FORMATS as CONST_ALLOWED_FORMATS, DEFAULT_FORMAT as CONST_DEFAULT_FORMAT } from "../utils/constants.js";

export const ALLOWED_FORMATS: string[] = CONST_ALLOWED_FORMATS || ['markdown', 'json_openai', 'json', 'json_raw'];
export const DEFAULT_FORMAT: string = CONST_DEFAULT_FORMAT || 'markdown';
const ALLOWED = ALLOWED_FORMATS;
const DEFAULT = DEFAULT_FORMAT;



    function isAllowed(val: string): boolean {
        return ALLOWED.includes(val);
    }

    function normalizeFormat(val: string, isDev?: boolean): string {
        if (!isAllowed(val)) return DEFAULT;
        if (val === 'json_raw' && !isDev) return DEFAULT;
        return val;
    }

    // Validate against option list (duck-typed options array, zero DOM required)
    function validateAgainstSelect(val: string, selectEl: any): boolean {
        if (!selectEl || !selectEl.options) return isAllowed(val);
        return Array.from<any>(selectEl.options).some((o: any) => o.value === val);
    }

    async function loadFormat(selectEl?: any): Promise<FormatStoreLoadResult> {
        try {
            const data = (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local)
                ? await chrome.storage.local.get(['gemini_export_format', 'gemini_dev_mode'])
                : {};
            const isDev = !!data.gemini_dev_mode;
            const stored = (data.gemini_export_format as string) || null;
            if (!stored) return { format: DEFAULT, isDev, stored: null };
            const normalized = normalizeFormat(stored, isDev);
            const finalVal = (selectEl && !validateAgainstSelect(normalized, selectEl)) ? DEFAULT : normalized;
            if (finalVal !== stored && typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
                await chrome.storage.local.set({ gemini_export_format: finalVal });
            }
            if (selectEl) selectEl.value = finalVal;
            return { format: finalVal, isDev, stored };
        } catch (e) {
            if (selectEl) selectEl.value = DEFAULT;
            return { format: DEFAULT, isDev: false, stored: null };
        }
    }

    async function saveFormat(val: string): Promise<string> {
        const toSave = isAllowed(val) ? val : DEFAULT;
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
            await chrome.storage.local.set({ gemini_export_format: toSave });
        }
        return toSave;
    }

    function getCurrentFormat(isDev?: boolean, currentVal?: string): string {
        let v = currentVal !== undefined ? currentVal : DEFAULT;
        if (!isAllowed(v)) v = DEFAULT;
        if (v === 'json_raw' && !isDev) v = DEFAULT;
        return v;
    }

    function getFormatFromSelect(selectEl: any, isDev?: boolean): string {
        let v = selectEl ? selectEl.value : DEFAULT;
        if (!isAllowed(v)) v = DEFAULT;
        const devMode = isDev !== undefined ? isDev : (typeof document !== 'undefined' && document.body && document.body.classList.contains('dev-mode'));
        if (v === 'json_raw' && !devMode) v = DEFAULT;
        return v;
    }

    function bindFormatSelect(selectEl: any): void {
        if (!selectEl) return;
        selectEl.addEventListener('change', (e: any) => saveFormat(e.target.value));
    }

    function handleDevToggle(devOn: boolean, currentFormatOrSelect: any): DevToggleResult {
        if (currentFormatOrSelect && typeof currentFormatOrSelect === 'object' && 'value' in currentFormatOrSelect) {
            if (!devOn && currentFormatOrSelect.value === 'json_raw') {
                currentFormatOrSelect.value = DEFAULT;
                saveFormat(DEFAULT);
                return { format: DEFAULT, changed: true };
            }
            return { format: currentFormatOrSelect.value, changed: false };
        }
        if (!devOn && currentFormatOrSelect === 'json_raw') {
            return { format: DEFAULT, changed: true };
        }
        return { format: currentFormatOrSelect, changed: false };
    }

export {
    isAllowed,
    normalizeFormat,
    validateAgainstSelect,
    loadFormat,
    saveFormat,
    getCurrentFormat,
    getFormatFromSelect,
    bindFormatSelect,
    handleDevToggle
};

export const FormatStore: FormatStoreModule = {
    ALLOWED_FORMATS,
    DEFAULT_FORMAT,
    isAllowed,
    normalizeFormat,
    validateAgainstSelect,
    loadFormat,
    saveFormat,
    getCurrentFormat,
    getFormatFromSelect,
    bindFormatSelect,
    handleDevToggle
};

if (typeof globalThis !== 'undefined') (globalThis as any).FormatStore = FormatStore;
if (typeof module === 'object' && module.exports) module.exports = FormatStore;

export default FormatStore;

