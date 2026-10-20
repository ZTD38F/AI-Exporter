export {};
const test = require('node:test');
const assert = require('node:assert');

const { toTypstPayload } = require('../src/core/export/typst/payload.js');
const { TypstSandboxCompiler } = require('../src/core/export/typst/typstSandboxCompiler.js');
const { convertMath } = require('../src/core/export/typst/mathConverter.js');
const { extractPdfText } = require('./helpers/pdfTextExtract.js');
const {
    RealWasmSandboxHost,
    repoRoot,
} = require('./helpers/realWasmSandbox.js');

function bundle(messages: any[], extra: any = {}) {
    return {
        schemaVersion: 1,
        conversation: {
            key: { providerId: 'gemini', accountId: 'test-account', conversationId: 'c1' },
            title: 'Table break strike',
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

function cell(text: string) {
    return { children: [{ type: 'text', text }] };
}

function row(...texts: string[]) {
    return { cells: texts.map(cell) };
}

const headerlessTable = {
    type: 'table',
    id: 't1',
    rows: [row('north-one', 'north-two'), row('south-one', 'south-two')],
};

test('headerless table keeps empty headers and full body rows', async () => {
    const b = bundle([msg('m1', 'assistant', [headerlessTable])]);
    const { payload } = toTypstPayload(b, opts);
    const node: any = payload.messages[0].blocks[0];
    assert.strictEqual(node.type, 'table');
    assert.deepStrictEqual(node.headers, []);
    assert.strictEqual(node.rows.length, 2);
    assert.strictEqual(node.rows[0].length, 2);
    assert.strictEqual(node.rows[0][0].children[0].text, 'north-one');
    assert.strictEqual(node.rows[1][1].children[0].text, 'south-two');
});

test('thematicBreak becomes a native divider node, not an em-dash paragraph', async () => {
    const b = bundle([msg('m1', 'assistant', [{ type: 'thematicBreak', id: 'tb1' }])]);
    const { payload } = toTypstPayload(b, opts);
    const node: any = payload.messages[0].blocks[0];
    assert.deepStrictEqual(node, { type: 'thematicBreak' });
});

async function compileOnce(bundle: any) {
    const host = new RealWasmSandboxHost(repoRoot());
    const compiler = new TypstSandboxCompiler({ host });
    const assetPath = (a: any) => `/assets/${a.id}.png`;
    const { payload: document } = toTypstPayload(bundle, { assetPath, convertMath });
    const context = {
        bundle,
        assets: {
            resolve: async (id: string) => null,
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

test('real WASM: headerless table, thematicBreak and strikethrough compile with all text selectable', async () => {
    const b = bundle([msg('m1', 'assistant', [
        headerlessTable,
        { type: 'thematicBreak', id: 'tb1' },
        {
            type: 'paragraph', id: 'p1',
            children: [{ type: 'strikethrough', children: [{ type: 'text', text: 'struck-text' }] }],
        },
    ])]);
    const result = await compileOnce(b);
    assert.ok(result.pdfBytes && result.pdfBytes.length > 0, 'compile must produce PDF bytes');
    const extracted = extractPdfText(result.pdfBytes);
    for (const needle of ['north-one', 'north-two', 'south-one', 'south-two', 'struck-text']) {
        assert.ok(extracted.text.includes(needle), `missing from PDF text: ${needle}`);
    }
    assert.ok(!extracted.text.includes('—'), 'thematic break must not render as copyable em-dash text');
});
