import { fixtureKey, fixtureAccountFor } from './helpers/domainFixture.js';
import { restoreDomainSnapshot } from '../src/l2/runtimeValidation.js';
export {};
const test = require('node:test');
const assert = require('node:assert');

const { composeDomainDocument } = require('../src/l3b/compose/composeDomainDocument.js');
const { renderTypstFixture } = require('./helpers/renderTypstFixture.js');
const { renderDocumentHtml } = require('../src/l4/format/html/renderHtml.js');

function domainFixture(blocks: any[], extra: any = {}) {
    return restoreDomainSnapshot({ index: { key: fixtureKey(String('c1'), 'gemini'),   titleSource: "derived",   title: 'Matrix', createdAt: Date.parse('2026-09-26T10:00:00Z') }, detail: { key: fixtureKey(String('c1'), 'gemini'), quality: { status: 'unknown' }, assets: extra.assets ?? [], messages: [{ id: 'm1', role: 'assistant', content: blocks, reasoning: extra.reasoning, citations: extra.citations ?? [] }] } });
}

const txt = (text: string) => ({ type: 'text', text });
const para = (text: string) => ({ type: 'paragraph', children: [txt(text)] });
const cell = (text: string, extra: any = {}) => ({ children: [txt(text)], ...extra });
const row = (...texts: string[]) => ({ cells: texts.map((t) => cell(t)) });
const opts = {};
const imgAsset = (id: string) => ({ id, kind: 'image', name: `${id}.png`, mediaType: 'image/png', byteLength: 1024 });

function typstOf(blocks: any[], extra: any = {}) {
    const domain = domainFixture(blocks, extra);
    const { payload, diagnostics } = renderTypstFixture(composeDomainDocument(domain, fixtureAccountFor(domain)), Object.fromEntries(domain.detail.assets.map((asset: any) => [asset.id, `assets/${asset.id}.png`])), opts);
    return { node: payload.messages[0].blocks[0] as any, diagnostics: diagnostics as any[] };
}

function htmlOf(blocks: any[], extra: any = {}, options: any = {}) {
    const domain = domainFixture(blocks, extra);
    return renderDocumentHtml(composeDomainDocument(domain, fixtureAccountFor(domain)), Object.fromEntries(domain.detail.assets.map((asset: any) => [asset.id, `assets/${asset.id}.png`])), options).html as string;
}
const imgUrl = {};

function noDegradation(diagnostics: any[], code: string) {
    assert.ok(!diagnostics.some((d: any) => d.code === code), `unexpected degradation ${code}`);
}

test('matrix: H1-H6 headings keep level in HTML and Typst', () => {
    const blocks = [{ type: 'heading', level: 4, children: [txt('L4')] }];
    assert.ok(htmlOf(blocks).includes('<h4'), 'html keeps h4');
    const { node, diagnostics } = typstOf(blocks);
    assert.strictEqual(node.type, 'heading');
    assert.strictEqual(node.level, 4);
    noDegradation(diagnostics, 'TYPST_V8_HEADING_CLAMP');
});

test('matrix: strikethrough is native in HTML and Typst', () => {
    const blocks = [{ type: 'paragraph', children: [{ type: 'strikethrough', children: [txt('gone')] }] }];
    assert.ok(htmlOf(blocks).includes('<del>gone</del>'), 'html uses del');
    const { node, diagnostics } = typstOf(blocks);
    assert.strictEqual(node.children[0].type, 'strikethrough');
    noDegradation(diagnostics, 'TYPST_STRIKETHROUGH_DROPPED');
});

test('matrix: nested list keeps structure in HTML and Typst', () => {
    const inner = { type: 'list', ordered: false, items: [{ blocks: [para('inner')] }] };
    const blocks = [{ type: 'list', ordered: false, items: [{ blocks: [para('outer'), inner] }] }];
    const html = htmlOf(blocks);
    assert.ok((html.match(/<ul/g) || []).length >= 2, 'html nests ul');
    const { node, diagnostics } = typstOf(blocks);
    assert.strictEqual(node.items[0].blocks[1].type, 'list');
    noDegradation(diagnostics, 'TYPST_V8_LIST_FLATTENED');
});

