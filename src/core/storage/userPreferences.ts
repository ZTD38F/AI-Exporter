import { STORAGE_KEYS } from "../utils/constants.js";
import { isVersionGreater as utilsIsVersionGreater } from "../utils/pathUtils.js";

async function getPrefVal<T>(key: string, fallback: T): Promise<T> {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return fallback;
    try {
        const data = await chrome.storage.local.get([key]);
        const val = data?.[key];
        return val !== undefined ? (val as T) : fallback;
    } catch {
        return fallback;
    }
}

async function setPrefVal(key: string, val: any): Promise<void> {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return;
    try {
        await chrome.storage.local.set({ [key]: val });
    } catch (e) {
        console.warn("[GemExporter:storage] Storage operation failed:", e);
    }
}

export async function getDevMode(): Promise<boolean> {
    return getPrefVal(STORAGE_KEYS.DEV_MODE, false);
}

export async function setDevMode(enabled: boolean): Promise<void> {
    return setPrefVal(STORAGE_KEYS.DEV_MODE, !!enabled);
}

export async function isTourCompleted(): Promise<boolean> {
    return getPrefVal(STORAGE_KEYS.HAS_COMPLETED_TOUR, false);
}

export async function setTourCompleted(completed: boolean = true): Promise<void> {
    return setPrefVal(STORAGE_KEYS.HAS_COMPLETED_TOUR, !!completed);
}

export function isVersionGreater(v1: string, v2: string): boolean {
    return utilsIsVersionGreater(v1, v2);
}

export async function getLastSeenFeatureVersion(): Promise<string> {
    return getPrefVal(STORAGE_KEYS.LAST_SEEN_FEATURE_VERSION, '0.0.0');
}

export async function setLastSeenFeatureVersion(version: string): Promise<void> {
    return setPrefVal(STORAGE_KEYS.LAST_SEEN_FEATURE_VERSION, version);
}

export async function isTakeoutPromptCompleted(): Promise<boolean> {
    return getPrefVal(STORAGE_KEYS.HAS_COMPLETED_TAKEOUT_PROMPT, false);
}

export async function setTakeoutPromptCompleted(completed: boolean = true): Promise<void> {
    return setPrefVal(STORAGE_KEYS.HAS_COMPLETED_TAKEOUT_PROMPT, !!completed);
}

export async function isDirectWritePromptSuppressed(): Promise<boolean> {
    return getPrefVal(STORAGE_KEYS.SUPPRESS_DIRECT_WRITE_PROMPT, false);
}

export async function setDirectWritePromptSuppressed(suppressed: boolean = true): Promise<void> {
    return setPrefVal(STORAGE_KEYS.SUPPRESS_DIRECT_WRITE_PROMPT, !!suppressed);
}

export async function getZipPreference(defaultValue: boolean = true): Promise<boolean> {
    return getPrefVal(STORAGE_KEYS.ZIP, defaultValue);
}

export async function setZipPreference(useZip: boolean): Promise<void> {
    return setPrefVal(STORAGE_KEYS.ZIP, !!useZip);
}

export async function getBadgePosition(): Promise<{ left: number; top: number } | null> {
    const pos = await getPrefVal<{ left: number; top: number }>(STORAGE_KEYS.BADGE_POS, null as any);
    if (pos && typeof pos.left === 'number' && typeof pos.top === 'number') {
        return pos;
    }
    return null;
}

export async function setBadgePosition(pos: { left: number; top: number }): Promise<void> {
    return setPrefVal(STORAGE_KEYS.BADGE_POS, pos);
}

export async function setLastSyncDiagnostics(diagnostics: any): Promise<void> {
    return setPrefVal(STORAGE_KEYS.LAST_SYNC_DIAGNOSTICS, diagnostics);
}

export async function setPendingTakeoutPrompt(payload: any): Promise<void> {
    return setPrefVal(STORAGE_KEYS.PENDING_TAKEOUT_PROMPT, payload);
}

export async function setLanguagePreference(lang: string): Promise<void> {
    return setPrefVal(STORAGE_KEYS.LANG, lang);
}
