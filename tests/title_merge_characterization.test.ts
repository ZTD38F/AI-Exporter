import { fixtureAccount } from './helpers/domainFixture.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGeminiIndexObservation } from '../src/l1/parsers/gemini/parseIndexObservation.js';
import { mergeConversationIndex, restoreConversationIndex } from '../src/l2/conversationIndex.js';
import { historicalFixture } from './helpers/nativeFixture.js';
import { parseLegacyConversationIndex } from './helpers/recordFixture/parseIndex.js';
import { indexFixture } from './helpers/indexFixture.js';
import { makeConversationIndex } from './helpers/conversationIndexFixture.js';

test('index title authority survives weaker observations and adopts same-tier renames', () => {
    for (const [strong, weak] of [['user', 'provider'], ['provider', 'derived']] as const) {
        const a = makeConversationIndex({ key: { conversationId: 'title-order' }, title: 'Authority', titleSource: strong });
        const b = makeConversationIndex({ key: a.key, title: 'Fallback', titleSource: weak });
        for (const [old, incoming] of [[a, b], [b, a]]) {
            const result = mergeConversationIndex(old, incoming);
            assert.equal(result.title, 'Authority');
            assert.equal(result.titleSource, strong, 'the surviving title and authority source must stay consistent');
        }
        const renamed = mergeConversationIndex(a, { ...a, title: 'Renamed authority' });
        assert.equal(renamed.title, 'Renamed authority');
        assert.equal(renamed.titleSource, strong);
    }
});
test('placeholder and malformed provenance are handled before index merging', () => {
    const old = makeConversationIndex({ key: { conversationId: 'empty-title' }, title: 'Stored RPC title', titleSource: 'provider' });
    for (const title of ['', '   ', '\t\n', 'Google Gemini']) {
        const incoming = parseGeminiIndexObservation({ id: old.key.conversationId, title, titleSource: 'rpc' }, 'detail');
        assert.equal(incoming.fields.title, undefined);
        assert.equal(incoming.fields.titleSource, undefined);
        assert.equal(mergeConversationIndex(old, { key: old.key, ...incoming.fields }).title, old.title);
    }
    const dirty = parseLegacyConversationIndex({ id: old.key.conversationId, title: 'Candidate', titleSource: 'export', titles: { made_up: 'Injected title' } }, fixtureAccount());
    assert.equal(dirty.titleSource, 'derived');
    assert.equal(Object.hasOwn(dirty, 'titles'), false);
});
test('index merging preserves independent times, sampled counts, and import history without extension fields', () => {
    const old = indexFixture({ id: 'merge-fields', title: 'RPC title', titleSource: 'rpc', updatedAt: 5000, createdAt: 2000, messageCount: 8 });
    const incoming = restoreConversationIndex(historicalFixture({ id: old.key.conversationId, title: 'Offline title', titleSource: 'takeout',
        messages: [{ role: 'user', content: 'Question' }, { role: 'model', content: 'Answer' }] }).conversation.index);
    const result = mergeConversationIndex(old, incoming);
    assert.equal(result.updatedAt, 5000);
    assert.equal(result.createdAt, 2000, 'Takeout message times cannot replace metadata creation');
    assert.equal(Reflect.get(result ?? {}, 'messageCount'), undefined);
    assert.equal(Reflect.get(result ?? {}, 'hasTakeoutImport'), undefined);
    assert.deepEqual(result, old, 'weaker imported metadata does not change the canonical index');
    for (const field of ['messages', 'turns', 'lastSeen', 'extensionData', 'timestamp', 'titles']) assert.equal(Object.hasOwn(result, field), false);
});
test('legacy aliases are normalized once; missing source facts remain missing', () => {
    const index = parseLegacyConversationIndex({ id: 'c_legacy123', title: 'Historical title', updatedAt: 'invalid', timestamp: '1700000000', createdAt: 0, lastSeen: 9999999999999 }, fixtureAccount());
    assert.equal(index.key.conversationId, 'legacy123');
    assert.equal(index.updatedAt, 1700000000000);
    assert.equal(index.createdAt, 0);
    const unknown = parseLegacyConversationIndex({ id: 'unknown-time', title: 'Untimed title', lastSeen: 9999999999999, messageCount: 100, turns: [1, 2] }, fixtureAccount());
    assert.equal(unknown.updatedAt, undefined);
    assert.equal(unknown.createdAt, undefined);
    assert.equal(Reflect.get(unknown ?? {}, 'messageCount'), undefined, 'mixed historical counts are not promoted to message facts');
});


test('historical import source survives authoritative title replacement without a candidate map', () => {
    const index = parseLegacyConversationIndex({ id: 'import-history', title: 'Online rename', titleSource: 'rpc', source: 'takeout-import' }, fixtureAccount());
    assert.equal(Reflect.get(index ?? {}, 'hasTakeoutImport'), undefined);
    assert.equal(index.titleSource, 'provider');
    assert.equal(index.title, 'Online rename');
    assert.equal(Object.hasOwn(index, 'source'), false);
});
