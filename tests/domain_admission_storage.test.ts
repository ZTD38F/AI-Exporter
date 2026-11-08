import { getCoverage, getIndex, getDetail, updateIndexesAtomically } from '../src/l3a/storageService.js';
import { admitFixture } from './helpers/admitFixture.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { indexStorage } from './helpers/indexStorage.js';
import { fixtureAccount, fixtureKey } from './helpers/domainFixture.js';
import { validateParserDomain } from '../src/l2/runtimeValidation.js';
import { ingestIndexes, ingestDetail } from '../src/l2/ingestion.js';
import { storageIdentity } from './helpers/admitFixture.js';
import { readFixture } from './helpers/admitFixture.js';
import { listIndexes as getConversations } from '../src/l3a/storageService.js';
import type { DomainFixture } from './helpers/domainFixture.js';

const account = fixtureAccount();
function snapshot(text: string, status: 'complete' | 'partial' | 'unknown', savedAt?: number, image = false): DomainFixture {
    const key = fixtureKey('admission-storage');
    return { account, diagnostics: [], resourceHints: {}, acquisitionHints: image ? { image: { dataBase64: 'AQID' } } : {},
        conversation: validateParserDomain({ index: { key, title: 'Source title', titleSource: 'provider' }, detail: {
            key, ...(savedAt !== undefined ? { savedAt } : {}), quality: { status },
            assets: image ? [{ id: 'image', kind: 'image' }] : [],
            messages: [{ role: 'assistant', content: [{ type: 'paragraph', children: [{ type: 'text', text }] },
                ...(image ? [{ type: 'image' as const, assetId: 'image' }] : [])] }],
        } }) };
}

test('admission replaces complete body and assets together, preserves complete against partial, and keeps bytes outside Domain', async () => {
    const env = indexStorage(), identity = storageIdentity('gemini', account.id, 'admission-storage');
    try {
        const original = snapshot('A B C D', 'complete', 10, true);
        await admitFixture(account.id, original);
        assert.ok(!JSON.stringify((await readFixture(identity))!.conversation).includes('dataBase64'));
        await ingestIndexes(account.id, [{ conversationId: original.conversation.index.key.conversationId, fields: { title: 'Renamed', titleSource: 'user', updatedAt: 30 } }]);
        assert.equal((await readFixture(identity))!.conversation.detail.savedAt, 10, 'Index-only observation cannot advance the body version');
        const partial = { ...snapshot('C D E', 'partial', 30, true), acquisitionHints: { image: { dataBase64: 'BAUG' } } };
        const rejected = await admitFixture(account.id, partial);
        assert.deepEqual(rejected.conversation.detail, original.conversation.detail);
        assert.equal(rejected.conversation.index.title, 'Renamed');
        const next = snapshot('A B edited', 'complete', 20);
        await admitFixture(account.id, next);
        assert.deepEqual((await readFixture(identity))!.conversation.detail, next.conversation.detail);
        await admitFixture(account.id, snapshot('stale longer complete body', 'complete', 15));
        assert.deepEqual((await readFixture(identity))!.conversation.detail, next.conversation.detail);
    } finally { env.restore(); }
});

test('admission replaces incomplete snapshots by order and rejects mismatched ownership and failed catalog commits', async () => {
    const env = indexStorage(), identity = storageIdentity('gemini', account.id, 'admission-storage');
    try {
        await admitFixture(account.id, snapshot('long unknown body', 'unknown'));
        const next = snapshot('short', 'partial', 20);
        await admitFixture(account.id, next);
        assert.deepEqual((await readFixture(identity))!.conversation.detail, next.conversation.detail);
        await assert.rejects(admitFixture('10000000-0000-4000-8000-000000000002', next), /account\/provider mismatch/);
        assert.equal((await getConversations('10000000-0000-4000-8000-000000000002')).length, 0);
        env.fail('indexes');
        const failed = snapshot('uncommitted catalog', 'complete', 30); failed.conversation.index.updatedAt = 30;
        await assert.rejects(admitFixture(account.id, failed), /write failed/);
        env.fail();
        assert.equal((await getConversations(account.id))[0].key.accountId, account.id);
    } finally { env.restore(); }
});

test('canonical detail entry binds Registry UUID and shares Index and body admission rules', async () => {
    const env = indexStorage(), key = fixtureKey('canonical-detail');
    try {
        const incoming = snapshot('complete body', 'complete', 10);
        const { key: _, ...detail } = incoming.conversation.detail;
        await ingestDetail(account.id, key.conversationId, detail, { title: 'Explicit title', titleSource: 'user', updatedAt: 10 });
        await ingestDetail(account.id, key.conversationId, { ...detail, quality: { status: 'partial' }, savedAt: 20 },
            { title: 'Provider title', titleSource: 'provider', updatedAt: 20 });
        const stored = await readFixture(storageIdentity('gemini', account.id, key.conversationId));
        assert.deepEqual(stored!.conversation.detail, { ...detail, key });
        const index = (await getConversations(account.id)).find(row => row.key.conversationId === key.conversationId)!;
        assert.equal(index.title, 'Explicit title');
        assert.equal(index.updatedAt, 20);
        await assert.rejects(ingestDetail('10000000-0000-4000-8000-000000000099', key.conversationId, detail), /account does not exist/);
    } finally { env.restore(); }
});


