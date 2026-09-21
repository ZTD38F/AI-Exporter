// src/core/storage/idbHandleStore.ts - Single Source of Truth for FileSystemDirectoryHandle in IndexedDB

export const IDB_NAME = 'gemini_exporter_idb';
export const IDB_VERSION = 1;
export const IDB_STORE = 'handles';
export const IDB_KEY = 'export_dir_handle';

export interface IdbHandleStoreModule {
    IDB_NAME: string;
    IDB_VERSION: number;
    IDB_STORE: string;
    IDB_KEY: string;
    openHandleDB: () => Promise<IDBDatabase>;
    getStoredDirHandle: () => Promise<any>;
    saveStoredDirHandle: (handle: any) => Promise<boolean>;
    clearStoredDirHandle: () => Promise<boolean>;
}

declare global {
    var IdbHandleStore: IdbHandleStoreModule;
}

export function openHandleDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        if (typeof indexedDB === 'undefined') {
            return reject(new Error('IndexedDB is not available in current environment'));
        }
        const req = indexedDB.open(IDB_NAME, IDB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(IDB_STORE)) {
                db.createObjectStore(IDB_STORE);
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

export async function getStoredDirHandle(): Promise<any> {
    if (typeof indexedDB === 'undefined') return null;
    try {
        const db = await openHandleDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(IDB_STORE, 'readonly');
            const store = tx.objectStore(IDB_STORE);
            const req = store.get(IDB_KEY);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => reject(req.error);
        });
    } catch (e) {
        console.warn('[IdbHandleStore] Failed to get dir handle from IndexedDB:', e);
        return null;
    }
}

export async function saveStoredDirHandle(handle: any): Promise<boolean> {
    if (typeof indexedDB === 'undefined') return false;
    try {
        const db = await openHandleDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(IDB_STORE, 'readwrite');
            const store = tx.objectStore(IDB_STORE);
            if (handle === null || handle === undefined) {
                store.delete(IDB_KEY);
            } else {
                store.put(handle, IDB_KEY);
            }
            tx.oncomplete = () => resolve(true);
            tx.onerror = () => reject(tx.error);
        });
    } catch (e) {
        console.warn('[IdbHandleStore] Failed to save dir handle to IndexedDB:', e);
        return false;
    }
}

export async function clearStoredDirHandle(): Promise<boolean> {
    return saveStoredDirHandle(null);
}

export const IdbHandleStore: IdbHandleStoreModule = {
    IDB_NAME,
    IDB_VERSION,
    IDB_STORE,
    IDB_KEY,
    openHandleDB,
    getStoredDirHandle,
    saveStoredDirHandle,
    clearStoredDirHandle
};

if (typeof globalThis !== 'undefined') (globalThis as any).IdbHandleStore = IdbHandleStore;
if (typeof module === 'object' && module.exports) module.exports = IdbHandleStore;

export default IdbHandleStore;
