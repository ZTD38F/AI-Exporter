import { fixtureKey, fixtureAccountFor } from './helpers/domainFixture.js';
import { restoreDomainSnapshot } from '../src/l2/runtimeValidation.js';
export {};
const test = require('node:test');
const assert = require('node:assert');

const { renderTypstFixture } = require('./helpers/renderTypstFixture.js');
const { composeDomainDocument } = require('../src/l3b/compose/composeDomainDocument.js');
const { TypstSandboxCompiler } = require('../src/l4/format/pdf/typst/typstSandboxCompiler.js');
const { convertMathForTest: convertMath } = require('./helpers/mathConversion.js');
const { extractPdfText } = require('./helpers/pdfTextExtract.js');
const {
    RealWasmSandboxHost,
    repoRoot,
} = require('./helpers/realWasmSandbox.js');

function domainFixture(messages: any[], assets: any[] = []) {
    return restoreDomainSnapshot({ index: { key: fixtureKey(String('c1'), 'gemini'),   titleSource: "derived",   title: 'Fixture', createdAt: Date.parse('2026-09-26T10:00:00Z') }, detail: { key: fixtureKey(String('c1'), 'gemini'), quality: { status: 'unknown' }, assets, messages: messages } });
}

function msg(id: string, role: string, blocks: any[], extra: any = {}) {
    return { id, role, content: blocks, ...extra };
}

const opts = {};

function cell(text: string) {
    return { children: [{ type: 'text', text }] };
}

function row(...texts: string[]) {
    return { cells: texts.map(cell) };
}

test('multi header rows all reach the transport with no collapse diagnostic', async () => {
    const b = domainFixture([msg('m1', 'assistant', [{
        type: 'table', headerRows: [row('h1a', 'h1b'), row('h2a', 'h2b')],
        rows: [row('b1a', 'b1b')],
    }])]);
    const { payload, diagnostics } = renderTypstFixture(composeDomainDocument(b, fixtureAccountFor(b)), Object.fromEntries(b.detail.assets.map((asset: { id: string }) => [asset.id, `assets/${asset.id}.png`])), opts);
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
    const b = domainFixture([msg('m1', 'assistant', [{
        type: 'table', rows: [{ cells: [spanned, { children: [{ type: 'text', text: 'b' }] }] }, { cells: [tall, { children: [{ type: 'text', text: 'c' }] }] }],
    }])]);
    const { payload, diagnostics } = renderTypstFixture(composeDomainDocument(b, fixtureAccountFor(b)), Object.fromEntries(b.detail.assets.map((asset: { id: string }) => [asset.id, `assets/${asset.id}.png`])), opts);
    const node: any = payload.messages[0].blocks[0];
    assert.strictEqual(node.rows[0].length, 2);
    assert.strictEqual(node.rows[0][0].colspan, 2);
    assert.strictEqual(node.rows[0][0].children[0].text, 'wide');
    assert.ok(!('colspan' in node.rows[0][1]), 'span of 1 is not emitted');
    assert.strictEqual(node.rows[1][0].rowspan, 2);
    assert.ok(!diagnostics.some((d: any) => d.code === 'TYPST_V8_TABLE_SPAN_IGNORED'));
});

test('message sources append a note to blocks in Typst payload', async () => {
    const b = domainFixture(
        [msg('m1', 'assistant', [], { citations: [{ id: 'c1', url: 'https://example.com/a' }] })],
    );
    const { payload } = renderTypstFixture(composeDomainDocument(b, fixtureAccountFor(b)), Object.fromEntries(b.detail.assets.map((asset: { id: string }) => [asset.id, `assets/${asset.id}.png`])), opts);
    const node: any = payload.messages[0].blocks[0];
    assert.strictEqual(node.type, 'note');
    assert.equal(node.label, 'Sources');
    assert.deepEqual(node.children, [{ type: 'link', url: 'https://example.com/a', children: [{ type: 'text', text: '[1] https://example.com/a' }] }]);
});

test('file description reaches the transport', async () => {
    const b = domainFixture(
        [msg('m1', 'assistant', [{
            type: 'file', assetId: 'fa',
            label: 'report.pdf',
            description: [{ type: 'text', text: 'Q3 summary deck' }],
        }])],
        [{ id: 'fa', name: 'report.pdf', kind: 'file', mediaType: 'application/pdf', byteLength: 2048 }],
    );
    const { payload } = renderTypstFixture(composeDomainDocument(b, fixtureAccountFor(b)), Object.fromEntries(b.detail.assets.map((asset: { id: string }) => [asset.id, `assets/${asset.id}.png`])), opts);
    const node: any = payload.messages[0].blocks[0];
    assert.strictEqual(node.type, 'file');
    assert.deepStrictEqual(node.description, [{ type: 'text', text: 'Q3 summary deck' }]);
});

