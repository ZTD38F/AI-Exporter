/** L2 persistence/read boundaries; retired repository and export orchestration are not L2 ports. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { putOne } from '../src/l3a/idb.js';
import { indexStorage } from './helpers/indexStorage.js';
import { ingestDetail, ingestIndexes, ingestDeletedConversation } from '../src/l2/ingestion.js';
import { readStoredConversation } from './helpers/readStoredConversation.js';
import { conversationKey } from '../src/l2/conversationKey.js';
import { getIndex, getDetail, getExportRecord, putExportRecord, updateConversationAtomically } from '../src/l3a/storageService.js';
import type { DomainConversationDetail } from '../src/l2/conversationDetail.js';
const accountId = '10000000-0000-4000-8000-000000000001';
const otherId = '10000000-0000-4000-8000-000000000002';
const key = { accountId, conversationId: 'chat' };
const fields = { title: 'Old title', titleSource: 'provider' as const, updatedAt: 100 };
const body = (): Omit<DomainConversationDetail, 'key'> => ({ savedAt: 100, quality: { status: 'complete' }, assets: [],
    messages: [{ role: 'user', content: [{ type: 'paragraph', children: [{ type: 'text', text: 'Question' }] }] },
        { role: 'assistant', content: [{ type: 'paragraph', children: [{ type: 'text', text: 'Answer' }] }] }] });
async function seed() { await ingestDetail(accountId, key.conversationId, body(), fields); }
async function rename(title = 'Renamed', updatedAt = 200) {
    await ingestIndexes(accountId, [{ conversationId: key.conversationId, fields: { title, titleSource: 'provider', updatedAt, createdAt: 50 } }]);
}

test('Index owns metadata; Detail does not acquire metadata during reads', async () => {
    const env = indexStorage();
    try {
        await seed(); await rename();
        const snapshot = await readStoredConversation(key); assert.ok(snapshot);
        assert.equal(snapshot.index.title, 'Renamed'); assert.equal(snapshot.index.createdAt, 50);
        assert.equal(snapshot.index.updatedAt, 200); assert.equal(snapshot.detail.savedAt, 100);
        assert.deepEqual(Object.keys(snapshot.detail).sort(), ['assets', 'key', 'messages', 'quality', 'savedAt']);
    } finally { env.restore(); }
});

test('missing, index-only, explicitly empty and partial Detail stay distinct without read repair', async () => {
    const env = indexStorage();
    try {
        assert.equal(await readStoredConversation(key), null);
        await ingestIndexes(accountId, [{ conversationId: 'chat', fields }]);
        const writes = env.writes();
        assert.equal(await readStoredConversation(key), null); assert.ok(await getIndex(key));
        assert.equal(await getDetail(key), null); assert.equal(env.writes(), writes);
        await ingestDetail(accountId, 'chat', { quality: { status: 'unknown' }, messages: [], assets: [] });
        assert.deepEqual((await readStoredConversation(key))?.detail.messages, []);
        await ingestDetail(accountId, 'chat', { ...body(), quality: { status: 'partial' } });
        assert.equal((await readStoredConversation(key))?.detail.quality.status, 'partial');
    } finally { env.restore(); }
});

test('read snapshots cannot mutate persisted Index or Detail and perform no writes', async () => {
    const env = indexStorage();
    try {
        await seed(); const writes = env.writes(); const snapshot = await readStoredConversation(key); assert.ok(snapshot);
        snapshot.index.title = 'Caller mutation'; snapshot.detail.messages.length = 0;
        const again = await readStoredConversation(key); assert.equal(again?.index.title, 'Old title');
        assert.equal(again?.detail.messages.length, 2); assert.equal(env.writes(), writes);
    } finally { env.restore(); }
});

test('explicit keys isolate accounts and reads ignore orphan Detail without repairing it', async () => {
    const env = indexStorage();
    try {
        await seed(); const other = { ...key, accountId: otherId };
        await ingestDetail(otherId, 'chat', body(), { title: 'Other account', titleSource: 'provider' });
        assert.equal((await readStoredConversation(other))?.index.title, 'Other account');
        assert.equal((await readStoredConversation(key))?.index.title, 'Old title');
        await assert.rejects(ingestDetail('10000000-0000-4000-8000-000000000099', 'chat', body()), /account does not exist/);
        assert.throws(() => conversationKey('typo', 'chat'), /Invalid/);
        assert.throws(() => conversationKey(accountId, ''), /Invalid/);
        const orphanKey = { accountId, conversationId: 'orphan' };
        // Deliberately corrupt physical persistence: this is not a public admission API.
        await putOne('details', { ...body(), key: orphanKey });
        const writes = env.writes();
        assert.equal(await readStoredConversation(orphanKey), null); assert.ok(await getDetail(orphanKey));
        assert.equal(await getIndex(orphanKey), null); assert.equal(env.writes(), writes);
    } finally { env.restore(); }
});

test('Index reads do not validate or read an independently corrupt body', async () => {
    const env = indexStorage();
    try {
        await seed();
        await updateConversationAtomically(key, () => ({ detail: { ...body(), key, messages: [{ role: 'assistant', content: [{ type: 'image', assetId: 'missing' }] }] }, result: undefined }));
        assert.equal((await getIndex(key))?.title, 'Old title');
        const writes = env.writes(); await assert.rejects(readStoredConversation(key), /asset|resource/i);
        assert.equal(env.writes(), writes);
    } finally { env.restore(); }
});

test('failed Detail admission rolls back metadata and subsequent admissions recover', async () => {
    const env = indexStorage();
    try {
        await seed(); env.fail('details');
        await assert.rejects(ingestDetail(accountId, 'chat', { ...body(), savedAt: 200 }, { title: 'Uncommitted', titleSource: 'provider', updatedAt: 200 }), /write failed/);
        assert.equal((await getIndex(key))?.title, 'Old title'); assert.equal((await getDetail(key))?.savedAt, 100);
        env.fail(); await rename(); assert.equal((await readStoredConversation(key))?.index.title, 'Renamed');
    } finally { env.restore(); }
});

test('export history writes cannot roll back metadata renamed after a read', async () => {
    const env = indexStorage();
    try {
        await seed(); const snapshot = await readStoredConversation(key); assert.ok(snapshot); await rename();
        await putExportRecord(key, { format: 'markdown', status: 'ok', chatTime: snapshot.detail.savedAt, exportedAt: 900 });
        assert.equal((await getIndex(key))?.title, 'Renamed'); assert.equal((await getExportRecord(key))?.chatTime, 100);
        assert.equal((await readStoredConversation(key))?.detail.savedAt, 100);
    } finally { env.restore(); }
});

test('fresh Detail admission commits metadata independently of export completion', async () => {
    const env = indexStorage();
    try {
        await seed(); assert.equal((await getIndex(key))?.titleSource, 'provider');
        assert.equal((await readStoredConversation(key))?.detail.messages.length, 2);
        assert.equal(await getExportRecord(key), null);
    } finally { env.restore(); }
});

test('partial admission advances Index but retains the complete body version', async () => {
    const env = indexStorage();
    try {
        await seed();
        assert.deepEqual(await ingestDetail(accountId, 'chat', { ...body(), savedAt: 200, quality: { status: 'partial' }, messages: body().messages.slice(0, 1) }, { title: 'New title', titleSource: 'provider', updatedAt: 200 }), { accepted: false, changed: false });
        const stored = await readStoredConversation(key); assert.equal(stored?.index.updatedAt, 200);
        assert.equal(stored?.detail.messages.length, 2); assert.equal(stored?.detail.savedAt, 100);
    } finally { env.restore(); }
});

test('initial partial Detail keeps its known source version without claiming completeness', async () => {
    const env = indexStorage();
    try {
        await ingestDetail(accountId, 'chat', { ...body(), quality: { status: 'partial' } }, fields);
        const stored = await readStoredConversation(key); assert.equal(stored?.detail.savedAt, 100);
        assert.equal(stored?.detail.quality.status, 'partial'); assert.equal(stored?.index.updatedAt, 100);
    } finally { env.restore(); }
});

test('stale reads cannot republish metadata or resurrect confirmed deletion', async () => {
    const env = indexStorage();
    try {
        await seed(); const cached = await readStoredConversation(key); await rename();
        assert.equal(cached?.index.title, 'Old title'); assert.equal((await readStoredConversation(key))?.index.title, 'Renamed');
        await ingestDeletedConversation(accountId, 'chat'); const writes = env.writes();
        assert.equal(await readStoredConversation(key), null); assert.equal(await getIndex(key), null);
        assert.equal(env.writes(), writes); assert.equal(cached?.detail.messages.length, 2);
    } finally { env.restore(); }
});
