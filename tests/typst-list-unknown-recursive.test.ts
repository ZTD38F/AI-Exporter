export {};
const test = require('node:test');
const assert = require('node:assert');

const { toTypstPayload } = require('../src/core/export/typst/payload.js');
const { TypstSandboxCompiler } = require('../src/core/export/typst/typstSandboxCompiler.js');
const { convertMath: convertLatex } = require('../src/core/export/typst/mathConverter.js');
const convertMath = (source: string, display: boolean) => convertLatex(source, 'latex', display);
const { extractPdfText } = require('./helpers/pdfTextExtract.js');
const {
    RealWasmSandboxHost,
    repoRoot,
} = require('./helpers/realWasmSandbox.js');

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function bundle(messages: any[], extra: any = {}) {
    return {
        schemaVersion: 1,
        conversation: {
            key: { providerId: 'gemini', accountId: 'test-account', conversationId: 'c1' },
            title: 'Nested list and unknown text',
            createdAt: '2026-09-26T10:00:00Z',
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

const opts = { assetPath: (a: any) => `assets/${a.id}.png` };

const imgAsset = { id: 'list-img', kind: 'image', name: 'dot.png', mimeType: 'image/png', status: 'available', sizeBytes: 70 };

function listBundle(blocks: any[], assets: any[] = []) {
    return bundle([msg('m1', 'user', blocks)], { assets });
}

test('list item keeps inline image as a node, not flattened text', async () => {
    const b = listBundle([{
        type: 'list', ordered: false,
        items: [{ blocks: [{ type: 'paragraph', children: [{ type: 'text', text: 'see ' }, { type: 'image', assetId: 'list-img', alt: 'dot' }] }] }],
    }], [imgAsset]);
    const { payload, diagnostics } = toTypstPayload(b, opts);
    const node: any = payload.messages[0].blocks[0];
    assert.strictEqual(node.type, 'list');
    assert.deepStrictEqual(node.items[0].blocks[0].children.map((c: any) => c.type), ['text', 'image']);
    assert.deepStrictEqual(node.items[0].blocks[0].children[1], { type: 'image', asset: 'assets/list-img.png', alt: 'dot' });
    assert.ok(!diagnostics.some((d: any) => d.code === 'TYPST_V8_LIST_FLATTENED'));
});

test('list item keeps block image, nested list, code, math and multi-paragraph', async () => {
    const b = listBundle([{
        type: 'list', ordered: false,
        items: [
            { blocks: [{ type: 'image', assetId: 'list-img', alt: 'dot' }] },
            { blocks: [{ type: 'list', ordered: false, items: [{ blocks: [{ type: 'paragraph', children: [{ type: 'text', text: 'nested' }] }] }] }] },
            { blocks: [{ type: 'code', language: 'python', code: 'print(1)' }] },
            { blocks: [{ type: 'math', source: 'x^2' }] },
            { blocks: [
                { type: 'paragraph', children: [{ type: 'text', text: 'first' }] },
                { type: 'paragraph', children: [{ type: 'text', text: 'second' }] },
            ] },
        ],
    }], [imgAsset]);
    const { payload, diagnostics } = toTypstPayload(b, opts);
    const node: any = payload.messages[0].blocks[0];
    assert.strictEqual(node.items[0].blocks[0].type, 'image');
    assert.strictEqual(node.items[0].blocks[0].asset, 'assets/list-img.png');
    assert.strictEqual(node.items[1].blocks[0].type, 'list');
    assert.strictEqual(node.items[1].blocks[0].items[0].blocks[0].children[0].text, 'nested');
    assert.strictEqual(node.items[2].blocks[0].type, 'code');
    assert.strictEqual(node.items[2].blocks[0].text, 'print(1)');
    assert.strictEqual(node.items[3].blocks[0].type, 'math');
    assert.strictEqual(node.items[3].blocks[0].latex, 'x^2');
    assert.deepStrictEqual(node.items[4].blocks.map((x: any) => x.type), ['paragraph', 'paragraph']);
    assert.ok(!diagnostics.some((d: any) => d.code === 'TYPST_V8_LIST_FLATTENED'));
});

test('ordered list keeps start; absent start stays absent', async () => {
    const b = listBundle([
        { type: 'list', ordered: true, start: 3, items: [{ blocks: [{ type: 'paragraph', children: [{ type: 'text', text: 'third' }] }] }] },
        { type: 'list', ordered: true, items: [{ blocks: [{ type: 'paragraph', children: [{ type: 'text', text: 'one' }] }] }] },
        { type: 'list', ordered: false, items: [{ blocks: [{ type: 'paragraph', children: [{ type: 'text', text: 'bullet' }] }] }] },
    ]);
    const { payload } = toTypstPayload(b, opts);
    const blocks: any[] = payload.messages[0].blocks;
    assert.strictEqual(blocks[0].start, 3);
    assert.ok(!('start' in blocks[1]));
    assert.ok(!('start' in blocks[2]));
    assert.strictEqual(blocks[0].ordered, true);
    assert.strictEqual(blocks[2].ordered, false);
});

test('unknown text remains visible without nested render blocks', async () => {
    const b = listBundle([{ type: 'unknown', sourceType: 'weird-widget', text: 'kept-para\ndot\nkept-code\nkept-list' }]);
    const { payload } = toTypstPayload(b, opts);
    const node: any = payload.messages[0].blocks[0];
    assert.strictEqual(node.type, 'unknown');
    assert.strictEqual(node.sourceType, 'weird-widget');
    assert.strictEqual(node.fallback, 'kept-para\ndot\nkept-code\nkept-list');
    assert.ok(!('blocks' in node));
});

async function compileOnce(bundle: any, assets: Record<string, Uint8Array>) {
    const host = new RealWasmSandboxHost(repoRoot());
    const compiler = new TypstSandboxCompiler({ host });
    const assetPath = (a: any) => `/assets/${a.id}.png`;
    const { payload: document } = toTypstPayload(bundle, { assetPath, convertMath });
    const context = {
        bundle,
        assets: {
            resolve: async (id: string) => {
                const bytes = assets[id];
                return bytes ? { bytes } : null;
            },
        },
        locale: 'en' as const,
        signal: new AbortController().signal,
        reportProgress: () => undefined,
    };
    try {
        const result = await compiler.compile(
            {
                rendererSchemaVersion: 1,
                sourceSchemaVersion: 1,
                bundle,
                document,
                assetPaths: new Map((bundle.assets ?? []).map((a: any) => [a.id, assetPath(a)])),
            } as never,
            context as never,
        );
        return result;
    } finally {
        compiler.dispose();
    }
}

test('real WASM: nested lists and unknown text compile with all content selectable', async () => {
    const b = listBundle([
        {
            type: 'list', ordered: true, start: 3,
            items: [
                { blocks: [
                    { type: 'paragraph', children: [{ type: 'text', text: 'third item with inline ' }, { type: 'image', assetId: 'list-img', alt: 'dot' }] },
                    { type: 'paragraph', children: [{ type: 'text', text: 'second paragraph of item' }] },
                ] },
                { blocks: [
                    { type: 'list', ordered: false, items: [{ blocks: [{ type: 'paragraph', children: [{ type: 'text', text: 'nested item text' }] }] }] },
                    { type: 'code', language: 'python', code: 'print("list code")' },
                    { type: 'math', source: 'E=mc^2' },
                ] },
            ],
        },
        {
            type: 'unknown', sourceType: 'weird-widget',
            text: 'unknown kept paragraph\nunknown kept code',
        },
        {
            type: 'quote',
            blocks: [
                { type: 'paragraph', children: [{ type: 'text', text: 'quoted text here' }] },
                { type: 'list', ordered: false, items: [{ blocks: [{ type: 'paragraph', children: [{ type: 'text', text: 'quoted list item' }] }] }] },
            ],
        },
        {
            type: 'thought', kind: 'reasoning',
            blocks: [{ type: 'paragraph', children: [{ type: 'text', text: 'thinking trace kept' }] }],
        },
    ], [imgAsset]);
    const result = await compileOnce(b, { 'list-img': Buffer.from(PNG_B64, 'base64') });
    assert.ok(!result.diagnostics.some((d: any) => d.severity === 'error'), JSON.stringify(result.diagnostics));
    assert.strictEqual(Buffer.from(result.pdfBytes.slice(0, 5)).toString('latin1'), '%PDF-');
    const extracted = extractPdfText(result.pdfBytes);
    for (const needle of [
        'third item with inline',
        'second paragraph of item',
        'nested item text',
        'print("list code")',
        '𝑚𝑐',
        'unknown kept paragraph',
        'unknown kept code',
        'quoted text here',
        'quoted list item',
        'thinking trace kept',
    ]) {
        assert.ok(extracted.text.includes(needle), `missing from PDF text: ${needle}`);
    }
    assert.ok(extracted.imageXObjectCount >= 1, 'list inline image must be mounted as an image XObject');
});
