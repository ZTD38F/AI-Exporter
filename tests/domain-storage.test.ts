import { getDetail } from '../src/l3a/storageService.js';
import { useIndexStorage } from './helpers/indexStorage.js';
useIndexStorage();
import { admitFixture } from './helpers/admitFixture.js';
import { bindFixture, fixtureAccount, fixtureKey, fixtureAccountFor } from './helpers/domainFixture.js';
import { withRegistry } from './helpers/registryMock.js';
import { parseIndexMetadata } from '../src/l1/parsers/shared/parseIndexMetadata.js';
import { indexFixture } from './helpers/indexFixture.js';
import { composeDomainDocument } from '../src/l3b/compose/composeDomainDocument.js';
import { validateParserDomain } from '../src/l2/runtimeValidation.js';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { storageIdentity } from './helpers/admitFixture.js';
import { readFixture, removeFixture } from './helpers/admitFixture.js';
import { restoreDomainSnapshot as readStorageDomain } from '../src/l2/runtimeValidation.js';
import { parseLegacyStorageConversation } from './helpers/recordFixture/parseConversation.js';
import type { DomainFixture } from './helpers/domainFixture.js';


function source(id = 'chat', count = 2): DomainFixture {
    return { account: fixtureAccount(), sourceVersion: 1700000000000, conversation: validateParserDomain({ index: { key: fixtureKey(String(id), 'gemini'),   titleSource: "derived",   title: 'Stored title' }, detail: { savedAt: 1700000000000, key: fixtureKey(String(id), 'gemini'), quality: { status: 'unknown' }, assets: [{ id: 'asset', kind: 'image', sourceUri: 'source.png' }], messages: Array.from({ length: count }, (_, i) => ({ id: `m${i}`, role: 'assistant', model: 'Source model', content: [{ type: 'paragraph', children: [{ type: 'strong', children: [{ type: 'text', text: `content ${i}` }, { type: 'image', assetId: 'asset' }] }] }], reasoning: [{ type: 'math', source: 'x^2' }], attachmentIds: ['asset'] })) } }), resourceHints: { asset: { archivePath: 'assets/export.png' } }, acquisitionHints: { asset: { url: 'source.png', localName: 'assets/export.png', resolvedUrl: 'https://derived.test/high-res' } }, diagnostics: [{ severity: 'warning', code: 'TEST', message: 'side channel' }] };
}
test('v2 stores structured Domain intact and excludes render/parse transport state', async () => {
    const parsed = source();
    const before = structuredClone(parsed);
    const record = await admitFixture('10000000-0000-4000-8000-000000000001', parsed);
    assert.deepEqual(record.conversation, parsed.conversation);
    assert.equal('index' in (await getDetail(record.conversation.detail.key))!, false);
    assert.equal('revision' in (await getDetail(record.conversation.detail.key))!, false);
    assert.doesNotMatch(JSON.stringify(await getDetail(record.conversation.detail.key)), /archivePath|localName|resolvedUrl|diagnostics/);
    assert.deepEqual(parsed, before);
    record.conversation.detail.messages[0].model = 'mutated';
    assert.equal((await readFixture(storageIdentity('gemini', '10000000-0000-4000-8000-000000000001', 'chat')))!.conversation.detail.messages[0].model, 'Source model');
});
test('accounts and providers isolate identical IDs; non-Gemini IDs remain opaque', async () => {
    assert.deepEqual(storageIdentity('gemini', '10000000-0000-4000-8000-000000000001', 'chat'), storageIdentity('gemini', '10000000-0000-4000-8000-000000000001', 'chat'));
    assert.equal(storageIdentity('future', fixtureAccount('future').id, 'chat').accountId, fixtureAccount('future').id);
    await admitFixture('10000000-0000-4000-8000-000000000001', source());
    assert.equal((await readFixture(storageIdentity('gemini', '10000000-0000-4000-8000-000000000001', 'chat')))!.account.id, '10000000-0000-4000-8000-000000000001');
    const second = bindFixture(source(), '10000000-0000-4000-8000-000000000002'); second.conversation.index.title = 'Other account';
    await admitFixture('10000000-0000-4000-8000-000000000002', second);
    const other = bindFixture(source('chat'), fixtureAccount('future'));
    await admitFixture(other.account.id, other);
    assert.equal((await readFixture(storageIdentity('gemini', '10000000-0000-4000-8000-000000000001', 'chat')))!.conversation.index.title, 'Stored title');
    assert.equal((await readFixture(storageIdentity('gemini', '10000000-0000-4000-8000-000000000002', 'chat')))!.conversation.index.title, 'Other account');
    assert.equal(await readFixture(storageIdentity('future', fixtureAccount('future').id, 'c_chat')), null);
    assert.ok(await readFixture(storageIdentity('future', fixtureAccount('future').id, 'chat')));
});
test('partial/older captures cannot truncate current detail', async () => {
    const full = source('chat', 4); full.conversation.detail.quality.status = 'complete';
    await admitFixture('10000000-0000-4000-8000-000000000001', full);
    const shorter = source('chat', 1); shorter.sourceVersion = 1800000000000;
    await admitFixture('10000000-0000-4000-8000-000000000001', shorter);
    const partial = source('chat', 4); partial.conversation.detail.quality.status = 'partial';
    await admitFixture('10000000-0000-4000-8000-000000000001', partial);
    assert.deepEqual((await readFixture(storageIdentity('gemini', '10000000-0000-4000-8000-000000000001', 'chat')))!.conversation, full.conversation);
    assert.deepEqual((await readFixture(storageIdentity('gemini', '10000000-0000-4000-8000-000000000001', 'chat')))!.conversation, full.conversation);
});

