import test from 'node:test';
import assert from 'node:assert/strict';
import { useIndexStorage } from './helpers/indexStorage.js';
import { ingestIndexes } from '../src/l2/ingestion.js';
import { getIndex, getCoverage, updateCoverageAtomically } from '../src/l3a/storageService.js';
const accountId = '10000000-0000-4000-8000-000000000001';
const key = { accountId, conversationId: 'chat' };
useIndexStorage();

test('a local observation preserves server timestamp on an existing index', async () => {
    await ingestIndexes(accountId, [{ conversationId: 'chat', fields: { updatedAt: 1700000000000 } }]);
    await ingestIndexes(accountId, [{ conversationId: 'chat', fields: {} }]);
    const index = await getIndex(key); assert.equal(index?.updatedAt, 1700000000000);
    assert.equal(Object.hasOwn(index!, 'sidebarIndex'), false); assert.equal(Object.hasOwn(index!, 'lastSeen'), false);
});
test('an unknown observed conversation creates an index without client timestamp', async () => {
    await ingestIndexes(accountId, [{ conversationId: 'chat', fields: {} }]);
    assert.deepEqual(await getIndex(key), { key });
});
test('an observation without reliable page evidence never moves Recent Coverage', async () => {
    const coverage = { range: { head: { id: 'head', time: 20 }, tail: { id: 'tail', time: 10 } } };
    await updateCoverageAtomically(accountId, 'recent', () => ({ next: coverage, result: undefined }));
    await ingestIndexes(accountId, [{ conversationId: 'chat', fields: { updatedAt: 30 } }]);
    assert.deepEqual(await getCoverage(accountId, 'recent'), coverage);
});
