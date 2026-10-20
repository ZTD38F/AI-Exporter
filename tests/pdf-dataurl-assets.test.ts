/**
 * tests/pdf-dataurl-assets.test.ts
 * Tier 1 tests for data: URL -> byte-backed asset decoding (Scheme B) with
 * the per-run inline byte store.
 *
 * Covers: small base64 image -> 'available' + content-addressed storageRef +
 * bytes retrievable from the run's InlineByteStore + mimeType/sizeBytes/sha256
 * + no sourceUrl + no PSEUDO_AVAILABLE from validateBundle; oversized payload
 * -> guard + diagnostic; malformed URLs -> 'missing' + diagnostic; URL-encoded
 * (non-base64) payloads; http(s) inline images unchanged; store isolation
 * across consecutive normalize calls (session ownership regression).
 */
export {};
const test = require('node:test');
const assert = require('node:assert');

const canonical = require('../src/core/export/canonical/index.js');
const { normalizeGeminiConversation, validateBundle } = canonical;
const assetsApi = require('../src/core/export/assets/index.js');
const { createInlineByteStore, decodeDataUrl, decodeDataUrlAsset } = assetsApi;

// 1x1 transparent PNG, 70 bytes.
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_SHA256 = 'c414cd0e204de974f73753c7e28d7638e7b3691bb8b1a2bab6b25bb7fed7ce77';
const PNG_REF = `assets/sha256/c4/14/${PNG_SHA256}.png`;

function convoWithContent(content: string, id = 'c-dataurl') {
    return {
        id,
        title: 'data url assets',
        messages: [{ id: 'm1', role: 'user', content }],
    };
}

function inlineAssetOf(bundle: any): any {
    assert.strictEqual(bundle.assets.length, 1);
    return bundle.assets[0];
}

test('small base64 data: URL decodes to a byte-backed available asset', async () => {
    const src = `data:image/png;base64,${PNG_B64}`;
    const { bundle, diagnostics, byteStore } = await normalizeGeminiConversation(convoWithContent(`![dot](${src})`));
    const asset = inlineAssetOf(bundle);
    assert.strictEqual(asset.status, 'available');
    assert.strictEqual(asset.storageRef, PNG_REF);
    assert.strictEqual(asset.mimeType, 'image/png');
    assert.strictEqual(asset.sizeBytes, 70);
    assert.strictEqual(asset.sha256, PNG_SHA256);
    assert.ok(!('sourceUrl' in asset), 'full data: URL must not be stored in sourceUrl');
    assert.strictEqual(asset.name, 'dot', 'alt text wins over the derived name');

    const bytes = byteStore.get(asset.storageRef);
    assert.ok(bytes instanceof Uint8Array, 'bytes are retrievable from the run byte store');
    assert.deepStrictEqual(Buffer.from(bytes), Buffer.from(PNG_B64, 'base64'), 'stored bytes match the decoded payload');
    assert.ok(byteStore.has(asset.storageRef));
    assert.strictEqual(byteStore.entryCount, 1);

    const issues = validateBundle(bundle);
    assert.ok(!issues.some((d: any) => d.severity === 'error'), 'no validation errors');
    assert.ok(!issues.some((d: any) => d.code === 'PSEUDO_AVAILABLE'), 'no PSEUDO_AVAILABLE for the byte-backed asset');
    assert.ok(!diagnostics.some((d: any) => d.code === 'DATA_URL_TOO_LARGE' || d.code === 'DATA_URL_MALFORMED'));
});

test('data: URL asset without alt text gets a derived file name', async () => {
    const { bundle } = await normalizeGeminiConversation(convoWithContent(`![](data:image/png;base64,${PNG_B64})`));
    const asset = inlineAssetOf(bundle);
    assert.strictEqual(asset.name, 'image.png');
});

test('URL-encoded (non-base64) data: URL decodes', async () => {
    const payload = '%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%2F%3E';
    const { bundle, byteStore } = await normalizeGeminiConversation(convoWithContent(`![v](data:image/svg+xml,${payload})`));
    const asset = inlineAssetOf(bundle);
    assert.strictEqual(asset.status, 'available');
    assert.strictEqual(asset.mimeType, 'image/svg+xml');
    assert.ok(asset.storageRef.endsWith('.svg'), `storageRef keeps the svg extension: ${asset.storageRef}`);
    const expected = new TextEncoder().encode(decodeURIComponent(payload));
    assert.deepStrictEqual(Buffer.from(byteStore.get(asset.storageRef)!), Buffer.from(expected));
    assert.strictEqual(asset.sizeBytes, expected.length);
    const issues = validateBundle(bundle);
    assert.ok(!issues.some((d: any) => d.code === 'PSEUDO_AVAILABLE'));
});

