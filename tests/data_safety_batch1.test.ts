import test from 'node:test';
import assert from 'node:assert/strict';
import { useIndexStorage } from './helpers/indexStorage.js';
import { accountRuntime, ACCOUNT_UUID } from './helpers/accountRuntime.js';
import { ingestDetail } from '../src/l2/ingestion.js';
import { getIndex, getDetail, getExportRecord, putExportRecord } from '../src/l3a/storageService.js';
import { GeminiProvider } from '../src/l1/client/gemini/geminiProvider.js';
import { ConfirmedGeminiConversationNotFound } from '../src/l1/client/gemini/geminiClient.js';
import { sourceList } from './helpers/l1SourceFixture.js';
import { init, handleWindowMessage } from '../src/l1/sniffer/gemini/messageBridge.js';
useIndexStorage();
const key = { accountId: ACCOUNT_UUID, conversationId: '12345678abcdef' };
async function seed() {
    await ingestDetail(key.accountId, key.conversationId, { quality: { status: 'complete' }, assets: [],
        messages: [{ role: 'user', content: [{ type: 'paragraph', children: [{ type: 'text', text: 'Local body' }] }] }] });
    await putExportRecord(key, { status: 'ok', format: 'markdown', exportedAt: 100 });
}
function failingProvider(error: Error) {
    return new GeminiProvider({ getConversationList: async () => sourceList('G_SOURCE_EMPTY_01'),
        getConversationDetail: async () => { throw error; } }, async () => 'u0');
}
test('D2: incidental 11167, generic 404 and unverified error strings cannot delete local facts', async () => {
    await seed();
    for (const error of [new Error('Server returned error code 11167'), new Error('HTTP 404'),
        new Error('BardErrorInfo: 1167'), new ConfirmedGeminiConversationNotFound('c_other')]) {
        await assert.rejects(failingProvider(error).fetchConversationDetail(key.accountId, key.conversationId));
        assert.ok(await getIndex(key)); assert.ok(await getDetail(key)); assert.ok(await getExportRecord(key));
    }
});
test('D2: target-bound verified NotFound removes Index, Detail and ExportRecord while preserving another account', async () => {
    await seed();
    const otherKey = { ...key, accountId: '10000000-0000-4000-8000-000000000002' };
    const { key: _key, ...detail } = (await getDetail(key))!;
    await ingestDetail(otherKey.accountId, otherKey.conversationId, detail);
    const confirmed = failingProvider(new ConfirmedGeminiConversationNotFound('c_' + key.conversationId));
    await assert.rejects(confirmed.fetchConversationDetail(key.accountId, key.conversationId), /conversation_not_found/);
    assert.equal(await getIndex(key), null); assert.equal(await getDetail(key), null); assert.equal(await getExportRecord(key), null);
    assert.ok(await getDetail(otherKey));
});

// Explicit scan reset clears all account-local conversation facts.
test('D4: clearStoredAccountScanRecords clears all account-local records and preserves another account', async () => {
    const { indexStorage } = require('./helpers/indexStorage.js');
    const storage = require('../src/l3a/storageService.js');
    const env = indexStorage();
    try {
        const key = { accountId: '10000000-0000-4000-8000-000000000001', conversationId: 'chat_1' };
        await storage.putIndexes([{ key }]);
        await storage.updateConversationAtomically(key, () => ({ detail: { key, quality: {status:'complete'}, assets:[], messages:[{role:'user',content:[]}] }, result: undefined }));
        await storage.putExportRecord(key, { format: 'markdown', exportedAt: 0, status: 'ok' });
        await storage.updateCoverageAtomically(key.accountId, 'recent', () => ({ next: { range: null }, result: undefined }));
        const otherKey = { ...key, accountId: '10000000-0000-4000-8000-000000000002' };
        await storage.putIndexes([{ key: otherKey }]);
        await storage.updateConversationAtomically(otherKey, () => ({ detail: { key: otherKey, quality: {status:'complete'}, assets:[], messages:[{role:'user',content:[]}] }, result: undefined }));
        await storage.putExportRecord(otherKey, { format: 'markdown', exportedAt: 0, status: 'ok' });
        await storage.clearStoredAccountScanRecords(key.accountId);
        assert.deepEqual(await storage.listExportRecords(key.accountId), {});
        assert.equal(await storage.getCoverage(key.accountId, 'recent'), null);
        assert.equal(await storage.getIndex(key), null);
        assert.equal(await storage.getDetail(key), null);
        assert.deepEqual(await storage.getIndex(otherKey), { key: otherKey });
        assert.ok(await storage.getDetail(otherKey));
        assert.ok(await storage.getExportRecord(otherKey));
    } finally { env.restore(); }
});

// An untrusted page-world notification has no acknowledged DELETE response.
test('MessageBridge ignores malformed and unverified deletion notifications without active fetch or local deletion', async t => {
    await seed();
    const runtime = accountRuntime('u0');
    const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('No active verification request allowed'); });
    try {
        init();
        for (const id of ['../../malicious/path', 'c_' + key.conversationId]) {
            await handleWindowMessage({ origin: location.origin, source: window, data: {
                type: 'GEMINI_CONVERSATION_DELETED', payload: { id, slot: 'u0',
                    requestAccountObservation: { providerId: 'gemini', providerAccountId: '10000000001' } },
            } } as unknown as MessageEvent);
        }
        assert.equal(fetch.mock.callCount(), 0);
        assert.ok(await getIndex(key)); assert.ok(await getDetail(key)); assert.ok(await getExportRecord(key));
    } finally { runtime.restore(); }
});
