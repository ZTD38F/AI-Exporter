import { fixtureAccount } from './helpers/domainFixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLegacyConversationIndex } from './helpers/recordFixture/parseIndex.js';
import { mergeConversationIndex } from '../src/l2/conversationIndex.js';

for (const source of ['openai', 'sniff', 'api-detail', 'rpc', 'takeout', 'dom'] as const) {
    test(`legacy ${source} title candidate resolves before entering Domain`, () => {
        const old = parseLegacyConversationIndex({ id: 'chat', title: 'Historical fallback title', titles: { [source]: 'Authoritative title' } }, fixtureAccount());
        const incoming = parseLegacyConversationIndex({ id: 'chat', title: 'New fallback title' }, fixtureAccount());
        const merged = mergeConversationIndex(old, incoming);
        assert.equal(merged.title, ['sniff', 'takeout'].includes(source) ? 'New fallback title' : 'Authoritative title');
        assert.equal(merged.titleSource, ['openai', 'api-detail', 'rpc', 'dom'].includes(source) ? 'provider' : 'derived');
        assert.equal('titles' in merged, false);
    });
}
test('a historical title without provenance becomes an explicit legacy candidate', () => {
    const index = parseLegacyConversationIndex({ id: 'chat', title: 'Historical title' }, fixtureAccount());
    assert.equal(index.title, 'Historical title');
    assert.equal(index.titleSource, 'derived');
});
