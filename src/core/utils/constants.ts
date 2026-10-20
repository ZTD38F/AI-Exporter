declare const __EXT_VERSION__: string | undefined;

export type AllowedFormat = 'markdown' | 'html' | 'json_openai' | 'json' | 'json_raw' | 'pdf';

export const STORAGE_KEYS = {
    FORMAT: 'gemini_export_format',
    ZIP: 'gemini_export_zip',
    DEV_MODE: 'gemini_dev_mode',
    LANG: 'gemini_exporter_lang',
    PENDING_TAKEOUT_PROMPT: 'gemini_pending_takeout_prompt',
    SUPPRESS_DIRECT_WRITE_PROMPT: 'gemini_suppress_direct_write_prompt',
    CREDENTIALS_MAP: 'gemini_credentials_map',
    CREDENTIALS: 'gemini_credentials',
    ACCOUNT_SLOTS: 'gemini_account_slots',
    LAST_SYNC_DIAGNOSTICS: 'gemini_last_sync_diagnostics',
    LAST_EXPORT_SESSION: 'gemini_last_export_session',
    LIVE_SAVE_CONFIG: 'live_save_config',
    HAS_COMPLETED_TOUR: 'has_completed_tour',
    LAST_SEEN_FEATURE_VERSION: 'last_seen_feature_version',
    BADGE_POS: 'gemini_export_badge_pos',
    HAS_COMPLETED_TAKEOUT_PROMPT: 'has_completed_takeout_prompt',
    HAS_IMPORTED_TAKEOUT: 'has_imported_takeout'
} as const;

export type StorageKeyMap = typeof STORAGE_KEYS;

export const DEFAULT_EXPORT_FOLDER_NAME = 'gemini_export';

export const IDB_DATABASES = {
    DETAILS: 'gemini_exporter_details_idb',
    HANDLES: 'gemini_exporter_idb'
} as const;

export interface GeminiConstantsModule {
    ALLOWED_FORMATS: AllowedFormat[];
    DEFAULT_FORMAT: AllowedFormat;
    DIRECT_WRITE_THRESHOLD: number;
    FEEDBACK_URL: string;
    STORAGE_KEYS: StorageKeyMap;
    EXT_VERSION: string;
    DEFAULT_EXPORT_FOLDER_NAME: string;
    IDB_DATABASES: typeof IDB_DATABASES;
    getExtensionVersion: (customVersion?: string) => string;
    exportedIdsKey: (slot: string | null | undefined) => string;
}

export const ALLOWED_FORMATS: AllowedFormat[] = ['markdown', 'html', 'json_openai', 'json', 'json_raw', 'pdf'];
export const DEFAULT_FORMAT: AllowedFormat = 'markdown';
export const DIRECT_WRITE_THRESHOLD = 20;
export const FEEDBACK_URL = 'https://tally.so/r/Y56ZBB';

export const EXT_VERSION: string = typeof __EXT_VERSION__ !== 'undefined' ? __EXT_VERSION__ : '';

export function getExtensionVersion(customVersion?: string): string {
    if (customVersion) return customVersion;
    try {
        if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest) {
            const manifest = chrome.runtime.getManifest();
            if (manifest && manifest.version) return manifest.version;
        }
    } catch {}
    return EXT_VERSION;
}

export const GeminiConstants: GeminiConstantsModule = {
    ALLOWED_FORMATS,
    DEFAULT_FORMAT,
    DIRECT_WRITE_THRESHOLD,
    STORAGE_KEYS,
    FEEDBACK_URL,
    DEFAULT_EXPORT_FOLDER_NAME,
    IDB_DATABASES,
    EXT_VERSION,
    getExtensionVersion,
    exportedIdsKey
};

// Legacy compatibility: slot u0 uses historical 'exportedIds' key
export function exportedIdsKey(slot?: string | null): string {
    const s = slot || 'u0';
    return s === 'u0' ? 'exportedIds' : `gemini_exported_${s}`;
}

if (typeof module === 'object' && module.exports) module.exports = GeminiConstants;

export default GeminiConstants;

