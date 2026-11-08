import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGeminiResponse } from '../src/l1/parsers/gemini/rpc/parseResponse.js';
import { isConfirmedGeminiDetailNotFound } from '../src/l1/parsers/gemini/rpc/parseDeletion.js';
import { listGen } from './fixtures/providers/gemini.js';
import { detailGen } from './fixtures/providers/geminiDetail.js';

const context = { providerId: 'gemini' };

test('mixed batch decodes transport and shared list payload once, preserving detail metadata', () => {
    const text = detailGen('G_DISPATCH_MIXED_01');
    const counts = new Map<string, number>();
    const original = JSON.parse;
    JSON.parse = (text, reviver) => {
        counts.set(text, (counts.get(text) ?? 0) + 1);
        return original(text, reviver);
    };
    try {
        const response = parseGeminiResponse(text);
        assert.equal(response.hasList, true);
        assert.equal(response.hasDetail, true);
        const list = response.list();
        const detail = response.detail(context);
        assert.equal(list.conversations.length, 1);
        assert.equal(detail.conversation.detail.messages.length, 2);
        assert.equal(detail.conversation.index.title, 'Dispatch title');
        assert.equal(detail.sourceVersion, 1700000010000);
        assert.equal(counts.get(text), 1);
        const listJson = response.envelope.rows('MaZiqc')[0][2];
        assert.equal(typeof listJson, 'string');
        if (typeof listJson === 'string') assert.equal(counts.get(listJson), 1);
    } finally { JSON.parse = original; }
});

test('RPC names inside another RPC body never trigger list or detail dispatch', () => {
    const response = parseGeminiResponse(detailGen('G_DISPATCH_DECOY_01'));
    assert.equal(response.hasList, false);
    assert.equal(response.hasDetail, false);
    assert.equal(response.list().failure, 'invalid_response');
    assert.throws(() => response.detail(context), /detail parse fail: invalid/);
});

test('a detail business error cannot recover another RPC body as successful detail', () => {
    const response = parseGeminiResponse(detailGen('G_DISPATCH_DETAIL_ERROR_01'));
    assert.equal(response.hasDetail, true);
    assert.equal(isConfirmedGeminiDetailNotFound(response.envelope), true);
    assert.throws(() => response.detail(context), /detail parse fail: invalid/);
});

test('framed mixed response keeps complete RPC chunks around malformed chunks and unfinished tails', () => {
    const response = parseGeminiResponse(detailGen('G_DISPATCH_CHUNKED_01'));
    assert.equal(response.hasList, true);
    assert.equal(response.hasDetail, true);
    assert.deepEqual(response.list().conversations, []);
    assert.equal(response.detail(context).conversation.detail.messages.length, 2);
});

test('a LIST-only metadata response stays an index observation, never a Detail result', () => {
    const response = parseGeminiResponse(listGen('G_VERSION_METADATA_ONLY_LIST_01'));
    assert.equal(response.hasList, true);
    assert.equal(response.hasDetail, false);
    assert.equal(response.list().conversations[0].id, 'metadata_chat');
    assert.throws(() => response.detail({ ...context, targetConvId: 'metadata_chat' }), /detail parse fail: invalid/);
});
