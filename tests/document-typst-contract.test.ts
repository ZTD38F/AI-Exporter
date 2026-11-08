import { fixtureKey, fixtureAccountFor } from './helpers/domainFixture.js';
/**
 * tests/document-typst-contract.test.ts
 * Tier 1 tests for the P1a Domain → Document AST → Typst backend.
 *
 * Covers: block mapping (paragraph/heading/code/table/image/file/unknown),
 * math with and without the controlled convertMath hook, missing-asset
 * diagnostics, heading clamp diagnostics, branch linearization refusal,
 * and the injection red line (hostile text stays inert JSON data).
 */
export {};
const test = require('node:test');
const assert = require('node:assert');

const { composeDomainDocument } = require('../src/l3b/compose/composeDomainDocument.js');
const { renderTypstFixture } = require('./helpers/renderTypstFixture.js');

function domainFixture(messages: any[], extra: any = {}) {
    const createdAt = require('../src/l1/parsers/shared/time.js').normalizeTimestamp('createdAt' in extra ? extra.createdAt : Date.parse('2026-09-20T10:00:00Z'));
    const updatedAt = require('../src/l1/parsers/shared/time.js').normalizeTimestamp(extra.updatedAt);
    return { index: { key: fixtureKey(String('c1'), 'gemini'),   title: 'Test convo', titleSource: "derived",
        ...(createdAt !== undefined ? { createdAt } : {}), ...(updatedAt !== undefined ? { updatedAt } : {}) },
        detail: { key: fixtureKey(String('c1'), 'gemini'), quality: { status: 'unknown' }, assets: extra.assets ?? [], messages } };
}

function msg(id: string, role: string, blocks: any[], extra: any = {}) {
    return { id, role, content: blocks, ...extra };
}

const opts = {};

test('maps paragraph, heading, code and table blocks', async () => {
    const b = domainFixture([
        msg('m1', 'user', [
            { type: 'heading', level: 2, children: [{ type: 'text', text: 'Hi' }] },
            { type: 'paragraph', children: [{ type: 'text', text: 'hello' }, { type: 'strong', children: [{ type: 'text', text: 'world' }] }] },
            { type: 'code', language: 'python', code: 'print(1)' },
            {
                type: 'table',
                headerRows: [{ cells: [{ children: [{ type: 'text', text: 'A' }] }] }],
                rows: [{ cells: [{ children: [{ type: 'text', text: '1' }] }] }],
            },
        ]),
    ]);
    const { payload, diagnostics } = renderTypstFixture(composeDomainDocument(b, fixtureAccountFor(b)), {}, opts);
    assert.strictEqual(diagnostics.length, 0);
    assert.strictEqual(payload.schemaVersion, 1);
    assert.strictEqual(payload.title, 'Test convo');
    assert.strictEqual(payload.metadata, 'gemini · 2026-09-20 · 1 messages');
    assert.strictEqual(payload.messages.length, 1);
    const kinds = payload.messages[0].blocks.map((x: any) => x.type);
    assert.deepStrictEqual(kinds, ['heading', 'paragraph', 'code', 'table']);
    assert.strictEqual(payload.messages[0].blocks[0].level, 2);
    assert.strictEqual(payload.messages[0].blocks[2].text, 'print(1)');
    assert.strictEqual(payload.messages[0].variant, 'bubble');
});

test('math without converter keeps latex only; with converter adds typst', async () => {
    const mathBlock = { type: 'math', source: '\\frac{1}{2}' };
    const noConv = renderTypstFixture(composeDomainDocument(domainFixture([msg('m1', 'assistant', [mathBlock])]), fixtureAccountFor(domainFixture([msg('m1', 'assistant', [mathBlock])]))), {}, opts);
    assert.deepStrictEqual(noConv.payload.messages[0].blocks[0], { type: 'math', latex: '\\frac{1}{2}', fallbackLabel: 'Could not typeset this formula; original LaTeX preserved:', layout: { gapBeforePt: 0, keepWithNext: false, width: 'full' } });
    assert.ok(!('typst' in noConv.payload.messages[0].blocks[0]), 'no typst key without converter');

    const withConv = renderTypstFixture(composeDomainDocument(domainFixture([msg('m1', 'assistant', [mathBlock])]), fixtureAccountFor(domainFixture([msg('m1', 'assistant', [mathBlock])]))), {}, {
        ...opts,
        convertMath: (src: string) => `frac(1, 2) /* ${src.length} */`,
    });
    assert.strictEqual(withConv.payload.messages[0].blocks[0].typst, 'frac(1, 2) /* 11 */');

    const failed = renderTypstFixture(composeDomainDocument(domainFixture([msg('m1', 'assistant', [mathBlock])]), fixtureAccountFor(domainFixture([msg('m1', 'assistant', [mathBlock])]))), {}, {
        ...opts,
        convertMath: () => undefined,
    });
    assert.ok(!('typst' in failed.payload.messages[0].blocks[0]), 'failed conversion degrades to latex-only');
});

