/**
 * tests/pdf-asset-resolver.test.ts
 * Tier 1 tests for the Phase D-2 real asset resolution pipeline
 * (src/core/export/assets/resolver.ts).
 *
 * Covers the report §9 matrix: normal / local / missing / corrupt /
 * unsupported MIME / filename collision / duplicate content / large /
 * 50MiB gate / remote-only / unavailable / zero-byte, plus
 * MIME-sniff override, extension mismatch, SVG, non-image pass-through,
 * determinism, and the offline iron rule (remote assets are never fetched).
 *
 * The byte source is the per-run InlineByteStore instance passed positionally
 * as resolveAssets(assets, byteStore, options); module-global byte functions
 * are never touched.
 */
export {};
const test = require('node:test');
const assert = require('node:assert');
const nodeCrypto = require('node:crypto');

const {
    resolveAssets,
    buildVirtualAssetPath,
    MAX_ASSET_BYTES,
} = require('../src/core/export/assets/resolver.js');

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_MAGIC = [0xff, 0xd8, 0xff, 0xe0];

function pngBytes(extra = 16, seed = 1): Uint8Array {
    const b = new Uint8Array(PNG_MAGIC.length + extra);
    b.set(PNG_MAGIC, 0);
    for (let i = PNG_MAGIC.length; i < b.length; i++) b[i] = (i * seed) & 0xff;
    return b;
}

function jpegBytes(extra = 16): Uint8Array {
    const b = new Uint8Array(JPEG_MAGIC.length + extra);
    b.set(JPEG_MAGIC, 0);
    for (let i = JPEG_MAGIC.length; i < b.length; i++) b[i] = i & 0xff;
    return b;
}

function svgBytes(): Uint8Array {
    return Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>', 'utf8');
}

function asset(id: string, overrides: any = {}): any {
    return { id, kind: 'image', status: 'available', ...overrides };
}

/**
 * Faithful per-run InlineByteStore per the new contract
 * (put/get/has/clear/entryCount via createInlineByteStore()).
 */
function perRunStore(entries: Record<string, Uint8Array> = {}): any {
    const map = new Map<string, Uint8Array>(Object.entries(entries));
    return {
        put: (ref: string, bytes: Uint8Array) => { map.set(ref, bytes); },
        get: (ref: string) => map.get(ref),
        has: (ref: string) => map.has(ref),
        clear: () => { map.clear(); },
        get entryCount() { return map.size; },
    };
}

function sha256hex(bytes: Uint8Array): string {
    return nodeCrypto.createHash('sha256').update(bytes).digest('hex');
}

function codesFor(result: any, assetId: string): string[] {
    return result.diagnostics.filter((d: any) => d.path === `asset:${assetId}`).map((d: any) => d.code);
}

