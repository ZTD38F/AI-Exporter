import { fixtureKey, fixtureAccountFor } from './helpers/domainFixture.js';
import { restoreDomainSnapshot } from '../src/l2/runtimeValidation.js';
/**
 * tests/document-renderer-contract.test.ts
 *
 * Item 3: cross-renderer contract gate (Document HTML x Typst backend).
 * Unlike tests/domain-contract.test.ts (Domain closure layer), this
 * gate asserts the two RENDER paths agree: for each of the 12 most common
 * document features, the main text must appear in BOTH outputs, key asset
 * placements must exist on BOTH sides, and nothing may be silently dropped
 * (no error diagnostics, no drop-indicating warning codes).
 *
 * Item 15: asset block placement gate (same file). Both render paths must
 * route asset blocks faithfully so future renderers cannot drop them.
 */
export {};
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { execSync } = require('node:child_process');

const { renderDocumentHtml } = require('../src/l4/format/html/renderHtml.js');
const { composeDomainDocument } = require('../src/l3b/compose/composeDomainDocument.js');
const { renderTypstFixture } = require('./helpers/renderTypstFixture.js');

const REPO_ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------- builders

const txt = (text: string) => ({ type: 'text', text });
const para = (text: string) => ({ type: 'paragraph', children: [txt(text)] });

function domainFixture(blocks: any[], extra: any = {}) {
    return restoreDomainSnapshot({ index: { key: fixtureKey(String('c1'), 'gemini'),   titleSource: "derived",   title: 'Contract', createdAt: Date.parse('2026-09-26T10:00:00Z') }, detail: { key: fixtureKey(String('c1'), 'gemini'), quality: { status: 'unknown' }, assets: extra.assets ?? [], messages: [{ id: 'm1', role: 'assistant', content: blocks, reasoning: extra.reasoning, citations: extra.citations ?? [] }] } });
}

const imgAsset = (id: string, name: string) => ({
    id, kind: 'image', name, mediaType: 'image/png', byteLength: 1024,
});
const fileAsset = (id: string, name: string) => ({
    id, kind: 'file', name, mediaType: 'application/pdf', byteLength: 2048,
});

const HTML_OPTS = {};
const TYPST_OPTS = {};

function renderBoth(blocks: any[], extra: any = {}) {
    const b = domainFixture(blocks, extra);
    const { html, diagnostics: htmlDiags } = renderDocumentHtml(composeDomainDocument(b, fixtureAccountFor(b)), Object.fromEntries(b.detail.assets.map((asset: any) => [asset.id, `assets/${asset.id}`])), HTML_OPTS);
    const { payload, diagnostics: typstDiags } = renderTypstFixture(composeDomainDocument(b, fixtureAccountFor(b)), Object.fromEntries(b.detail.assets.map((asset: any) => [asset.id, `assets/${asset.id}.png`])), TYPST_OPTS);
    return { html: html as string, htmlDiags: htmlDiags as any[], payload: payload as any, typstDiags: typstDiags as any[] };
}

const typstText = (payload: any): string => JSON.stringify(payload);

const DROP_CODE_PATTERN = /DROP|MISSING|UNRESOLVED|TRUNCATED/i;

function assertNoSilentDrop(htmlDiags: any[], typstDiags: any[], feature: string) {
    for (const d of htmlDiags) {
        assert.notStrictEqual(d.severity, 'error', `${feature}: html error diagnostic: ${JSON.stringify(d)}`);
        assert.ok(!DROP_CODE_PATTERN.test(d.code ?? ''), `${feature}: html drop-indicating warning ${d.code}: ${JSON.stringify(d)}`);
    }
    for (const d of typstDiags) {
        assert.notStrictEqual(d.severity, 'error', `${feature}: typst error diagnostic: ${JSON.stringify(d)}`);
        assert.ok(!DROP_CODE_PATTERN.test(d.code ?? ''), `${feature}: typst drop-indicating warning ${d.code}: ${JSON.stringify(d)}`);
    }
}

// ---------------------------------------------------------------- fixtures

test('contract: paragraph text survives in HTML and Typst', () => {
    const s = 'SENTINEL_PARA_A1B2';
    const { html, htmlDiags, payload, typstDiags } = renderBoth([para(s)]);
    assert.ok(html.includes(s), 'html keeps paragraph text');
    assert.ok(typstText(payload).includes(s), 'typst keeps paragraph text');
    assertNoSilentDrop(htmlDiags, typstDiags, 'paragraph');
});

