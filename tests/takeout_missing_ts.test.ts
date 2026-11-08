import test from 'node:test';
import assert from 'node:assert/strict';
import { activityHtml } from './helpers/l1SourceFixture.js';
import { parseGeminiTakeoutArchive, parseGeminiTakeoutConversation } from '../src/l1/parsers/gemini/takeout/parseConversation.js';
test('untimed Takeout source has no invented activity, savedAt or sourceVersion', () => {
    const [parsed] = parseGeminiTakeoutArchive({ htmlText: activityHtml('<p>Answer</p>', 'NoTimestamp_4242', '') }, { providerId: 'gemini' });
    assert.equal(parsed.sourceVersion, undefined);
    assert.equal('updatedAt' in parsed.conversation.index, false);
    assert.equal('savedAt' in parsed.conversation.detail, false);
    assert.equal('key' in parsed.conversation.detail, false);
});

test('dated Takeout keeps activity for display, never supplies an online update or body version', () => {
    const htmlText = '<div class="outer-cell"><div class="content-cell">Prompted Question<br>Dec 19, 2025, 8:23:56 AM UTC<br><p>Answer</p></div><div class="content-cell mdl-typography--caption">https://gemini.google.com/app/version_chat</div></div>';
    const parsed = parseGeminiTakeoutConversation({ htmlText }, { providerId: 'gemini', targetConvId: 'version_chat' });
    assert.equal(parsed.conversation.index.activityAt, 1766132636000);
    assert.equal(parsed.conversation.detail.messages.length, 2);
    assert.equal(parsed.conversation.detail.messages[0].timestamp, 1766132636000);
    assert.equal('updatedAt' in parsed.conversation.index, false);
    assert.equal('savedAt' in parsed.conversation.detail, false);
    assert.equal('sourceVersion' in parsed, false);
});
