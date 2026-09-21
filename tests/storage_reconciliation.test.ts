export {};
const test = require('node:test');
const assert = require('node:assert');

// Mock chrome.storage.local
const mockStorage: Record<string, any> = {};
(global as any).chrome = {
    storage: {
        local: {
            get: async (keys: any) => {
                if (keys === null) return { ...mockStorage };
                if (typeof keys === 'string') keys = [keys];
                const res: Record<string, any> = {};
                for (const k of keys) {
                    if (k in mockStorage) res[k] = mockStorage[k];
                }
                return res;
            },
            set: async (obj: any) => {
                Object.assign(mockStorage, obj);
            },
            remove: async (keys: any) => {
                if (typeof keys === 'string') keys = [keys];
                for (const k of keys) delete mockStorage[k];
            }
        }
    }
};

const StorageService = require('../src/core/storage/storageService.js');

test('StorageService.removeConversation - removes target conversation by id or c_id', async () => {
    await StorageService.setConversations('u0', [
        { id: 'cca63136d0630930', title: 'Deleted Chat', source: 'page-sync', timestamp: 1700000000000 },
        { id: '1dc469a46941004f', title: 'Active Chat 1', source: 'network-list', timestamp: 1700000000000 },
        { id: 'c_6ea653f1f5f2f533', title: 'Active Chat 2', source: 'network-list', timestamp: 1700000000000 }
    ]);

    const res1 = await StorageService.removeConversation('u0', 'cca63136d0630930');
    assert.strictEqual(res1, true);

    const list1 = await StorageService.getConversations('u0');
    assert.strictEqual(list1.length, 2);
    assert.strictEqual(list1.some((c: any) => c.id === 'cca63136d0630930'), false);

    const res2 = await StorageService.removeConversation('u0', 'c_1dc469a46941004f');
    assert.strictEqual(res2, true);

    const list2 = await StorageService.getConversations('u0');
    assert.strictEqual(list2.length, 1);
    assert.strictEqual(list2[0].id.replace(/^c_/, ''), '6ea653f1f5f2f533');

    const res3 = await StorageService.removeConversation('u0', 'non_existent_id');
    assert.strictEqual(res3, false);
});

test('StorageService.reconcileConversations - prunes absent cloud chats while keeping Takeout chats', async () => {
    await StorageService.setConversations('u0', [
        { id: 'cca63136d0630930', title: 'Deleted on Cloud', source: 'page-sync', timestamp: 1700000000000 },
        { id: '0214ab4226767bf9', title: 'Active Cloud Chat', source: 'network-list', timestamp: 1700000000000 },
        { id: 'takeout_offline_1', title: 'Takeout Imported Chat', source: 'takeout', timestamp: 1700000000000 },
        { id: 'takeout_offline_2', title: 'Takeout Title Source', titleSource: 'takeout', titles: { takeout: 'Takeout Title' }, timestamp: 1700000000000 }
    ]);

    const activeCloudList = [
        { id: '0214ab4226767bf9', title: 'Active Cloud Chat' }
    ];

    const result = await StorageService.reconcileConversations('u0', activeCloudList, { keepTakeout: true });

    assert.strictEqual(result.removed, 1);
    assert.deepStrictEqual(result.removedIds, ['cca63136d0630930']);
    assert.strictEqual(result.kept, 3);

    const updatedList = await StorageService.getConversations('u0');
    assert.strictEqual(updatedList.length, 3);
    const updatedIds = updatedList.map((c: any) => c.id);
    assert.strictEqual(updatedIds.includes('cca63136d0630930'), false);
    assert.strictEqual(updatedIds.includes('0214ab4226767bf9'), true);
    assert.strictEqual(updatedIds.includes('takeout_offline_1'), true);
    assert.strictEqual(updatedIds.includes('takeout_offline_2'), true);
});
