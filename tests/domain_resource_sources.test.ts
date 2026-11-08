import test from 'node:test';
import assert from 'node:assert/strict';
import type { HistoricalConversation as Conversation } from './helpers/historicalConversation.js';
import { historicalFixture } from './helpers/nativeFixture.js';
import { planExportPaths } from '../src/l4/packaging/index.js';
import type { PreparedResources } from '../src/shared/resources/resourceResult.js';

const base = { id: 'resource-sources', title: '', timestamp: null };

test('renaming source archive paths cannot change Domain identity or Packaging destinations', async () => {
    const input: Conversation = { ...base, messages: [{ role: 'model', content: '![caption](old/photo.png)', attachments: [{
        type: 'image', name: 'Authored photo', url: 'https://example.test/photo', localName: 'old/photo.png',
        isGenerated: true, generation: { chatId: base.id, generationOrdinal: 1, imageOrdinal: 0 },
    }] }] };
    const before = structuredClone(input);
    const renamed = structuredClone(input);
    renamed.messages![0].content = '![caption](new/photo.webp)';
    renamed.messages![0].attachments![0].localName = 'new/photo.webp';
    const first = historicalFixture(input), second = historicalFixture(renamed);
    assert.deepEqual(first.conversation, second.conversation);
    assert.deepEqual(input, before);
    const asset = first.conversation.detail.assets[0];
    assert.deepEqual(asset.sourceUri, 'https://example.test/photo');
    assert.equal(asset.name, 'Authored photo');
    const prepared: PreparedResources = new Map([[asset.id, { ok: true, resourceId: asset.id, value: { bytes: new Uint8Array([1]), mediaType: 'image/png' } }]]);
    const firstPlan = planExportPaths([{ conversation: first.conversation, prepared, fileIds: new Set<string>() }], 'markdown')[0];
    const secondPlan = planExportPaths([{ conversation: second.conversation, prepared, fileIds: new Set<string>() }], 'markdown')[0];
    assert.deepEqual(firstPlan, secondPlan);
    assert.ok(firstPlan.resources[asset.id].endsWith('Authored photo.png'));
    assert.ok(!JSON.stringify(firstPlan).includes('old/photo'));
    const restored = JSON.parse(JSON.stringify(first.conversation));
    assert.deepEqual(restored, first.conversation);
    assert.deepEqual(planExportPaths([{ conversation: restored, prepared, fileIds: new Set<string>() }], 'markdown')[0], firstPlan);
});

test('same export destination cannot collapse resources from different sources', () => {
    const { conversation } = historicalFixture({ ...base, messages: [{ role: 'user', content: '', attachments: [
        { type: 'image', url: 'https://example.test/one', localName: 'assets/same.png' },
        { type: 'image', url: 'https://example.test/two', localName: 'assets/same.png' },
    ] }] });
    assert.equal(conversation.detail.assets.length, 2);
    assert.notEqual(conversation.detail.assets[0].id, conversation.detail.assets[1].id);
});

test('one source remains one resource across renamed legacy destinations', () => {
    const { conversation } = historicalFixture({ ...base, messages: [
        { role: 'user', content: '![one](one.png)', attachments: [{ type: 'image', url: 'https://example.test/shared', localName: 'one.png' }] },
        { role: 'model', content: '![two](two.png)', images: [{ type: 'image', url: 'https://example.test/shared', localName: 'two.png' }] },
    ] });
    assert.equal(conversation.detail.assets.length, 1);
    assert.deepEqual(conversation.detail.messages[0].attachmentIds, conversation.detail.messages[1].attachmentIds);
    assert.ok(conversation.detail.messages.every(message => JSON.stringify(message.content).includes(conversation.detail.assets[0].id)));
});

test('destination-only resources retain distinct occurrence identities without path/name/kind leakage', () => {
    const input: Conversation = { ...base, messages: [{ role: 'user', content: '', attachments: [
        { type: 'file', localName: 'old/report.pdf' }, { type: 'file', localName: 'old/report.pdf' },
    ] }] };
    const renamed = structuredClone(input);
    renamed.messages![0].attachments!.forEach(item => { item.localName = 'new/image.png'; });
    const first = historicalFixture(input).conversation;
    assert.deepEqual(first, historicalFixture(renamed).conversation);
    assert.equal(first.detail.assets.length, 2);
    assert.ok(first.detail.assets.every(asset => asset.kind === 'file' && !asset.sourceUri && !asset.name));
});

test('ambiguous export aliases remain unresolved instead of becoming acquisition sources', () => {
    const { conversation } = historicalFixture({ ...base, messages: [{
        role: 'user', content: '![caption](same.png)', attachments: [
            { type: 'image', url: 'https://example.test/one', localName: 'same.png' },
            { type: 'image', url: 'https://example.test/two', localName: 'same.png' },
        ],
    }] });
    assert.equal(conversation.detail.assets.length, 3);
    assert.equal(conversation.detail.assets[2].sourceUri, undefined);
});
