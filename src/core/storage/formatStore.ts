import { setLiveConfig } from './liveStorageManager.js';

export type ExportFormat = 'markdown' | 'html' | 'json_openai' | 'json' | 'json_raw' | string;

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
    handleDevToggle: (devOn: boolean, currentFormatOrSelect: any) => DevToggleResult;
}

import { ALLOWED_FORMATS as CONST_ALLOWED_FORMATS, DEFAULT_FORMAT as CONST_DEFAULT_FORMAT, STORAGE_KEYS } from "../utils/constants.js";

export const ALLOWED_FORMATS: string[] = CONST_ALLOWED_FORMATS || ['markdown', 'html', 'json_openai', 'json', 'json_raw', 'pdf'];
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

    function validateAgainstSelect(val: string, selectEl: any): boolean {
        if (!selectEl || !selectEl.options) return isAllowed(val);
        return Array.from<any>(selectEl.options).some((o: any) => o.value === val);
    }

    async function loadFormat(selectEl?: any): Promise<FormatStoreLoadResult> {
        try {
            const data = (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local)
                ? await chrome.storage.local.get([STORAGE_KEYS.FORMAT, STORAGE_KEYS.DEV_MODE])
                : {};
            const isDev = !!data[STORAGE_KEYS.DEV_MODE];
            const stored = (data[STORAGE_KEYS.FORMAT] as string) || null;
            if (!stored) return { format: DEFAULT, isDev, stored: null };
            const normalized = normalizeFormat(stored, isDev);
            const finalVal = (selectEl && !validateAgainstSelect(normalized, selectEl)) ? DEFAULT : normalized;
            if (finalVal !== stored && typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
                await chrome.storage.local.set({ [STORAGE_KEYS.FORMAT]: finalVal });
            }
            if (selectEl) selectEl.value = finalVal;
            return { format: finalVal, isDev, stored };
        } catch (e) {
            console.warn('[FormatStore] Failed to load format from storage:', e);
            if (selectEl) selectEl.value = DEFAULT;
            return { format: DEFAULT, isDev: false, stored: null };
        }
    }

    let formatSaveChain: Promise<unknown> = Promise.resolve();
    async function saveFormat(val: string): Promise<string> {
        const toSave = isAllowed(val) ? val : DEFAULT;
        const operation = formatSaveChain.then(async () => {
            if (toSave !== 'markdown') await setLiveConfig({ enabledDisk: false });
            if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
                await chrome.storage.local.set({ [STORAGE_KEYS.FORMAT]: toSave });
            }
            return toSave;
        });
        formatSaveChain = operation.catch(() => undefined);
        return operation;
    }

    function getCurrentFormat(isDev?: boolean, currentVal?: string): string {
        return normalizeFormat(currentVal !== undefined ? currentVal : DEFAULT, isDev);
    }

    function handleDevToggle(devOn: boolean, currentFormatOrSelect: any): DevToggleResult {
        if (currentFormatOrSelect && typeof currentFormatOrSelect === 'object' && 'value' in currentFormatOrSelect) {
            if (!devOn && currentFormatOrSelect.value === 'json_raw') {
                currentFormatOrSelect.value = DEFAULT;
                saveFormat(DEFAULT).catch((err: any) => {
                    console.warn('[FormatStore] Failed to save format on dev toggle:', err);
                });
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
    handleDevToggle
};

export default FormatStore;

