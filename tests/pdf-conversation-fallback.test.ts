export {};
const test = require('node:test');
const assert = require('node:assert/strict');
const { preparePdfItem, PDF_NO_MESSAGES } = require('../src/core/export/pdf/prepareItem.js');
const { resolveConversationData } = require('../src/core/engine/export/batchWorker.js');
const store = require('../src/core/storage/conversationDetailStore.js');
const message = (text: string) => ({ id: 'm1', role: 'model', content: text });

test('PDF successful empty online response recovers Takeout messages before normalization', async () => {
    const result = await preparePdfItem({ id: 'fallback' }, {
        includeAssets: false,
        fetchChatDetail: async () => ({ success: true, results: [{ messages: [] }] }),
        takeoutEngine: { getTakeoutOfflineChat: () => ({ messages: [message('Recovered Takeout')] }) },
    });
    assert.equal(result.ok, true);
    assert.match(JSON.stringify(result.bundle), /Recovered Takeout/);
});

test('shared acquisition prefers online and uses cache only after unusable Takeout', async () => {
    let calls = 0;
    const takeout = { getTakeoutOfflineChat: () => { calls++; return { messages: [] }; } };
    const online = { messages: [message('online')] };
    assert.equal(await resolveConversationData(online, 'fallback', null, takeout), online);
    assert.equal(calls, 0);
    await store.saveConversationDetail('fallback', { messages: [message('cache')] });
    try {
        const recovered = await resolveConversationData({ messages: [] }, 'fallback', null, takeout);
        assert.equal(recovered.messages[0].content, 'cache');
        const pdf = await preparePdfItem({ id: 'fallback' }, {
            includeAssets: false, takeoutEngine: takeout,
            fetchChatDetail: async () => ({ success: false, error: 'offline' }),
        });
        assert.equal(pdf.ok, true);
        assert.match(JSON.stringify(pdf.bundle), /cache/);
    } finally { store.__clearMemoryStore(); }
});

test('PDF reports no messages only after all sources fail', async () => {
    const result = await preparePdfItem({ id: 'missing' }, {
        includeAssets: false,
        fetchChatDetail: async () => ({ success: true, results: [{ messages: [] }] }),
        takeoutEngine: { getTakeoutOfflineChat: () => null },
    });
    assert.equal(result.ok, false);
    assert.match(result.error, new RegExp(PDF_NO_MESSAGES));
});
