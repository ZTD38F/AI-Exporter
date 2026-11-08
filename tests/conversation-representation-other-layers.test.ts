/**
 * V2 representation and authority regression on actual L2, L3a, L3b and L4.
 * Metadata belongs to Index; Detail.savedAt is source capture evidence.
 * There is no flat v1 chat export DTO or ChatFormatter JSON wrapper.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { useIndexStorage } from './helpers/indexStorage.js';
import { fixtureAccount } from './helpers/domainFixture.js';
import { ingestDetail, ingestIndexes } from '../src/l2/ingestion.js';
import { readConversation } from '../src/l2/readConversation.js';
import { restoreDomainSnapshot } from '../src/l2/runtimeValidation.js';
import { getDetail, getIndex } from '../src/l3a/storageService.js';
import { composeDomainDocument } from '../src/l3b/compose/composeDomainDocument.js';
import { renderDocumentMarkdown } from '../src/l4/format/markdown/renderMarkdown.js';
import { serializeDomainJson } from '../src/l4/format/json/serializeDomainJson.js';

useIndexStorage();
const account = fixtureAccount('gemini');
const key = (conversationId: string) => ({ accountId: account.id, conversationId });
const paragraph = (text: string) => ({ type: 'paragraph' as const, children: [{ type: 'text' as const, text }] });

test('Index rename updates authority while Detail.savedAt and body remain actual immutable source evidence', async () => {
    const id = 'upgraded-conversation';
    await ingestDetail(account.id, id, {
        savedAt: 100, quality: { status: 'complete' }, assets: [],
        messages: [{ role: 'assistant', content: [paragraph('Saved body, never reinterpreted')] }],
    }, { title: 'Snapshot title', titleSource: 'provider', updatedAt: 100 });
    const detailBefore = await getDetail(key(id));
    assert.ok(detailBefore);
    await ingestIndexes(account.id, [{ conversationId: id,
        fields: { title: 'Current rename', titleSource: 'user', updatedAt: 200 } }]);

    const conversation = await readConversation(key(id));
    assert.ok(conversation);
    assert.equal(conversation.index.title, 'Current rename');
    assert.equal(conversation.index.titleSource, 'user');
    assert.equal(conversation.index.updatedAt, 200);
    assert.equal(conversation.detail.savedAt, 100);
    assert.deepEqual(await getDetail(key(id)), detailBefore, 'Index-only updates never modify Detail');
    assert.equal('title' in conversation.detail, false);
    assert.equal('updatedAt' in conversation.detail, false);

    const archive = JSON.parse(serializeDomainJson(conversation, account, {}));
    assert.equal(archive.format, 'gemini-exporter-domain');
    assert.equal(archive.version, 1);
    assert.equal(archive.conversation.index.title, 'Current rename');
    assert.equal(archive.conversation.index.updatedAt, 200);
    assert.equal(archive.conversation.detail.savedAt, 100);
    assert.equal('savedAt' in archive, false, 'a flat v1 source version must not be fabricated');
    assert.deepEqual(archive.conversation.detail, conversation.detail);
    const document = composeDomainDocument(conversation, account);
    assert.equal(document.title, 'Current rename');
    assert.equal(document.metadata.updatedAt, 200);
    assert.match(renderDocumentMarkdown(document, {}), /Saved body, never reinterpreted/);
});

test('cross-layer schema never admits a second title authority into the persisted Detail body', async () => {
    const id = 'closed-schema';
    await ingestDetail(account.id, id, {
        savedAt: 500, quality: { status: 'complete' }, assets: [],
        messages: [{ role: 'assistant', content: [paragraph('Canonical Detail')] }],
    }, { title: 'Canonical Index', titleSource: 'provider', updatedAt: 500 });
    const stored = await readConversation(key(id));
    assert.ok(stored);
    assert.throws(() => restoreDomainSnapshot({
        ...stored, detail: { ...stored.detail, title: 'Second authority' },
    }), /Domain contract/);
    assert.equal((await getIndex(key(id)))?.title, 'Canonical Index');
    assert.equal((await getDetail(key(id)))?.savedAt, 500);
    assert.match(renderDocumentMarkdown(composeDomainDocument(stored, account), {}), /Canonical Detail/);
});