test('default retains source Index facts without establishing trusted account coverage', async () => {
    const env = indexStorage(), accountId = '10000000-0000-4000-8000-000000000003';
    const key = { accountId, conversationId: 'default-fact' };
    try {
        await ingestIndexes(accountId, [{ conversationId: key.conversationId, fields: { updatedAt: 100 } }], {
            streamId: 'recent', requestCursor: null, nextCursor: null,
            requestedAt: 1, requestKnown: true, valid: true, ordered: true, keys: [{ id: key.conversationId, time: 100 }],
        });
        assert.deepEqual(await getConversations(accountId), [{ key, updatedAt: 100 }]);
        assert.equal(await getCoverage(accountId, 'recent'), null);
    } finally { env.restore(); }
});

test('ingestDetail reports admitted candidate and material change independently after commit', async () => {
    const env = indexStorage(), key = fixtureKey('changed-semantics');
    try {
        const body = { ...snapshot('first', 'complete', 10).conversation.detail };
        const { key: _unused, ...facts } = body;
        assert.deepEqual(await ingestDetail(account.id, key.conversationId, facts), { accepted: true, changed: true });
        assert.deepEqual(await ingestDetail(account.id, key.conversationId, { ...facts }), { accepted: true, changed: false });
        assert.deepEqual(await ingestDetail(account.id, key.conversationId, { ...facts, savedAt: 11 }),
            { accepted: true, changed: false }, 'savedAt-only progress does not trigger Live Save');
        assert.deepEqual(await ingestDetail(account.id, key.conversationId, { ...facts, savedAt: 9 }),
            { accepted: true, changed: false }, 'equal material facts permit candidate resource reuse');
        assert.deepEqual(await ingestDetail(account.id, key.conversationId, { ...facts, savedAt: 12, messages: [] }),
            { accepted: true, changed: true }, 'a newer complete snapshot can remove messages');
        assert.deepEqual(await ingestDetail(account.id, key.conversationId, { ...facts, savedAt: 11 }),
            { accepted: false, changed: false }, 'older different material facts are rejected');
        assert.deepEqual(await ingestDetail(account.id, key.conversationId, { ...facts, savedAt: 13 }),
            { accepted: true, changed: true }, 'newer full snapshot can replace an older one');
        assert.equal((await readFixture(storageIdentity('gemini', account.id, key.conversationId)))!.conversation.detail.savedAt, 13);
        assert.deepEqual(await ingestDetail(account.id, key.conversationId, { ...facts, quality: { status: 'partial' }, savedAt: 14 },
            { title: 'New index', titleSource: 'provider' }), { accepted: false, changed: false });
        assert.deepEqual(await ingestDetail(account.id, key.conversationId, { ...facts, savedAt: 14,
            messages: [{ role: 'assistant', content: [{ type: 'paragraph', children: [{ type: 'text', text: 'edited' }] }] }] }), { accepted: true, changed: true });
    } finally { env.restore(); }
});

test('one failed Detail write rolls back its freshly created Index', async () => {
    const env = indexStorage(), key = fixtureKey('atomic-rollback');
    try {
        env.fail('details');
        const { key: _unused, ...facts } = snapshot('new body', 'complete', 10).conversation.detail;
        await assert.rejects(ingestDetail(account.id, key.conversationId, facts), /write failed/);
        env.fail();
        assert.equal(await getIndex(key), null);
        assert.equal(await getDetail(key), null);
        assert.deepEqual(await ingestDetail(account.id, key.conversationId, facts), { accepted: true, changed: true });
        assert.ok(await getIndex(key));
        assert.ok(await getDetail(key));
    } finally { env.restore(); }
});

test('concurrent Index admissions preserve the highest trusted updatedAt', async () => {
    const env = indexStorage(), key = fixtureKey('atomic-index');
    try {
        await Promise.all(Array.from({ length: 20 }, (_, updatedAt) =>
            ingestIndexes(account.id, [{ conversationId: key.conversationId, fields: { updatedAt } }])));
        assert.equal((await getIndex(key))?.updatedAt, 19);
    } finally { env.restore(); }
});