test('persisted contract rejects obsolete fields, malformed content, non-finite values and dangling resources', async () => {
    for (const mutate of [
        (v: Record<string, unknown>) => { v.diagnostics = []; },
        (v: Record<string, unknown>) => { v.timestamp = Infinity; },
        (v: Record<string, unknown>) => { v.messages = [{ role: 'assistant', content: [{ type: 'paragraph', children: [], anchor: 'old' }] }]; },
        (v: Record<string, unknown>) => { v.assets = []; },
        (v: Record<string, unknown>) => { v.messages = [{ role: 'unknown', content: 'text' }]; },
    ]) {
        const v: Record<string, unknown> = structuredClone(source().conversation) as unknown as Record<string, unknown>;
        mutate(v); assert.throws(() => readStorageDomain(v));
    }
});
test('identical captures retain the same Detail facts', async () => {
    const parsed = source();
    const first = await admitFixture('10000000-0000-4000-8000-000000000001', parsed);
    const again = await admitFixture('10000000-0000-4000-8000-000000000001', parsed);
    assert.deepEqual(again.conversation.detail, first.conversation.detail);
});


test('larger partial and unknown captures protect complete body while title arbitration remains independent', async () => {
    const full = source('chat', 2);
    full.conversation.detail.quality.status = 'complete';
    full.conversation.index.titleSource = "provider";
    await admitFixture('10000000-0000-4000-8000-000000000001', full);
    const more = source('chat', 5);
    more.conversation.detail.quality.status = 'partial';
    more.sourceVersion = 1900000000000;
    more.conversation.index.title = 'RPC authoritative title';
    more.conversation.index.titleSource = "provider";
    await admitFixture('10000000-0000-4000-8000-000000000001', more);
    const stored = (await readFixture(storageIdentity('gemini', '10000000-0000-4000-8000-000000000001', 'chat')))!.conversation;
    assert.deepEqual(stored.detail.messages, full.conversation.detail.messages);
    assert.equal(stored.detail.quality.status, 'complete');
    assert.equal('updatedAt' in stored, false);
    assert.equal((await readFixture(storageIdentity('gemini', '10000000-0000-4000-8000-000000000001', 'chat')))!.conversation.detail.savedAt, full.sourceVersion);
    assert.equal(stored.index.title, more.conversation.index.title);
    assert.equal(stored.index.titleSource, 'provider');
    more.conversation.detail.quality.status = 'unknown';
    more.conversation.index.title = 'Weaker incoming title';
    more.conversation.index.titleSource = "derived";
    await admitFixture('10000000-0000-4000-8000-000000000001', more);
    const again = (await readFixture(storageIdentity('gemini', '10000000-0000-4000-8000-000000000001', 'chat')))!.conversation;
    assert.deepEqual(again, stored);
});


