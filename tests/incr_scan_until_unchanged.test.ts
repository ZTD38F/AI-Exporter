import test from 'node:test';
import assert from 'node:assert/strict';
import { useIndexStorage } from './helpers/indexStorage.js';
import { ACCOUNT_UUID } from './helpers/accountRuntime.js';
import { sourceDetail, sourceList } from './helpers/l1SourceFixture.js';
import { GeminiProvider } from '../src/l1/client/gemini/geminiProvider.js';
import { listIndexes as getConversations } from '../src/l3a/storageService.js';
useIndexStorage();
test('without a caller stop the Client commits all three pages and reports source_end', async () => {
    let calls = 0;
    const provider = new GeminiProvider({ getConversationList: async () => {
        const page = calls++;
        return sourceList(`G_SOURCE_150_PAGE_${page + 1}`);
    }, getConversationDetail: async () => sourceDetail() }, async () => 'u0');
    const counts: number[] = [];
    assert.equal(await provider.listConversations({ accountId: ACCOUNT_UUID, streamId: 'recent', onPageCommitted: async info => { counts.push(info.totalObserved); return false; } }), 'source_end');
    assert.equal(calls, 3); assert.deepEqual(counts, [50, 100, 150]);
    assert.equal((await getConversations(ACCOUNT_UUID)).length, 150);
});
