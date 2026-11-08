import { geminiRpcPacket } from './fixtures/providers/geminiRpcCapture.js';
import { parseList } from '../src/l1/parsers/gemini/rpc/parseList.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { useIndexStorage } from './helpers/indexStorage.js';
import { ACCOUNT_UUID } from './helpers/accountRuntime.js';
import { sourceDetail, sourceList } from './helpers/l1SourceFixture.js';
import { GeminiProvider } from '../src/l1/client/gemini/geminiProvider.js';
import { getCoverage } from '../src/l2/coverageAdmission.js';
useIndexStorage();

test('each Client call acquires exactly its requested stream with independent cursors', async () => {
    const pages = [sourceList('G_SOURCE_SHARED_CURSOR_01'), sourceList('G_SOURCE_EMPTY_01'), sourceList('G_SOURCE_SHARED_CURSOR_01'), sourceList('G_SOURCE_RECENT_01')];
    const requests: unknown[] = [];
    const provider = new GeminiProvider({ getConversationList: async (cursor, _slot, filter) => { requests.push([cursor, filter]); return pages.shift()!; }, getConversationDetail: async () => sourceDetail() }, async () => 'u0');
    for (const streamId of ['pinned', 'recent']) assert.equal(await provider.listConversations({ accountId: ACCOUNT_UUID, streamId }), 'source_end');
    assert.deepEqual(requests, [[null, [1, null, 1]], ['tC_same_token_123456789', [1, null, 1]], [null, undefined], ['tC_same_token_123456789', undefined]]);
    assert.ok(await getCoverage(ACCOUNT_UUID, 'pinned'));
    assert.ok(await getCoverage(ACCOUNT_UUID, 'recent'));
});
test('recent acquisition never implicitly fetches pinned or establishes its coverage', async () => {
    const provider = new GeminiProvider({ getConversationList: async (_cursor, _slot, filter) => { assert.equal(filter, undefined); return sourceList('G_SOURCE_EMPTY_01'); }, getConversationDetail: async () => sourceDetail() }, async () => 'u0');
    assert.equal(await provider.listConversations({ accountId: ACCOUNT_UUID, streamId: 'recent' }), 'source_end');
    assert.equal(await getCoverage(ACCOUNT_UUID, 'pinned'), null);
});
test('unknown stream is rejected before network acquisition', async () => {
    const provider = new GeminiProvider({ getConversationList: async () => { assert.fail('unexpected request'); }, getConversationDetail: async () => sourceDetail() }, async () => 'u0');
    await assert.rejects(provider.listConversations({ accountId: ACCOUNT_UUID, streamId: 'all' }), /stream/);
});

test('real empty pinned response commits pinned coverage without recent coverage', async () => {
    const provider = new GeminiProvider({
        getConversationList: async (cursor, _slot, filter) => {
            assert.equal(cursor, null);
            assert.deepEqual(filter, [1, null, 1]);
            return parseList(geminiRpcPacket('pinned').responseBody);
        },
        getConversationDetail: async () => sourceDetail(),
    }, async () => 'u0');
    assert.equal(await provider.listConversations({ accountId: ACCOUNT_UUID, streamId: 'pinned' }), 'source_end');
    assert.ok(await getCoverage(ACCOUNT_UUID, 'pinned'));
    assert.equal(await getCoverage(ACCOUNT_UUID, 'recent'), null);
});
