import test from 'node:test';
import assert from 'node:assert/strict';
import { indexStorage } from './helpers/indexStorage.js';
import { ACCOUNT_UUID, OTHER_ACCOUNT_UUID } from './helpers/accountIds.js';
import { ingestIndexes, ingestDetail, ingestDeletedConversation } from '../src/l2/ingestion.js';
import { listIndexes, getIndex, getDetail, putExportRecord, getExportRecord } from '../src/l3a/storageService.js';
import { mergeConversationIndex, indexActivityTime } from '../src/l2/conversationIndex.js';
import { makeConversationIndex } from './helpers/conversationIndexFixture.js';
const key = (id = 'chat', accountId = ACCOUNT_UUID) => ({ accountId, conversationId: id });
const fields = () => ({ title: 'Research', titleSource: 'provider' as const, updatedAt: 50 });
const detail = () => ({ quality: { status: 'complete' as const }, assets: [],
    messages: [{ role: 'user' as const, content: [] }] });
async function index(id = 'chat', accountId = ACCOUNT_UUID) {
    await ingestIndexes(accountId, [{ conversationId: id, fields: fields() }]);
}

test('physical Index roundtrip is exact, detached and account isolated', async () => {
    const env = indexStorage();
    try {
        await index();
        const read = await listIndexes(ACCOUNT_UUID); assert.deepEqual(read, [{ key: key(), ...fields() }]);
        read[0].title = 'External mutation';
        assert.equal((await listIndexes(ACCOUNT_UUID))[0].title, 'Research');
        assert.deepEqual(await listIndexes(OTHER_ACCOUNT_UUID), []);
    } finally { env.restore(); }
});

test('L2 rejects unknown fields and malformed Index facts before writing; duplicate rows use the unique merge', async () => {
    const env = indexStorage();
    try {
        for (const bad of [{ messages: [] }, { timestamp: 5 }, { messageCount: -1 }, { title: 'Missing source' },
            { updatedAt: NaN }, { updatedAt: '5' }, { createdAt: null }, { createdAt: Infinity }, { titleSource: 'rpc' }]) {
            await assert.rejects(ingestIndexes(ACCOUNT_UUID, [{ conversationId: 'bad', fields: bad as never }]));
            assert.deepEqual(await listIndexes(ACCOUNT_UUID), []);
        }
        await ingestIndexes(ACCOUNT_UUID, [{ conversationId: 'chat', fields: fields() },
            { conversationId: 'chat', fields: { updatedAt: 60 } }]);
        assert.deepEqual(await listIndexes(ACCOUNT_UUID), [{ key: key(), ...fields(), updatedAt: 60 }]);
    } finally { env.restore(); }
});

test('atomic Index patches preserve title authority and source-authored times', async () => {
    const env = indexStorage();
    try {
        await ingestIndexes(ACCOUNT_UUID, [{ conversationId: 'chat', fields: { title: 'User title', titleSource: 'user', createdAt: 10, updatedAt: 100 } }]);
        await Promise.all([
            ingestIndexes(ACCOUNT_UUID, [{ conversationId: 'chat', fields: { title: 'Provider title', titleSource: 'provider', updatedAt: 300 } }]),
            ingestIndexes(ACCOUNT_UUID, [{ conversationId: 'chat', fields: { createdAt: 5, updatedAt: 200 } }]),
        ]);
        assert.deepEqual(await getIndex(key()), { key: key(), title: 'User title', titleSource: 'user', createdAt: 5, updatedAt: 300 });
    } finally { env.restore(); }
});

test('Detail persists separately and Index-only observations cannot replace the body', async () => {
    const env = indexStorage();
    try {
        await ingestDetail(ACCOUNT_UUID, 'chat', detail(), fields());
        const before = await getDetail(key());
        await ingestIndexes(ACCOUNT_UUID, [{ conversationId: 'chat', fields: { title: 'Renamed', titleSource: 'provider' } }]);
        assert.deepEqual(await getDetail(key()), before);
        assert.equal((await getIndex(key()))?.title, 'Renamed');
        assert.equal(Object.hasOwn((await getIndex(key()))!, 'messages'), false);
        await ingestDeletedConversation(ACCOUNT_UUID, 'chat');
        assert.equal(await getDetail(key()), null); assert.equal(await getIndex(key()), null);
    } finally { env.restore(); }
});