test('contract: heading text and level survive in HTML and Typst', () => {
    const s = 'SENTINEL_HEADING_C3D4';
    const blocks = [{ type: 'heading', level: 2, children: [txt(s)] }];
    const { html, htmlDiags, payload, typstDiags } = renderBoth(blocks);
    assert.ok(html.includes('<h2'), 'html keeps h2');
    assert.ok(html.includes(s), 'html keeps heading text');
    assert.ok(typstText(payload).includes('"type":"heading"'), 'typst has heading node');
    assert.ok(typstText(payload).includes(s), 'typst keeps heading text');
    assertNoSilentDrop(htmlDiags, typstDiags, 'heading');
});

test('contract: strong and emphasis survive in HTML and Typst', () => {
    const s1 = 'SENTINEL_STRONG_E5F6';
    const s2 = 'SENTINEL_EM_G7H8';
    const blocks = [{
        type: 'paragraph',
        children: [
            { type: 'strong', children: [txt(s1)] },
            txt(' and '),
            { type: 'emphasis', children: [txt(s2)] },
        ],
    }];
    const { html, htmlDiags, payload, typstDiags } = renderBoth(blocks);
    assert.ok(html.includes(`<strong>${s1}</strong>`), 'html uses strong');
    assert.ok(html.includes(`<em>${s2}</em>`), 'html uses em');
    const jt = typstText(payload);
    assert.ok(jt.includes(s1) && jt.includes(s2), 'typst keeps both runs');
    assertNoSilentDrop(htmlDiags, typstDiags, 'strong/emphasis');
});

test('contract: code block content survives in HTML and Typst', () => {
    const s = 'SENTINEL_CODE_I9J0';
    const blocks = [{ type: 'code', code: `print("${s}")`, language: 'python' }];
    const { html, htmlDiags, payload, typstDiags } = renderBoth(blocks);
    assert.ok(html.includes(s), 'html keeps code text');
    const jt = typstText(payload);
    assert.ok(jt.includes('"type":"code"'), 'typst has code node');
    assert.ok(jt.includes(s), 'typst keeps code text');
    assertNoSilentDrop(htmlDiags, typstDiags, 'code');
});

test('contract: list items survive in HTML and Typst', () => {
    const s1 = 'SENTINEL_LIST_K1L2';
    const s2 = 'SENTINEL_LIST_M3N4';
    const blocks = [{
        type: 'list', ordered: false,
        items: [{ blocks: [para(s1)] }, { blocks: [para(s2)] }],
    }];
    const { html, htmlDiags, payload, typstDiags } = renderBoth(blocks);
    assert.ok(html.includes('<ul'), 'html uses ul');
    assert.ok(html.includes(s1) && html.includes(s2), 'html keeps both items');
    const jt = typstText(payload);
    assert.ok(jt.includes('"type":"list"'), 'typst has list node');
    assert.ok(jt.includes(s1) && jt.includes(s2), 'typst keeps both items');
    assertNoSilentDrop(htmlDiags, typstDiags, 'list');
});

test('contract: table cells survive in HTML and Typst', () => {
    const s = 'SENTINEL_CELL_O5P6';
    const blocks = [{
        type: 'table',
        headerRows: [{ cells: [{ children: [txt('Head SENTINEL_CELL_HDR')] }] }],
        rows: [{ cells: [{ children: [txt(s)] }] }],
    }];
    const { html, htmlDiags, payload, typstDiags } = renderBoth(blocks);
    assert.ok(html.includes('<table'), 'html uses table');
    assert.ok(html.includes(s), 'html keeps cell text');
    const jt = typstText(payload);
    assert.ok(jt.includes('"type":"table"'), 'typst has table node');
    assert.ok(jt.includes(s), 'typst keeps cell text');
    assertNoSilentDrop(htmlDiags, typstDiags, 'table');
});

test('contract: image block placement exists on both renderers', () => {
    const s = 'SENTINEL_IMG_Q1W2';
    const blocks = [{ type: 'image', assetId: 'imgA', alt: s }];
    const { html, htmlDiags, payload, typstDiags } = renderBoth(
        blocks,
        { assets: [imgAsset('imgA', 'imgA.png')] },
    );
    assert.ok(html.includes('src="assets/imgA"'), 'html renders image block');
    const msgBlocks = payload.messages[0].blocks ?? [];
    assert.ok(
        msgBlocks.some((b: any) => b.type === 'image' && b.asset === 'assets/imgA.png'),
        `typst blocks place the image, got: ${JSON.stringify(msgBlocks)}`,
    );
    assertNoSilentDrop(htmlDiags, typstDiags, 'image block');
});