const PATH_RE = /^assets\/sha256\/[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{64}\.[a-z0-9]+$/;

test('normal: per-run store bytes resolve to a content-addressed virtual path', async () => {
    const bytes = pngBytes();
    const byteStore = perRunStore();
    byteStore.put('inline:a1', bytes);
    assert.strictEqual(byteStore.entryCount, 1);
    const a = asset('a1', { mimeType: 'image/png', name: 'pic.png', storageRef: 'inline:a1' });
    const result = await resolveAssets([a], byteStore);
    const path = result.pathMap.get('a1');
    assert.ok(path, 'expected a path');
    assert.match(path, PATH_RE);
    assert.ok(path.endsWith('.png'), `expected .png extension, got ${path}`);
    const expected = buildVirtualAssetPath(sha256hex(bytes), 'png');
    assert.strictEqual(path, expected, 'path must be the real sha256 content address');
    assert.deepStrictEqual(codesFor(result, 'a1'), [], 'clean resolve emits no diagnostics');
    assert.strictEqual(result.effectiveStatus.get('a1'), 'available');
    assert.strictEqual(result.resolved.get('a1').sizeBytes, bytes.length);
    assert.strictEqual(result.resolved.get('a1').mimeType, 'image/png');
});

test('default hasher is the sibling dependency-free SHA-256 (matches node:crypto)', async () => {
    // png magic so the image gate passes; hash covers the full bytes
    const png = pngBytes(8);
    const r = await resolveAssets(
        [asset('v', { mimeType: 'image/png', storageRef: 'inline:v' })],
        perRunStore({ 'inline:v': png }),
    );
    const path = r.pathMap.get('v');
    assert.strictEqual(
        path,
        `assets/sha256/${sha256hex(png).slice(0, 2)}/${sha256hex(png).slice(2, 4)}/${sha256hex(png)}.png`,
    );
});

test('local: archive-local storageRef is read via readLocalFile', async () => {
    const bytes = pngBytes(24);
    const a = asset('loc', { mimeType: 'image/png', name: 'photo.png', storageRef: 'assets/photo.png' });
    const readLocalFile = async (ref: string) => (ref === 'assets/photo.png' ? bytes : undefined);
    const result = await resolveAssets([a], perRunStore(), { readLocalFile });
    const path = result.pathMap.get('loc');
    assert.ok(path && PATH_RE.test(path), `expected virtual path, got ${path}`);
    assert.strictEqual(result.effectiveStatus.get('loc'), 'available');
});

test('local read miss: available + unreadable local file -> missing + diagnostic', async () => {
    const a = asset('locmiss', { storageRef: 'assets/gone.png' });
    const result = await resolveAssets([a], perRunStore(), { readLocalFile: async () => undefined });
    assert.strictEqual(result.pathMap.get('locmiss'), undefined);
    assert.deepStrictEqual(codesFor(result, 'locmiss'), ['PSEUDO_AVAILABLE']);
    assert.strictEqual(result.effectiveStatus.get('locmiss'), 'missing');
});

test('local read throw: reader error is diagnosed, not silent', async () => {
    const a = asset('locerr', { storageRef: 'assets/boom.png' });
    const result = await resolveAssets([a], perRunStore(), {
        readLocalFile: async () => { throw new Error('disk gone'); },
    });
    assert.deepStrictEqual(codesFor(result, 'locerr'), ['ASSET_LOCAL_READ_ERROR', 'PSEUDO_AVAILABLE']);
    assert.strictEqual(result.pathMap.get('locerr'), undefined);
});

test('missing: available with unknown storageRef -> pseudo-available diagnostic', async () => {
    const a = asset('m1', { storageRef: 'inline:nope' });
    for (const bs of [undefined, perRunStore()]) {
        const result = await resolveAssets([a], bs);
        assert.strictEqual(result.pathMap.get('m1'), undefined);
        assert.deepStrictEqual(codesFor(result, 'm1'), ['PSEUDO_AVAILABLE']);
        assert.strictEqual(result.effectiveStatus.get('m1'), 'missing');
    }
    const result = await resolveAssets([a], undefined);
    const d = result.diagnostics.find((x: any) => x.code === 'PSEUDO_AVAILABLE');
    assert.ok(d.message.includes('inline:nope'), 'diagnostic names the storageRef');
});

test('missing: available without any storageRef -> pseudo-available', async () => {
    const a = asset('m2', { mimeType: 'image/png' });
    const result = await resolveAssets([a], perRunStore());
    assert.deepStrictEqual(codesFor(result, 'm2'), ['PSEUDO_AVAILABLE']);
    assert.strictEqual(result.pathMap.get('m2'), undefined);
});

test('missing: storageRef that is a remote URL is not treated as local', async () => {
    const a = asset('m3', { storageRef: 'https://example.com/x.png' });
    let readerCalled = false;
    const result = await resolveAssets([a], perRunStore(), {
        readLocalFile: async () => { readerCalled = true; return undefined; },
    });
    assert.strictEqual(readerCalled, false, 'URL storageRef must not go to the local reader');
    assert.deepStrictEqual(codesFor(result, 'm3'), ['PSEUDO_AVAILABLE']);
});

test('corrupt: declared PNG with garbage bytes -> corrupt, no path', async () => {
    const a = asset('c1', { mimeType: 'image/png', name: 'x.png', storageRef: 'inline:c1' });
    const result = await resolveAssets([a], perRunStore({ 'inline:c1': new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]) }));
    assert.strictEqual(result.pathMap.get('c1'), undefined);
    assert.deepStrictEqual(codesFor(result, 'c1'), ['ASSET_CORRUPT']);
    assert.strictEqual(result.effectiveStatus.get('c1'), 'failed');
});

