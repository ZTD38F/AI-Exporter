import test from 'node:test';
import assert from 'node:assert/strict';
import { makeConversationIndex } from './helpers/conversationIndexFixture.js';
import { restoreConversationIndex } from '../src/l2/conversationIndex.js';

test('canonical factory produces legal independent indexes and never shares override keys', () => {
    const key = { conversationId: 'independent' };
    const first = makeConversationIndex({ key, title: 'A', updatedAt: 100 });
    const second = makeConversationIndex({ key, title: 'B' });
    assert.deepEqual(restoreConversationIndex(first), first);
    first.key.conversationId = 'mutated';
    first.title = 'Changed';
    assert.equal(second.key.conversationId, 'independent');
    assert.equal(second.title, 'B');
    assert.equal(key.conversationId, 'independent');
    assert.equal(second.updatedAt, undefined);
    const defaultIndex = makeConversationIndex();
    defaultIndex.key.accountId = 'mutated';
    assert.notEqual(makeConversationIndex().key.accountId, 'mutated');
});