test('placeholder sources never displace a real stored title, even when the incoming body wins', async () => {
    for (const title of ['Gemini', 'Google Gemini', 'New chat', '新对话', 'Untitled', 'Untitled Chat', '未命名对话']) {
        const id = `title-${title}`;
        const old = source(id, 2);
        old.conversation.index.title = 'Research question from Takeout';
        old.conversation.index.titleSource = "derived";
        await admitFixture('10000000-0000-4000-8000-000000000001', old);
        const incoming = source(id, 3);
        incoming.conversation.index = { key: incoming.conversation.index.key, ...parseIndexMetadata({ account: fixtureAccount(), providerId: incoming.account.providerId, id: incoming.conversation.index.key.conversationId, title, titleSource: 'rpc' }) };
        await admitFixture('10000000-0000-4000-8000-000000000001', incoming);
        const stored = (await readFixture(storageIdentity('gemini', '10000000-0000-4000-8000-000000000001', id)))!.conversation;
        assert.equal(stored.index.title, old.conversation.index.title, title);
        assert.equal(stored.index.titleSource, 'derived', title);
        assert.deepEqual(stored.detail.messages, incoming.conversation.detail.messages);
    }
});

test('real titles replace higher-ranked placeholders without rejecting short or Takeout prompt titles', async () => {
    for (const title of ['A', 'Research question from Takeout']) {
        const id = `real-${title}`;
        const old = source(id, 2);
        old.conversation.index = { key: old.conversation.index.key, ...parseIndexMetadata({ account: fixtureAccount(), providerId: old.account.providerId, id: old.conversation.index.key.conversationId, title: 'Gemini', titleSource: 'rpc' }) };
        await admitFixture('10000000-0000-4000-8000-000000000001', old);
        const incoming = source(id, 1);
        incoming.conversation.index.title = title;
        incoming.conversation.index.titleSource = "derived";
        await admitFixture('10000000-0000-4000-8000-000000000001', incoming);
        const stored = (await readFixture(storageIdentity('gemini', '10000000-0000-4000-8000-000000000001', id)))!.conversation;
        assert.equal(stored.index.title, title);
        assert.equal(stored.index.titleSource, 'derived');
        assert.deepEqual(stored.detail.messages, incoming.conversation.detail.messages);
    }
});


test('stored repeated source message IDs export without losing or rewriting source messages', async () => {
    const parsed = source('duplicate-identities', 3);
    parsed.conversation.detail.messages.forEach(message => { message.id = 'same'; });
    const original = structuredClone(parsed.conversation);
    await admitFixture('10000000-0000-4000-8000-000000000001', parsed);
    const stored = await readFixture(storageIdentity('gemini', '10000000-0000-4000-8000-000000000001', parsed.conversation.index.key.conversationId));
    assert.ok(stored);
    const document = composeDomainDocument(stored.conversation, fixtureAccountFor(stored.conversation));
    assert.equal(document.messages.length, 3);
    assert.ok(document.messages.every(message => !('id' in message)));
    assert.equal(document.messages.length, original.detail.messages.length);
    assert.deepEqual(stored.conversation, original);
});


test('a partial capture fills an empty metadata placeholder without replacing existing nonpartial bodies', async () => {
    const identity = storageIdentity('gemini', '10000000-0000-4000-8000-000000000001', 'dom-capture');
    const placeholder = source('dom-capture', 0);
    await admitFixture('10000000-0000-4000-8000-000000000001', placeholder);
    const captured = source('dom-capture', 2);
    captured.conversation.detail.quality.status = 'partial';
    await admitFixture('10000000-0000-4000-8000-000000000001', captured);
    assert.deepEqual((await readFixture(identity))!.conversation.detail.messages, captured.conversation.detail.messages);
    const full = source('dom-capture', 3); full.conversation.detail.quality.status = 'complete';
    await admitFixture('10000000-0000-4000-8000-000000000001', full);
    const fragment = source('dom-capture', 5);
    fragment.conversation.detail.quality.status = 'partial';
    await admitFixture('10000000-0000-4000-8000-000000000001', fragment);
    assert.deepEqual((await readFixture(identity))!.conversation.detail.messages, full.conversation.detail.messages);
});
