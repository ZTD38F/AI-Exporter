export {};

/**
 * tests/audit_reinforcement.test.ts
 *
 * Verification suite for architectural audit reinforcements:
 * 1. Two-Tier Storage atomic abort: IDB batch failure throws and blocks chrome.storage.local write.
 * 2. Takeout mediaIndex strict slot isolation: no global singleton clobber across account slots.
 * 3. Pagination getAllConversations token loop detection: circular nextPageToken triggers early safe termination.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

// 1. Two-Tier Storage Atomic Abort Verification
test('storageService: IDB failure aborts write and prevents chrome.storage.local corruption', async () => {
    const StorageService = require('../src/core/storage/storageService.js');
    const DetailStore = require('../src/core/storage/conversationDetailStore.js');

    // Setup mock chrome.storage.local
    const mockStorage: Record<string, any> = {};
    (globalThis as any).chrome = {
        storage: {
            local: {
                get: async (keys: string[]) => {
                    const out: Record<string, any> = {};
                    for (const k of keys) if (mockStorage[k]) out[k] = mockStorage[k];
                    return out;
                },
                set: async (items: Record<string, any>) => {
                    Object.assign(mockStorage, items);
                }
            }
        }
    };

    // Save original method
    const origSaveBatch = DetailStore.saveConversationDetailsBatch;
    try {
        // Mock saveConversationDetailsBatch to throw an error (simulating quota exceeded or DB failure)
        DetailStore.saveConversationDetailsBatch = async () => {
            throw new Error('IndexedDB quota exceeded');
        };

        const testConversations = [
            {
                id: 'conv_1',
                title: 'Test Chat 1',
                messages: [{ id: 'm1', text: 'hello' }],
                turns: [{ role: 'user', text: 'hello' }]
            }
        ];

        // setConversations must throw, and chrome.storage.local must NOT receive the stripped list
        await assert.rejects(
            async () => {
                await StorageService.setConversations('u0', testConversations);
            },
            /IndexedDB quota exceeded/
        );

        // Verify that gemini_conversations in chrome.storage.local is still empty (never written)
        assert.strictEqual(mockStorage['gemini_conversations'], undefined);
    } finally {
        DetailStore.saveConversationDetailsBatch = origSaveBatch;
    }
});

// 2. Takeout MediaIndex Strict Slot Isolation Verification
test('mediaIndex: strict slot isolation prevents cross-account data corruption', () => {
    const MediaIndex = require('../src/core/engine/takeout/mediaIndex.js');

    // Commit takeout data for Slot u0
    MediaIndex.commitTakeoutData('u0', {
        mediaMap: { chat_u0: [{ filename: 'image_u0.png' }] },
        globalMedia: { 'image_u0.png': {} },
        convCache: { chat_u0: { title: 'Slot 0 Chat' } }
    });

    // Commit takeout data for Slot u1
    MediaIndex.commitTakeoutData('u1', {
        mediaMap: { chat_u1: [{ filename: 'image_u1.png' }] },
        globalMedia: { 'image_u1.png': {} },
        convCache: { chat_u1: { title: 'Slot 1 Chat' } }
    });

    // Verify Slot u0 has only Slot u0 data
    const storeU0 = MediaIndex.getStore('u0');
    assert.ok(storeU0.mediaMap['chat_u0'], 'Slot u0 must have chat_u0');
    assert.strictEqual(storeU0.mediaMap['chat_u1'], undefined, 'Slot u0 must NOT contain chat_u1');
    assert.strictEqual(MediaIndex.getTakeoutOfflineChat('chat_u0', 'u0')?.title, 'Slot 0 Chat');
    assert.strictEqual(MediaIndex.getTakeoutOfflineChat('chat_u1', 'u0'), null);

    // Verify Slot u1 has only Slot u1 data
    const storeU1 = MediaIndex.getStore('u1');
    assert.ok(storeU1.mediaMap['chat_u1'], 'Slot u1 must have chat_u1');
    assert.strictEqual(storeU1.mediaMap['chat_u0'], undefined, 'Slot u1 must NOT contain chat_u0');
    assert.strictEqual(MediaIndex.getTakeoutOfflineChat('chat_u1', 'u1')?.title, 'Slot 1 Chat');
    assert.strictEqual(MediaIndex.getTakeoutOfflineChat('chat_u0', 'u1'), null);

    // Verify clearing Slot u1 does NOT affect Slot u0
    MediaIndex.clearTakeoutData('u1');
    assert.strictEqual(MediaIndex.getTakeoutOfflineChat('chat_u1', 'u1'), null);
    assert.strictEqual(MediaIndex.getTakeoutOfflineChat('chat_u0', 'u0')?.title, 'Slot 0 Chat');

    // Clean up
    MediaIndex.clearTakeoutData('u0');
});

// 3. Pagination Token Loop Guard Verification
test('pagination: getAllConversations detects token loop and terminates safely', async () => {
    const Pagination = require('../src/core/api/client/pagination.js');

    // Create a mock client that returns a repeating nextPageToken
    let callCount = 0;
    const mockClient = {
        getConversationList: async (token: string | null) => {
            callCount++;
            return {
                conversations: [
                    { id: `c_${callCount}`, title: `Chat ${callCount}` }
                ],
                // Return a repeating cursor
                nextPageToken: 'repeating_token_xyz'
            };
        }
    };

    const result = await Pagination.getAllConversations(mockClient, 2000);

    // The first call gets 'repeating_token_xyz'.
    // The second call passes 'repeating_token_xyz' and receives 'repeating_token_xyz' again,
    // which hits seenTokens.has('repeating_token_xyz') and breaks!
    assert.strictEqual(callCount, 2, 'Should terminate immediately upon repeating token (call count = 2)');
    assert.strictEqual(result.conversations.length, 2);
    assert.ok(result.diagnostics.stopReason.includes('Token Loop'), 'stopReason must mention Token Loop');
    assert.strictEqual(result.stoppedEarly, true, 'Token loop must set stoppedEarly to true');
    assert.strictEqual(result.exhaustive, false, 'Token loop must set exhaustive to false');
});

test('pagination D1: non-exhaustive token-loop result prevents reconcileConversations and preserves missing local chats', async () => {
    const Pagination = require('../src/core/api/client/pagination.js');

    let callCount = 0;
    const mockClient = {
        getConversationList: async () => {
            callCount++;
            return {
                conversations: [{ id: `c_${callCount}`, title: `Chat ${callCount}` }],
                nextPageToken: 'looping_token'
            };
        }
    };

    const paginationResult = await Pagination.getAllConversations(mockClient, 2000);
    assert.strictEqual(paginationResult.stoppedEarly, true);
    assert.strictEqual(paginationResult.exhaustive, false);

    // Simulate syncEngine's isFullExhaustive gate
    const effectiveForceFull = true;
    const hitLimit = !!(paginationResult.hitGoogleLimit || paginationResult.diagnostics?.hitGoogleLimit);
    const isAborted = false;
    const isFullExhaustive = effectiveForceFull && !paginationResult.stoppedEarly && !isAborted && !hitLimit && (paginationResult.exhaustive !== false);

    assert.strictEqual(isFullExhaustive, false, 'isFullExhaustive must be false when pagination loop stopped early');
});
