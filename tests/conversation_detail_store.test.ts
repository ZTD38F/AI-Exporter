export {};
const test = require('node:test');
const assert = require('node:assert');
const {
    getConversationDetail,
    saveConversationDetail,
    saveConversationDetailsBatch,
    removeConversationDetails,
    hasConversationDetail,
    clearAllDetails,
    ConversationDetailStore,
    __clearMemoryStore
} = require('../src/core/storage/conversationDetailStore.js');

test.beforeEach(() => {
    __clearMemoryStore();
});

test('conversation_detail_store - save and get single conversation detail', async () => {
    const detail = {
        messages: [
            { id: 'm1', role: 'user', content: 'Hello' },
            { id: 'm2', role: 'model', content: 'World' }
        ],
        turns: [
            { user: 'Hello', model: 'World' }
        ],
        updatedAt: 1700000000000
    };

    const saved = await saveConversationDetail('chat_1', detail);
    assert.strictEqual(saved, true);

    const retrieved = await getConversationDetail('chat_1');
    assert.ok(retrieved);
    assert.strictEqual(retrieved.id, 'chat_1');
    assert.strictEqual(retrieved.messages.length, 2);
    assert.strictEqual(retrieved.messages[0].content, 'Hello');
    assert.strictEqual(retrieved.turns.length, 1);
    assert.strictEqual(retrieved.updatedAt, 1700000000000);
    assert.ok(typeof retrieved.savedAt === 'number');

    // canonical normId probe ('c_chat_1' -> 'chat_1')
    const byAlias = await getConversationDetail('c_chat_1');
    assert.ok(byAlias);
    assert.strictEqual(byAlias.id, 'chat_1');
});

test('conversation_detail_store - batch save details from array and record map', async () => {
    // Array format
    await saveConversationDetailsBatch([
        { id: 'chat_a', messages: [{ id: 'm1', role: 'user', content: 'Alpha' }] },
        { id: 'chat_b', messages: [{ id: 'm2', role: 'user', content: 'Beta' }] }
    ]);

    assert.strictEqual(await hasConversationDetail('chat_a'), true);
    assert.strictEqual(await hasConversationDetail('chat_b'), true);
    assert.strictEqual(await hasConversationDetail('chat_nonexistent'), false);

    // Record map format
    await saveConversationDetailsBatch({
        'chat_c': { messages: [{ id: 'm3', role: 'user', content: 'Gamma' }] }
    });

    const c = await getConversationDetail('chat_c');
    assert.ok(c);
    assert.strictEqual(c.messages[0].content, 'Gamma');
});

test('conversation_detail_store - remove details and clear', async () => {
    await saveConversationDetailsBatch([
        { id: 'chat_x', messages: [] },
        { id: 'chat_y', messages: [] },
        { id: 'chat_z', messages: [] }
    ]);

    const removedCount = await removeConversationDetails(['chat_x', 'c_chat_y']);
    assert.strictEqual(removedCount, 2);
    assert.strictEqual(await hasConversationDetail('chat_x'), false);
    assert.strictEqual(await hasConversationDetail('chat_y'), false);
    assert.strictEqual(await hasConversationDetail('chat_z'), true);

    await clearAllDetails();
    assert.strictEqual(await hasConversationDetail('chat_z'), false);
});

test('conversation_detail_store - saveConversationDetail monotonic length guard (memory store)', async () => {
    // 1. 存入 4 条消息
    const mkMsgs = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `m${i}`, role: 'user', content: `text ${i}` }));
    await saveConversationDetail('chat_mono_1', {
        messages: mkMsgs(4),
        updatedAt: 1000
    });
    let d = await getConversationDetail('chat_mono_1');
    assert.strictEqual(d?.messages.length, 4);

    // 2. 尝试用更短的 2 条消息覆盖 —— 必须被单调保护拦截（不覆盖现有 4 条）
    const resShort = await saveConversationDetail('chat_mono_1', {
        messages: mkMsgs(2),
        updatedAt: 1050
    });
    assert.strictEqual(resShort, true);
    d = await getConversationDetail('chat_mono_1');
    assert.strictEqual(d?.messages.length, 4, '更短的消息内容不得截断已保存的长内容');

    // 3. 用更长的 6 条消息更新 —— 正常升级覆盖
    const resLong = await saveConversationDetail('chat_mono_1', {
        messages: mkMsgs(6),
        updatedAt: 1100
    });
    assert.strictEqual(resLong, true);
    d = await getConversationDetail('chat_mono_1');
    assert.strictEqual(d?.messages.length, 6, '更长的消息内容应正常升级保存');
});

