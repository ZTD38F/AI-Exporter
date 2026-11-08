import { fixtureKey, fixtureAccountFor } from './helpers/domainFixture.js';
export {};
const test = require('node:test');
const assert = require('node:assert');

const { renderTypstFixture } = require('./helpers/renderTypstFixture.js');
const { composeDomainDocument } = require('../src/l3b/compose/composeDomainDocument.js');
const { validateParserDomain } = require('../src/l2/runtimeValidation.js');
const { TypstSandboxCompiler } = require('../src/l4/format/pdf/typst/typstSandboxCompiler.js');
const { convertMathForTest: convertMath } = require('./helpers/mathConversion.js');
const { extractPdfText } = require('./helpers/pdfTextExtract.js');
const {
    RealWasmSandboxHost,
    repoRoot,
} = require('./helpers/realWasmSandbox.js');

function domainFixture(messages: any[], assets: any[] = []) {
    // Use a valid, trusted Domain graph before testing DocumentAst/Typst behavior.
    return validateParserDomain({ index: { key: fixtureKey(String('c1'), 'gemini'),   titleSource: "derived",   title: 'Fixture', createdAt: Date.parse('2026-09-26T10:00:00Z') }, detail: { key: fixtureKey(String('c1'), 'gemini'), quality: { status: 'unknown' }, assets, messages } });
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

const headerlessTable = {
    type: 'table',
    rows: [row('north-one', 'north-two'), row('south-one', 'south-two')],
};

test('headerless table keeps empty headers and full body rows', async () => {
    const b = domainFixture([msg('m1', 'assistant', [headerlessTable])]);
    const { payload } = renderTypstFixture(composeDomainDocument(b, fixtureAccountFor(b)), Object.fromEntries(b.detail.assets.map((asset: { id: string }) => [asset.id, `assets/${asset.id}.png`])), opts);
    const node: any = payload.messages[0].blocks[0];
    assert.strictEqual(node.type, 'table');
    assert.deepStrictEqual(node.headers, []);
    assert.strictEqual(node.rows.length, 2);
    assert.strictEqual(node.rows[0].length, 2);
    assert.strictEqual(node.rows[0][0].children[0].text, 'north-one');
    assert.strictEqual(node.rows[1][1].children[0].text, 'south-two');
});

test('thematicBreak becomes a native divider node, not an em-dash paragraph', async () => {
    const b = domainFixture([msg('m1', 'assistant', [{ type: 'thematicBreak' }])]);
    const { payload } = renderTypstFixture(composeDomainDocument(b, fixtureAccountFor(b)), Object.fromEntries(b.detail.assets.map((asset: { id: string }) => [asset.id, `assets/${asset.id}.png`])), opts);
    const node: any = payload.messages[0].blocks[0];
    assert.deepStrictEqual(node, { type: 'thematicBreak', layout: { gapBeforePt: 0, keepWithNext: false, width: 'reading' } });
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

test('real WASM: headerless table, thematicBreak and strikethrough compile with all text selectable', async () => {
    const b = domainFixture([msg('m1', 'assistant', [
        headerlessTable,
        { type: 'thematicBreak' },
        {
            type: 'paragraph', children: [{ type: 'strikethrough', children: [{ type: 'text', text: 'struck-text' }] }],
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
