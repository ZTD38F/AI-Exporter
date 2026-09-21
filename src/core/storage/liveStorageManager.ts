// src/core/storage/liveStorageManager.ts - Live Auto-Save configuration and Directory Handle persistence
import type { LiveConversationRecord, LiveSaveConfig } from '../../types/liveSave.js';
import {
    getStoredDirHandle,
    saveStoredDirHandle,
    clearStoredDirHandle
} from './idbHandleStore.js';

export const DEFAULT_LIVE_CONFIG: LiveSaveConfig = {
    enabledDisk: false,
    format: 'markdown',
    includeAssets: true
};

const KEY_CONFIG = 'live_save_config';
let _memConfig: LiveSaveConfig = { ...DEFAULT_LIVE_CONFIG };

/**
 * @deprecated Legacy stub. Conversation text is no longer retained in browser storage.
 */
export async function saveLiveConversation(_record: Partial<LiveConversationRecord> & { id: string }): Promise<boolean> {
    return false;
}

export async function getLiveConversation(_id: string): Promise<LiveConversationRecord | null> {
    return null;
}

export async function listLiveConversations(): Promise<LiveConversationRecord[]> {
    return [];
}

export async function removeLiveConversation(_id: string): Promise<boolean> {
    return true;
}

export async function clearLiveConversations(): Promise<boolean> {
    return true;
}

export async function getLiveConfig(): Promise<LiveSaveConfig> {
    // 1. SSoT: chrome.storage.local is the canonical source shared across Content Script, Options, and Background
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        try {
            const d = await chrome.storage.local.get([KEY_CONFIG]);
            if (d && d[KEY_CONFIG]) {
                _memConfig = { ...DEFAULT_LIVE_CONFIG, ...d[KEY_CONFIG] };
                return _memConfig;
            }
        } catch {
            /* intentional fallback */
        }
    }
    return { ..._memConfig };
}

export async function setLiveConfig(patch: Partial<LiveSaveConfig>): Promise<LiveSaveConfig> {
    const current = await getLiveConfig();
    const updated: LiveSaveConfig = { ...current, ...patch };
    _memConfig = updated;

    // 1. SSoT: Save to chrome.storage.local first
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        try {
            await chrome.storage.local.set({ [KEY_CONFIG]: updated });
        } catch (err) {
            console.warn('[LiveStorageManager] Failed to set config in chrome.storage.local:', err);
        }
    }

    return updated;
}

export async function saveLiveDirHandle(handle: any): Promise<boolean> {
    if (typeof globalThis !== 'undefined' && (globalThis as any).DirHandleController?.setDirHandle) {
        (globalThis as any).DirHandleController.setDirHandle(handle);
    }
    return saveStoredDirHandle(handle);
}

export async function getLiveDirHandle(): Promise<any> {
    if (typeof globalThis !== 'undefined' && (globalThis as any).DirHandleController?.getDirHandle) {
        const memHandle = (globalThis as any).DirHandleController.getDirHandle();
        if (memHandle) return memHandle;
    }
    return getStoredDirHandle();
}

export async function clearLiveDirHandle(): Promise<boolean> {
    if (typeof globalThis !== 'undefined' && (globalThis as any).DirHandleController?.setDirHandle) {
        (globalThis as any).DirHandleController.setDirHandle(null);
    }
    return clearStoredDirHandle();
}

export const LiveStorageManager = {
    DEFAULT_LIVE_CONFIG,
    saveLiveConversation,
    getLiveConversation,
    listLiveConversations,
    removeLiveConversation,
    clearLiveConversations,
    getLiveConfig,
    setLiveConfig,
    saveLiveDirHandle,
    getLiveDirHandle,
    clearLiveDirHandle
};

declare global {
    var LiveStorageManager: any;
}

if (typeof globalThis !== 'undefined') {
    (globalThis as any).LiveStorageManager = LiveStorageManager;
}

export default LiveStorageManager;
