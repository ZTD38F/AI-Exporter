import test from 'node:test';
import assert from 'node:assert/strict';
import { chatGPTTimestamp } from '../src/l1/parsers/chatgpt/timestamp.js';
import { payloadToMs } from '../src/l1/parsers/gemini/rpc/payload.js';

test('ChatGPT source timestamps normalize seconds and reject unsafe or fabricated time', () => {
    assert.equal(chatGPTTimestamp(1700000000.125), 1700000000125);
    assert.equal(chatGPTTimestamp(1700000000123), 1700000000123);
    assert.equal(chatGPTTimestamp(1700000000.1259), 1700000000125);
    assert.equal(chatGPTTimestamp(1700000000123.9), 1700000000123);
    assert.equal(chatGPTTimestamp('2023-11-14T22:13:20Z'), 1700000000000);
    for (const value of [null, undefined, 0, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 2, 'invalid']) {
        assert.equal(chatGPTTimestamp(value), undefined);
    }
});

test('Gemini native source time accepts characterized tuples but never unsafe epoch values', () => {
    assert.equal(payloadToMs([1700000000, 123456789]), 1700000000123);
    assert.equal(payloadToMs([1792011603, 510828000]), 1792011603510);
    assert.equal(payloadToMs([1700000000, 123999999]), 1700000000123);
    assert.equal(payloadToMs([1700000000, 999999999]), 1700000000999);
    assert.equal(payloadToMs(1700000000.1259), 1700000000125);
    assert.equal(payloadToMs(1700000000123.9), 1700000000123);
    assert.equal(payloadToMs(1700000000), 1700000000000);
    assert.equal(payloadToMs(1700000000123), 1700000000123);
    for (const value of [[1700000000, -1], [1700000000, 1000000000],
        [1700000000, NaN], [Number.MAX_SAFE_INTEGER + 2, 0], 0, -1, NaN, Infinity]) {
        assert.equal(payloadToMs(value), null);
    }
});
