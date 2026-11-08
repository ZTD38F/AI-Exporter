/** Replaces the retired cloudAvailability retention contract with frozen L1/L2 deletion semantics. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { indexStorage } from './helpers/indexStorage.js';
import { ingestDetail, ingestIndexes } from '../src/l2/ingestion.js';
import { getIndex, getDetail, getExportRecord, putExportRecord, listIndexes } from '../src/l3a/storageService.js';
import { GeminiProvider } from '../src/l1/client/gemini/geminiProvider.js';
import type { GeminiProviderClient } from '../src/l1/client/gemini/geminiContracts.js';
import { ConfirmedGeminiConversationNotFound } from '../src/l1/client/gemini/geminiClient.js';
const accountId = '10000000-0000-4000-8000-000000000001', otherId = '10000000-0000-4000-8000-000000000002';
const conversationId = 'deadbeef00112233';
test('ordinary 404 preserves facts; target-bound confirmed deletion removes all three records only for its account', async () => {
    const env = indexStorage();
    try {
        for (const id of [accountId, otherId]) {
            await ingestDetail(id, conversationId, { quality: { status: 'unknown' }, messages: [], assets: [] }, { title: 'Saved conversation', titleSource: 'provider' });
            await putExportRecord({ accountId: id, conversationId }, { format: 'markdown', status: 'ok', exportedAt: 100 });
        }
        const key = { accountId, conversationId }, otherKey = { accountId: otherId, conversationId };
        const provider = (failure: Error) => new GeminiProvider({ getConversationDetail: async () => { throw failure; } } as unknown as GeminiProviderClient, async () => 'u0');
        await assert.rejects(provider(new Error('HTTP 404')).fetchConversationDetail(accountId, conversationId), /404/);
        assert.ok(await getIndex(key)); assert.ok(await getDetail(key)); assert.ok(await getExportRecord(key));
        await assert.rejects(provider(new ConfirmedGeminiConversationNotFound('c_' + conversationId)).fetchConversationDetail(accountId, conversationId), /conversation_not_found/);
        assert.equal(await getIndex(key), null); assert.equal(await getDetail(key), null); assert.equal(await getExportRecord(key), null);
        assert.ok(await getIndex(otherKey)); assert.ok(await getDetail(otherKey)); assert.ok(await getExportRecord(otherKey));
    } finally { env.restore(); }
});
test('failed Index persistence preserves existing records and a subsequent admission succeeds', async () => {
    const env = indexStorage();
    try {
        await ingestIndexes(accountId, [{ conversationId: 'existing', fields: { title: 'Preserved', titleSource: 'provider', updatedAt: 100 } }]);
        env.fail('indexes');
        await assert.rejects(ingestIndexes(accountId, [{ conversationId: 'incoming', fields: { title: 'Incoming', titleSource: 'provider' } }]), /write failed/);
        assert.deepEqual((await listIndexes(accountId)).map(row => row.key.conversationId), ['existing']);
        env.fail(); await ingestIndexes(accountId, [{ conversationId: 'retry', fields: { title: 'Retry', titleSource: 'provider' } }]);
        assert.deepEqual((await listIndexes(accountId)).map(row => row.key.conversationId).sort(), ['existing', 'retry']);
    } finally { env.restore(); }
});
