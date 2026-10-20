export {};
const test = require('node:test');
const assert = require('node:assert');

// 1. D1: Pagination loop sets stoppedEarly and exhaustive accurately
test('D1: Pagination getAllConversations sets stoppedEarly=true and exhaustive=false on token loop', async () => {
    const Pagination = require('../src/core/api/client/pagination.js');
    let callCount = 0;
    const mockClient = {
        getConversationList: async () => {
            callCount++;
            return {
                conversations: [{ id: `c_${callCount}`, title: `Chat ${callCount}` }],
                nextPageToken: 'looping_cursor'
            };
        }
    };

    const result = await Pagination.getAllConversations(mockClient, 2000);
    assert.strictEqual(callCount, 2);
    assert.strictEqual(result.stoppedEarly, true, 'Token loop must set stoppedEarly: true');
    assert.strictEqual(result.exhaustive, false, 'Token loop must set exhaustive: false');
    assert.ok(result.diagnostics.stopReason.includes('Token Loop'));
});

test('D1: Natural end sets stoppedEarly=false and exhaustive=true', async () => {
    const Pagination = require('../src/core/api/client/pagination.js');
    let callCount = 0;
    const mockClient = {
        getConversationList: async (token: string | null) => {
            callCount++;
            if (callCount === 1) {
                return {
                    conversations: [{ id: 'c_1', title: 'Chat 1' }],
                    nextPageToken: 'next_page'
                };
            }
            return {
                conversations: [{ id: 'c_2', title: 'Chat 2' }],
                nextPageToken: null // Natural end
            };
        }
    };

    const result = await Pagination.getAllConversations(mockClient, 2000);
    assert.strictEqual(callCount, 2);
    assert.strictEqual(result.stoppedEarly, undefined, 'Natural end must not set stoppedEarly');
    assert.strictEqual(result.exhaustive, true, 'Natural end must set exhaustive: true');
});

// 2. D2: Narrowed error detection
test('D2: BatchWorker does not delete conversation when error contains 11167 or other non-deletion numbers', async () => {
    const BatchWorker = require('../src/core/engine/export/batchWorker.js');
    const { __setModuleOverride } = require('../src/core/utils/moduleOverrides.js');

    let removedId: string | null = null;
    const mockStorage = {
        removeConversation: async (_slot: string, id: string) => {
            removedId = id;
            return true;
        }
    };
    __setModuleOverride('StorageService', mockStorage);

    try {
        const logs: string[] = [];
        const chatWith11167 = {
            id: 'chat_safe_1',
            title: 'Safe Chat',
            messages: [],
            error: 'Server returned error code 11167',
            _empty: true
        };
        const reqItem = { id: 'chat_safe_1', title: 'Safe Chat' };

        const res = await BatchWorker.resolveChat(
            chatWith11167,
            reqItem,
            null,
            null,
            'u0',
            () => {},
            (msg: string) => logs.push(msg)
        );

        assert.strictEqual(removedId, null, '11167 must NOT trigger removeConversation');
        assert.strictEqual(res.isConfirmedDeleted, false);
    } finally {
        __setModuleOverride('StorageService', null);
    }
});

test('D2: BatchWorker deletes conversation ONLY when confirmed BardErrorInfo: 1167 or 404', async () => {
    const BatchWorker = require('../src/core/engine/export/batchWorker.js');
    const { __setModuleOverride } = require('../src/core/utils/moduleOverrides.js');

    let removedId: string | null = null;
    const mockStorage = {
        removeConversation: async (_slot: string, id: string) => {
            removedId = id;
            return true;
        }
    };
    __setModuleOverride('StorageService', mockStorage);

    try {
        const logs: string[] = [];
        const deletedChat = {
            id: 'chat_del_1',
            title: 'Deleted Chat',
            messages: [],
            error: '会话已在服务端删除 (chat_del_1) [BardErrorInfo: 1167]',
            _empty: true
        };
        const reqItem = { id: 'chat_del_1', title: 'Deleted Chat' };

        const res = await BatchWorker.resolveChat(
            deletedChat,
            reqItem,
            null,
            null,
            'u0',
            () => {},
            (msg: string) => logs.push(msg)
        );

        assert.strictEqual(removedId, 'chat_del_1', 'Confirmed BardErrorInfo: 1167 must trigger removeConversation');
        assert.strictEqual(res.isConfirmedDeleted, true);
    } finally {
        __setModuleOverride('StorageService', null);
    }
});

// 3. D4: Clear All clears list, details, checkpoint, and exported records
test('D4: StorageService.clearConversations cleans up checkpoint and exported records map', async () => {
    const StorageService = require('../src/core/storage/storageService.js');

    const mockStore: Record<string, any> = {
        gemini_conversations: [{ id: 'chat_1', title: 'Chat 1' }],
        gemini_last_count: 1,
        gemini_scan_checkpoint: 1700000000000,
        exportedIds: { 'chat_1': { status: 'ok', exportedAt: 1700000000000 } }
    };

    (globalThis as any).chrome = {
        storage: {
            local: {
                get: async (keys: any) => {
                    const out: Record<string, any> = {};
                    const arr = Array.isArray(keys) ? keys : (typeof keys === 'string' ? [keys] : Object.keys(mockStore));
                    for (const k of arr) {
                        if (mockStore[k] !== undefined) out[k] = mockStore[k];
                    }
                    return out;
                },
                set: async (items: Record<string, any>) => {
                    Object.assign(mockStore, items);
                },
                remove: async (keys: any) => {
                    const arr = Array.isArray(keys) ? keys : [keys];
                    for (const k of arr) {
                        delete mockStore[k];
                    }
                }
            }
        }
    };

    await StorageService.clearConversations('u0');

    assert.deepStrictEqual(mockStore.gemini_conversations, []);
    assert.strictEqual(mockStore.gemini_last_count, 0);
    assert.strictEqual(mockStore.gemini_scan_checkpoint, undefined, 'Scan checkpoint must be removed');
    assert.deepStrictEqual(mockStore.exportedIds, {}, 'Exported records must be emptied');

    const checkpoint = await StorageService.getScanCheckpoint('u0');
    assert.strictEqual(checkpoint, null, 'getScanCheckpoint must return null after clearConversations');
});

// 4. MessageBridge: Invalid ID validation on deletion
test('MessageBridge: ignores malformed conversation IDs in CONVERSATION_DELETED event', async () => {
    const MessageBridge = require('../src/content/messageBridge.js');

    let removedCalled = false;
    const mockStorage = {
        removeConversation: async () => {
            removedCalled = true;
            return true;
        }
    };

    const api = MessageBridge.init({
        Storage: mockStorage,
        getAccountSlot: () => 'u0',
        upsertConversations: async () => {}
    });

    // 1. Post message with invalid ID (e.g. script injection attempt or garbage)
    await api.handleWindowMessage({
        origin: (typeof location !== 'undefined' ? location.origin : undefined),
        source: (typeof window !== 'undefined' ? window : null),
        data: {
            type: 'GEMINI_CONVERSATION_DELETED',
            payload: { id: '../../malicious/path' }
        }
    });

    assert.strictEqual(removedCalled, false, 'Malformed ID must NOT call removeConversation');

    // 2. Post message with valid hex ID
    await api.handleWindowMessage({
        origin: (typeof location !== 'undefined' ? location.origin : undefined),
        source: (typeof window !== 'undefined' ? window : null),
        data: {
            type: 'GEMINI_CONVERSATION_DELETED',
            payload: { id: 'c_12345678abcdef' }
        }
    });

    assert.strictEqual(removedCalled, false, 'Valid page event must still be verified before deletion');
});
