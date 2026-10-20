/**
 * W3: pagination.ts getConversationDetail message dedupe root-cause fix.
 * The old `seenMsgIds` bypass let any message whose id equals the conversation
 * id skip dedupe permanently, so a repeated page (token loop / re-fetch)
 * duplicated turns in the source data itself (markdown/JSON/HTML all affected).
 * Rule after fix: a stable non-empty message id is accepted exactly once,
 * regardless of whether it equals the conversation id; id-less messages are
 * still kept (no risky content hashing).
 *
 * 运行：node -r ./tests/ts_register.js --test tests/pagination_detail_dedupe.test.ts
 */
export {};
const test = require('node:test');
const assert = require('node:assert');

const Pagination = require('../src/core/api/client/pagination.js');

function makeClient(pages: any[]): any {
    let calls = 0;
    return {
        fetchConversationPage: async (_cid: string, _token: string | null) => {
            const p = pages[Math.min(calls++, pages.length - 1)];
            return p;
        },
    };
}

test('W3-case1: message id equal to conversation id is deduped across pages (appears once)', async () => {
    const convId = 'c_det1';
    const client = makeClient([
        { messages: [{ id: convId, role: 'user', content: 'q' }, { id: 'rc_a', role: 'model', content: 'a' }], nextPageToken: 't1', title: 'T' },
        // Server repeats the same first-turn user message on page 2.
        { messages: [{ id: convId, role: 'user', content: 'q' }, { id: 'rc_b', role: 'model', content: 'b' }], nextPageToken: null, title: 'T' },
    ]);
    const res = await Pagination.getConversationDetail(client, convId);
    const ids = (res.messages as any[]).map((m: any) => m.id);
    assert.deepStrictEqual(ids, ['rc_b', convId, 'rc_a'], `convId message leaked a duplicate: ${JSON.stringify(ids)}`);
});

test('W3-case2: ordinary repeated message ids appear exactly once', async () => {
    const client = makeClient([
        { messages: [{ id: 'm1' }, { id: 'm2' }], nextPageToken: 't1', title: 'T' },
        { messages: [{ id: 'm2' }, { id: 'm3' }], nextPageToken: null, title: 'T' },
    ]);
    const res = await Pagination.getConversationDetail(client, 'c_det2');
    const ids = (res.messages as any[]).map((m: any) => m.id);
    assert.deepStrictEqual(ids, ['m3', 'm1', 'm2'], `duplicate message leaked: ${JSON.stringify(ids)}`);
});

test('W3-case3: id-less messages are kept, never content-deduped', async () => {
    const client = makeClient([
        { messages: [{ role: 'user', content: 'same text' }, { id: '', role: 'model', content: 'same text' }], nextPageToken: 't1', title: 'T' },
        { messages: [{ role: 'user', content: 'same text' }], nextPageToken: null, title: 'T' },
    ]);
    const res = await Pagination.getConversationDetail(client, 'c_det3');
    assert.strictEqual((res.messages as any[]).length, 3, 'id-less messages must be preserved');
});