test('unsupported MIME: image/tiff with garbage bytes -> refused', async () => {
    const a = asset('u1', { mimeType: 'image/tiff', name: 'x.tiff', storageRef: 'inline:u1' });
    const result = await resolveAssets([a], perRunStore({ 'inline:u1': new Uint8Array([7, 7, 7, 7]) }));
    assert.strictEqual(result.pathMap.get('u1'), undefined);
    assert.deepStrictEqual(codesFor(result, 'u1'), ['ASSET_UNSUPPORTED_MIME']);
    assert.strictEqual(result.effectiveStatus.get('u1'), 'failed');
});

test('unsupported MIME: undeclared type with undetectable bytes -> refused', async () => {
    const a = asset('u2', { name: 'blob', storageRef: 'inline:u2' });
    const result = await resolveAssets([a], perRunStore({ 'inline:u2': new Uint8Array([9, 9, 9, 9]) }));
    assert.deepStrictEqual(codesFor(result, 'u2'), ['ASSET_UNSUPPORTED_MIME']);
});

test('filename collision: same name, different content -> different paths', async () => {
    const a = asset('f1', { mimeType: 'image/png', name: 'a.png', storageRef: 'inline:f1' });
    const b = asset('f2', { mimeType: 'image/png', name: 'a.png', storageRef: 'inline:f2' });
    const result = await resolveAssets([a, b], perRunStore({ 'inline:f1': pngBytes(16, 1), 'inline:f2': pngBytes(16, 2) }));
    const p1 = result.pathMap.get('f1');
    const p2 = result.pathMap.get('f2');
    assert.ok(p1 && p2, 'both resolve');
    assert.notStrictEqual(p1, p2, 'content addressing must not collide on filename');
});

test('duplicate content: same bytes -> same path (dedup)', async () => {
    const bytes = pngBytes(20, 3);
    const a = asset('d1', { mimeType: 'image/png', name: 'one.png', storageRef: 'inline:d1' });
    const b = asset('d2', { mimeType: 'image/png', name: 'two.png', storageRef: 'inline:d2' });
    const result = await resolveAssets([a, b], perRunStore({ 'inline:d1': bytes, 'inline:d2': bytes }));
    assert.strictEqual(result.pathMap.get('d1'), result.pathMap.get('d2'));
});

test('large: multi-MB asset under the gate resolves', async () => {
    const bytes = pngBytes(2 * 1024 * 1024);
    const a = asset('big', { mimeType: 'image/png', storageRef: 'inline:big' });
    const result = await resolveAssets([a], perRunStore({ 'inline:big': bytes }));
    assert.ok(result.pathMap.get('big'), 'expected path for large asset');
    assert.strictEqual(result.resolved.get('big').sizeBytes, bytes.length);
});

test('50MiB gate: threshold is an exported constant; over-limit refused with diagnostic', async () => {
    assert.strictEqual(MAX_ASSET_BYTES, 50 * 1024 * 1024, 'threshold constant must be 50MiB');
    const bytes = pngBytes(2048);
    const a = asset('huge', { mimeType: 'image/png', storageRef: 'inline:huge' });
    const result = await resolveAssets([a], perRunStore({ 'inline:huge': bytes }), {
        maxBytes: 1024, // override to exercise the gate logic without a 50MB alloc
    });
    assert.strictEqual(result.pathMap.get('huge'), undefined);
    assert.deepStrictEqual(codesFor(result, 'huge'), ['ASSET_TOO_LARGE']);
    const d = result.diagnostics.find((x: any) => x.code === 'ASSET_TOO_LARGE');
    assert.ok(d.message.includes('1024'), 'diagnostic states the limit');
    assert.strictEqual(result.effectiveStatus.get('huge'), 'failed');
});

