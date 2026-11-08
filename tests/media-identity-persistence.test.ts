import { useIndexStorage } from './helpers/indexStorage.js';
useIndexStorage();
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mediaSources, mediaChatId, mediaBytes } from './helpers/mediaSourceFixture.js';
import { ingestDetail, ingestDeletedConversation } from '../src/l2/ingestion.js';
import { readConversation } from '../src/l2/readConversation.js';
import { createSourceResourceContext } from '../src/l1/resources/sourceResources.js';
import type { SourceConversationParseResult } from '../src/l1/parsers/parsingResult.js';
const key = { accountId: '10000000-0000-4000-8000-000000000001', conversationId: mediaChatId };
const commit = (source: SourceConversationParseResult) => ingestDetail(key.accountId, key.conversationId, source.conversation.detail, source.conversation.index);
for (const order of ['online-first', 'takeout-first'] as const) {
    test(`L2 ${order}: source selection retains a complete body without importing acquisition bytes`, async () => {
        const { online, offline } = mediaSources();
        online.conversation.detail.quality.status = 'complete'; offline.conversation.detail.quality.status = 'partial';
        const snapshot = structuredClone(online.conversation.detail);
        if (order === 'online-first') await commit(online);
        await commit(offline);
        if (order === 'takeout-first') await commit(online);
        const stored = await readConversation(key); assert.ok(stored);
        assert.deepEqual(stored.detail, { ...snapshot, key });
        assert.equal('resources' in stored.detail, false); assert.equal('resourceDigests' in stored.detail, false);
        assert.equal('acquisitionHints' in stored, false); assert.equal('hasTakeoutImport' in stored.index, false);
        await commit(offline); assert.deepEqual((await readConversation(key))?.detail, stored.detail);
    });
}


test('task resources isolate accounts and conversations; fresh tasks cannot recover a persistent byte cache', async () => {
    const { online } = mediaSources(); const asset = { ...online.conversation.detail.assets[0] }; delete asset.sourceUri;
    const context = createSourceResourceContext(), fresh = createSourceResourceContext();
    try {
        context.retain(key, asset.id, async () => ({ bytes: mediaBytes.slice() }));
        assert.deepEqual((await context.acquire(key, asset)).bytes, mediaBytes);
        await assert.rejects(context.acquire({ ...key, accountId: '10000000-0000-4000-8000-000000000002' }, asset), /locator/);
        await assert.rejects(context.acquire({ ...key, conversationId: 'other' }, asset), /locator/);
        await assert.rejects(fresh.acquire(key, asset), /locator/);
    } finally { context.release(); fresh.release(); }
});
test('URI-less imported resources stay in task acquisition output while repeated L2 admission stays byte-free', async () => {
    const parsed = mediaSources().online, asset = parsed.conversation.detail.assets[0]; delete asset.sourceUri;
    parsed.acquisitionHints = { [asset.id]: { dataBase64: btoa(String.fromCharCode(...mediaBytes)) } };
    const context = createSourceResourceContext();
    try {
        context.retainParsed(key, parsed); await commit(parsed); const initial = await readConversation(key); assert.ok(initial);
        parsed.conversation.index.title = 'Continued conversation'; await commit(parsed);
        const continued = await readConversation(key); assert.ok(continued);
        assert.deepEqual(continued.detail, initial.detail);
        assert.deepEqual((await context.acquire(key, asset)).bytes, mediaBytes);
        assert.equal(JSON.stringify(continued).includes('dataBase64'), false);
        await ingestDeletedConversation(key.accountId, key.conversationId); assert.equal(await readConversation(key), null);
    } finally { context.release(); }
    await assert.rejects(context.acquire(key, asset), /released/);
});
test('acquisition receipt/path changes never become Domain fields or change an idempotent Detail', async () => {
    const parsed = mediaSources().online; await commit(parsed); const first = await readConversation(key);
    const asset = parsed.conversation.detail.assets[0];
    parsed.acquisitionHints = { [asset.id]: { localName: 'archive/relocated.png', dataBase64: 'AQID' } };
    assert.deepEqual(await commit(parsed), { accepted: true, changed: false }); assert.deepEqual(await readConversation(key), first);
    assert.equal(JSON.stringify(first).includes('archive/relocated.png'), false);
});
