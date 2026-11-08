export {};
const test = require('node:test');
const assert = require('node:assert');

const zipBombGuard = require('../src/l1/parsers/shared/archive/zipBombGuard.js');


// The full media-index suite covers general matching/slot isolation. This is a
// distinct substring-direction regression: the requested name contains a stored one.
test('p1_h1 - source resolver must not match a filename by substring', () => {
    const { createTakeoutResourceResolver } = require('../src/l1/parsers/gemini/takeout/archiveResources.js');
    const resolve = createTakeoutResourceResolver({ 'cat-photo.png': {} });
    assert.equal(resolve('prefix-cat-photo.png').status, 'missing');
    assert.equal(resolve('cat-photo.png').status, 'resolved');
});

test('p1_h1 - P1-114: zip guards fail closed on unknown size', () => {
    assert.throws(() => zipBombGuard.validateZipFile(undefined), /无法确认|Cannot determine/);
    assert.throws(() => zipBombGuard.validateZipFile({} as any), /无法确认|Cannot determine/);
    assert.throws(() => zipBombGuard.validateZipFile({ size: 600 * 1024 * 1024 }), /过大|too large/i);
    assert.doesNotThrow(() => zipBombGuard.validateZipFile(Buffer.alloc(10) as any), 'Buffer uses .length');
    assert.throws(
        () => zipBombGuard.validateZipEntries({ files: { 'a.txt': { dir: false } } } as any),
        /无法确认未压缩大小|unverified sizes/i
    );
    assert.doesNotThrow(
        () => zipBombGuard.validateZipEntries({ files: { 'a.txt': { dir: false, _data: { uncompressedSize: 10 } } } } as any)
    );
    assert.throws(
        () => zipBombGuard.validateZipEntries({ files: { 'huge.bin': { dir: false, _data: {
            uncompressedSize: 1024 * 1024 * 1024 + 1 // Test the documented 1 GiB limit, not an internal export
        } } } } as any),
        /过大|超过|too large|OOM/i, 'declared uncompressed size must enforce the ZIP bomb cap without allocating bytes'
    );
});

// C2PA marker/date coverage lives in media_index_safety.test.ts and takeout_engine.test.ts.

test('p1_h1 - explicit numeric UTC offsets in English and Chinese Takeout dates', () => {
    const { parseTakeoutTimestamp } = require('../src/l1/parsers/gemini/takeout/decodeHtml.js');
    // Avoid asserting a CST interpretation from prompt language: CST is ambiguous
    // without locale metadata, and a Chinese prompt is not timezone evidence.

    const blockUtc = '<div class="content-cell">Prompted Hello<br>Jul 15, 2024, 2:30:00 PM UTC+8</div>';
    const tsUtc = parseTakeoutTimestamp(blockUtc);
    assert.ok(tsUtc !== null);
    assert.strictEqual(new Date(tsUtc).toISOString(), '2024-07-15T06:30:00.000Z');

    const blockZh = '<div class="content-cell">提示 你好<br>2024年3月15日 下午2:30:00 UTC+8</div>';
    const tsZh = parseTakeoutTimestamp(blockZh);
    assert.ok(tsZh !== null);
    assert.strictEqual(new Date(tsZh).toISOString(), '2024-03-15T06:30:00.000Z');
});