test('oversized data: URL is refused with DATA_URL_TOO_LARGE', async () => {
    // 10 MiB + 1 byte of decoded payload; the guard fires before allocating.
    const overB64 = 'A'.repeat(Math.ceil((10 * 1024 * 1024 + 1) / 3) * 4);
    const { bundle, diagnostics, byteStore } = await normalizeGeminiConversation(
        convoWithContent(`![big](data:image/png;base64,${overB64})`));
    const asset = inlineAssetOf(bundle);
    assert.strictEqual(asset.status, 'missing');
    assert.ok(asset.failureReason, 'failureReason is set');
    assert.ok(!('storageRef' in asset), 'no storageRef for a refused payload');
    assert.strictEqual(byteStore.entryCount, 0, 'nothing stored');
    const diag = diagnostics.find((d: any) => d.code === 'DATA_URL_TOO_LARGE');
    assert.ok(diag, 'DATA_URL_TOO_LARGE warning diagnostic emitted');
    assert.strictEqual(diag.severity, 'warning');
    const issues = validateBundle(bundle);
    assert.ok(!issues.some((d: any) => d.code === 'ASSET_NO_REASON'), 'missing asset carries a failureReason');
});

test('malformed data: URLs become missing with DATA_URL_MALFORMED', async () => {
    const bad = [
        'data:image/png;base64', // no comma
        'data:image/png;base64,!!!not-base64!!!', // bad base64
        'data:image/png,%zz', // bad percent-encoding
    ];
    for (const src of bad) {
        const { bundle, diagnostics } = await normalizeGeminiConversation(convoWithContent(`![x](${src})`, `c-${bad.indexOf(src)}`));
        const asset = inlineAssetOf(bundle);
        assert.strictEqual(asset.status, 'missing', src);
        assert.ok(asset.failureReason, `failureReason is set for ${src}`);
        assert.ok(diagnostics.some((d: any) => d.code === 'DATA_URL_MALFORMED'), `DATA_URL_MALFORMED for ${src}`);
    }
});

test('http(s) inline images keep the old remote behavior', async () => {
    const src = 'https://example.com/inline.png';
    const { bundle, diagnostics } = await normalizeGeminiConversation(convoWithContent(`![a](${src})`));
    const asset = inlineAssetOf(bundle);
    assert.strictEqual(asset.status, 'remote');
    assert.strictEqual(asset.sourceUrl, src);
    assert.ok(!('storageRef' in asset));
    assert.ok(!diagnostics.some((d: any) => d.code === 'DATA_URL_TOO_LARGE' || d.code === 'DATA_URL_MALFORMED'));
});

test('decodeDataUrlAsset unit checks: header parsing and strictness', async () => {
    const ok = await decodeDataUrlAsset(`data:image/png;base64,${PNG_B64}`);
    assert.ok(ok.ok);
    if (ok.ok) {
        assert.strictEqual(ok.mimeType, 'image/png');
        assert.strictEqual(ok.storageRef, PNG_REF);
        assert.strictEqual(ok.sha256, PNG_SHA256);
        assert.strictEqual(ok.suggestedName, 'image.png');
    }
    // Whitespace inside base64 is insignificant.
    const spaced = await decodeDataUrlAsset(`data:image/png;base64,${PNG_B64.slice(0, 20)} ${PNG_B64.slice(20)}`);
    assert.ok(spaced.ok && spaced.storageRef === PNG_REF);

    const noComma = await decodeDataUrlAsset('data:image/png;base64');
    assert.ok(!noComma.ok && noComma.code === 'DATA_URL_MALFORMED');

    const badPad = await decodeDataUrlAsset('data:image/png;base64,AB=C');
    assert.ok(!badPad.ok && badPad.code === 'DATA_URL_MALFORMED');

    const emptyType = await decodeDataUrlAsset('data:,hello');
    assert.ok(emptyType.ok && emptyType.mimeType === 'application/octet-stream');
    if (emptyType.ok) assert.deepStrictEqual(Buffer.from(emptyType.bytes), Buffer.from('hello'));
});