test('Index atomic update accepts only changed subset and zero-write no-op admissions', async () => {
    const env = indexStorage(), one = fixtureKey('subset-one'), two = fixtureKey('subset-two');
    try {
        await ingestIndexes(account.id, [
            { conversationId: one.conversationId, fields: { updatedAt: 10 } },
            { conversationId: two.conversationId, fields: { updatedAt: 20 } },
        ]);
        const beforeNoop = env.writes();
        await ingestIndexes(account.id, [
            { conversationId: one.conversationId, fields: { updatedAt: 10 } },
            { conversationId: two.conversationId, fields: { updatedAt: 20 } },
        ]);
        assert.equal(env.writes(), beforeNoop, 'L2 chooses an empty write subset');
        await updateIndexesAtomically([one, two], rows => {
            assert.equal(rows[0]?.updatedAt, 10);
            assert.equal(rows[1]?.updatedAt, 20);
            return [{ ...rows[1]!, updatedAt: 30 }];
        });
        assert.equal((await getIndex(one))?.updatedAt, 10);
        assert.equal((await getIndex(two))?.updatedAt, 30);
    } finally { env.restore(); }
});

test('Index atomic update rejects duplicate/foreign decision keys and rolls back partial writes', async () => {
    const env = indexStorage(), one = fixtureKey('subset-first'), two = fixtureKey('subset-second');
    try {
        await ingestIndexes(account.id, [
            { conversationId: one.conversationId, fields: { updatedAt: 10 } },
            { conversationId: two.conversationId, fields: { updatedAt: 20 } },
        ]);
        await assert.rejects(updateIndexesAtomically([one, one], () => []), /Duplicate Index admission key/);
        await assert.rejects(updateIndexesAtomically([one, two], old => [
            { ...old[0]!, updatedAt: 999 },
            { key: fixtureKey('foreign'), updatedAt: 300 },
        ]), /Index decision key mismatch/);
        assert.equal((await getIndex(one))?.updatedAt, 10);
        await assert.rejects(updateIndexesAtomically([one, two], old => [
            { ...old[0]!, updatedAt: 999 }, { ...old[0]!, updatedAt: 888 },
        ]), /Duplicate Index decision key/);
        assert.equal((await getIndex(one))?.updatedAt, 10);
        assert.equal((await getIndex(two))?.updatedAt, 20);
    } finally { env.restore(); }
});

test('Detail admission compares semantic JSON facts, not object property insertion order', async () => {
    const env = indexStorage(), key = fixtureKey('same-facts-key-order');
    try {
        const facts = { messages: [{ role: 'assistant' as const, content: [] }], assets: [{ id: 'a', kind: 'image' as const }],
            quality: { status: 'complete' as const }, savedAt: 10 };
        assert.deepEqual(await ingestDetail(account.id, key.conversationId, facts), { accepted: true, changed: true });
        const writes = env.writes();
        const equivalent = { quality: { status: 'complete' as const }, assets: [{ kind: 'image' as const, id: 'a' }],
            messages: [{ content: [], role: 'assistant' as const }], savedAt: 10 };
        assert.deepEqual(await ingestDetail(account.id, key.conversationId, equivalent),
            { accepted: true, changed: false });
        assert.equal(env.writes(), writes, 'a duplicate material snapshot must not write again');
        const versionOnly = { ...equivalent, savedAt: 11 };
        assert.deepEqual(await ingestDetail(account.id, key.conversationId, versionOnly),
            { accepted: true, changed: false });
        assert.equal((await getDetail(key))?.savedAt, 11);
    } finally { env.restore(); }
});

test('rejected partial Detail never grafts its resources onto a retained complete snapshot', async () => {
    const env = indexStorage(), key = fixtureKey('rejected-resource-graph');
    try {
        const original = { savedAt: 10, quality: { status: 'complete' as const },
            assets: [{ id: 'old-image', kind: 'image' as const }],
            messages: [{ role: 'assistant' as const, content: [{ type: 'image' as const, assetId: 'old-image' }] }] };
        assert.deepEqual(await ingestDetail(account.id, key.conversationId, original,
            { title: 'Original', titleSource: 'provider' }), { accepted: true, changed: true });
        const partial = { savedAt: 20, quality: { status: 'partial' as const },
            assets: [{ id: 'untrusted-image', kind: 'image' as const }],
            messages: [{ role: 'assistant' as const, content: [{ type: 'image' as const, assetId: 'untrusted-image' }] }] };
        assert.deepEqual(await ingestDetail(account.id, key.conversationId, partial,
            { title: 'Refreshed', titleSource: 'provider', updatedAt: 20 }),
            { accepted: false, changed: false });
        assert.deepEqual(await getDetail(key), { ...original, key });
        assert.deepEqual((await getDetail(key))?.assets.map(asset => asset.id), ['old-image']);
        assert.equal((await getIndex(key))?.title, 'Refreshed', 'Index still accepts new metadata');
        assert.equal((await getIndex(key))?.updatedAt, 20);
    } finally { env.restore(); }
});
