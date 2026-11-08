declare const __EXT_VERSION__: string | undefined;

export const STORAGE_KEYS = {
    FORMAT: 'gemini_export_format',
    ZIP: 'gemini_export_zip',
    DEV_MODE: 'gemini_dev_mode',
    LANG: 'gemini_exporter_lang',
    PENDING_TAKEOUT_PROMPT: 'gemini_pending_takeout_prompt',
    SUPPRESS_DIRECT_WRITE_PROMPT: 'gemini_suppress_direct_write_prompt',
    CREDENTIALS_MAP: 'gemini_credentials_map',
    CREDENTIALS: 'gemini_credentials',
    SCAN_COVERAGE: 'gemini_scan_coverage',
    LAST_SYNC_DIAGNOSTICS: 'gemini_last_sync_diagnostics',
    LAST_EXPORT_SESSION: 'gemini_last_export_session',
    LIVE_SAVE_CONFIG: 'live_save_config',
    HAS_COMPLETED_TOUR: 'has_completed_tour',
    LAST_SEEN_FEATURE_VERSION: 'last_seen_feature_version',
    BADGE_POS: 'gemini_export_badge_pos',
    HAS_COMPLETED_TAKEOUT_PROMPT: 'has_completed_takeout_prompt',
    HAS_IMPORTED_TAKEOUT: 'has_imported_takeout'
} as const;

export const DIRECT_WRITE_THRESHOLD = 20;
export const DISCORD_URL = 'https://discord.gg/e3FgrXUZ8f';
export const REVIEW_URL = 'https://chromewebstore.google.com/detail/gemini-exporter/ldpbiafkgjlaooeplkiooljccpalpkgf/reviews';
export const FEEDBACK_URL = 'https://tally.so/r/Y56ZBB?source=extension';
export const UNINSTALL_FEEDBACK_URL = 'https://tally.so/r/Y56ZBB?source=uninstall';

const EXT_VERSION: string = typeof __EXT_VERSION__ !== 'undefined' ? __EXT_VERSION__ : '';

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
