import test from 'node:test';
import assert from 'node:assert/strict';
import { useIndexStorage } from './helpers/indexStorage.js';
import { ingestIndexes } from '../src/l2/ingestion.js';
import { getIndex, listIndexes } from '../src/l3a/storageService.js';
import { mergeConversationIndex } from '../src/l2/conversationIndex.js';
import { conversationKey } from '../src/l2/conversationKey.js';
import { makeConversationIndex } from './helpers/conversationIndexFixture.js';
useIndexStorage();
const accountId = '10000000-0000-4000-8000-000000000001';
const key = (id: string) => conversationKey(accountId, id);

test('Domain ingestIndexes patches only the target record and rejects missing identities', async () => {
    await ingestIndexes(accountId, ['first', 'second', 'third'].map(conversationId => ({ conversationId, fields: { title: conversationId, titleSource: 'provider' } })));
    await ingestIndexes(accountId, [{ conversationId: 'first', fields: { title: 'New title', titleSource: 'provider', updatedAt: 10 } }]);
    assert.equal((await getIndex(key('first')))?.title, 'New title');
    assert.equal((await getIndex(key('first')))?.updatedAt, 10);
    assert.equal((await getIndex(key('second')))?.title, 'second');
    assert.equal((await getIndex(key('third')))?.title, 'third');
    await assert.rejects(ingestIndexes(accountId, [{ conversationId: '', fields: { title: 'X', titleSource: 'provider' } }]), /Invalid conversation key/);
    assert.equal((await listIndexes(accountId)).length, 3);
});
test('mergeConversationIndex keeps source updatedAt monotonic and earliest createdAt', () => {
    const previous = makeConversationIndex({ key: key('monotonic'), title: 'Before', titleSource: 'provider', updatedAt: 1700000050000, createdAt: 1700000000000 });
    const older = mergeConversationIndex(previous, makeConversationIndex({ key: previous.key, title: 'Old RPC', titleSource: 'provider', updatedAt: 1700000010000, createdAt: 1700000005000 }));
    assert.equal(older.updatedAt, previous.updatedAt); assert.equal(older.createdAt, previous.createdAt);
    const newer = mergeConversationIndex(previous, makeConversationIndex({ key: previous.key, title: undefined, titleSource: undefined, updatedAt: 1700000090000, createdAt: 1699999990000 }));
    assert.equal(newer.updatedAt, 1700000090000); assert.equal(newer.createdAt, 1699999990000);
});
test('overlapping ingestIndexes transactions preserve both independent changes', async () => {
    await ingestIndexes(accountId, [{ conversationId: 'first', fields: { title: 'Before', titleSource: 'provider' } }, { conversationId: 'second', fields: { title: 'Independent', titleSource: 'provider' } }]);
    // Both calls reach native IDB before either is awaited; no mock read/modify/write queue.
    await Promise.all([
        ingestIndexes(accountId, [{ conversationId: 'first', fields: { title: 'After', titleSource: 'provider' } }]),
        ingestIndexes(accountId, [{ conversationId: 'second', fields: { updatedAt: 7 } }]),
    ]);
    assert.equal((await getIndex(key('first')))?.title, 'After');
    assert.equal((await getIndex(key('second')))?.updatedAt, 7);
    assert.equal((await getIndex(key('second')))?.title, 'Independent');
    assert.equal((await listIndexes(accountId)).length, 2);
});
