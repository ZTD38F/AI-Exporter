import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useIndexStorage } from './helpers/indexStorage.js';
import { fixtureKey } from './helpers/domainFixture.js';
import { activityHtml, sourceDetail } from './helpers/l1SourceFixture.js';
import { parseGeminiTakeoutArchive } from '../src/l1/parsers/gemini/takeout/parseConversation.js';
import { ingestDetail } from '../src/l2/ingestion.js';
import { getIndex, getDetail } from '../src/l3a/storageService.js';
import { compareConversationIndexes, restoreConversationIndex } from '../src/l2/conversationIndex.js';

useIndexStorage();
const id = 'source_chat_123';
const key = fixtureKey(id);
const archive = () => parseGeminiTakeoutArchive({ htmlText: activityHtml('<p>Archive answer</p>', id, '2026-09-02T12:00:00Z') }, { providerId: 'gemini' })[0];

test('Takeout first, online later accepts a lower source version and retains the independent display date', async () => {
    const takeout = archive();
    await ingestDetail(key.accountId, id, takeout.conversation.detail, takeout.conversation.index);
    assert.equal((await getIndex(key))?.updatedAt, undefined);
    assert.equal((await getDetail(key))?.savedAt, undefined);
    const online = sourceDetail();
    online.conversation.detail.quality.status = 'partial';
    const admission = await ingestDetail(key.accountId, id, online.conversation.detail, online.conversation.index);
    assert.equal(admission.accepted, true);
    assert.equal((await getIndex(key))?.updatedAt, 1700000000000);
    assert.equal((await getIndex(key))?.activityAt, Date.parse('2026-09-02T12:00:00Z'));
    assert.deepEqual((await getDetail(key))?.messages, online.conversation.detail.messages);
});

test('reimporting Takeout cannot erase a known online version or replace its partial body', async () => {
    const online = sourceDetail();
    online.conversation.detail.quality.status = 'partial';
    await ingestDetail(key.accountId, id, online.conversation.detail, online.conversation.index);
    const takeout = archive();
    const admission = await ingestDetail(key.accountId, id, takeout.conversation.detail, takeout.conversation.index);
    assert.equal(admission.accepted, false);
    assert.equal((await getIndex(key))?.updatedAt, online.sourceVersion);
    assert.equal((await getDetail(key))?.savedAt, online.sourceVersion);
    assert.deepEqual((await getDetail(key))?.messages, online.conversation.detail.messages);
});

test('activity dates survive index validation and affect sorting without becoming versions', () => {
    const takeout = restoreConversationIndex({ key, activityAt: 2000 });
    const online = restoreConversationIndex({ key: fixtureKey('other'), updatedAt: 1000 });
    assert.ok(compareConversationIndexes(takeout, online) < 0);
    assert.equal(takeout.updatedAt, undefined);
    assert.throws(() => restoreConversationIndex({ key, activityAt: NaN }), /schema/);
});
