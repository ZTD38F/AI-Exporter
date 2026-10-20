export {};
const test = require('node:test');
const assert = require('node:assert');

const { toTypstPayload } = require('../src/core/export/typst/payload.js');

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

function imgAsset(id: string) {
    return { id, kind: 'image', name: `${id}.png`, mimeType: 'image/png', sizeBytes: 1024, status: 'available' };
}

const withPath = { assetPath: (a: any) => `assets/${a.id}.png` };

test('quote keeps nested image as a real image node', async () => {
    const b = bundle([msg('m1', 'assistant', [
        {
            type: 'quote',
            blocks: [
                { type: 'paragraph', children: [{ type: 'text', text: 'hello' }] },
                { type: 'image', assetId: 'a1', alt: 'pic' },
            ],
        },
    ])], { assets: [imgAsset('a1')] });
    const { payload, diagnostics } = toTypstPayload(b, withPath);
    const quote = payload.messages[0].blocks[0] as any;
    assert.strictEqual(quote.type, 'quote');
    assert.strictEqual(quote.blocks.length, 2);
    assert.strictEqual(quote.blocks[0].type, 'paragraph');
    assert.strictEqual(quote.blocks[1].type, 'image');
    assert.strictEqual(quote.blocks[1].asset, 'assets/a1.png');
    assert.ok(!diagnostics.some((d: any) => d.severity === 'warning' && /quote/i.test(d.code)));
});

test('thought keeps nested image as a real image node', async () => {
    const b = bundle([msg('m1', 'assistant', [
        {
            type: 'thought',
            blocks: [
                { type: 'paragraph', children: [{ type: 'text', text: 'thinking' }] },
                { type: 'image', assetId: 'a1', alt: 'pic' },
            ],
        },
    ])], { assets: [imgAsset('a1')] });
    const { payload } = toTypstPayload(b, withPath);
    const note = payload.messages[0].blocks[0] as any;
    assert.strictEqual(note.type, 'note');
    assert.strictEqual(note.blocks.length, 2);
    assert.strictEqual(note.blocks[1].type, 'image');
    assert.strictEqual(note.blocks[1].asset, 'assets/a1.png');
});

test('quote keeps code and math as structured nodes instead of flat text', async () => {
    const b = bundle([msg('m1', 'assistant', [
        {
            type: 'quote',
            blocks: [
                { type: 'code', language: 'python', code: 'print(1)' },
                { type: 'math', source: 'E=mc^2' },
            ],
        },
    ])]);
    const { payload } = toTypstPayload(b, withPath);
    const quote = payload.messages[0].blocks[0] as any;
    assert.strictEqual(quote.blocks[0].type, 'code');
    assert.strictEqual(quote.blocks[0].text, 'print(1)');
    assert.strictEqual(quote.blocks[1].type, 'math');
    assert.strictEqual(quote.blocks[1].latex, 'E=mc^2');
});

test('thought keeps code as a structured node instead of flat text', async () => {
    const b = bundle([msg('m1', 'assistant', [
        {
            type: 'thought',
            blocks: [{ type: 'code', language: 'ts', code: 'const x = 1' }],
        },
    ])]);
    const { payload } = toTypstPayload(b, withPath);
    const note = payload.messages[0].blocks[0] as any;
    assert.strictEqual(note.blocks[0].type, 'code');
    assert.strictEqual(note.blocks[0].text, 'const x = 1');
});







test('strikethrough is transported natively without a warning', async () => {
    const b = bundle([msg('m1', 'user', [
        { type: 'paragraph', children: [{ type: 'strikethrough', children: [{ type: 'text', text: 'gone' }] }] },
    ])]);
    const { payload, diagnostics } = toTypstPayload(b, withPath);
    assert.ok(!diagnostics.some((d: any) => d.code === 'TYPST_STRIKETHROUGH_DROPPED'));
    const node = (payload.messages[0].blocks[0] as any).children[0];
    assert.strictEqual(node.type, 'strikethrough');
    assert.strictEqual(node.children[0].text, 'gone');
});


