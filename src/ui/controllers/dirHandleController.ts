// src/ui/controllers/dirHandleController.ts - Directory Handle Persistence & Permission Controller
import type { DirHandleControllerContract } from '../../types/ui.js';
const t = (key: string, ...args: any[]): string => {
    const g: any = (typeof I18n !== 'undefined' ? I18n : (typeof globalThis !== 'undefined' ? (globalThis as any).I18n : null));
    return g && typeof g.t === 'function' ? g.t(key, ...args) : key;
};

import { getStoredDirHandle, saveStoredDirHandle } from '../../core/storage/idbHandleStore.js';
export { getStoredDirHandle, saveStoredDirHandle };

let currentDirHandle: any = null;

export async function verifyDirPermission(handle: any): Promise<boolean> {
    if (!handle) return false;
    try {
        const opts = { mode: 'readwrite' };
        if ((await handle.queryPermission(opts)) !== 'granted') {
            if ((await handle.requestPermission(opts)) !== 'granted') {
                return false;
            }
        }
        // Physical existence check:
        // Even if permission was granted, if the directory was deleted from the disk,
        // querying keys() will immediately throw a NotFoundError!
        for await (const _ of handle.keys()) {
            break;
        }
        return true;
    } catch (e: any) {
        if (e?.name === 'NotFoundError' || e?.message?.includes('not be found')) {
            console.warn('[DirHandleController] Target directory was deleted from disk:', e);
        }
        return false;
    }
}

export async function restoreSavedDirHandle(): Promise<any> {
    try {
        const handle = await getStoredDirHandle();
        if (handle) {
            const ok = await verifyDirPermission(handle);
            if (!ok) {
                currentDirHandle = null;
                // Delete stale handle from IndexedDB so we don't keep referencing a deleted directory!
                await saveStoredDirHandle(null);
                console.warn('[DirHandle] Restored handle invalid or deleted on disk, cleared from storage');
                return null;
            }
            currentDirHandle = handle;
            return handle;
        }
    } catch (e) {
        console.warn('Failed to restore dir handle:', e);
    }
    return null;
}

export async function requestDirHandle(): Promise<any> {
    if (typeof window === 'undefined' || !(window as any).showDirectoryPicker) {
        throw new Error(typeof t === 'function' ? t('browserNoDirPicker') : '当前浏览器不支持 FileSystem Access API 目录选择');
    }
    const handle = await (window as any).showDirectoryPicker({ mode: 'readwrite' });
    currentDirHandle = handle;
    await saveStoredDirHandle(handle);
    return handle;
}

export function getDirHandle(): any {
    return currentDirHandle;
}

export function setDirHandle(handle: any): void {
    currentDirHandle = handle;
}

export const DirHandleController: DirHandleControllerContract = {
    saveStoredDirHandle,
    getStoredDirHandle,
    verifyDirPermission,
    restoreSavedDirHandle,
    requestDirHandle,
    getDirHandle,
    setDirHandle
};

(DirHandleController as any).DirHandleController = DirHandleController;
(DirHandleController as any).default = DirHandleController;

if (typeof globalThis !== 'undefined') {
    (globalThis as any).DirHandleController = DirHandleController;
}
if (typeof module === 'object' && module.exports) {
    module.exports = DirHandleController;
}

export default DirHandleController;