test('conversation_detail_store - saveConversationDetailsBatch monotonic guard & intra-batch dedup', async () => {
    const mkMsgs = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `m${i}`, role: 'user', content: `text ${i}` }));

    // 1. 批次保存 3 条
    await saveConversationDetailsBatch([
        { id: 'chat_batch_1', messages: mkMsgs(3) }
    ]);
    let d = await getConversationDetail('chat_batch_1');
    assert.strictEqual(d?.messages.length, 3);

    // 2. 批次试图用 1 条截断
    await saveConversationDetailsBatch([
        { id: 'chat_batch_1', messages: mkMsgs(1) }
    ]);
    d = await getConversationDetail('chat_batch_1');
    assert.strictEqual(d?.messages.length, 3, '批次写入不得截断已存在长内容');

    // 3. 同一批次内重复 ID 按最完整者胜出（无论出现顺序）
    await saveConversationDetailsBatch([
        { id: 'chat_batch_intra', messages: mkMsgs(1) },
        { id: 'chat_batch_intra', messages: mkMsgs(5) },
        { id: 'chat_batch_intra', messages: mkMsgs(2) }
    ]);
    d = await getConversationDetail('chat_batch_intra');
    assert.strictEqual(d?.messages.length, 5, '同批次重复项必须保留最长正文');
});

test('conversation_detail_store - mock IndexedDB monotonic detail preservation', async () => {
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
                    createObjectStore: (n: string, opts?: any) => {
                        memoryStores[n] = new Map();
                    },
                    transaction: (storeName: string, mode: string) => {
                        if (!memoryStores[storeName]) memoryStores[storeName] = new Map();
                        const store = memoryStores[storeName];
                        const tx: any = {
                            objectStore: () => ({
                                put: (val: any) => {
                                    store.set(val.id, val);
                                    const putReq: any = { result: val.id };
                                    setTimeout(() => putReq.onsuccess && putReq.onsuccess(), 0);
                                    return putReq;
                                },
                                get: (key: any) => {
                                    const val = store.get(key);
                                    const getReq: any = { result: val ? { ...val } : undefined };
                                    setTimeout(() => getReq.onsuccess && getReq.onsuccess(), 0);
                                    return getReq;
                                }
                            }),
                            oncomplete: null,
                            onerror: null,
                            onabort: null
                        };
                        setTimeout(() => tx.oncomplete && tx.oncomplete(), 20);
                        return tx;
                    },
                    close: () => {}
                }
            };
            setTimeout(() => req.onsuccess && req.onsuccess(), 0);
            return req;
        }
    };

    const origIdb = (global as any).indexedDB;
    (global as any).indexedDB = mockIdb;

    try {
        const mkMsgs = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `m${i}`, role: 'user', content: `text ${i}` }));

        // 1. 在 mock IndexedDB 中保存 5 条消息
        await saveConversationDetail('idb_chat_1', {
            messages: mkMsgs(5),
            updatedAt: 1000
        });

        const store = memoryStores['conversation_details'];
        assert.ok(store);
        assert.strictEqual(store.get('idb_chat_1')?.messages?.length, 5);

        // 2. 尝试用 2 条消息在 IDB 中覆盖 —— 应被单调保护拦截
        await saveConversationDetail('idb_chat_1', {
            messages: mkMsgs(2),
            updatedAt: 1050
        });
        assert.strictEqual(store.get('idb_chat_1')?.messages?.length, 5, 'IDB 写入不得截断已保存的 5 条消息');

        // 3. 批次写入测试：包含 1 个截断尝试与 1 个新会话
        await saveConversationDetailsBatch([
            { id: 'idb_chat_1', messages: mkMsgs(2) },
            { id: 'idb_chat_2', messages: mkMsgs(3) }
        ]);
        assert.strictEqual(store.get('idb_chat_1')?.messages?.length, 5, '批次写入不得截断现有长记录');
        assert.strictEqual(store.get('idb_chat_2')?.messages?.length, 3, '新记录应正常写入 IDB');
    } finally {
        (global as any).indexedDB = origIdb;
    }
});

