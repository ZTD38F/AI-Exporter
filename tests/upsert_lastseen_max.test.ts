import test from 'node:test';
import assert from 'node:assert/strict';
import { useIndexStorage } from './helpers/indexStorage.js';
import { ingestIndexes } from '../src/l2/ingestion.js';
import { getIndex } from '../src/l3a/storageService.js';
useIndexStorage();
const accountId = '10000000-0000-4000-8000-000000000001';
test('local observation time never enters an existing or new index', async () => {
    for (const [id, previous] of [['new', undefined], ['existing', 1000]] as const) {
        const key = { accountId, conversationId: id };
        if (previous) await ingestIndexes(accountId, [{ conversationId: id, fields: { updatedAt: previous } }]);
        await ingestIndexes(accountId, [{ conversationId: id, fields: { updatedAt: 900 } }]);
        const index = await getIndex(key); assert.equal(index?.updatedAt, previous ?? 900);
        assert.equal(Object.hasOwn(index!, 'lastSeen'), false); assert.equal(Object.hasOwn(index!, 'timestamp'), false);
        await assert.rejects(ingestIndexes(accountId, [{ conversationId: id, fields: { lastSeen: '2099-01-01' } as never }]), /Invalid conversation index schema/);
        assert.equal((await getIndex(key))?.updatedAt, previous ?? 900);
    }
});
test('an observation without authored time stays undated', async () => {
    await ingestIndexes(accountId, [{ conversationId: 'undated', fields: {} }]);
    const index = await getIndex({ accountId, conversationId: 'undated' });
    assert.equal(index?.updatedAt, undefined); assert.equal(index?.createdAt, undefined);
});