test('contract: file block placement exists on both renderers', () => {
    const s = 'SENTINEL_FILE_Q7R8.pdf';
    const blocks = [{ type: 'file', assetId: 'fileB', label: s }];
    const { html, htmlDiags, payload, typstDiags } = renderBoth(
        blocks,
        { assets: [fileAsset('fileB', s)] },
    );
    assert.ok(html.includes(s), 'html renders file card');
    const msgBlocks = payload.messages[0].blocks ?? [];
    assert.ok(
        msgBlocks.some((b: any) => b.type === 'file' && b.name === s),
        `typst blocks place the file, got: ${JSON.stringify(msgBlocks)}`,
    );
    assertNoSilentDrop(htmlDiags, typstDiags, 'file block');
});

test('contract: citation label and message sources survive in HTML and Typst', () => {
    const s = 'SENTINEL_CITE_T5Y6';
    const blocks = [
        { type: 'paragraph', children: [txt(s), { type: 'citationRef', citationId: 'cite1' }] },
    ];
    const { html, htmlDiags, payload, typstDiags } = renderBoth(
        blocks,
        {
            citations: [{ id: 'cite1', url: 'https://example.com/article' }],
        },
    );
    assert.ok(html.includes('gem-citation-ref'), 'html renders citation ref');
    assert.ok(html.includes('[1]'), 'html shows citation number');
    assert.ok(html.includes('gem-citation-group'), 'html keeps sources section');
    const jt = typstText(payload);
    assert.ok(jt.includes(s), 'typst keeps paragraph text');
    assert.ok(jt.includes('[1]'), 'typst keeps citation label');
    assertNoSilentDrop(htmlDiags, typstDiags, 'citation');
});

test('contract: thought inner text survives in HTML and Typst', () => {
    const s = 'SENTINEL_THOUGHT_S9T0';
    const reasoning = [para(s)];
    const { html, htmlDiags, payload, typstDiags } = renderBoth([], { reasoning });
    assert.ok(html.includes(s), 'html keeps thought text');
    const jt = typstText(payload);
    assert.ok(jt.includes(s), 'typst keeps thought text');
    assertNoSilentDrop(htmlDiags, typstDiags, 'thought');
});

test('contract: unknown block fallback is visible on both renderers', () => {
    const s = 'SENTINEL_UNKNOWN_F1B2';
    const blocks = [{
        type: 'unknown', sourceType: 'SENTINEL_UNKNOWN_SRC',
        text: s,
    }];
    const { html, htmlDiags, payload, typstDiags } = renderBoth(blocks);
    assert.ok(html.includes(s), 'html shows unknown fallback text');
    assert.ok(html.includes('SENTINEL_UNKNOWN_SRC'), 'html labels the unknown source type');
    const jt = typstText(payload);
    assert.ok(jt.includes(s), 'typst shows unknown fallback text');
    assert.ok(jt.includes('SENTINEL_UNKNOWN_SRC'), 'typst keeps the unknown source type');
    assertNoSilentDrop(htmlDiags, typstDiags, 'unknown fallback');
});




test('inline HTML resource references are collected from the Document AST and use supplied bindings', () => {
    const domain = domainFixture([{ type: 'paragraph', children: [txt('diagram: '), { type: 'image', assetId: 'img-1', alt: 'architecture' }] }], { assets: [imgAsset('img-1', 'diagram.png')] });
    const document = composeDomainDocument(domain, fixtureAccountFor(domain));
    const { collectDocumentResources } = require('../src/l3b/ast/resourceReferences.js');
    assert.deepEqual([...collectDocumentResources(document).referencedIds], ['img-1']);
    const result = renderDocumentHtml(document, { 'img-1': 'assets/img-1.png' });
    assert.ok(result.html.includes('<img'));
    assert.ok(result.html.includes('assets/img-1.png'));
    assert.deepEqual(result.diagnostics, []);
});
test('HTML renders all messages in authoritative source order', () => {
    const domain = { index: { key: fixtureKey(String('order'), 'gemini'),   titleSource: "derived",   title: 'Order' }, detail: { key: fixtureKey(String('order'), 'gemini'), quality: { status: 'unknown' }, assets: [], messages: ['second', 'first'].map(id => ({ id, role: 'user', content: [para(id)] })) } };
    const { html } = renderDocumentHtml(composeDomainDocument(domain, fixtureAccountFor(domain)), {});
    assert.ok(html.indexOf('second') < html.indexOf('first'));
});