test('50MiB gate: asset exactly at the default limit passes', async () => {
    const bytes = pngBytes(100);
    const a = asset('edge', { mimeType: 'image/png', storageRef: 'inline:edge' });
    const result = await resolveAssets([a], perRunStore({ 'inline:edge': bytes }), {
        maxBytes: bytes.length,
    });
    assert.ok(result.pathMap.get('edge'), 'exactly-at-limit must pass (gate is strict >)');
});

test('remote-only: reported, never fetched (offline iron rule)', async () => {
    const a = asset('r1', { status: 'remote', sourceUrl: 'https://lh3.google.com/x.png' });
    const throwingStore: any = {
        has: () => { throw new Error('must not touch byte store for remote'); },
        get: () => { throw new Error('must not touch byte store for remote'); },
    };
    const result = await resolveAssets([a], throwingStore, {
        readLocalFile: async () => { throw new Error('must not read local for remote'); },
    });
    assert.strictEqual(result.pathMap.get('r1'), undefined);
    assert.deepStrictEqual(codesFor(result, 'r1'), ['ASSET_REMOTE_ONLY']);
    const d = result.diagnostics.find((x: any) => x.code === 'ASSET_REMOTE_ONLY');
    assert.strictEqual(d.severity, 'info');
    assert.ok(d.message.includes('no network fetch'), 'diagnostic states the offline rule');
    assert.strictEqual(result.effectiveStatus.get('r1'), 'remote');
});

test('unavailable: missing/failed/notFetched diagnosed, bytes never invented', async () => {
    const missing = asset('x1', { status: 'missing', failureReason: 'evicted from cache' });
    const failed = asset('x2', { status: 'failed', failureReason: 'decode error' });
    const notFetched = asset('x3', { status: 'notFetched' });
    const throwingStore: any = {
        has: () => { throw new Error('must not fetch for unavailable'); },
        get: () => { throw new Error('must not fetch for unavailable'); },
    };
    const result = await resolveAssets([missing, failed, notFetched], throwingStore);
    for (const id of ['x1', 'x2', 'x3']) assert.strictEqual(result.pathMap.get(id), undefined);
    assert.deepStrictEqual(codesFor(result, 'x1'), ['ASSET_UNAVAILABLE']);
    assert.deepStrictEqual(codesFor(result, 'x2'), ['ASSET_UNAVAILABLE']);
    assert.deepStrictEqual(codesFor(result, 'x3'), ['ASSET_UNAVAILABLE']);
    const d1 = result.diagnostics.find((x: any) => x.path === 'asset:x1');
    assert.ok(d1.message.includes('evicted from cache'), 'failureReason is passed through');
    assert.strictEqual(result.diagnostics.find((x: any) => x.path === 'asset:x3').severity, 'info');
    assert.strictEqual(result.effectiveStatus.get('x1'), 'missing');
    assert.strictEqual(result.effectiveStatus.get('x2'), 'failed');
});

test('zero-byte: empty bytes refused with diagnostic', async () => {
    const a = asset('z1', { mimeType: 'image/png', storageRef: 'inline:z1' });
    const result = await resolveAssets([a], perRunStore({ 'inline:z1': new Uint8Array(0) }));
    assert.strictEqual(result.pathMap.get('z1'), undefined);
    assert.deepStrictEqual(codesFor(result, 'z1'), ['ASSET_ZERO_BYTES']);
    assert.strictEqual(result.effectiveStatus.get('z1'), 'failed');
});

test('MIME/extension mismatch: declared png, .jpg name -> warned, path uses validated ext', async () => {
    const bytes = pngBytes();
    const a = asset('mm', { mimeType: 'image/png', name: 'photo.jpg', storageRef: 'inline:mm' });
    const result = await resolveAssets([a], perRunStore({ 'inline:mm': bytes }));
    const path = result.pathMap.get('mm');
    assert.ok(path && path.endsWith('.png'), `expected .png path, got ${path}`);
    assert.deepStrictEqual(codesFor(result, 'mm'), ['ASSET_EXTENSION_MISMATCH']);
});

