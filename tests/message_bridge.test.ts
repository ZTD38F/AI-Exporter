export {};

const test = require('node:test');
const assert = require('node:assert');
const MessageBridge = require('../src/content/messageBridge.js');
const paginationMod = require('../src/core/api/client/pagination.js');
const retryPolicyMod = require('../src/core/api/client/retryPolicy.js');
const rpcClientMod = require('../src/core/api/client/rpcClient.js');

test('messageBridge - init returns API with handleWindowMessage', () => {
    const api = MessageBridge.init();
    assert.strictEqual(typeof api.handleWindowMessage, 'function', 'init should return handleWindowMessage');
});

test('messageBridge - ignores falsy or non-object events', async () => {
    let upsertCalled = false;
    const api = MessageBridge.init({
        upsertConversations: async () => { upsertCalled = true; }
    });
    await api.handleWindowMessage(null);
    await api.handleWindowMessage({});
    assert.strictEqual(upsertCalled, false, 'should ignore invalid event data');
});

test('messageBridge - handles GEMINI_CONVERSATION_DELETED', async () => {
    let removedId: any = null;
    let badgeUpdated = false;
    const api = MessageBridge.init({
        Storage: {
            removeConversation: async (_slot: any, id: any) => {
                removedId = id;
                return true;
            },
            getConversations: async () => [{ id: 'c_remaining' }]
        },
        updateBadge: () => { badgeUpdated = true; },
        getAccountSlot: () => 'u0'
    });

    await api.handleWindowMessage({
        origin: typeof location !== 'undefined' ? location.origin : undefined,
        data: {
            type: 'GEMINI_CONVERSATION_DELETED',
            payload: { id: 'c_test_del', slot: 'u0' }
        }
    });

    assert.strictEqual(removedId, 'c_test_del', 'should remove conversation from storage');
    assert.strictEqual(badgeUpdated, true, 'should update badge after deletion');
});

test('messageBridge - rejects forged postMessage from foreign source', async () => {
    let forgedRemovedId: any = null;
    const fakeWindow = { name: 'top-window' };
    const oldWindow = (global as any).window;
    try {
        (global as any).window = fakeWindow;
        const api = MessageBridge.init({
            Storage: {
                removeConversation: async (_slot: any, id: any) => {
                    forgedRemovedId = id;
                    return true;
                }
            },
            getAccountSlot: () => 'u0'
        });

        // Foreign source rejected
        await api.handleWindowMessage({
            source: { name: 'iframe-window' },
            data: {
                type: 'GEMINI_CONVERSATION_DELETED',
                payload: { id: 'c_forged_del', slot: 'u0' }
            }
        });
        assert.strictEqual(forgedRemovedId, null, 'should reject postMessage from foreign source');

        // Window source accepted
        await api.handleWindowMessage({
            source: fakeWindow,
            data: {
                type: 'GEMINI_CONVERSATION_DELETED',
                payload: { id: 'c_valid_del', slot: 'u0' }
            }
        });
        assert.strictEqual(forgedRemovedId, 'c_valid_del', 'should accept postMessage when source is window');
    } finally {
        (global as any).window = oldWindow;
    }
});

test('client - getAllConversations respects opts.signal', async () => {
    const controller = new AbortController();
    controller.abort();

    const mockClient = {
        aborted: false,
        isAborted: () => false,
        getConversationList: async () => {
            return { conversations: [{ id: 'c_1', title: 'Chat 1' }], nextPageToken: 'tC_2' };
        }
    };

    const res = await paginationMod.getAllConversations(mockClient as any, {
        maxPages: 10,
        signal: controller.signal
    });

    assert.strictEqual(res.conversations.length, 0, 'Should abort immediately when opts.signal is aborted');
    assert.ok(res.diagnostics.stopReason.includes('终止'), 'Stop reason should indicate aborted');
});

test('client - retryPolicy.handleHttp429 returns structured backoff metadata', async () => {
    const mockResp = {
        status: 429,
        headers: {
            get: (h: string) => (h.toLowerCase() === 'retry-after' ? '0' : null)
        }
    };

    const exceeded = await retryPolicyMod.handleHttp429({
        resp: mockResp as any,
        retryCount: 3,
        maxRetries: 3
    });
    assert.strictEqual(exceeded.shouldRetry, false);
});

