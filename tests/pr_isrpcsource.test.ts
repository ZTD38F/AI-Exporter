import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeConversationIndex } from './helpers/conversationIndexFixture.js';
import { mergeConversationIndex } from '../src/l2/conversationIndex.js';

test('index activity time is monotonic without a source-specific merge option', () => {
    const old = makeConversationIndex({ key: { conversationId: 'source-independent' }, title: 'Stored', titleSource: 'provider', updatedAt: 2000 });
    for (const [time, expected] of [[1000, 2000], [3000, 3000]] as const) {
        const incoming = makeConversationIndex({ key: { conversationId: old.key.conversationId }, title: 'Stored', titleSource: 'provider', updatedAt: time });
        const merged = mergeConversationIndex(old, incoming);
        assert.equal(merged.updatedAt, expected);
        assert.equal(old.updatedAt, 2000, 'merging must not mutate the stored observation');
    }
});
