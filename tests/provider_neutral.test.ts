export {};
const test = require('node:test');
const assert = require('node:assert');

const { GeminiProvider } = require('../src/core/provider/gemini/geminiProvider.js');

function makeGeminiClient() {
    return {
        getAllConversations: async (_opts: any) => ({
            conversations: [{
                id: 'c1', title: 'T1', titleSource: 'api-list', titles: { rpc: 'T1' },
                createdAt: 1, updatedAt: 2, chatTime: 2, timestamp: 2, messageCount: 3, url: 'u'
            }],
            total: 1, stoppedEarly: true, diagnostics: { d: 1 }, hitGoogleLimit: false
        }),
        getConversationDetail: async (id: string, _sid: any) => ({
            id, title: 'DT', titleSource: 'api-detail', titles: { rpc: 'DT' },
            messages: [{ role: 'user', content: 'hi' }],
            createdAt: 1, chatTime: 1, timestamp: 1, updatedAt: 1,
            url: 'u2', nextPageToken: null, attachmentCount: 0
        })
    };
}

test('provider-neutral - GeminiProvider.listConversations maps to ProviderPageResult', async () => {
    const gp = new GeminiProvider(makeGeminiClient() as any);
    const page = await gp.listConversations({ maxPages: 5 });
    assert.strictEqual(page.items.length, 1);
    assert.strictEqual(page.items[0].id, 'c1');
    assert.strictEqual(page.items[0].title, 'T1');
    assert.strictEqual(page.total, 1);
    assert.strictEqual(page.hasMore, true); // stoppedEarly=true -> more may exist
    assert.strictEqual(page.nextCursor, null);
    assert.deepStrictEqual(page.diagnostics, { d: 1, hitGoogleLimit: false });

    const gp2 = new GeminiProvider({
        getAllConversations: async () => ({ conversations: [], total: 0, stoppedEarly: false, diagnostics: null, hitGoogleLimit: false })
    } as any);
    const page2 = await gp2.listConversations();
    assert.strictEqual(page2.hasMore, false); // exhausted -> no more
    assert.strictEqual(page2.items.length, 0);
});

test('provider-neutral - GeminiProvider.fetchConversationDetail guarantees id/title/messages', async () => {
    const gp = new GeminiProvider(makeGeminiClient() as any);
    const det = await gp.fetchConversationDetail('c9', { slot: 'u1' });
    assert.strictEqual(det.id, 'c9');
    assert.strictEqual(det.title, 'DT');
    assert.strictEqual(det.messages.length, 1);
    assert.strictEqual(det.nextPageToken, null); // extra Gemini fields preserved via spread
});
