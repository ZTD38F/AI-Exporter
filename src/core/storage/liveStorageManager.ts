import type { LiveSaveConfig } from '../../types/liveSave.js';
import {
    getStoredDirHandle,
    saveStoredDirHandle,
    clearStoredDirHandle
} from './idbHandleStore.js';

import { STORAGE_KEYS } from '../utils/constants.js';

export const DEFAULT_LIVE_CONFIG: LiveSaveConfig = {
    enabledDisk: false,
    format: 'markdown',
    includeAssets: true
};

const KEY_CONFIG = STORAGE_KEYS.LIVE_SAVE_CONFIG;
let _memConfig: LiveSaveConfig = { ...DEFAULT_LIVE_CONFIG };

export async function isLiveSaveFormatSupported(): Promise<boolean> {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) return true;
    try {
        const data = await chrome.storage.local.get([STORAGE_KEYS.FORMAT]);
        return (data[STORAGE_KEYS.FORMAT] || 'markdown') === 'markdown';
    } catch (err) {
        console.warn('[LiveStorageManager] Cannot verify live-save format:', err);
        return false;
    }
}

export async function getLiveConfig(): Promise<LiveSaveConfig> {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        try {
            const d = await chrome.storage.local.get([KEY_CONFIG]);
            if (d && d[KEY_CONFIG]) {
                _memConfig = { ...DEFAULT_LIVE_CONFIG, ...d[KEY_CONFIG] };
            }
        } catch (err) {
            console.warn('[LiveStorageManager] Failed to read live config from chrome.storage.local:', err);
        }
    }
    return { ..._memConfig, enabledDisk: _memConfig.enabledDisk && await isLiveSaveFormatSupported() };
}

let _configChain: Promise<any> = Promise.resolve();
function withConfigLock<T>(fn: () => Promise<T>): Promise<T> {
    const p = _configChain.then(fn, fn);
    _configChain = p.then(() => undefined, () => undefined);
    return p;
}

export async function setLiveConfig(patch: Partial<LiveSaveConfig>): Promise<LiveSaveConfig> {
    return withConfigLock(async () => {
        const current = await getLiveConfig();
        const updated: LiveSaveConfig = { ...current, ...patch };
        if (updated.enabledDisk && !await isLiveSaveFormatSupported()) updated.enabledDisk = false;

        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
            try {
                await chrome.storage.local.set({ [KEY_CONFIG]: updated });
            } catch (err) {
                console.warn('[LiveStorageManager] Failed to set config in chrome.storage.local:', err);
                return { ..._memConfig };
            }
        }
        _memConfig = { ...updated };
        return { ..._memConfig };
    });
}

export async function saveLiveDirHandle(handle: any): Promise<boolean> {
    return saveStoredDirHandle(handle);
}

export async function getLiveDirHandle(): Promise<any> {
    return getStoredDirHandle();
}

export async function clearLiveDirHandle(): Promise<boolean> {
    return clearStoredDirHandle();
}

export const LiveStorageManager = {
    DEFAULT_LIVE_CONFIG,
    getLiveConfig,
    setLiveConfig,
    saveLiveDirHandle,
    getLiveDirHandle,
    clearLiveDirHandle
};

export default LiveStorageManager;
