import { fixtureAccount } from './helpers/domainFixture.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGeminiRpcConversation } from '../src/l1/parsers/gemini/rpc/parseConversation.js';
import { parseGeminiTakeoutConversation } from '../src/l1/parsers/gemini/takeout/parseConversation.js';
import { detailGen as geminiDetailGen } from './fixtures/providers/geminiDetail.js';

test('timestamp_honesty - RPC Domain messages omit timestamps when source dates are absent', () => {
    const { conversation } = parseGeminiRpcConversation(geminiDetailGen('G_TIMESTAMP_HONESTY_01'), { account: fixtureAccount('gemini'), providerId: 'gemini' });
    assert.equal(conversation.detail.messages.length, 2);
    assert.equal(Object.hasOwn(conversation, 'updatedAt'), false, 'unknown updatedAt must be omitted');
    assert.equal(Object.hasOwn(conversation, 'createdAt'), false, 'unknown createdAt must be omitted');
    for (const message of conversation.detail.messages) {
        assert.equal(Object.hasOwn(message, 'timestamp'), false, 'unknown message timestamp must be omitted');
    }
});

test('timestamp_honesty - Takeout Domain messages omit dates instead of fabricating now', () => {
    const htmlText = `<div class="outer-cell"><a href="https://gemini.google.com/app/no_timestamp">Chat</a>
        <div class="content-cell mdl-cell mdl-cell--6-col mdl-typography--body-1">Prompted Question<br><p>Answer</p></div></div>`;
    const { conversation } = parseGeminiTakeoutConversation({ htmlText }, { account: fixtureAccount('gemini'), providerId: 'gemini' });
    assert.equal(conversation.detail.messages.length, 2);
    assert.equal(Object.hasOwn(conversation, 'updatedAt'), false, 'unknown updatedAt must be omitted');
    assert.equal(Object.hasOwn(conversation, 'createdAt'), false, 'unknown createdAt must be omitted');
    for (const message of conversation.detail.messages) {
        assert.equal(Object.hasOwn(message, 'timestamp'), false, 'unknown message timestamp must be omitted');
    }
});
