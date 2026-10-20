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

test('non-Markdown formats suppress live save config and both write routes', async () => {
    const { STORAGE_KEYS } = require('../src/core/utils/constants.js');
    const { handleLiveSaveViaHandle } = require('../src/background/liveSaveHandler.js');
    const { writeLiveSaveMarkdown } = require('../src/core/engine/liveSaveWriter.js');
    const { saveFormat } = require('../src/core/storage/formatStore.js');
    const originalChrome = (global as any).chrome;
    const data: Record<string, any> = {};
    (global as any).chrome = { storage: { local: {
        get: async () => ({ ...data }),
        set: async (patch: any) => { Object.assign(data, patch); }
    } } };
    try {
        for (const format of ['pdf', 'html', 'json', 'json_openai', 'json_raw']) {
            data[STORAGE_KEYS.FORMAT] = format;
            data[STORAGE_KEYS.LIVE_SAVE_CONFIG] = { enabledDisk: true };
            assert.strictEqual((await LiveStorageManager.getLiveConfig()).enabledDisk, false);
            assert.strictEqual((await LiveStorageManager.setLiveConfig({ enabledDisk: true })).enabledDisk, false);
            const result = await handleLiveSaveViaHandle({});
            assert.strictEqual(result.error, 'live_save_requires_markdown');
            let written = false;
            await assert.rejects(writeLiveSaveMarkdown({ writeFile: async () => { written = true; } },
                { chat: {}, safeTitle: 'Test', nid: 'abcdef' },
                { formatter: { formatMarkdownCanonical: async () => ({ content: '# Test' }) } }), /only supports Markdown/);
            assert.strictEqual(written, false);
        }
        data[STORAGE_KEYS.FORMAT] = 'markdown';
        await LiveStorageManager.setLiveConfig({ enabledDisk: true });
        await saveFormat('pdf');
        assert.strictEqual(data[STORAGE_KEYS.LIVE_SAVE_CONFIG].enabledDisk, false);
        await saveFormat('markdown');
        assert.strictEqual((await LiveStorageManager.getLiveConfig()).enabledDisk, false);
        await LiveStorageManager.setLiveConfig({ enabledDisk: true });
        assert.strictEqual((await LiveStorageManager.getLiveConfig()).enabledDisk, true);
        await Promise.all([saveFormat('html'), saveFormat('markdown')]);
        assert.strictEqual(data[STORAGE_KEYS.FORMAT], 'markdown');
    } finally {
        (global as any).chrome = originalChrome;
    }
});
