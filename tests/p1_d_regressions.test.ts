import test from 'node:test';
import { IDBObjectStore } from 'fake-indexeddb';
import assert from 'node:assert/strict';
import { indexStorage } from './helpers/indexStorage.js';
import { ACCOUNT_UUID as A, OTHER_ACCOUNT_UUID as B } from './helpers/accountIds.js';
import { ingestIndexes, ingestDetail, ingestDeletedConversation } from '../src/l2/ingestion.js';
import { getIndex, listIndexes, getDetail, putExportRecord, getExportRecord, listExportRecords, clearStoredAccountExportRecords } from '../src/l3a/storageService.js';
import { getSettings, updateSettings } from '../src/application/settings/index.js';
import { SETTINGS_KEY } from '../src/l3a/settingsStore.js';
import { getConversationDetail } from '../src/l1/client/gemini/api/pagination.js';
import { sourceDetail, sourceMessage } from './helpers/l1SourceFixture.js';
const key = (id = 'chat', accountId = A) => ({ accountId, conversationId: id });
const record = { exportedAt: 100, format: 'markdown' as const, status: 'ok' as const };
function host(t: import('node:test').TestContext) { const env = indexStorage(); t.after(() => env.restore()); return env; }
async function seed(id = 'chat', accountId = A) {
    await ingestDetail(accountId, id, { savedAt: 100, quality: { status: 'complete' }, assets: [],
        messages: [{ id: 'answer', role: 'assistant', content: [{ type: 'paragraph', children: [{ type: 'text', text: 'Body' }] }] }] },
        { title: 'Title', titleSource: 'provider', updatedAt: 100 });
}

test('records write exactly one key and overwrite only the addressed conversation', async t => {
    host(t); await putExportRecord(key(), record); await putExportRecord(key('other'), record);
    await putExportRecord(key(), { ...record, exportedAt: 200 });
    assert.deepEqual(await listExportRecords(A), { chat: { ...record, exportedAt: 200 }, other: record });
});
test('current storage preserves trusted identities; historical alias conversion is owned solely by Migration', async t => {
    host(t); await putExportRecord(key('id'), record); await putExportRecord(key('c_id'), { ...record, exportedAt: 200 });
    assert.deepEqual(Object.keys(await listExportRecords(A)).sort(), ['c_id', 'id']);
});
test('account records have no global or other-account fallback', async t => {
    const env = host(t); await putExportRecord(key('id', B), record);
    assert.deepEqual(await listExportRecords(A), {});
    assert.deepEqual(await listExportRecords(B), { id: record });
    assert.equal(Object.hasOwn(env.local, 'exportedIds'), false);
});
test('overlapping index admissions retain both committed sets', async t => {
    host(t);
    await Promise.all(['one', 'two'].map(id => ingestIndexes(A, [{ conversationId: id, fields: { title: id, titleSource: 'provider' } }])));
    assert.deepEqual((await listIndexes(A)).map(x => x.key.conversationId).sort(), ['one', 'two']);
});
test('confirmed deletion atomically removes Index, Detail and ExportRecord without affecting a sibling account', async t => {
    host(t); await seed(); await seed('chat', B);
    await putExportRecord(key(), record); await putExportRecord(key('chat', B), record);
    await ingestDeletedConversation(A, 'chat');
    assert.equal(await getIndex(key()), null); assert.equal(await getDetail(key()), null); assert.equal(await getExportRecord(key()), null);
    assert.ok(await getIndex(key('chat', B))); assert.ok(await getDetail(key('chat', B))); assert.deepEqual(await getExportRecord(key('chat', B)), record);
});
test('a failed deletion transaction rolls back all three stores', async t => {
    const env = host(t); await seed(); await putExportRecord(key(), record);
    // A transaction abort is injected at the IDB host boundary, not in Domain.
    const original = IDBObjectStore.prototype.delete;
    t.mock.method(IDBObjectStore.prototype, 'delete', function(this: IDBObjectStore, value: IDBValidKey) {
        if (this.name === 'exportRecords') throw new Error('delete failed');
        return original.call(this, value);
    });
    await assert.rejects(ingestDeletedConversation(A, 'chat'), /delete failed/);
    assert.ok(await getIndex(key())); assert.ok(await getDetail(key())); assert.deepEqual(await getExportRecord(key()), record);
});
test('list omission never deletes a local conversation or its export marker', async t => {
    host(t); await seed(); await putExportRecord(key(), record);
    await ingestIndexes(A, [{ conversationId: 'new', fields: { title: 'New', titleSource: 'provider' } }]);
    assert.ok(await getDetail(key())); assert.deepEqual(await getExportRecord(key()), record);
    assert.equal((await listIndexes(A)).length, 2);
});
test('concurrent Settings patches serialize without losing unrelated preferences', async t => {
    host(t);
    await Promise.all([updateSettings({ enabledDisk: true }), updateSettings({ includeAssets: false }), updateSettings({ language: 'zh' })]);
    const settings = await getSettings();
    assert.equal(settings.enabledDisk, true); assert.equal(settings.includeAssets, false); assert.equal(settings.language, 'zh');
});
test('failed Settings persistence does not publish a speculative value or poison the next write', async t => {
    const env = host(t); await updateSettings({ language: 'en' });
    env.fail(SETTINGS_KEY); await assert.rejects(updateSettings({ language: 'zh' }), /write failed/);
    assert.equal((await getSettings()).language, 'en');
    env.fail(); await updateSettings({ language: 'zh' }); assert.equal((await getSettings()).language, 'zh');
});
test('Settings reads return defensive values instead of a mutable live cache', async t => {
    host(t); await updateSettings({ badgePosition: { left: 10, top: 20 } });
    const settings = await getSettings(); settings.badgePosition!.left = 99;
    assert.equal((await getSettings()).badgePosition?.left, 10);
});
test('explicit account export-marker cleanup leaves Domain and other-account records intact', async t => {
    host(t); await seed(); await putExportRecord(key(), record); await putExportRecord(key('chat', B), record);
    await clearStoredAccountExportRecords(A);
    assert.deepEqual(await listExportRecords(A), {}); assert.deepEqual(await getExportRecord(key('chat', B)), record); assert.ok(await getDetail(key()));
});
test('Index admissions never supplement an existing Detail with partial message bodies', async t => {
    host(t); await seed(); const before = await getDetail(key());
    await ingestIndexes(A, [{ conversationId: 'chat', fields: { title: 'Updated title', titleSource: 'provider', updatedAt: 200 } }]);
    assert.deepEqual(await getDetail(key()), before); assert.equal((await getIndex(key()))?.updatedAt, 200);
});
test('older provider observations cannot regress the source version', async t => {
    host(t); await seed();
    await ingestIndexes(A, [{ conversationId: 'chat', fields: { updatedAt: 50 } }]);
    assert.equal((await getIndex(key()))?.updatedAt, 100);
});
test('detail pagination stops a real cursor loop while retaining unique source messages', async () => {
    let calls = 0;
    const result = await getConversationDetail({ fetchConversationPage: async () => sourceDetail({
        id: 'loop', messages: [sourceMessage('same'), sourceMessage('page-' + ++calls)], nextPageToken: 'repeat',
    }) }, 'loop');
    assert.equal(calls, 2); assert.equal(result.evidence?.truncation, 'token_loop');
    assert.equal(new Set(result.conversation.detail.messages.map(message => message.id)).size, 3);
    assert.equal(result.conversation.detail.quality.status, 'partial');
});