test('reasoning maps to a thinking process note', async () => {
    const b = domainFixture([msg('m1', 'assistant', [], { reasoning: [{ type: 'paragraph', children: [{ type: 'text', text: 'hmm' }] }] })]);
    const { payload } = renderTypstFixture(composeDomainDocument(b, fixtureAccountFor(b)), {}, opts);
    const node: any = payload.messages[0].blocks[0];
    assert.strictEqual(node.type, 'note');
    assert.strictEqual(node.label, 'Thinking Process');
});

test('code language and meta reach the transport', async () => {
    const b = domainFixture([msg('m1', 'assistant', [{
        type: 'code', code: 'print(1)', language: 'python',
        meta: 'runnable',
    }])]);
    const { payload } = renderTypstFixture(composeDomainDocument(b, fixtureAccountFor(b)), Object.fromEntries(b.detail.assets.map((asset: { id: string }) => [asset.id, `assets/${asset.id}.png`])), opts);
    const node: any = payload.messages[0].blocks[0];
    assert.strictEqual(node.type, 'code');
    assert.strictEqual(node.header, 'python · runnable');
    assert.ok(!('filename' in node));
    assert.ok(!('meta' in node));
});

test('code without filename has no filename field', async () => {
    const b = domainFixture([msg('m1', 'assistant', [
        { type: 'code', code: 'x', language: 'text' },
    ])]);
    const { payload } = renderTypstFixture(composeDomainDocument(b, fixtureAccountFor(b)), Object.fromEntries(b.detail.assets.map((asset: { id: string }) => [asset.id, `assets/${asset.id}.png`])), opts);
    const node: any = payload.messages[0].blocks[0];
    assert.ok(!('filename' in node));
    assert.ok(!('meta' in node));
});

async function compileOnce(domain: any) {
    const host = new RealWasmSandboxHost(repoRoot());
    const compiler = new TypstSandboxCompiler({ host });
    const resources = Object.fromEntries(domain.detail.assets.map((asset: { id: string }) => [asset.id, `/assets/${asset.id}.png`]));
    const { payload: document } = renderTypstFixture(composeDomainDocument(domain, fixtureAccountFor(domain)), resources, { convertMath });
    const context = {

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

                document,
                assetPaths: new Map(Object.entries(resources)),
            } as never,
            context as never,
        );
        return result;
    } finally {
        compiler.dispose();
    }
}

test('real WASM: phase B features compile with all text selectable', async () => {
    const b = domainFixture(
        [msg('m1', 'assistant', [
            {
                type: 'table', headerRows: [row('hdr-one', 'hdr-two'), row('sub-one', 'sub-two')],
                rows: [row('cell-one', 'cell-two')],
            },
            {
                type: 'file', assetId: 'fa',
                label: 'report.pdf',
                description: [{ type: 'text', text: 'Q3 summary deck' }],
            },
            { type: 'heading', level: 4, children: [{ type: 'text', text: 'fourth level' }] },
            { type: 'heading', level: 5, children: [{ type: 'text', text: 'fifth level' }] },
            { type: 'heading', level: 6, children: [{ type: 'text', text: 'sixth level' }] },
            {
                type: 'code', code: 'print(1)', language: 'python',
                meta: 'runnable',
            },
        ], { reasoning: [{ type: 'paragraph', children: [{ type: 'text', text: 'working on it' }] }], citations: [{ id: 'c1', url: 'https://example.com/a', title: 'Key sources' }] })],
        [{ id: 'fa', name: 'report.pdf', kind: 'file', mediaType: 'application/pdf', byteLength: 2048 }],
    );
    const result = await compileOnce(b);
    assert.ok(result.pdfBytes && result.pdfBytes.length > 0, 'compile must produce PDF bytes');
    const extracted = extractPdfText(result.pdfBytes);
    for (const needle of [
        'hdr-one', 'hdr-two', 'sub-one', 'sub-two', 'cell-one', 'cell-two',
        'Key sources', 'report.pdf', 'Q3 summary deck',
        'fourth level', 'fifth level', 'sixth level',
        'Thinking Process', 'working on it',
        'runnable',
    ]) {
        assert.ok(extracted.text.includes(needle), `missing from PDF text: ${needle}`);
    }
});
