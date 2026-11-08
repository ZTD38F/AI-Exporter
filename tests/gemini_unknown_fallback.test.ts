import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatUnknownPayload } from '../src/l1/parsers/gemini/shared/unknownFallback.js';

test('Gemini unknown-content fallback is deterministic and does not mutate source evidence', () => {
    const raw = { z: [1, null, { b: true, a: 'x' }], a: 'hi' };
    const original = structuredClone(raw);
    assert.deepEqual(formatUnknownPayload(raw), {
        text: '{"a": "hi", "z": [1, null, {"a": "x", "b": true}]}',
        truncated: false,
    });
    assert.deepEqual(raw, original);
});

test('Gemini unknown-content fallback handles undefined inputs without an unchecked assertion', () => {
    const unreadable = { text: '[unprintable payload]', truncated: false };
    assert.deepEqual(formatUnknownPayload(undefined), unreadable);
    assert.deepEqual(formatUnknownPayload({ nested: undefined }), unreadable);
    assert.deepEqual(formatUnknownPayload([undefined]), unreadable);
    assert.deepEqual(formatUnknownPayload(null), { text: 'null', truncated: false });
});

test('Gemini unknown-content fallback retains the bounded output contract', () => {
    const result = formatUnknownPayload({ message: 'x'.repeat(3000) });
    assert.equal(result.truncated, true);
    assert.equal(result.text.length, 2001);
    assert.ok(result.text.endsWith('…'));
    const nested = { a: { b: { c: { d: { e: 'hidden' } } } } };
    assert.ok(!formatUnknownPayload(nested).text.includes('hidden'));
});