test('sniffed type wins: declared jpeg but PNG bytes -> warned, still resolves', async () => {
    const bytes = pngBytes();
    const a = asset('sn', { mimeType: 'image/jpeg', name: 'x.jpg', storageRef: 'inline:sn' });
    const result = await resolveAssets([a], perRunStore({ 'inline:sn': bytes }));
    const path = result.pathMap.get('sn');
    assert.ok(path && path.endsWith('.png'), `expected sniffed .png path, got ${path}`);
    const codes = codesFor(result, 'sn');
    assert.ok(codes.includes('ASSET_MIME_MISMATCH'), `expected MIME mismatch warning, got ${codes}`);
    assert.ok(codes.includes('ASSET_EXTENSION_MISMATCH'));
});

test('svg and jpeg alias resolve', async () => {
    const s = asset('svg1', { mimeType: 'image/svg+xml', name: 'v.svg', storageRef: 'inline:svg1' });
    const j = asset('jpg1', { mimeType: 'image/jpg', name: 'p.jpeg', storageRef: 'inline:jpg1' });
    const result = await resolveAssets(
        [s, j],
        perRunStore({ 'inline:svg1': svgBytes(), 'inline:jpg1': jpegBytes() }),
    );
    assert.ok(result.pathMap.get('svg1')?.endsWith('.svg'));
    assert.ok(result.pathMap.get('jpg1')?.endsWith('.jpg'), 'image/jpg alias normalizes to jpeg');
    assert.deepStrictEqual(codesFor(result, 'svg1'), []);
});

test('non-image kind with real bytes gets a content-addressed path (pass-through)', async () => {
    const bytes = Buffer.from('%PDF-1.7 fake', 'utf8');
    const a = asset('pdf1', { kind: 'file', mimeType: 'application/pdf', name: 'doc.pdf', storageRef: 'inline:pdf1' });
    const result = await resolveAssets([a], perRunStore({ 'inline:pdf1': bytes }));
    const path = result.pathMap.get('pdf1');
    assert.ok(path && path.endsWith('.pdf'), `expected .pdf path, got ${path}`);
    assert.deepStrictEqual(codesFor(result, 'pdf1'), []);
});

test('non-image kind without name or MIME falls back to .bin', async () => {
    const bytes = Buffer.from([1, 2, 3, 4]);
    const a = asset('bin1', { kind: 'other', storageRef: 'inline:bin1' });
    const result = await resolveAssets([a], perRunStore({ 'inline:bin1': bytes }));
    assert.ok(result.pathMap.get('bin1')?.endsWith('.bin'));
});

test('determinism: same input -> same pathMap across runs', async () => {
    const mk = () => resolveAssets(
        [asset('k', { mimeType: 'image/png', storageRef: 'inline:k' })],
        perRunStore({ 'inline:k': pngBytes(32, 7) }),
    );
    const r1 = await mk();
    const r2 = await mk();
    assert.strictEqual(r1.pathMap.get('k'), r2.pathMap.get('k'));
});

test('hash failure is diagnosed, never silent', async () => {
    const a = asset('h1', { mimeType: 'image/png', storageRef: 'inline:h1' });
    const result = await resolveAssets([a], perRunStore({ 'inline:h1': pngBytes() }), {
        hashBytes: async () => { throw new Error('no hasher'); },
    });
    assert.strictEqual(result.pathMap.get('h1'), undefined);
    assert.deepStrictEqual(codesFor(result, 'h1'), ['ASSET_HASH_FAILED']);
});

