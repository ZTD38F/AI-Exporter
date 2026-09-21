// src/core/utils/constants.ts - Pure constants, no DOM / no chrome APIs

export type AllowedFormat = 'markdown' | 'json_openai' | 'json' | 'json_raw';

export interface StorageKeyMap {
    FORMAT: string;
    ZIP: string;
    DEV_MODE: string;
    SUPPRESS_DIRECT_WRITE_PROMPT: string;
}

export interface GeminiConstantsModule {
    ALLOWED_FORMATS: AllowedFormat[];
    DEFAULT_FORMAT: AllowedFormat;
    DIRECT_WRITE_THRESHOLD: number;
    FEEDBACK_URL: string;
    STORAGE_KEYS: StorageKeyMap;
}

declare global {
    var GeminiConstants: GeminiConstantsModule;
}

export const ALLOWED_FORMATS: AllowedFormat[] = ['markdown', 'json_openai', 'json', 'json_raw'];
export const DEFAULT_FORMAT: AllowedFormat = 'markdown';
export const DIRECT_WRITE_THRESHOLD = 50;
export const FEEDBACK_URL = 'https://tally.so/r/Y56ZBB';
export const STORAGE_KEYS: StorageKeyMap = {
    FORMAT: 'gemini_export_format',
    ZIP: 'gemini_export_zip',
    DEV_MODE: 'gemini_dev_mode',
    SUPPRESS_DIRECT_WRITE_PROMPT: 'gemini_suppress_direct_write_prompt'
};

export const GeminiConstants: GeminiConstantsModule = {
    ALLOWED_FORMATS,
    DEFAULT_FORMAT,
    DIRECT_WRITE_THRESHOLD,
    STORAGE_KEYS,
    FEEDBACK_URL
};

if (typeof globalThis !== 'undefined') (globalThis as any).GeminiConstants = GeminiConstants;
if (typeof module === 'object' && module.exports) module.exports = GeminiConstants;

export default GeminiConstants;

