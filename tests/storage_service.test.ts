export {};
const test = require('node:test');
const assert = require('node:assert');
const StorageService = require('../src/core/storage/storageService.js');

test('storage_service - normSlot', () => {
    assert.strictEqual(StorageService.normSlot(null), 'u0');
    assert.strictEqual(StorageService.normSlot(''), 'u0');
    assert.strictEqual(StorageService.normSlot('default'), 'u0');
    assert.strictEqual(StorageService.normSlot('u0'), 'u0');
    assert.strictEqual(StorageService.normSlot('u1'), 'u1');
    assert.strictEqual(StorageService.normSlot('u2'), 'u2');
});

test('storage_service - getStorageKeys', () => {
    const keys0 = StorageService.getStorageKeys('u0');
    assert.strictEqual(keys0.convKey, 'gemini_conversations');
    assert.strictEqual(keys0.expKey, 'exportedIds');

    const keys1 = StorageService.getStorageKeys('u1');
    assert.strictEqual(keys1.convKey, 'gemini_conversations_u1');
    assert.strictEqual(keys1.expKey, 'gemini_exported_u1');
});

test('storage_service - hasTakeoutData & setHasImportedTakeout functions exist', () => {
    assert.strictEqual(typeof StorageService.hasTakeoutData, 'function');
    assert.strictEqual(typeof StorageService.setHasImportedTakeout, 'function');
});

test('storage_service - reconcileConversations preserves takeout entries and purges deleted cloud entries', async () => {
    const mockStorage: Record<string, any> = {};
    const origChrome = (global as any).chrome;
    (global as any).chrome = {
        storage: {
            local: {
                get: async (keys: any) => {
                    if (keys === null) return { ...mockStorage };
                    if (typeof keys === 'string') keys = [keys];
                    const res: Record<string, any> = {};
                    for (const k of (keys || [])) {
                        if (k in mockStorage) res[k] = mockStorage[k];
                    }
                    return res;
                },
                set: async (obj: any) => {
                    Object.assign(mockStorage, obj);
                },
                remove: async (keys: any) => {
                    if (typeof keys === 'string') keys = [keys];
                    for (const k of (keys || [])) delete mockStorage[k];
                }
            }
        }
    };

    try {
        await StorageService.setConversations('u0', [
            { id: 'chat_active_1', title: 'Active Chat 1', source: 'network-list', timestamp: 1700000000000 },
            { id: 'chat_deleted', title: 'Deleted Cloud Chat', source: 'network-list', timestamp: 1700000000000 },
            { id: 'chat_takeout_only', title: 'Takeout Imported Chat', source: 'takeout', isTakeoutOnly: true, timestamp: 1700000000000 }
        ]);

        const activeCloud = [{ id: 'chat_active_1', title: 'Active Chat 1' }];
        const result = await StorageService.reconcileConversations('u0', activeCloud);
        assert.strictEqual(result.kept, 2, 'should keep active chat and takeout chat');
        assert.strictEqual(result.removed, 1, 'should remove deleted cloud chat');
        assert.deepStrictEqual(result.removedIds, ['chat_deleted']);

        const remaining = await StorageService.getConversations('u0');
        assert.strictEqual(remaining.length, 2);
        assert.ok(remaining.some((c: any) => c.id === 'chat_active_1'));
        assert.ok(remaining.some((c: any) => c.id === 'chat_takeout_only'));
    } finally {
        (global as any).chrome = origChrome;
    }
});

test('format_store - normalizeFormat validates against allowed formats and devMode', () => {
    const FormatStore = require('../src/core/storage/formatStore.js');
    assert.strictEqual(FormatStore.normalizeFormat('markdown', false), 'markdown');
    assert.strictEqual(FormatStore.normalizeFormat('json_openai', false), 'json_openai');
    assert.strictEqual(FormatStore.normalizeFormat('unknown_format', false), 'markdown');

    assert.strictEqual(FormatStore.normalizeFormat('json_raw', false), 'markdown');
    assert.strictEqual(FormatStore.normalizeFormat('json_raw', true), 'json_raw');
});
