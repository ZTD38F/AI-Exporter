import { IDB_DATABASES } from '../utils/constants.js';

export const IDB_NAME = IDB_DATABASES.HANDLES;
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
    getMemoryDirHandle: () => any;
    setMemoryDirHandle: (handle: any) => void;
}

let _memoryDirHandle: any = null;

export function getMemoryDirHandle(): any {
    return _memoryDirHandle;
}

export function setMemoryDirHandle(handle: any): void {
    _memoryDirHandle = handle || null;
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
        req.onblocked = () => {
            console.warn(
                '[IdbHandleStore] IndexedDB open is blocked by an older unclosed connection. ' +
                'A future version upgrade would stall here; connections are now closed after each operation.'
            );
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function withHandleDB<T>(fn: (db: IDBDatabase) => Promise<T>): Promise<T> {
    const db = await openHandleDB();
    try {
        return await fn(db);
    } finally {
        try {
            db.close();
        } catch {}
    }
}

export async function getStoredDirHandle(): Promise<any> {
    if (_memoryDirHandle) return _memoryDirHandle;
    if (typeof indexedDB === 'undefined') return null;
    try {
        const handle = await withHandleDB((db) => new Promise((resolve, reject) => {
            const tx = db.transaction(IDB_STORE, 'readonly');
            const store = tx.objectStore(IDB_STORE);
            const req = store.get(IDB_KEY);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => reject(req.error);
        }));
        if (handle) {
            _memoryDirHandle = handle;
        }
        return handle;
    } catch (e) {
        console.warn('[IdbHandleStore] Failed to get dir handle from IndexedDB:', e);
        return null;
    }
}

export async function saveStoredDirHandle(handle: any): Promise<boolean> {
    if (typeof indexedDB === 'undefined') return false;
    try {
        const ok = await withHandleDB((db) => new Promise<boolean>((resolve, reject) => {
            const tx = db.transaction(IDB_STORE, 'readwrite');
            const store = tx.objectStore(IDB_STORE);
            if (handle === null || handle === undefined) {
                store.delete(IDB_KEY);
            } else {
                store.put(handle, IDB_KEY);
            }
            tx.oncomplete = () => resolve(true);
            tx.onerror = () => reject(tx.error);
        }));
        if (ok) {
            _memoryDirHandle = handle || null;
        }
        return ok;
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
    clearStoredDirHandle,
    getMemoryDirHandle,
    setMemoryDirHandle
};

if (typeof module === 'object' && module.exports) module.exports = IdbHandleStore;

export default IdbHandleStore;
