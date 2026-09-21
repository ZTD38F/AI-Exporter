export {};
const test = require('node:test');
const assert = require('node:assert');

const { getConversationDetail } = require('../src/core/api/client/pagination.js');

function page(messageId: string, timestamp: number, nextPageToken: string | null) {
    return {
        id: 'c_integrity_test',
        title: 'Integrity Test',
        titleSource: 'rpc',
        titles: { rpc: 'Integrity Test' },
        messages: [{
            id: messageId,
            role: 'user',
            content: messageId,
            timestamp,
            attachmentCount: 0
        }],
        createdAt: timestamp,
        chatTime: timestamp,
        timestamp,
        updatedAt: timestamp,
        url: 'https://gemini.google.com/app/integrity_test',
        nextPageToken,
        attachmentCount: 0
    };
}

test('detail pagination - exports beyond the legacy 20-page ceiling and proves completion', async () => {
    const totalPages = 25;
    let calls = 0;

    const client = {
        fetchConversationPage: async (_conversationId: string, token: string | null) => {
            const index = token ? Number(token.slice(1)) : 0;
            calls++;
            const next = index + 1 < totalPages ? `p${index + 1}` : null;
            return page(`m-${index}`, 1_700_000_000_000 + index, next);
        }
    };

    const result = await getConversationDetail(client, 'integrity_test');

    assert.strictEqual(calls, totalPages);
    assert.strictEqual(result.messages.length, totalPages);
    assert.strictEqual(result.pagination.complete, true);
    assert.strictEqual(result.pagination.pagesFetched, totalPages);
    assert.strictEqual(result.pagination.stopReason, 'end_of_history');
    assert.strictEqual(result.pagination.remainingToken, null);
    assert.strictEqual(result.nextPageToken, null);
});

test('detail pagination - token loop is explicit and never reported as complete', async () => {
    let calls = 0;
    const client = {
        fetchConversationPage: async (_conversationId: string, token: string | null) => {
            calls++;
            if (!token) return page('m-0', 1_700_000_000_000, 'loop-token');
            return page('m-1', 1_700_000_000_001, 'loop-token');
        }
    };

    const result = await getConversationDetail(client, 'integrity_test');

    assert.strictEqual(calls, 2, 'cursor loops must terminate immediately');
    assert.strictEqual(result.messages.length, 2);
    assert.strictEqual(result.pagination.complete, false);
    assert.strictEqual(result.pagination.stopReason, 'token_loop');
    assert.strictEqual(result.pagination.remainingToken, 'loop-token');
    assert.strictEqual(result.nextPageToken, 'loop-token');
});