test('math callback receives LaTeX source and the inline/display flag', () => {
    const calls: any[] = [];
    const b = domainFixture([msg('m1', 'assistant', [
        { type: 'paragraph', children: [{ type: 'inlineMath', source: 'x^2' }] },
        { type: 'math', source: 'y^2' },
    ])]);
    renderTypstFixture(composeDomainDocument(b, fixtureAccountFor(b)), {}, { ...opts, convertMath: (...args: any[]) => { calls.push(args); return 'x'; } });
    assert.deepStrictEqual(calls, [['x^2', false], ['y^2', true]]);
});

test('missing image asset becomes visible unknown node with diagnostic', async () => {
    const b = domainFixture([msg('m1', 'assistant', [
        { type: 'image', assetId: 'a-missing', alt: 'a diagram' },
    ])], { assets: [{ id: 'a-missing', kind: 'image' }] });
    const { payload, diagnostics } = renderTypstFixture(composeDomainDocument(b, fixtureAccountFor(b)), {}, opts);
    const node: any = payload.messages[0].blocks[0];
    assert.strictEqual(node.type, 'unknown');
    assert.strictEqual(node.sourceType, 'missing-image');
    assert.equal(node.details, undefined, 'alt is not an invented caption');
    assert.ok(diagnostics.some((d: any) => d.code === 'TYPST_V8_IMAGE_MISSING' && d.severity === 'warning'));
});

test('present image asset maps to virtual path', async () => {
    const b = domainFixture(
        [msg('m1', 'assistant', [{ type: 'image', assetId: 'a1', alt: 'pic' }])],
        { assets: [{ id: 'a1', kind: 'image', name: 'pic.png', mediaType: 'image/png' }] },
    );
    const { payload, diagnostics } = renderTypstFixture(composeDomainDocument(b, fixtureAccountFor(b)), { a1: 'assets/sha256/ab/a1.png' }, {

    });
    assert.strictEqual(diagnostics.length, 0);
    assert.deepStrictEqual(payload.messages[0].blocks[0], {
        type: 'image', asset: 'assets/sha256/ab/a1.png', layout: { gapBeforePt: 0, keepWithNext: false, width: 'full' },
    });
});

test('inline image maps to a formal transport node', async () => {
    const b = domainFixture(
        [msg('m1', 'user', [
            {
                type: 'paragraph',
                children: [
                    { type: 'text', text: 'see ' },
                    { type: 'image', assetId: 'a-inline', alt: 'a diagram' },
                    { type: 'text', text: ' here' },
                ],
            },
        ])],
        { assets: [{ id: 'a-inline', kind: 'image', name: 'd.png', mediaType: 'image/png' }] },
    );
    const { payload, diagnostics } = renderTypstFixture(composeDomainDocument(b, fixtureAccountFor(b)), Object.fromEntries(b.detail.assets.map((asset: any) => [asset.id, `assets/${asset.id}.png`])), {  });
    const para: any = payload.messages[0].blocks[0];
    assert.strictEqual(para.type, 'paragraph');
    assert.deepStrictEqual(para.children.map((c: any) => c.type), ['text', 'image', 'text']);
    assert.deepStrictEqual(para.children[1], { type: 'image', asset: 'assets/a-inline.png', alt: 'a diagram' });
    assert.ok(!diagnostics.some((d: any) => d.code === 'TYPST_V8_INLINE_IMAGE_FLATTENED'),
        'TYPST_V8_INLINE_IMAGE_FLATTENED is retired');
});