test('decodeDataUrl stays synchronous and returns bytes without a digest', () => {
    const decoded: any = decodeDataUrl(`data:image/png;base64,${PNG_B64}`);
    assert.ok(decoded.ok);
    assert.strictEqual(decoded.mimeType, 'image/png');
    assert.ok(!('sha256' in decoded), 'sync decode must not compute a digest');
    assert.ok(!('storageRef' in decoded), 'sync decode must not build a storageRef');
    assert.deepStrictEqual(Buffer.from(decoded.bytes), Buffer.from(PNG_B64, 'base64'));
    const bad: any = decodeDataUrl('data:image/png;base64');
    assert.ok(!bad.ok && bad.code === 'DATA_URL_MALFORMED');
});

test('createInlineByteStore: put/get/has/clear/entryCount round-trip', () => {
    const store = createInlineByteStore();
    assert.strictEqual(store.entryCount, 0);
    assert.ok(!store.has('assets/sha256/zz/ref.png'));
    store.put('assets/sha256/zz/ref.png', new Uint8Array([1, 2, 3]));
    assert.strictEqual(store.entryCount, 1);
    assert.ok(store.has('assets/sha256/zz/ref.png'));
    assert.deepStrictEqual(Array.from(store.get('assets/sha256/zz/ref.png')!), [1, 2, 3]);
    // put is idempotent for the same storageRef (content-addressed).
    store.put('assets/sha256/zz/ref.png', new Uint8Array([1, 2, 3]));
    assert.strictEqual(store.entryCount, 1);
    store.clear();
    assert.strictEqual(store.entryCount, 0);
    assert.ok(!store.has('assets/sha256/zz/ref.png'));
    assert.strictEqual(store.get('assets/sha256/zz/ref.png'), undefined);
});

// --- Session-ownership regression: bytes must never linger across runs ---

test('consecutive normalizes: second run store is empty, first-run bytes do not leak', async () => {
    const src = `data:image/png;base64,${PNG_B64}`;
    const first = await normalizeGeminiConversation(convoWithContent(`![dot](${src})`, 'c-first'));
    const firstAsset = inlineAssetOf(first.bundle);
    assert.strictEqual(first.byteStore.entryCount, 1);
    assert.ok(first.byteStore.get(firstAsset.storageRef) instanceof Uint8Array);

    // Second run has no data: URL images at all.
    const second = await normalizeGeminiConversation(convoWithContent('plain text, no images', 'c-second'));
    assert.strictEqual(second.bundle.assets.length, 0);
    assert.strictEqual(second.byteStore.entryCount, 0, 'second run store must be empty');
    assert.strictEqual(second.byteStore.get(firstAsset.storageRef), undefined, 'first-run bytes must not leak into the second run');
    assert.ok(!second.byteStore.has(firstAsset.storageRef));

    // The two runs own distinct store instances.
    assert.ok(second.byteStore !== first.byteStore, 'each run gets its own store instance');

    // And the first run's bytes are still intact on its own store.
    assert.deepStrictEqual(
        Buffer.from(first.byteStore.get(firstAsset.storageRef)!),
        Buffer.from(PNG_B64, 'base64'),
        'first run bytes remain retrievable from its own store',
    );
});

test('same data: URL repeated in one run still dedups (assetIndex behavior)', async () => {
    const src = `data:image/png;base64,${PNG_B64}`;
    const { bundle, byteStore } = await normalizeGeminiConversation(
        convoWithContent(`![one](${src})\n\n![two](${src})`, 'c-dedup'));
    assert.strictEqual(bundle.assets.length, 1, 'one asset for the repeated data: URL');
    assert.strictEqual(byteStore.entryCount, 1, 'bytes stored once');
    assert.ok(byteStore.has(bundle.assets[0].storageRef));
    assert.deepStrictEqual(
        Buffer.from(byteStore.get(bundle.assets[0].storageRef)!),
        Buffer.from(PNG_B64, 'base64'),
    );
});

test('returned byteStore.get(storageRef) returns the decoded bytes', async () => {
    const src = `data:image/png;base64,${PNG_B64}`;
    const { bundle, byteStore } = await normalizeGeminiConversation(convoWithContent(`![dot](${src})`, 'c-get'));
    const asset = inlineAssetOf(bundle);
    const bytes = byteStore.get(asset.storageRef);
    assert.ok(bytes instanceof Uint8Array);
    assert.deepStrictEqual(Buffer.from(bytes), Buffer.from(PNG_B64, 'base64'));
});