test('matrix: ordered list start is preserved in HTML and Typst', () => {
    const blocks = [{ type: 'list', ordered: true, start: 3, items: [{ blocks: [para('third')] }, { blocks: [para('fourth')] }] }];
    assert.ok(htmlOf(blocks).includes('start="3"'), 'html keeps ol start');
    const { node } = typstOf(blocks);
    assert.strictEqual(node.ordered, true);
    assert.strictEqual(node.start, 3);
});

test('matrix: quote keeps nested blocks in HTML and Typst', () => {
    const blocks = [{ type: 'quote', blocks: [para('quoted'), { type: 'image', assetId: 'a1', alt: 'pic' }] }];
    const extra = { assets: [imgAsset('a1')] };
    const html = htmlOf(blocks, extra, imgUrl);
    assert.ok(html.includes('<blockquote'), 'html blockquote');
    assert.ok(html.includes('assets/a1.png'), 'html keeps image');
    const { node } = typstOf(blocks, extra);
    assert.strictEqual(node.type, 'quote');
    assert.strictEqual(node.blocks[1].type, 'image');
});

test('matrix: reasoning keeps nested blocks and label in Typst', () => {
    const reasoning = [para('hmm')];
    assert.ok(htmlOf([], { reasoning }, { locale: 'en' }).includes('Thinking Process'), 'html shows thought label');
    const { node } = typstOf([], { reasoning });
    assert.strictEqual(node.type, 'note');
    assert.strictEqual(node.label, 'Thinking Process');
    assert.strictEqual(node.blocks.length, 1);
});

test('matrix: table caption survives in Typst', () => {
    const blocks = [{ type: 'table', caption: [txt('cap')], rows: [row('a', 'b')] }];
    const { node } = typstOf(blocks);
    assert.strictEqual(node.type, 'table');
    assert.deepStrictEqual(node.caption, [txt('cap')]);
});

test('matrix: headerless table keeps body rows in Typst', () => {
    const blocks = [{ type: 'table', headerRows: [], rows: [row('a', 'b'), row('c', 'd')] }];
    const { node } = typstOf(blocks);
    assert.deepStrictEqual(node.headers, []);
    assert.strictEqual(node.rows.length, 2);
    assert.strictEqual(node.rows[1][1].children[0].text, 'd');
});

test('matrix: multi header rows are all preserved in Typst', () => {
    const blocks = [{ type: 'table', headerRows: [row('h1a', 'h1b'), row('h2a', 'h2b')], rows: [row('a', 'b')] }];
    const { node, diagnostics } = typstOf(blocks);
    assert.strictEqual(node.headers.length, 2);
    assert.strictEqual(node.headers[1][0].children[0].text, 'h2a');
    noDegradation(diagnostics, 'TYPST_V8_MULTI_HEADER_COLLAPSE');
});

test('matrix: colSpan/rowSpan are native in Typst with no degradation diagnostic', () => {
    const blocks = [{ type: 'table', rows: [{ cells: [cell('wide', { colSpan: 2 }), cell('b')] }] }];
    const { node, diagnostics } = typstOf(blocks);
    assert.strictEqual(node.rows[0][0].colspan, 2);
    assert.strictEqual(node.rows[0][0].children[0].text, 'wide');
    noDegradation(diagnostics, 'TYPST_V8_TABLE_SPAN_IGNORED');
});

test('matrix: unknown content renders as visible text in HTML and Typst', () => {
    const blocks = [{ type: 'unknown', sourceType: 'x.y', text: 'fb\npic' }];
    const html = htmlOf(blocks, {}, { locale: 'en' });
    assert.ok(html.includes('fb\npic'));
    assert.ok(html.includes('Unsupported · x.y'));
    const { node } = typstOf(blocks);
    assert.strictEqual(node.type, 'unknown');
    assert.strictEqual(node.fallback, 'fb\npic');
    assert.ok(!('blocks' in node));
});

test('matrix: file description reaches Typst transport', () => {
    const asset = { id: 'f1', kind: 'file', name: 'doc.pdf', mediaType: 'application/pdf', byteLength: 100 };
    const blocks = [{ type: 'file', assetId: 'f1', label: 'doc.pdf', description: [txt('desc')] }];
    const { node } = typstOf(blocks, { assets: [asset] });
    assert.strictEqual(node.type, 'file');
    assert.deepStrictEqual(node.description, [txt('desc')]);
});

