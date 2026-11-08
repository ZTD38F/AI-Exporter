import test from 'node:test';
import assert from 'node:assert/strict';
import { useIndexStorage } from './helpers/indexStorage.js';
import { ACCOUNT_UUID } from './helpers/accountRuntime.js';
import { ingestIndexes } from '../src/l2/ingestion.js';
import { listIndexes } from '../src/l3a/storageService.js';
import { parseGeminiIndexObservation } from '../src/l1/parsers/gemini/parseIndexObservation.js';
import { listGen as geminiListGen } from './fixtures/providers/gemini.js';
import { parseList } from '../src/l1/parsers/gemini/rpc/parseList.js';
useIndexStorage();
const observation = (id: string, updatedAt: number, title: string) => ({ id, updatedAt, title, titleSource: 'rpc' });

test('active and passive source observations produce identical Index facts without timestampSource', async () => {
    for (const source of ['rpc-list', 'detail'] as const) {
        const candidate = parseGeminiIndexObservation(observation('chat_identity', 1000, 'Same title'), source);
        await ingestIndexes(ACCOUNT_UUID, [candidate]);
        assert.deepEqual(await listIndexes(ACCOUNT_UUID), [{ key: { accountId: ACCOUNT_UUID, conversationId: 'chat_identity' },
            title: 'Same title', titleSource: 'provider', updatedAt: 1000 }]);
    }
});
test('equal-version and newer observations merge through the same L2 owner without persisting source metadata', async () => {
    const admit = async (updatedAt: number, title: string, source: 'rpc-list' | 'detail', messageCount: number) => {
        await ingestIndexes(ACCOUNT_UUID, [parseGeminiIndexObservation({ ...observation('chat_merge', updatedAt, title), messageCount }, source)]);
    };
    await admit(1000, 'Old Title', 'rpc-list', 2);
    const original = await listIndexes(ACCOUNT_UUID);
    await admit(1000, 'Old Title', 'detail', 5);
    assert.deepEqual(await listIndexes(ACCOUNT_UUID), original);
    await admit(2000, 'New Title', 'rpc-list', 5);
    const [index] = await listIndexes(ACCOUNT_UUID);
    assert.equal(index.updatedAt, 2000); assert.equal(index.title, 'New Title');
    assert.equal(Object.hasOwn(index, 'messageCount'), false);
    assert.equal(Object.hasOwn(index, 'timestampSource'), false);
});
test('malformed source identities cannot overwrite existing Index facts; invalid canonical batches reject atomically', async () => {
    await ingestIndexes(ACCOUNT_UUID, [parseGeminiIndexObservation(observation('safe_123', 1000, 'Safe Chat'), 'rpc-list')]);
    const before = await listIndexes(ACCOUNT_UUID);
    for (const raw of [{ id: 'c_unknown' }, { id: '' }, {}, { id: 'c_' }]) {
        assert.throws(() => parseGeminiIndexObservation(raw, 'rpc-list'), TypeError);
    }
    await assert.rejects(ingestIndexes(ACCOUNT_UUID, [
        { conversationId: 'valid_123', fields: { title: 'Must not partially write', titleSource: 'provider' } },
        { conversationId: '', fields: {} },
    ]), TypeError);
    assert.deepEqual(await listIndexes(ACCOUNT_UUID), before);
});
test('a mixed RPC page admits only recognized rows and cannot certify coverage from invalid rows', async () => {
    const parsed = parseList(geminiListGen('G_UNIFIED_INGEST_INTEGRITY_01'));
    assert.equal(parsed.pageEvidence.valid, false);
    await ingestIndexes(ACCOUNT_UUID, parsed.conversations.map(row => parseGeminiIndexObservation(row, 'rpc-list')));
    const indexes = await listIndexes(ACCOUNT_UUID);
    assert.equal(indexes.length, 1); assert.equal(indexes[0].key.conversationId, 'valid_123');
});
