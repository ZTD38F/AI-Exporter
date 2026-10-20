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
            title: 'Phase B',
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

const opts = { assetPath: (_a: any) => undefined };

function cell(text: string) {
    return { children: [{ type: 'text', text }] };
}

function row(...texts: string[]) {
    return { cells: texts.map(cell) };
}

test('multi header rows all reach the transport with no collapse diagnostic', async () => {
    const b = bundle([msg('m1', 'assistant', [{
        type: 'table', id: 't1',
        headerRows: [row('h1a', 'h1b'), row('h2a', 'h2b')],
        rows: [row('b1a', 'b1b')],
    }])]);
    const { payload, diagnostics } = toTypstPayload(b, opts);
    const node: any = payload.messages[0].blocks[0];
    assert.strictEqual(node.type, 'table');
    assert.strictEqual(node.headers.length, 2);
    assert.strictEqual(node.headers[0].length, 2);
    assert.strictEqual(node.headers[0][0].children[0].text, 'h1a');
    assert.strictEqual(node.headers[1][1].children[0].text, 'h2b');
    assert.strictEqual(node.rows[0][0].children[0].text, 'b1a');
    assert.ok(!diagnostics.some((d: any) => d.code === 'TYPST_V8_MULTI_HEADER_COLLAPSE'));
});

test('colSpan/rowSpan map to native Typst table.cell spans with no warning', async () => {
    const spanned = { children: [{ type: 'text', text: 'wide' }], colSpan: 2 };
    const tall = { children: [{ type: 'text', text: 'tall' }], rowSpan: 2 };
    const b = bundle([msg('m1', 'assistant', [{
        type: 'table', id: 't1',
        rows: [{ cells: [spanned, { children: [{ type: 'text', text: 'b' }] }] }, { cells: [tall, { children: [{ type: 'text', text: 'c' }] }] }],
    }])]);
    const { payload, diagnostics } = toTypstPayload(b, opts);
    const node: any = payload.messages[0].blocks[0];
    assert.strictEqual(node.rows[0].length, 2);
    assert.strictEqual(node.rows[0][0].colspan, 2);
    assert.strictEqual(node.rows[0][0].children[0].text, 'wide');
    assert.ok(!('colspan' in node.rows[0][1]), 'span of 1 is not emitted');
    assert.strictEqual(node.rows[1][0].rowspan, 2);
    assert.ok(!diagnostics.some((d: any) => d.code === 'TYPST_V8_TABLE_SPAN_IGNORED'));
});

test('message citationIds appends a note to blocks in Typst payload', async () => {
    const b = bundle(
        [msg('m1', 'assistant', [], { citationIds: ['c1'] })],
        { citations: [{ id: 'c1', url: 'https://example.com/a' }] },
    );
    const { payload } = toTypstPayload(b, opts);
    const node: any = payload.messages[0].blocks[0];
    assert.strictEqual(node.type, 'note');
    assert.ok(!('label' in node));
    assert.ok((node.children[0].text as string).includes('[1]'));
});

test('file description reaches the transport', async () => {
    const b = bundle(
        [msg('m1', 'assistant', [{
            type: 'file', id: 'f1', assetId: 'fa',
            label: 'report.pdf',
            description: [{ type: 'text', text: 'Q3 summary deck' }],
        }])],
        { assets: [{ id: 'fa', name: 'report.pdf', kind: 'document', mimeType: 'application/pdf', sizeBytes: 2048 }] },
    );
    const { payload } = toTypstPayload(b, opts);
    const node: any = payload.messages[0].blocks[0];
    assert.strictEqual(node.type, 'file');
    assert.strictEqual(node.description, 'Q3 summary deck');
});

test('thought kinds map to note labels', async () => {
    const cases: Array<[string, string | undefined]> = [
        ['summary', 'Thinking Summary'],
        ['progress', 'Thinking Progress'],
        ['reasoning', 'Thinking Process'],
        ['unknown', undefined],
    ];
    for (const [kind, label] of cases) {
        const b = bundle([msg('m1', 'assistant', [{
            type: 'thought', id: 'th1', disclosure: 'providerExposed', kind,
            blocks: [{ type: 'paragraph', id: 'p1', children: [{ type: 'text', text: 'hmm' }] }],
        }])]);
        const { payload } = toTypstPayload(b, opts);
        const node: any = payload.messages[0].blocks[0];
        assert.strictEqual(node.type, 'note');
        assert.strictEqual(node.label, label, `kind=${kind}`);
    }
});

test('code filename and meta reach the transport', async () => {
    const b = bundle([msg('m1', 'assistant', [{
        type: 'code', id: 'c1', code: 'print(1)', language: 'python',
        filename: 'app.py', meta: 'runnable',
    }])]);
    const { payload } = toTypstPayload(b, opts);
    const node: any = payload.messages[0].blocks[0];
    assert.strictEqual(node.type, 'code');
    assert.strictEqual(node.filename, 'app.py');
    assert.strictEqual(node.meta, 'runnable');
});

test('code without filename has no filename field', async () => {
    const b = bundle([msg('m1', 'assistant', [
        { type: 'code', id: 'c1', code: 'x', language: 'text' },
    ])]);
    const { payload } = toTypstPayload(b, opts);
    const node: any = payload.messages[0].blocks[0];
    assert.ok(!('filename' in node));
    assert.ok(!('meta' in node));
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

test('real WASM: phase B features compile with all text selectable', async () => {
    const b = bundle(
        [msg('m1', 'assistant', [
            {
                type: 'table', id: 't1',
                headerRows: [row('hdr-one', 'hdr-two'), row('sub-one', 'sub-two')],
                rows: [row('cell-one', 'cell-two')],
            },
            {
                type: 'file', id: 'f1', assetId: 'fa',
                label: 'report.pdf',
                description: [{ type: 'text', text: 'Q3 summary deck' }],
            },
            { type: 'heading', id: 'h4', level: 4, children: [{ type: 'text', text: 'fourth level' }] },
            { type: 'heading', id: 'h5', level: 5, children: [{ type: 'text', text: 'fifth level' }] },
            { type: 'heading', id: 'h6', level: 6, children: [{ type: 'text', text: 'sixth level' }] },
            {
                type: 'thought', id: 'th1', disclosure: 'providerExposed', kind: 'progress',
                blocks: [{ type: 'paragraph', id: 'tp1', children: [{ type: 'text', text: 'working on it' }] }],
            },
            {
                type: 'code', id: 'c1', code: 'print(1)', language: 'python',
                filename: 'app.py', meta: 'runnable',
            },
        ], { citationIds: ['c1'] })],
        {
            assets: [{ id: 'fa', name: 'report.pdf', kind: 'document', mimeType: 'application/pdf', sizeBytes: 2048 }],
            citations: [{ id: 'c1', url: 'https://example.com/a', title: 'Key sources' }],
        },
    );
    const result = await compileOnce(b);
    assert.ok(result.pdfBytes && result.pdfBytes.length > 0, 'compile must produce PDF bytes');
    const extracted = extractPdfText(result.pdfBytes);
    for (const needle of [
        'hdr-one', 'hdr-two', 'sub-one', 'sub-two', 'cell-one', 'cell-two',
        'Key sources', 'report.pdf', 'Q3 summary deck',
        'fourth level', 'fifth level', 'sixth level',
        'Thinking Progress', 'working on it',
        'app.py', 'runnable',
    ]) {
        assert.ok(extracted.text.includes(needle), `missing from PDF text: ${needle}`);
    }
});