test('client - rpcClient.getApiUrl handles both u0/u1 and /u/0 formats', () => {
    assert.strictEqual(rpcClientMod.getApiUrl('default'), 'https://gemini.google.com/_/BardChatUi/data/batchexecute');
    assert.strictEqual(rpcClientMod.getApiUrl('u1'), 'https://gemini.google.com/u/1/_/BardChatUi/data/batchexecute');
});

test('messageBridge - handles GEMINI_STREAM_GENERATE_START and GEMINI_STREAM_GENERATE_COMPLETE', async () => {
    let startedId: string | null = null;
    let completedId: string | null = null;
    let completedSlot: string | null = null;

    const api = MessageBridge.init({
        onStreamStart: (cid: any) => { startedId = cid; },
        onStreamComplete: (cid: any, slot: any) => { completedId = cid; completedSlot = slot; }
    });

    await api.handleWindowMessage({
        data: {
            type: 'GEMINI_STREAM_GENERATE_START',
            payload: { id: 'c_abc123', slot: 'u0' }
        }
    });
    assert.strictEqual(startedId, 'c_abc123');

    await api.handleWindowMessage({
        data: {
            type: 'GEMINI_STREAM_GENERATE_COMPLETE',
            payload: { id: 'c_abc123', slot: 'u0' }
        }
    });
    assert.strictEqual(completedId, 'c_abc123');
    assert.strictEqual(completedSlot, 'u0');
});

test('messageBridge - touches active conversation and updates timestamp on stream start & complete', async () => {
    const touchedCalls: any[] = [];
    const api = MessageBridge.init({
        touchActiveConversation: async (cid: string, slot?: string, options?: any) => {
            touchedCalls.push({ cid, slot, options });
            return 1;
        }
    });

    await api.handleWindowMessage({
        data: {
            type: 'GEMINI_STREAM_GENERATE_START',
            payload: { id: 'c_active_old_chat', slot: 'u1' }
        }
    });

    assert.strictEqual(touchedCalls.length, 1);
    assert.strictEqual(touchedCalls[0].cid, 'active_old_chat');
    assert.strictEqual(touchedCalls[0].slot, 'u1');
    assert.strictEqual(touchedCalls[0].options?.source, 'stream-start');

    await api.handleWindowMessage({
        data: {
            type: 'GEMINI_STREAM_GENERATE_COMPLETE',
            payload: { id: 'c_active_old_chat', slot: 'u1' }
        }
    });

    assert.strictEqual(touchedCalls.length, 2);
    assert.strictEqual(touchedCalls[1].cid, 'active_old_chat');
    assert.strictEqual(touchedCalls[1].slot, 'u1');
    assert.strictEqual(touchedCalls[1].options?.source, 'stream-complete');
});

test('messageBridge - fallback to upsertConversations with updated timestamp when touchActiveConversation omitted', async () => {
    let upsertedItems: any[] = [];
    let upsertedSource = '';
    let upsertedForceWrite = false;
    let upsertedSlot = '';

    const api = MessageBridge.init({
        upsertConversations: async (items: any[], source: string, forceWrite?: boolean, targetSlot?: string) => {
            upsertedItems = items;
            upsertedSource = source;
            upsertedForceWrite = !!forceWrite;
            upsertedSlot = targetSlot || '';
            return items.length;
        },
        extractActiveChatTitle: (_id: string) => ({ title: 'Updated In-Page Title', source: 'dom' })
    });

    const before = Date.now();
    await api.handleWindowMessage({
        data: {
            type: 'GEMINI_STREAM_GENERATE_COMPLETE',
            payload: { id: 'c_active_fallback', slot: 'u0' }
        }
    });
    const after = Date.now();

    assert.strictEqual(upsertedItems.length, 1);
    assert.strictEqual(upsertedItems[0].id, 'active_fallback');
    assert.strictEqual(upsertedItems[0].title, 'Updated In-Page Title');
    assert.strictEqual(upsertedItems[0].titleSource, 'dom');
    assert.strictEqual(upsertedItems[0].sidebarIndex, 0);
    assert.ok(upsertedItems[0].updatedAt >= before && upsertedItems[0].updatedAt <= after, 'updatedAt must be fresh timestamp');
    assert.ok(upsertedItems[0].timestamp >= before && upsertedItems[0].timestamp <= after, 'timestamp must be fresh timestamp');
    assert.strictEqual(upsertedSource, 'stream-complete');
    assert.strictEqual(upsertedForceWrite, true, 'forceWrite must be true to ensure persistence');
    assert.strictEqual(upsertedSlot, 'u0');
});

