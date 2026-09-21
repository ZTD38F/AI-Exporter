export {};
const test = require('node:test');
const assert = require('node:assert');
const {
    IDB_NAME,
    IDB_VERSION,
    IDB_STORE,
    IDB_KEY,
    openHandleDB,
    getStoredDirHandle,
    saveStoredDirHandle,
    clearStoredDirHandle,
    IdbHandleStore
} = require('../src/core/storage/idbHandleStore.js');

test('idbHandleStore - constants integrity', () => {
    assert.strictEqual(IDB_NAME, 'gemini_exporter_idb');
    assert.strictEqual(IDB_VERSION, 1);
    assert.strictEqual(IDB_STORE, 'handles');
    assert.strictEqual(IDB_KEY, 'export_dir_handle');
});

test('idbHandleStore - environment with no indexedDB returns safe defaults', async () => {
    const origIdb = (global as any).indexedDB;
    (global as any).indexedDB = undefined;
    try {
        const handle = await getStoredDirHandle();
        assert.strictEqual(handle, null);
        const saveRes = await saveStoredDirHandle({ name: 'test' });
        assert.strictEqual(saveRes, false);
        const clearRes = await clearStoredDirHandle();
        assert.strictEqual(clearRes, false);
    } finally {
        (global as any).indexedDB = origIdb;
    }
});

test('idbHandleStore - save, get, and clear handle in mock IndexedDB', async () => {
    const memoryStores: Record<string, Map<any, any>> = {};

    const mockIdb = {
        open: (name: string, version: number) => {
            const req: any = {
                result: {
                    name,
                    version,
                    objectStoreNames: {
                        contains: (n: string) => n in memoryStores
                    },
                    createObjectStore: (n: string) => {
                        memoryStores[n] = new Map();
                    },
                    transaction: (storeName: string, mode: string) => {
                        const store = memoryStores[storeName] || new Map();
                        const tx: any = {
                            objectStore: () => ({
                                put: (val: any, key?: any) => {
                                    store.set(key, val);
                                },
                                get: (key: any) => {
                                    const reqGet: any = { result: store.get(key) };
                                    setTimeout(() => reqGet.onsuccess && reqGet.onsuccess(), 0);
                                    return reqGet;
                                },
                                delete: (key: any) => {
                                    store.delete(key);
                                }
                            }),
                            oncomplete: null as any,
                            onerror: null as any
                        };
                        setTimeout(() => {
                            if (typeof tx.oncomplete === 'function') tx.oncomplete();
                        }, 1);
                        return tx;
                    }
                },
                onsuccess: null as any,
                onerror: null as any,
                onupgradeneeded: null as any
            };

            setTimeout(() => {
                if (typeof req.onupgradeneeded === 'function') {
                    req.onupgradeneeded();
                }
                if (typeof req.onsuccess === 'function') {
                    req.onsuccess();
                }
            }, 0);

            return req;
        }
    };

    const origIdb = (global as any).indexedDB;
    (global as any).indexedDB = mockIdb;

    try {
        // Initial state: empty
        const initial = await getStoredDirHandle();
        assert.strictEqual(initial, null);

        // Store handle
        const mockHandle = { name: 'Vault_Obsidian', kind: 'directory' };
        const saved = await saveStoredDirHandle(mockHandle);
        assert.strictEqual(saved, true);

        // Retrieve handle
        const retrieved = await getStoredDirHandle();
        assert.ok(retrieved);
        assert.strictEqual(retrieved.name, 'Vault_Obsidian');

        // Clear handle
        const cleared = await clearStoredDirHandle();
        assert.strictEqual(cleared, true);

        // Retrieve after clear
        const afterClear = await getStoredDirHandle();
        assert.strictEqual(afterClear, null);
    } finally {
        (global as any).indexedDB = origIdb;
    }
});
