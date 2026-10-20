import type { DirHandleControllerContract } from '../../types/ui.js';
import { t } from '../uiCommon.js';

import {
    getStoredDirHandle,
    saveStoredDirHandle,
    getMemoryDirHandle,
    setMemoryDirHandle
} from '../../core/storage/idbHandleStore.js';
export { getStoredDirHandle, saveStoredDirHandle };

let currentDirHandle: any = null;
let pendingPermissionHandle: any = null;

export async function verifyDirPermission(handle: any, options?: { allowRequest?: boolean }): Promise<boolean> {
    const r = await verifyDirPermissionDetailed(handle, options);
    return r.ok;
}

interface DirVerifyResult { ok: boolean; notFound: boolean; }

async function verifyDirPermissionDetailed(handle: any, options?: { allowRequest?: boolean }): Promise<DirVerifyResult> {
    if (!handle) return { ok: false, notFound: false };
    try {
        const opts = { mode: 'readwrite' };
        const hasActivation = typeof navigator !== 'undefined' &&
            !!(navigator as any).userActivation && (navigator as any).userActivation.isActive;
        if ((await handle.queryPermission(opts)) !== 'granted') {
            if ((options && options.allowRequest) || hasActivation) {
                if ((await handle.requestPermission(opts)) !== 'granted') {
                    return { ok: false, notFound: false };
                }
            } else {
                return { ok: false, notFound: false };
            }
        }
        // Physical existence check: even if permission is granted, if directory was deleted from disk,
        // querying keys() throws NotFoundError immediately.
        for await (const _ of handle.keys()) {
            break;
        }
        return { ok: true, notFound: false };
    } catch (e: any) {
        const notFound = e?.name === 'NotFoundError' || e?.message?.includes('not be found');
        if (notFound) {
            console.warn('[DirHandleController] Target directory was deleted from disk:', e);
        }
        return { ok: false, notFound };
    }
}

export async function restoreSavedDirHandle(): Promise<any> {
    try {
        const handle = await getStoredDirHandle();
        if (handle) {
            const r = await verifyDirPermissionDetailed(handle);
            if (!r.ok) {
                currentDirHandle = null;
                setMemoryDirHandle(null);
                if (r.notFound) {
                    // Delete stale handle from storage when directory no longer exists on disk
                    await saveStoredDirHandle(null);
                    pendingPermissionHandle = null;
                    console.warn('[DirHandle] Restored handle invalid or deleted on disk, cleared from storage');
                } else {
                    // Browser degraded permission to 'prompt'; preserve handle for 1-click reauthorization
                    pendingPermissionHandle = handle;
                    console.info('[DirHandle] Stored handle permission is prompt. Preserving handle for 1-click reauthorization.');
                }
                return null;
            }
            currentDirHandle = handle;
            pendingPermissionHandle = null;
            setMemoryDirHandle(handle);
            return handle;
        }
    } catch (e) {
        console.warn('Failed to restore dir handle:', e);
    }
    return null;
}

export function getPendingPermissionHandle(): any {
    return pendingPermissionHandle;
}

export async function reauthorizeDirHandle(): Promise<boolean> {
    const handle = pendingPermissionHandle || (await getStoredDirHandle());
    if (!handle) return false;
    try {
        const opts = { mode: 'readwrite' };
        if (typeof handle.requestPermission === 'function') {
            const perm = await handle.requestPermission(opts);
            if (perm === 'granted') {
                currentDirHandle = handle;
                pendingPermissionHandle = null;
                setMemoryDirHandle(handle);
                await saveStoredDirHandle(handle);
                return true;
            }
        }
    } catch (err) {
        console.warn('[DirHandle] reauthorizeDirHandle failed:', err);
    }
    return false;
}

export async function requestDirHandle(): Promise<any> {
    if (typeof window === 'undefined' || !(window as any).showDirectoryPicker) {
        throw new Error(typeof t === 'function' ? t('browserNoDirPicker') : '当前浏览器不支持 FileSystem Access API 目录选择');
    }
    const handle = await (window as any).showDirectoryPicker({ mode: 'readwrite' });
    currentDirHandle = handle;
    pendingPermissionHandle = null;
    setMemoryDirHandle(handle);
    await saveStoredDirHandle(handle);
    return handle;
}

export function getDirHandle(): any {
    return currentDirHandle || getMemoryDirHandle();
}

export function setDirHandle(handle: any): void {
    currentDirHandle = handle;
    if (handle) pendingPermissionHandle = null;
    setMemoryDirHandle(handle);
}

export const DirHandleController: DirHandleControllerContract = {
    saveStoredDirHandle,
    getStoredDirHandle,
    verifyDirPermission,
    restoreSavedDirHandle,
    requestDirHandle,
    getDirHandle,
    setDirHandle,
    getPendingPermissionHandle,
    reauthorizeDirHandle
};

export default DirHandleController;
