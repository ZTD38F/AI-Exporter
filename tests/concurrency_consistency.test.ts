export {};
const test = require('node:test');
const assert = require('node:assert');
const StorageService = require('../src/core/storage/storageService.js');
const { mergeConversation } = require('../src/core/utils/mergeUtils.js');

function setupMockChromeStorage() {
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
    return {
        mockStorage,
        restore: () => {
            (global as any).chrome = origChrome;
        }
    };
}

test('StorageService.updateConversation - atomic targeted update', async () => {
    const env = setupMockChromeStorage();
    try {
        await StorageService.setConversations('u0', [
            { id: 'chat_1', title: 'Old Title 1', messageCount: 2 },
            { id: 'chat_2', title: 'Title 2', messageCount: 5 },
            { id: 'chat_3', title: 'Title 3', messageCount: 1 }
        ]);

        // 1. Update with partial object
        const updated = await StorageService.updateConversation('u0', 'chat_1', {
            title: 'New Title 1',
            messageCount: 10
        });
        assert.strictEqual(updated, true);

        const listAfter1 = await StorageService.getConversations('u0');
        assert.strictEqual(listAfter1.length, 3);
        assert.strictEqual(listAfter1[0].title, 'New Title 1');
        assert.strictEqual(listAfter1[0].messageCount, 10);
        assert.strictEqual(listAfter1[1].title, 'Title 2');
        assert.strictEqual(listAfter1[2].title, 'Title 3');

        // 2. Update with mutator function
        const updated2 = await StorageService.updateConversation('u0', 'chat_2', (conv: any) => {
            conv.title = 'Updated Title 2';
            conv.titles = { rpc: 'Updated Title 2' };
        });
        assert.strictEqual(updated2, true);

        const listAfter2 = await StorageService.getConversations('u0');
        assert.strictEqual(listAfter2[1].title, 'Updated Title 2');
        assert.deepStrictEqual(listAfter2[1].titles, { rpc: 'Updated Title 2' });

        // 3. Non-existent conversation
        const updated3 = await StorageService.updateConversation('u0', 'chat_nonexistent', { title: 'X' });
        assert.strictEqual(updated3, false);
    } finally {
        env.restore();
    }
});

test('mergeConversation - CON-HF10 timestamp monotonicity', () => {
    const existing = {
        id: 'chat_monotonic',
        title: 'Monotonic Test',
        updatedAt: 1700000050000,
        timestamp: 1700000050000,
        createdAt: 1700000000000
    };

    // Case 1: Older RPC response arrives out of order
    const olderIncoming = {
        id: 'chat_monotonic',
        title: 'Monotonic Test Older RPC',
        updatedAt: 1700000010000,
        timestamp: 1700000010000,
        createdAt: 1700000005000,
        titleSource: 'rpc',
        source: 'network-list'
    };

    const res1 = mergeConversation(existing, olderIncoming);
    // updatedAt and timestamp must NOT regress to 1700000050000
    assert.strictEqual(res1.merged.updatedAt, 1700000050000, 'updatedAt must not regress');
    assert.strictEqual(res1.merged.timestamp, 1700000050000, 'timestamp must not regress');
    // createdAt must remain earliest known
    assert.strictEqual(res1.merged.createdAt, 1700000000000, 'createdAt must remain earliest');

    // Case 2: Newer RPC response arrives
    const newerIncoming = {
        id: 'chat_monotonic',
        title: 'Monotonic Test Newer RPC',
        updatedAt: 1700000090000,
        timestamp: 1700000090000,
        createdAt: 1699999990000,
        titleSource: 'rpc',
        source: 'network-list'
    };

    const res2 = mergeConversation(existing, newerIncoming);
    assert.strictEqual(res2.merged.updatedAt, 1700000090000, 'updatedAt must advance to newer timestamp');
    assert.strictEqual(res2.merged.timestamp, 1700000090000, 'timestamp must advance to newer timestamp');
    assert.strictEqual(res2.merged.createdAt, 1699999990000, 'createdAt must advance to earlier timestamp');
});

test('CON-HF7: Export avoids stale snapshot overwrite & respects concurrent deletion/addition', async () => {
    const env = setupMockChromeStorage();
    try {
        // Initial conversations in storage before export begins
        await StorageService.setConversations('u0', [
            { id: 'chat_export_1', title: 'Export Chat 1', messageCount: 1 },
            { id: 'chat_export_2', title: 'Export Chat 2 (to be deleted)', messageCount: 1 },
            { id: 'chat_export_3', title: 'Export Chat 3', messageCount: 1 }
        ]);

        // Export starts: it takes a snapshot of IDs to export
        const snapshotConversations = await StorageService.getConversations('u0');
        assert.strictEqual(snapshotConversations.length, 3);

        // While export is running:
        // 1. chat_export_2 is confirmed deleted in cloud or deleted by user in UI
        await StorageService.removeConversation('u0', 'chat_export_2');

        // 2. A new conversation chat_new arrives concurrently (e.g. user chats in another tab)
        const currentList = await StorageService.getConversations('u0');
        await StorageService.setConversations('u0', [
            ...currentList,
            { id: 'chat_new', title: 'Concurrent New Chat', messageCount: 3 }
        ]);

        // 3. Export worker finishes chat_export_1 and updates its metadata atomically
        await StorageService.updateConversation('u0', 'chat_export_1', {
            title: 'Export Chat 1 (Resolved)',
            messageCount: 5
        });

        // Verify final storage state:
        // In the old buggy code, `await Storage.setConversations(slot, snapshotConversations)`
        // would wipe out `chat_new` and resurrect `chat_export_2`.
        // With our fix, only atomic updates occurred.
        const finalList = await StorageService.getConversations('u0');
        const finalIds = finalList.map((c: any) => c.id);

        assert.ok(!finalIds.includes('chat_export_2'), 'Deleted conversation must NOT be resurrected');
        assert.ok(finalIds.includes('chat_new'), 'Concurrently added conversation must NOT be lost');
        assert.ok(finalIds.includes('chat_export_1'), 'Exported conversation must exist');
        assert.ok(finalIds.includes('chat_export_3'), 'Untouched conversation must exist');

        const updatedChat1 = finalList.find((c: any) => c.id === 'chat_export_1');
        assert.strictEqual(updatedChat1.title, 'Export Chat 1 (Resolved)');
        assert.strictEqual(updatedChat1.messageCount, 5);
    } finally {
        env.restore();
    }
});