test('every omission carries a diagnostic (no silent drops)', async () => {
    const cases: Array<[string, any, any, any?]> = [
        ['o1', asset('o1', { status: 'remote' }), undefined, undefined],
        ['o2', asset('o2', { status: 'missing' }), undefined, undefined],
        ['o3', asset('o3', { storageRef: 'inline:missing' }), undefined, undefined],
        ['o4', asset('o4', { mimeType: 'image/png', storageRef: 'inline:o4' }),
            perRunStore({ 'inline:o4': new Uint8Array([0]) }), undefined],
        ['o5', asset('o5', { mimeType: 'image/png', storageRef: 'inline:o5' }),
            perRunStore({ 'inline:o5': new Uint8Array(0) }), undefined],
    ];
    for (const [id, a, bs, opts] of cases) {
        const result = await resolveAssets([a], bs, opts);
        assert.strictEqual(result.pathMap.get(id), undefined, `${id} should have no path`);
        const diags = result.diagnostics.filter((d: any) => d.path === `asset:${id}`);
        assert.ok(diags.length > 0, `${id} omission must produce a diagnostic`);
    }
});

test('svg sniff: non-svg markup starting with < is NOT image/svg+xml', async () => {
    const cases: Array<[string, string]> = [
        ['x1', '<html>hello</html>'],
        ['x2', '<foo>bar</foo>'],
        ['x3', '<script>alert(1)</script>'],
        ['x4', '  \n <svgfoo></svgfoo>'],      // looks like svg but is a different tag
        ['x5', '<SVG></SVG>'],                // XML is case-sensitive; <SVG> is not <svg>
    ];
    for (const [id, text] of cases) {
        const a = asset(id, { mimeType: 'image/svg+xml', name: 'v.svg', storageRef: `inline:${id}` });
        const result = await resolveAssets(
            [a],
            perRunStore({ [`inline:${id}`]: Buffer.from(text, 'utf8') }),
        );
        assert.strictEqual(result.pathMap.get(id), undefined, `${id} (${text}) must not resolve as SVG`);
        const codes = codesFor(result, id);
        assert.ok(
            codes.includes('ASSET_CORRUPT') || codes.includes('ASSET_UNSUPPORTED_MIME'),
            `${id} must be refused with a diagnostic, got: ${codes.join(',')}`,
        );
        assert.ok(!result.pathMap.get(id)?.endsWith('.svg'), `${id} must not get a .svg path`);
    }
});

test('svg sniff: xml declaration, comments, doctype and BOM still resolve', async () => {
    const cases: Array<[string, string]> = [
        ['s1', '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>'],
        ['s2', '<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg"/>'],
        ['s3', '<!-- a comment --><svg/>'],
        ['s4', '<!-- one --><!-- two -->\n<svg width="10"/>'],
        ['s5', '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd"><svg/>'],
        ['s6', 'BOM-PLACEHOLDER'],
        ['s7', '  \n\t <svg viewBox="0 0 1 1"/>'],
    ];
    const BOM = '\uFEFF';
    for (const [id, text] of cases) {
        const content = id === 's6' ? BOM + '<svg/>' : text;
        const a = asset(id, { mimeType: 'image/svg+xml', name: 'v.svg', storageRef: `inline:${id}` });
        const result = await resolveAssets(
            [a],
            perRunStore({ [`inline:${id}`]: Buffer.from(content, 'utf8') }),
        );
        assert.ok(result.pathMap.get(id)?.endsWith('.svg'), `${id} must resolve as SVG, got diagnostics: ${JSON.stringify(codesFor(result, id))}`);
        assert.deepStrictEqual(codesFor(result, id), [], `${id} must resolve cleanly`);
    }
});

test('svg sniff: unterminated prolog or duplicate xml declaration is refused', async () => {
    const cases: Array<[string, string]> = [
        ['u1', '<!-- never closed <svg/>'],
        ['u2', '<?xml version="1.0"'],
        ['u3', '<?xml version="1.0"?><?xml version="1.0"?><svg/>'],
    ];
    for (const [id, text] of cases) {
        const a = asset(id, { mimeType: 'image/svg+xml', name: 'v.svg', storageRef: `inline:${id}` });
        const result = await resolveAssets(
            [a],
            perRunStore({ [`inline:${id}`]: Buffer.from(text, 'utf8') }),
        );
        assert.strictEqual(result.pathMap.get(id), undefined, `${id} must be refused`);
        assert.ok(codesFor(result, id).length > 0, `${id} refusal must carry a diagnostic`);
    }
});
