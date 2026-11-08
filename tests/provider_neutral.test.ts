import test from 'node:test';
import assert from 'node:assert/strict';
import { useIndexStorage } from './helpers/indexStorage.js';
import { ACCOUNT_UUID } from './helpers/accountRuntime.js';
import { sourceDetail, sourceList } from './helpers/l1SourceFixture.js';
import { GeminiProvider } from '../src/l1/client/gemini/geminiProvider.js';
import { listIndexes as getConversations } from '../src/l3a/storageService.js';
import type { CommittedListPage } from '../src/l1/client/aiProvider.js';
useIndexStorage();

test('neutral listing returns ListEnd and callbacks contain committed progress only', async () => {
    const pages = [sourceList('G_SOURCE_ONE_MORE_01'), sourceList('G_SOURCE_TWO_01')];
    const provider = new GeminiProvider({ getConversationList: async () => pages.shift()!, getConversationDetail: async () => sourceDetail() }, async () => 'u0');
    const seen: CommittedListPage[] = [];
    const result = await provider.listConversations({ accountId: ACCOUNT_UUID, streamId: 'recent', onPageCommitted: async info => {
        seen.push(info); assert.equal((await getConversations(ACCOUNT_UUID)).length, info.totalObserved); return false;
    } });
    assert.equal(result, 'source_end'); assert.deepEqual(seen.map(p => p.totalObserved), [1, 2]);
    assert.equal('items' in seen[0], false); assert.equal('nextCursor' in seen[0], false);
});
test('neutral Detail has explicit Account/Conversation and routes internally', async () => {
    const routed: string[] = [];
    const provider = new GeminiProvider({ getConversationList: async () => sourceList('G_SOURCE_EMPTY_01'), getConversationDetail: async (id, slot, account) => {
        assert.equal(account?.id, ACCOUNT_UUID); routed.push(slot!); return sourceDetail({ id });
    } }, async accountId => { assert.equal(accountId, ACCOUNT_UUID); return 'u3'; });
    assert.equal(await provider.fetchConversationDetail(ACCOUNT_UUID, 'conversation9'), undefined);
    assert.deepEqual(routed, ['u3']);
});
test('neutral callback requests stop using a boolean after admission', async () => {
    let calls = 0;
    const provider = new GeminiProvider({ getConversationList: async () => { calls++; return sourceList('G_SOURCE_ONE_MORE_01'); }, getConversationDetail: async () => sourceDetail() }, async () => 'u0');
    assert.equal(await provider.listConversations({ accountId: ACCOUNT_UUID, streamId: 'recent', onPageCommitted: async () => true }), 'stopped');
    assert.equal(calls, 1); assert.equal((await getConversations(ACCOUNT_UUID)).length, 1);
});
