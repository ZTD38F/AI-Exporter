/**
 * tests/typst-payload.test.ts
 * Tier 1 tests for the P1a canonical -> Typst v8 payload adapter.
 *
 * Covers: block mapping (paragraph/heading/code/table/image/file/unknown),
 * math with and without the controlled convertMath hook, missing-asset
 * diagnostics, heading clamp diagnostics, branch linearization refusal,
 * and the injection red line (hostile text stays inert JSON data).
 */
export {};
const test = require('node:test');
const assert = require('node:assert');

const { toTypstPayload } = require('../src/core/export/typst/payload.js');
const { collectReferencedAssetIds } = require('../src/core/export/canonical/assetReferences.js');

function bundle(messages: any[], extra: any = {}) {
    return {
        schemaVersion: 1,
        conversation: {
            key: { providerId: 'gemini', accountId: 'test-account', conversationId: 'c1' },
            title: 'Test convo',
            createdAt: '2026-09-20T10:00:00Z',
            messages,
        },
        assets: [],
        citations: [],
        ...extra,
    };
}

function msg(id: string, role: string, blocks: any[], extra: any = {}) {
    return { id, role, blocks, ...extra };
}

const opts = { assetPath: (_a: any) => undefined };

test('maps paragraph, heading, code and table blocks', async () => {
    const b = bundle([
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
    const { payload, diagnostics } = toTypstPayload(b, opts);
    assert.strictEqual(diagnostics.length, 0);
    assert.strictEqual(payload.schemaVersion, 1);
    assert.strictEqual(payload.title, 'Test convo');
    assert.strictEqual(payload.provider, 'gemini');
    assert.strictEqual(payload.date, '2026-09-20');
    assert.strictEqual(payload.messageCount, 1);
    const kinds = payload.messages[0].blocks.map((x: any) => x.type);
    assert.deepStrictEqual(kinds, ['heading', 'paragraph', 'code', 'table']);
    assert.strictEqual(payload.messages[0].blocks[0].level, 2);
    assert.strictEqual(payload.messages[0].blocks[2].text, 'print(1)');
    assert.strictEqual(payload.messages[0].role, 'user');
});

test('math without converter keeps latex only; with converter adds typst', async () => {
    const mathBlock = { type: 'math', source: '\\frac{1}{2}' };
    const noConv = toTypstPayload(bundle([msg('m1', 'assistant', [mathBlock])]), opts);
    assert.deepStrictEqual(noConv.payload.messages[0].blocks[0], { type: 'math', latex: '\\frac{1}{2}', fallbackLabel: 'Could not typeset this formula; original LaTeX preserved:' });
    assert.ok(!('typst' in noConv.payload.messages[0].blocks[0]), 'no typst key without converter');

    const withConv = toTypstPayload(bundle([msg('m1', 'assistant', [mathBlock])]), {
        ...opts,
        convertMath: (src: string) => `frac(1, 2) /* ${src.length} */`,
    });
    assert.strictEqual(withConv.payload.messages[0].blocks[0].typst, 'frac(1, 2) /* 11 */');

    const failed = toTypstPayload(bundle([msg('m1', 'assistant', [mathBlock])]), {
        ...opts,
        convertMath: () => undefined,
    });
    assert.ok(!('typst' in failed.payload.messages[0].blocks[0]), 'failed conversion degrades to latex-only');
});

test('math callback receives LaTeX source and the inline/display flag', () => {
    const calls: any[] = [];
    const b = bundle([msg('m1', 'assistant', [
        { type: 'paragraph', children: [{ type: 'inlineMath', source: 'x^2' }] },
        { type: 'math', source: 'y^2' },
    ])]);
    toTypstPayload(b, { ...opts, convertMath: (...args: any[]) => { calls.push(args); return 'x'; } });
    assert.deepStrictEqual(calls, [['x^2', false], ['y^2', true]]);
});

test('missing image asset becomes visible unknown node with diagnostic', async () => {
    const b = bundle([msg('m1', 'assistant', [
        { type: 'image', assetId: 'a-missing', alt: 'a diagram' },
    ])]);
    const { payload, diagnostics } = toTypstPayload(b, opts);
    const node: any = payload.messages[0].blocks[0];
    assert.strictEqual(node.type, 'unknown');
    assert.strictEqual(node.sourceType, 'missing-image');
    assert.ok(node.fallback.includes('a diagram') || node.fallback.includes('a-missing'));
    assert.ok(diagnostics.some((d: any) => d.code === 'TYPST_V8_IMAGE_MISSING' && d.severity === 'warning'));
});

test('present image asset maps to virtual path', async () => {
    const b = bundle(
        [msg('m1', 'assistant', [{ type: 'image', assetId: 'a1', alt: 'pic' }])],
        { assets: [{ id: 'a1', kind: 'image', name: 'pic.png', mimeType: 'image/png', status: 'available' }] },
    );
    const { payload, diagnostics } = toTypstPayload(b, {
        assetPath: (a: any) => `assets/sha256/ab/${a.id}.png`,
    });
    assert.strictEqual(diagnostics.length, 0);
    assert.deepStrictEqual(payload.messages[0].blocks[0], {
        type: 'image', asset: 'assets/sha256/ab/a1.png', caption: 'pic',
    });
});

test('inline image maps to a formal transport node', async () => {
    const b = bundle(
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
        { assets: [{ id: 'a-inline', kind: 'image', name: 'd.png', mimeType: 'image/png', status: 'available' }] },
    );
    const { payload, diagnostics } = toTypstPayload(b, { assetPath: (a: any) => `assets/${a.id}.png` });
    const para: any = payload.messages[0].blocks[0];
    assert.strictEqual(para.type, 'paragraph');
    assert.deepStrictEqual(para.children.map((c: any) => c.type), ['text', 'image', 'text']);
    assert.deepStrictEqual(para.children[1], { type: 'image', asset: 'assets/a-inline.png', alt: 'a diagram' });
    assert.ok(!diagnostics.some((d: any) => d.code === 'TYPST_V8_INLINE_IMAGE_FLATTENED'),
        'TYPST_V8_INLINE_IMAGE_FLATTENED is retired');
});

test('inline image without alt omits the alt key', async () => {
    const b = bundle(
        [msg('m1', 'user', [
            { type: 'paragraph', children: [{ type: 'image', assetId: 'a-inline' }] },
        ])],
        { assets: [{ id: 'a-inline', kind: 'image', name: 'd.png', mimeType: 'image/png', status: 'available' }] },
    );
    const { payload } = toTypstPayload(b, { assetPath: (a: any) => `assets/${a.id}.png` });
    assert.deepStrictEqual((payload.messages[0].blocks[0] as any).children[0],
        { type: 'image', asset: 'assets/a-inline.png' });
});

test('missing inline image asset falls back to visible text with missing-asset diagnostic', async () => {
    const b = bundle([msg('m1', 'user', [
        { type: 'paragraph', children: [{ type: 'image', assetId: 'a-gone', alt: 'a diagram' }] },
    ])]);
    const { payload, diagnostics } = toTypstPayload(b, opts);
    const para: any = payload.messages[0].blocks[0];
    assert.deepStrictEqual(para.children[0], { type: 'text', text: 'a diagram' });
    assert.ok(diagnostics.some((d: any) => d.code === 'TYPST_V8_INLINE_IMAGE_MISSING' && d.severity === 'warning'),
        'asset absence must be visible, never silent');
    assert.ok(!diagnostics.some((d: any) => d.code === 'TYPST_V8_INLINE_IMAGE_FLATTENED'),
        'TYPST_V8_INLINE_IMAGE_FLATTENED is retired');
});

test('missing inline image asset without alt shows [image: id] placeholder', async () => {
    const b = bundle([msg('m1', 'user', [
        { type: 'paragraph', children: [{ type: 'image', assetId: 'a-gone' }] },
    ])]);
    const { payload } = toTypstPayload(b, opts);
    assert.strictEqual((payload.messages[0].blocks[0] as any).children[0].text, '[image: a-gone]');
});

test('collectReferencedAssetIds walks block and inline trees recursively', async () => {
    const blocks = [
        { type: 'image', assetId: 'top-img' },
        { type: 'file', assetId: 'top-file' },
        { type: 'paragraph', children: [{ type: 'image', assetId: 'para-img', alt: 'p' }] },
        { type: 'heading', level: 1, children: [{ type: 'strong', children: [{ type: 'image', assetId: 'heading-img' }] }] },
        {
            type: 'table',
            rows: [{ cells: [{ children: [{ type: 'link', url: 'https://x', children: [{ type: 'image', assetId: 'cell-img' }] }] }] }],
        },
        {
            type: 'list', ordered: false,
            items: [{ blocks: [{ type: 'paragraph', children: [{ type: 'image', assetId: 'list-img' }] }] }],
        },
        { type: 'quote', blocks: [{ type: 'paragraph', children: [{ type: 'image', assetId: 'quote-img' }] }] },
        { type: 'unknown', sourceType: 'x', text: 'unknown image alt' },
    ];
    const ids = collectReferencedAssetIds(blocks as any);
    assert.deepStrictEqual([...ids].sort(), [
        'cell-img', 'heading-img', 'list-img', 'para-img',
        'quote-img', 'top-file', 'top-img',
    ].sort());
});

test('inline image placements are intact in blocks', async () => {
    const b = bundle(
        [msg('m1', 'user', [
            { type: 'paragraph', children: [{ type: 'text', text: 'see ' }, { type: 'image', assetId: 'a-inline', alt: 'd' }] },
            {
                type: 'table',
                rows: [{ cells: [{ children: [{ type: 'image', assetId: 'a-cell' }] }] }],
            },
        ])],
        { assets: [
            { id: 'a-inline', kind: 'image', name: 'd.png', mimeType: 'image/png', status: 'available' },
            { id: 'a-cell', kind: 'image', name: 'c.png', mimeType: 'image/png', status: 'available' },
        ] },
    );
    const { payload, diagnostics } = toTypstPayload(b, { assetPath: (a: any) => `assets/${a.id}.png` });
    assert.strictEqual((payload.messages[0] as any).attachments, undefined);
    assert.strictEqual((payload.messages[0].blocks[0] as any).children[1].type, 'image');
    assert.strictEqual((payload.messages[0].blocks[1] as any).rows[0][0].children[0].type, 'image');
    assert.ok(!diagnostics.some((d: any) => d.code === 'TYPST_V8_INLINE_IMAGE_MISSING'));
});

test('unknown blocks are never dropped', async () => {
    const b = bundle([msg('m1', 'assistant', [
        { type: 'unknown', sourceType: 'weird-widget', text: 'kept' },
    ])]);
    const { payload } = toTypstPayload(b, opts);
    const node: any = payload.messages[0].blocks[0];
    assert.strictEqual(node.type, 'unknown');
    assert.strictEqual(node.sourceType, 'weird-widget');
    assert.strictEqual(node.fallback, 'kept');
    assert.ok(!('blocks' in node));
});

test('heading level passes through without clamping', async () => {
    const b = bundle([msg('m1', 'user', [
        { type: 'heading', level: 6, children: [{ type: 'text', text: 'deep' }] },
    ])]);
    const { payload, diagnostics } = toTypstPayload(b, opts);
    assert.strictEqual((payload.messages[0].blocks[0] as any).level, 6);
    assert.ok(!diagnostics.some((d: any) => d.code === 'TYPST_V8_HEADING_CLAMP'));
});

test('conversation renders every message in source order', async () => {
    const b = bundle([
        msg('root', 'user', [{ type: 'paragraph', children: [{ type: 'text', text: 'q' }] }]),
        msg('a', 'assistant', [{ type: 'paragraph', children: [{ type: 'text', text: 'a1' }] }]),
        msg('b', 'assistant', [{ type: 'paragraph', children: [{ type: 'text', text: 'a2' }] }]),
    ]);
    const { payload } = toTypstPayload(b, opts);
    assert.deepStrictEqual(payload.messages.map((m: any) => m.id), ['root', 'a', 'b']);

});

test('hostile text stays inert JSON data (injection red line)', async () => {
    const evil = '#set page(width: 1pt)\n#{eval("1+1")}\n${jndi:ldap://x}';
    const b = bundle([msg('m1', 'user', [
        { type: 'paragraph', children: [{ type: 'text', text: evil }] },
        { type: 'code', language: 'typst', code: evil },
    ])]);
    const { payload } = toTypstPayload(b, opts);
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
    const b = bundle([msg('m1', 'system', [
        { type: 'paragraph', children: [{ type: 'text', text: 'be nice' }] },
    ])]);
    const { payload } = toTypstPayload(b, opts);
    assert.strictEqual(payload.messages[0].role, 'assistant');
    assert.strictEqual((payload.messages[0].blocks[0] as any).type, 'note');
});



test('PDF date uses document timestamps and stays unknown without them', () => {
    const b: any = bundle([]);
    b.conversation.updatedAt = '2026-09-28T00:00:00Z';
    assert.strictEqual(toTypstPayload(b, opts).payload.date, '2026-09-28');
    delete b.conversation.updatedAt;
    assert.strictEqual(toTypstPayload(b, opts).payload.date, '2026-09-20');
    delete b.conversation.createdAt;
    const { getRendererStrings } = require('../src/core/export/canonical/rendererStrings.js');
    assert.strictEqual(toTypstPayload(b, { ...opts, locale: 'en' }).payload.date, getRendererStrings('en').dateUnknown);
});