test('inline image without authored alt uses the shared friendly name', async () => {
    const b = domainFixture(
        [msg('m1', 'user', [
            { type: 'paragraph', children: [{ type: 'image', assetId: 'a-inline' }] },
        ])],
        { assets: [{ id: 'a-inline', kind: 'image', name: 'd.png', mediaType: 'image/png' }] },
    );
    const { payload } = renderTypstFixture(composeDomainDocument(b, fixtureAccountFor(b)), Object.fromEntries(b.detail.assets.map((asset: any) => [asset.id, `assets/${asset.id}.png`])), {  });
    assert.deepStrictEqual((payload.messages[0].blocks[0] as any).children[0],
        { type: 'image', asset: 'assets/a-inline.png', alt: 'd.png' });
});

test('missing inline image asset falls back to visible text with missing-asset diagnostic', async () => {
    const b = domainFixture([msg('m1', 'user', [
        { type: 'paragraph', children: [{ type: 'image', assetId: 'a-gone', alt: 'a diagram' }] },
    ])], { assets: [{ id: 'a-gone', kind: 'image' }] });
    const { payload, diagnostics } = renderTypstFixture(composeDomainDocument(b, fixtureAccountFor(b)), {}, opts);
    const para: any = payload.messages[0].blocks[0];
    assert.deepStrictEqual(para.children[0], { type: 'text', text: 'Image unavailable: a diagram' });
    assert.ok(diagnostics.some((d: any) => d.code === 'TYPST_V8_INLINE_IMAGE_MISSING' && d.severity === 'warning'),
        'asset absence must be visible, never silent');
    assert.ok(!diagnostics.some((d: any) => d.code === 'TYPST_V8_INLINE_IMAGE_FLATTENED'),
        'TYPST_V8_INLINE_IMAGE_FLATTENED is retired');
});

test('missing inline image without authored alt uses a friendly fallback', async () => {
    const b = domainFixture([msg('m1', 'user', [
        { type: 'paragraph', children: [{ type: 'image', assetId: 'a-gone' }] },
    ])], { assets: [{ id: 'a-gone', kind: 'image' }] });
    const { payload } = renderTypstFixture(composeDomainDocument(b, fixtureAccountFor(b)), {}, opts);
    assert.strictEqual((payload.messages[0].blocks[0] as any).children[0].text, 'Image unavailable: Image');
});



test('inline image placements are intact in blocks', async () => {
    const b = domainFixture(
        [msg('m1', 'user', [
            { type: 'paragraph', children: [{ type: 'text', text: 'see ' }, { type: 'image', assetId: 'a-inline', alt: 'd' }] },
            {
                type: 'table',
                rows: [{ cells: [{ children: [{ type: 'image', assetId: 'a-cell' }] }] }],
            },
        ])],
        { assets: [
            { id: 'a-inline', kind: 'image', name: 'd.png', mediaType: 'image/png' },
            { id: 'a-cell', kind: 'image', name: 'c.png', mediaType: 'image/png' },
        ] },
    );
    const { payload, diagnostics } = renderTypstFixture(composeDomainDocument(b, fixtureAccountFor(b)), Object.fromEntries(b.detail.assets.map((asset: any) => [asset.id, `assets/${asset.id}.png`])), {  });
    assert.strictEqual((payload.messages[0] as any).attachments, undefined);
    assert.strictEqual((payload.messages[0].blocks[0] as any).children[1].type, 'image');
    assert.strictEqual((payload.messages[0].blocks[1] as any).rows[0][0].children[0].type, 'image');
    assert.ok(!diagnostics.some((d: any) => d.code === 'TYPST_V8_INLINE_IMAGE_MISSING'));
});

test('unknown blocks are never dropped', async () => {
    const b = domainFixture([msg('m1', 'assistant', [
        { type: 'unknown', sourceType: 'weird-widget', text: 'kept' },
    ])]);
    const { payload } = renderTypstFixture(composeDomainDocument(b, fixtureAccountFor(b)), {}, opts);
    const node: any = payload.messages[0].blocks[0];
    assert.strictEqual(node.type, 'unknown');
    assert.strictEqual(node.sourceType, 'weird-widget');
    assert.strictEqual(node.fallback, 'kept');
    assert.ok(!('blocks' in node));
});