test('export delivery records do not manufacture Index or Detail facts', async () => {
    const env = indexStorage();
    try {
        const record = { exportedAt: 10, format: 'markdown' as const, status: 'ok' as const };
        await putExportRecord(key(), record);
        assert.deepEqual(await getExportRecord(key()), record);
        assert.equal(await getIndex(key()), null); assert.equal(await getDetail(key()), null);
    } finally { env.restore(); }
});

test('concurrent Detail imports retain unrelated indexes, title authority and other accounts', async () => {
    const env = indexStorage();
    try {
        await index(); await index('other'); await index('other', OTHER_ACCOUNT_UUID);
        await Promise.all([
            ingestDetail(ACCOUNT_UUID, 'chat', detail(), { title: 'Weaker detail', titleSource: 'derived', updatedAt: 70 }),
            ingestDetail(ACCOUNT_UUID, 'added', detail()),
        ]);
        assert.deepEqual((await listIndexes(ACCOUNT_UUID)).map(i => i.key.conversationId).sort(), ['added', 'chat', 'other']);
        assert.equal((await getIndex(key()))?.title, 'Research');
        assert.equal((await getIndex(key()))?.updatedAt, 70);
        assert.equal((await getIndex(key('other', OTHER_ACCOUNT_UUID)))?.title, 'Research');
        const writes = env.writes(); await ingestIndexes(ACCOUNT_UUID, []); assert.equal(env.writes(), writes);
    } finally { env.restore(); }
});

test('Index activity belongs to source metadata and never introduces cloud availability fields', () => {
    const old = makeConversationIndex({ key: key(), ...fields(), createdAt: 10 });
    const incoming = makeConversationIndex({ key: key(), title: undefined, titleSource: undefined, updatedAt: 300 });
    const merged = mergeConversationIndex(old, incoming);
    assert.equal(indexActivityTime(merged), 300); assert.equal(merged.createdAt, 10);
    assert.equal(Object.hasOwn(merged, 'cloudAvailability'), false);
});

test('export chatTime is an export baseline and cannot poison Index.updatedAt', async () => {
    const env = indexStorage();
    try {
        await index(); await putExportRecord(key(), { format: 'markdown', status: 'ok', exportedAt: 20, chatTime: 999999 });
        assert.equal((await getIndex(key()))?.updatedAt, 50);
        assert.equal((await getExportRecord(key()))?.chatTime, 999999);
    } finally { env.restore(); }
});

test('confirmed deletion removes facts; only newly observed facts can recreate a minimal Index', async () => {
    const env = indexStorage();
    try {
        await ingestDetail(ACCOUNT_UUID, 'chat', detail(), fields());
        await index('chat', OTHER_ACCOUNT_UUID);
        await ingestDeletedConversation(ACCOUNT_UUID, 'chat');
        assert.equal(await getDetail(key()), null); assert.equal(await getIndex(key()), null);
        env.fail('indexes'); await assert.rejects(index(), /write failed/); env.fail();
        assert.equal(await getIndex(key()), null);
        await index();
        assert.equal((await getIndex(key()))?.title, 'Research'); assert.equal(await getDetail(key()), null);
        assert.ok(await getIndex(key('chat', OTHER_ACCOUNT_UUID)));
        assert.equal(Object.hasOwn((await getIndex(key()))!, 'cloudAvailability'), false);
    } finally { env.restore(); }
});

test('confirmed L2 deletion clears only the named conversation Index, Detail and ExportRecord', async () => {
    const env = indexStorage(), target = key('delete-confirmed'), other = key('delete-confirmed', OTHER_ACCOUNT_UUID);
    try {
        const record = { format: 'markdown' as const, status: 'ok' as const, exportedAt: 100 };
        await ingestDetail(ACCOUNT_UUID, target.conversationId, detail());
        await ingestDetail(OTHER_ACCOUNT_UUID, other.conversationId, detail());
        await putExportRecord(target, record);
        await putExportRecord(other, record);
        await ingestDeletedConversation(ACCOUNT_UUID, target.conversationId);
        assert.equal(await getIndex(target), null);
        assert.equal(await getDetail(target), null);
        assert.equal(await getExportRecord(target), null);
        assert.ok(await getIndex(other)); assert.ok(await getDetail(other));
        assert.deepEqual(await getExportRecord(other), record);
        await ingestDeletedConversation(ACCOUNT_UUID, target.conversationId);
        assert.equal(await getIndex(target), null, 'repeated verified deletion remains idempotent');
    } finally { env.restore(); }
});
