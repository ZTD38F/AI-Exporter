export {};
const test = require('node:test');
const assert = require('node:assert');
const LiveStorageManager = require('../src/core/storage/liveStorageManager.js');

test('liveStorageManager - default configuration structure', () => {
    const def = LiveStorageManager.DEFAULT_LIVE_CONFIG;
    assert.strictEqual(def.enabledDb, undefined);
    assert.strictEqual(def.enabledDisk, false);
    assert.strictEqual(def.format, 'markdown');
    assert.strictEqual(def.includeAssets, true);
});

test('liveStorageManager - IDB mock, config persistence and dir handle delegation', async () => {
    const memoryStores: Record<string, Map<any, any>> = {
        handles: new Map()
    };

    const mockIdb = {
        open: (name: string, version: number) => {
            const req: any = {
                result: {
                    objectStoreNames: {
                        contains: (n: string) => n in memoryStores
                    },
                    createObjectStore: (n: string) => {
                        memoryStores[n] = new Map();
                    },
                    transaction: (storeName: string, mode: string) => {
                        const store = memoryStores[storeName] || new Map();
                        return {
                            objectStore: () => ({
                                put: (val: any, key?: any) => {
                                    const actualKey = key !== undefined ? key : val.id;
                                    store.set(actualKey, val);
                                },
                                get: (key: any) => {
                                    const reqGet: any = { result: store.get(key) };
                                    setTimeout(() => reqGet.onsuccess && reqGet.onsuccess(), 0);
                                    return reqGet;
                                },
                                getAll: () => {
                                    const reqAll: any = { result: Array.from(store.values()) };
                                    setTimeout(() => reqAll.onsuccess && reqAll.onsuccess(), 0);
                                    return reqAll;
                                },
                                delete: (key: any) => {
                                    store.delete(key);
                                },
                                clear: () => {
                                    store.clear();
                                }
                            }),
                            oncomplete: null as any,
                            onerror: null as any
                        };
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

    // Helper to simulate IDB transaction completion
    const origOpen = mockIdb.open;
    mockIdb.open = (name: string, ver: number) => {
        const req: any = origOpen(name, ver);
        const origResult = req.result;
        req.result = {
            ...origResult,
            transaction: (storeName: string, mode: string) => {
                const tx = origResult.transaction(storeName, mode);
                setTimeout(() => {
                    if (typeof tx.oncomplete === 'function') tx.oncomplete();
                }, 1);
                return tx;
            }
        };
        return req;
    };

    try {
        // 1. Verify setLiveConfig & getLiveConfig
        await LiveStorageManager.setLiveConfig({ enabledDisk: true, dirName: 'MyNotes' });
        const cfg = await LiveStorageManager.getLiveConfig();
        assert.strictEqual(cfg.enabledDisk, true);
        assert.strictEqual(cfg.dirName, 'MyNotes');

        // 2. Verify saveLiveDirHandle & getLiveDirHandle delegating to idbHandleStore
        const mockHandle = { name: 'MyNotes', kind: 'directory' };
        await LiveStorageManager.saveLiveDirHandle(mockHandle);
        const retrievedHandle = await LiveStorageManager.getLiveDirHandle();
        assert.ok(retrievedHandle);
        assert.strictEqual(retrievedHandle.name, 'MyNotes');

        // 3. Verify conversation persistence stubs safely return empty/no-op without storing anything
        const saveRes = await LiveStorageManager.saveLiveConversation({ id: 'c_stub', title: 'Stub', messages: [] });
        assert.strictEqual(saveRes, false);
        const getRes = await LiveStorageManager.getLiveConversation('c_stub');
        assert.strictEqual(getRes, null);
        const listRes = await LiveStorageManager.listLiveConversations();
        assert.deepStrictEqual(listRes, []);
    } finally {
        (global as any).indexedDB = origIdb;
    }
});

test('liveStorageManager - chrome.storage.local takes precedence over IDB as canonical SSoT', async () => {
    let storageMap: Record<string, any> = {
        live_save_config: {
            enabledDisk: true,
            dirName: 'SSoT_Directory',
            format: 'markdown'
        }
    };

    const origChrome = (global as any).chrome;
    (global as any).chrome = {
        storage: {
            local: {
                get: async (keys: string[]) => {
                    const res: any = {};
                    for (const k of keys) {
                        if (k in storageMap) res[k] = storageMap[k];
                    }
                    return res;
                },
                set: async (obj: any) => {
                    Object.assign(storageMap, obj);
                }
            }
        }
    };

    try {
        // getLiveConfig should read from chrome.storage.local
        const cfg = await LiveStorageManager.getLiveConfig();
        assert.strictEqual(cfg.enabledDisk, true);
        assert.strictEqual(cfg.dirName, 'SSoT_Directory');

        // setLiveConfig should write to chrome.storage.local
        await LiveStorageManager.setLiveConfig({ dirName: 'Updated_SSoT' });
        assert.strictEqual(storageMap.live_save_config.dirName, 'Updated_SSoT');
    } finally {
        (global as any).chrome = origChrome;
    }
});