test('matrix: message citations reach HTML and Typst transport', () => {
    const extra = {
        citations: [{ id: 'c1', url: 'https://example.com', title: 'Example Source' }],
    };
    assert.ok(htmlOf([], extra).includes('Example Source'), 'html shows citation');
    const { payload } = renderTypstFixture(composeDomainDocument(domainFixture([], extra), fixtureAccountFor(domainFixture([], extra))), Object.fromEntries(domainFixture([], extra).detail.assets.map((asset: any) => [asset.id, `assets/${asset.id}.png`])), opts);
    const node: any = payload.messages[0].blocks[0];
    assert.strictEqual(node.type, 'note');
    assert.deepEqual(node.children[0], { type: 'link', url: 'https://example.com/', children: [txt('[1] Example Source')] }, 'Typst preserves source number and link');
});

test('matrix: thematic break is a native divider in HTML and Typst', () => {
    const blocks = [{ type: 'thematicBreak' }];
    assert.ok(htmlOf(blocks).includes('<hr'), 'html hr');
    const { node, diagnostics } = typstOf(blocks);
    assert.strictEqual(node.type, 'thematicBreak');
    assert.ok(!diagnostics.some((d: any) => /thematic/i.test(d.code)));
});

const citeRef = (citationId: string, label?: string) => ({
    type: 'paragraph',
    children: [{ type: 'citationRef', citationId, ...(label ? { label } : {}) }],
});

function typstRefLabel(blocks: any[], extra: any) {
    const { payload } = renderTypstFixture(composeDomainDocument(domainFixture(blocks, extra), fixtureAccountFor(domainFixture(blocks, extra))), Object.fromEntries(domainFixture(blocks, extra).detail.assets.map((asset: any) => [asset.id, `assets/${asset.id}.png`])), {  });
    const para: any = payload.messages[0].blocks[0];
    const link = para.children[0];
    return (link.children ? link.children[0].text : link.text) as string;
}

test('matrix: citation label priority is identical in HTML and Typst', () => {
    const cases: Array<[any, string]> = [
        [{ id: 'c1', title: 'Title' }, '[1]'],
        [{ id: 'c1', title: 'Pub' }, '[1]'],
        [{ id: 'c1' }, '[1]'],
    ];
    for (const [citation, expected] of cases) {
        const extra = { citations: [citation] };
        assert.ok(htmlOf([citeRef('c1')], extra).includes(expected), `html label priority -> ${expected}`);
        assert.strictEqual(typstRefLabel([citeRef('c1')], extra), expected, `typst label priority -> ${expected}`);
    }
    const extra = { citations: [{ id: 'c1', title: 'Title' }] };
    assert.ok(htmlOf([citeRef('c1', 'See here')], extra).includes('See here'), 'html explicit inline label wins');
    assert.strictEqual(typstRefLabel([citeRef('c1', 'See here')], extra), 'See here', 'typst explicit inline label wins');
});

test('matrix: message citation chips follow the unified label rule', () => {
    const extra = {
        citations: [{ id: 'c1', title: 'PubOne' }, { id: 'c2' }],
    };
    const html = htmlOf([], extra);
    assert.ok(html.includes('PubOne'), 'html chip uses publisher');
    assert.ok(html.includes('[2]'), 'html chip falls back to [n]');
    const { payload } = renderTypstFixture(composeDomainDocument(domainFixture([], extra), fixtureAccountFor(domainFixture([], extra))), Object.fromEntries(domainFixture([], extra).detail.assets.map((asset: any) => [asset.id, `assets/${asset.id}.png`])), {  });
    const text = JSON.stringify(payload.messages[0].blocks[0]);
    assert.ok(text.includes('PubOne'), 'typst group uses publisher');
    assert.ok(text.includes('[2]'), 'typst group falls back to [n]');
});

test('matrix: unknown raw citation metadata never reaches the shared AST or a backend', async () => {
    const { parseFixture } = require('./helpers/documentFixture.js');
    const { domain, document, resources } = await parseFixture({ id: 'metadata', messages: [{ role: 'model', content: 'Answer [1]', citations: [{ url: 'https://example.com', title: 'T', snippet: 'secret-snippet-xyz', assetId: 'asset-9' }] }] });
    for (const output of [JSON.stringify(domain), JSON.stringify(document), renderDocumentHtml(document, resources).html, JSON.stringify(renderTypstFixture(document, resources).payload)]) {
        assert.ok(!output.includes('secret-snippet-xyz'));
        assert.ok(!output.includes('asset-9'));
    }
});
