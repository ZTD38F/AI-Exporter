import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseList } from '../src/l1/parsers/gemini/rpc/parseList.js';
import { compareConversationIndexes, indexActivityTime, mergeConversationIndex } from '../src/l2/conversationIndex.js';
import { indexFixture } from './helpers/indexFixture.js';
import { makeConversationIndex } from './helpers/conversationIndexFixture.js';
import { listGen as geminiListGen } from './fixtures/providers/gemini.js';

test('index ordering prioritizes authored activity over creation and leaves unknown times after known times', () => {
    const records = [makeConversationIndex({ key: { conversationId: 'recent' }, title: 'Recent', createdAt: 5000 }), indexFixture({ id: 'unknown-time', title: 'Unknown', lastSeen: 99999 }),
        makeConversationIndex({ key: { conversationId: 'revived' }, title: 'Revived', createdAt: 1000, updatedAt: 6000 })];
    assert.deepEqual(records.sort(compareConversationIndexes).map(item => item.key.conversationId), ['revived', 'recent', 'unknown-time']);
    assert.equal(indexActivityTime(records[2]), undefined);
});
test('index ordering preserves established array order on ties including missing activity', () => {
    const records = ['third', 'first', 'second'].map(id => makeConversationIndex({ key: { conversationId: id }, title: id }));
    assert.deepEqual(records.sort(compareConversationIndexes).map(item => item.key.conversationId), ['third', 'first', 'second']);
    assert.equal(compareConversationIndexes({ ...records[0], updatedAt: 0 }, records[1]), -1);
});
test('reviving an old conversation monotonically advances activity without changing creation', () => {
    const old = makeConversationIndex({ key: { conversationId: 'revived' }, title: 'Revived', createdAt: 1000, updatedAt: 2000 });
    const newer = mergeConversationIndex(old, makeConversationIndex({ ...old, updatedAt: 5000 }));
    assert.equal(newer.createdAt, 1000);
    assert.equal(newer.updatedAt, 5000);
    assert.equal(mergeConversationIndex(newer, old).updatedAt, 5000);
});
test('list parsing provides strict indexes and independent source times, with no invented counts or aliases', () => {
    const wire = geminiListGen('G_CONVERSATION_ORDER_01');
    const index = parseList(wire).conversations[0];
    assert.equal(index.updatedAt, 1700000000000);
    assert.equal(index.createdAt, undefined);
    assert.equal(index.messageCount, undefined, 'RPC turn count is not a message count');
    assert.equal(Reflect.get(index ?? {}, 'cloudAvailability'), undefined);
    for (const key of ['timestamp', 'chatTime', 'titles', 'messages', 'lastSeen']) assert.equal(Object.hasOwn(index, key), false);
});


test('only the canonical source update version drives activity', () => {
    const list = makeConversationIndex({ key: { conversationId: 'chat' }, updatedAt: 100 });
    assert.equal(indexActivityTime(list), 100);
    assert.equal(indexActivityTime({ ...list, updatedAt: 300 }), 300);
    assert.equal(indexActivityTime({ ...list, updatedAt: undefined }), undefined);
    assert.equal(mergeConversationIndex(list, { ...list, updatedAt: 50 }).updatedAt, 100);
});