test('heading level passes through without clamping', async () => {
    const b = domainFixture([msg('m1', 'user', [
        { type: 'heading', level: 6, children: [{ type: 'text', text: 'deep' }] },
    ])]);
    const { payload, diagnostics } = renderTypstFixture(composeDomainDocument(b, fixtureAccountFor(b)), {}, opts);
    assert.strictEqual((payload.messages[0].blocks[0] as any).level, 6);
    assert.ok(!diagnostics.some((d: any) => d.code === 'TYPST_V8_HEADING_CLAMP'));
});

test('conversation renders every message in source order', async () => {
    const b = domainFixture([
        msg('root', 'user', [{ type: 'paragraph', children: [{ type: 'text', text: 'q' }] }]),
        msg('a', 'assistant', [{ type: 'paragraph', children: [{ type: 'text', text: 'a1' }] }]),
        msg('b', 'assistant', [{ type: 'paragraph', children: [{ type: 'text', text: 'a2' }] }]),
    ]);
    const { payload } = renderTypstFixture(composeDomainDocument(b, fixtureAccountFor(b)), {}, opts);
    assert.deepStrictEqual(payload.messages.map((m: any) => m.id), ['msg-0', 'msg-1', 'msg-2']);

});

test('hostile text stays inert JSON data (injection red line)', async () => {
    const evil = '#set page(width: 1pt)\n#{eval("1+1")}\n${jndi:ldap://x}';
    const b = domainFixture([msg('m1', 'user', [
        { type: 'paragraph', children: [{ type: 'text', text: evil }] },
        { type: 'code', language: 'typst', code: evil },
    ])]);
    const { payload } = renderTypstFixture(composeDomainDocument(b, fixtureAccountFor(b)), {}, opts);
    const roundTripped = JSON.parse(JSON.stringify(payload));
    const paraText = (roundTripped.messages[0].blocks[0] as any).children[0].text;
    const codeText = (roundTripped.messages[0].blocks[1] as any).text;
    assert.strictEqual(paraText, evil, 'paragraph text passes through byte-identical');
    assert.strictEqual(codeText, evil, 'code text passes through byte-identical');
    // Payload is pure data: no Typst source is ever constructed by the adapter.
    const json = JSON.stringify(payload);
    assert.ok(!json.includes('"type":"eval"'), 'no eval node type exists in transport');
});

test('system role becomes a visible note prefix', async () => {
    const b = domainFixture([msg('m1', 'system', [
        { type: 'paragraph', children: [{ type: 'text', text: 'be nice' }] },
    ])]);
    const { payload } = renderTypstFixture(composeDomainDocument(b, fixtureAccountFor(b)), {}, opts);
    assert.strictEqual(payload.messages[0].variant, 'flow');
    assert.strictEqual((payload.messages[0].blocks[0] as any).type, 'note');
});



test('PDF date uses document timestamps and stays unknown without them', () => {
    const b: any = domainFixture([]);
    assert.strictEqual(renderTypstFixture(composeDomainDocument({ ...b, index: { ...b.index, updatedAt: Date.parse('2026-09-28T00:00:00Z') } }, fixtureAccountFor({ ...b, index: { ...b.index, updatedAt: Date.parse('2026-09-28T00:00:00Z') } })), {}, opts).payload.metadata, 'gemini · 2026-09-28 · 0 messages · Empty conversation.');
    assert.strictEqual(renderTypstFixture(composeDomainDocument(b, fixtureAccountFor(b)), {}, opts).payload.metadata, 'gemini · 2026-09-20 · 0 messages · Empty conversation.');
    delete b.index.createdAt;
    const { getRendererStrings } = require('../src/l4/format/shared/renderStrings.js');
    assert.strictEqual(renderTypstFixture(composeDomainDocument(b, fixtureAccountFor(b)), {}, { ...opts, locale: 'en' }).payload.metadata, `gemini · ${getRendererStrings('en').dateUnknown} · 0 messages · Empty conversation.`);
});
