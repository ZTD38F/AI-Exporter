import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { JsonValue } from '../src/shared/utils/jsonTypes.js';
import { extractImageEvidence } from '../src/l1/parsers/gemini/rpc/sourceAttachments.js';

test('Gemini image source evidence preserves a JSON-only wire snapshot', () => {
    const tuple = [
        'https://lh3.googleusercontent.com/source-evidence',
        640, 480, 'image-token',
        { nested: [null, true, 7, 'text', { captured: 'value' }] },
    ];
    const [image] = extractImageEvidence([tuple]);
    assert.ok(image);
    assert.equal(image.sourceEvidence?.detectorKind, 'extractImages [url,w,h]');
    const jsonSnapshot: JsonValue | undefined = image.sourceEvidence?.node;
    assert.deepEqual(jsonSnapshot, tuple);
    assert.deepEqual(JSON.parse(JSON.stringify(jsonSnapshot)), tuple);
});

test('Gemini oversized image evidence remains a bounded JSON diagnostic preview', () => {
    const tuple = [
        'https://lh3.googleusercontent.com/source-evidence-large',
        640, 480, 'image-token',
        'X'.repeat(13000),
    ];
    const [image] = extractImageEvidence([tuple]);
    assert.ok(image);
    assert.deepEqual(image.sourceEvidence?.node, {
        truncated: true,
        preview: JSON.stringify(tuple).slice(0, 12000),
    });
    assert.equal(JSON.stringify(image.sourceEvidence?.node).includes('X'.repeat(13000)), false);
});
