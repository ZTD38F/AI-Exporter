/** Image validation and binary mounting use only Document AST + ResourceBytess. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileDocumentPdf } from '../src/l4/format/pdf/compileDocumentPdf.js';
import { MAX_ASSET_BYTES } from '../src/l4/format/resources/imageContent.js';
import { missingResource, type ResourceFailure, type ResourceBytes } from '../src/shared/resources/resourceResult.js';
import type { DocumentAst } from '../src/l3b/ast/ast.js';
async function mount(resources: Record<string, ResourceBytes | ResourceFailure>, ids = Object.keys(resources)) {
    const document: DocumentAst = { title: 'Image matrix', metadata: { id: 'fixture', provider: 'test' }, messages: [{ role: 'assistant', blocks: ids.map(resourceId => ({ type: 'image', resourceId, alt: resourceId })) }] };
    const before = JSON.stringify(document);
    const prepared = new Map(Object.entries(resources).map(([resourceId, value]) => [resourceId, 'ok' in value ? value : { ok: true as const, resourceId, value }]));
    const bindings = Object.fromEntries(ids.map(id => [id, `assets/${id}.fixture`]));
    const pathMap = new Map<string, string>();
    const mounts: Array<{ bytes: Uint8Array }> = [];
    const result = await compileDocumentPdf(document, bindings, prepared, {
        name: 'image-check-probe', async compile(payload, context) {
            for (const [id, path] of payload.assetPaths) {
                assert.equal(path, bindings[id], 'Format must preserve Packaging paths');
                pathMap.set(id, path);
                const mounted = await context.assets.resolve(id);
                assert.ok(mounted?.bytes);
                mounts.push({ bytes: mounted.bytes });
            }
            return { pdfBytes: new TextEncoder().encode('%PDF-1.7\n' + ' '.repeat(80)), diagnostics: [] };
        },
    }, { signal: new AbortController().signal, reportProgress() {} });
    assert.equal(JSON.stringify(document), before);
    return { pathMap, mounts, diagnostics: result.diagnostics };
}
function codesFor(result: Awaited<ReturnType<typeof mount>>, id: string) { return result.diagnostics.filter(d => d.path === `asset:${id}`).map(d => d.code); }
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


test('PDF uses the supplied path and retains validated bytes without hashing', async () => {
    const bytes = pngBytes();
    const result = await mount({ a: { bytes, name: 'pic.png', mediaType: 'image/png' } });
    assert.equal(result.pathMap.get('a'), 'assets/a.fixture');
    assert.equal(result.mounts[0].bytes, bytes);
    assert.deepEqual(result.diagnostics, []);
});
for (const [id, resource, code] of [
    ['corrupt', { bytes: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), mediaType: 'image/png', name: 'x.png' }, 'ASSET_CORRUPT'],
    ['tiff', { bytes: new Uint8Array([7, 7, 7, 7]), mediaType: 'image/tiff', name: 'x.tiff' }, 'ASSET_UNSUPPORTED_MIME'],
    ['untyped', { bytes: new Uint8Array([9, 9, 9, 9]), name: 'blob' }, 'ASSET_UNSUPPORTED_MIME'],
    ['zero', { bytes: new Uint8Array(), mediaType: 'image/png' }, 'ASSET_ZERO_BYTES'],
] as const) {
    test(`invalid image is omitted with a diagnostic: ${id}`, async () => {
        const result = await mount({ [id]: resource });
        assert.equal(result.pathMap.get(id), undefined);
        assert.deepEqual(codesFor(result, id), [code, 'FORMAT_CONTENT_OMITTED']);
    });
}
test('same filenames or duplicate bytes never change Packaging paths', async () => {
    const one = pngBytes(16, 1), two = pngBytes(16, 2);
    const result = await mount({ a: { name: 'a.png', bytes: one }, b: { name: 'a.png', bytes: two }, c: { name: 'other.png', bytes: one } });
    assert.notEqual(result.pathMap.get('a'), result.pathMap.get('b'));
    assert.notEqual(result.pathMap.get('a'), result.pathMap.get('c'));
    assert.equal(result.pathMap.size, 3);
    assert.equal(result.mounts.length, 3);
});
test('multi-MB images below the binary size limit retain their complete bytes', async () => {
    const bytes = pngBytes(2 * 1024 * 1024);
    const result = await mount({ big: { bytes, mediaType: 'image/png' } });
    assert.ok(result.pathMap.get('big'));
    assert.equal(result.mounts[0].bytes.length, bytes.length);
});
test('50 MiB binary gate accepts the actual boundary and rejects one byte above it', async () => {
    assert.equal(MAX_ASSET_BYTES, 50 * 1024 * 1024);
    const edge = pngBytes(MAX_ASSET_BYTES - PNG_MAGIC.length);
    const passed = await mount({ edge: { bytes: edge, mediaType: 'image/png' } });
    assert.ok(passed.pathMap.get('edge'));
    const over = new Uint8Array(MAX_ASSET_BYTES + 1);
    const refused = await mount({ huge: { bytes: over, mediaType: 'image/png' } });
    assert.equal(refused.pathMap.size, 0);
    assert.deepEqual(codesFor(refused, 'huge'), ['ASSET_TOO_LARGE', 'FORMAT_CONTENT_OMITTED']);
});
test('unprepared, absent and failed images never acquire bytes in the offline stage', async () => {
    const previous = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('resourceStage must never fetch'); };
    try {
        const result = await mount({ remote: missingResource('remote', 'no network fetch'), missing: missingResource('missing', 'evicted from cache'), failed: missingResource('failed', 'decode error'), notFetched: missingResource('notFetched', 'no network fetch') }, ['remote', 'missing', 'failed', 'notFetched', 'absent']);
        assert.equal(result.pathMap.size, 0);
        assert.equal(result.diagnostics.filter(d => d.code === 'TYPST_V8_IMAGE_MISSING').length, 5);

    } finally { globalThis.fetch = previous; }
});
test('validated image type wins over conflicting names and MIME metadata', async () => {
    const result = await mount({ extension: { bytes: pngBytes(), name: 'photo.jpg', mediaType: 'image/png' }, mime: { bytes: pngBytes(), name: 'x.jpg', mediaType: 'image/jpeg' } });
    assert.equal(result.pathMap.get('extension'), 'assets/extension.fixture');
    assert.deepEqual(codesFor(result, 'extension'), ['ASSET_EXTENSION_MISMATCH']);
    assert.equal(result.pathMap.get('mime'), 'assets/mime.fixture');
    assert.ok(codesFor(result, 'mime').includes('ASSET_MIME_MISMATCH'));
    assert.ok(codesFor(result, 'mime').includes('ASSET_EXTENSION_MISMATCH'));
});
test('SVG and JPEG aliases are validated without renaming Packaging paths', async () => {
    const result = await mount({ svg: { bytes: svgBytes(), mediaType: 'image/svg+xml', name: 'v.svg' }, jpeg: { bytes: jpegBytes(), mediaType: 'image/jpg', name: 'p.jpeg' } });
    assert.equal(result.pathMap.get('svg'), 'assets/svg.fixture');
    assert.equal(result.pathMap.get('jpeg'), 'assets/jpeg.fixture');
    assert.deepEqual(codesFor(result, 'svg'), []);
});
test('Packaging paths are stable across separate compilations', async () => {
    const resources = { k: { bytes: pngBytes(32, 7), mediaType: 'image/png' } };
    assert.deepEqual((await mount(resources)).pathMap, (await mount(resources)).pathMap);
});
test('an unavailable hasher cannot interfere with PDF Format', async () => {
    const previous = crypto.subtle.digest;
    crypto.subtle.digest = async () => { throw new Error('PDF must not hash'); };
    try {
        const result = await mount({ hash: { bytes: pngBytes(), mediaType: 'image/png' } });
        assert.equal(result.pathMap.get('hash'), 'assets/hash.fixture');
        assert.deepEqual(result.diagnostics, []);
    } finally { crypto.subtle.digest = previous; }
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
        const result = await mount({ [id]: { mediaType: 'image/svg+xml', name: 'v.svg', bytes: Buffer.from(text, 'utf8') } });
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
        const result = await mount({ [id]: { mediaType: 'image/svg+xml', name: 'v.svg', bytes: Buffer.from(content, 'utf8') } });
        assert.equal(result.pathMap.get(id), `assets/${id}.fixture`, `${id} must resolve as SVG, got diagnostics: ${JSON.stringify(codesFor(result, id))}`);
        assert.deepStrictEqual(codesFor(result, id), [], `${id} must resolve cleanly`);
    }
});

test('svg sniff: unterminated prolog or duplicate xml declaration is refused', async () => {
    const cases: Array<[string, string]> = [
        ['10000000-0000-4000-8000-000000000002', '<!-- never closed <svg/>'],
        ['10000000-0000-4000-8000-000000000003', '<?xml version="1.0"'],
        ['10000000-0000-4000-8000-000000000004', '<?xml version="1.0"?><?xml version="1.0"?><svg/>'],
    ];
    for (const [id, text] of cases) {
        const result = await mount({ [id]: { mediaType: 'image/svg+xml', name: 'v.svg', bytes: Buffer.from(text, 'utf8') } });
        assert.strictEqual(result.pathMap.get(id), undefined, `${id} must be refused`);
        assert.ok(codesFor(result, id).length > 0, `${id} refusal must carry a diagnostic`);
    }
});
