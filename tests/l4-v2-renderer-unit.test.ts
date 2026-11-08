/** Frozen L3b v2 DocumentAst + Packaging bindings are input mocks; real L4 outputs are under test. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { v2Document } from './helpers/l4V2Fixtures.js';
import { renderDocumentHtml } from '../src/l4/format/html/renderHtml.js';
import { renderDocumentMarkdown } from '../src/l4/format/markdown/renderMarkdown.js';
import { renderDocumentTypst } from './helpers/renderTypstFixture.js';
import type { DocumentAst } from '../src/l3b/ast/ast.js';
import type { ResourceBindings } from '../src/l4/packaging/resourceBindings.js';

const bindings: ResourceBindings = { image: 'assets/Chosen name.png', file: 'files/report.txt' };
const document: DocumentAst = v2Document([
    { type: 'heading', level: 2, children: [{ type: 'text', text: 'Heading <unsafe>' }] },
    { type: 'paragraph', children: [
        { type: 'strong', children: [{ type: 'text', text: 'Hello & friends' }] },
        { type: 'text', text: ' ' },
        { type: 'link', href: 'https://example.com/path?q=1', children: [{ type: 'text', text: 'Source' }] },
        { type: 'text', text: ' ' },
        { type: 'link', href: 'javascript:alert(1)', children: [{ type: 'text', text: 'Untrusted' }] },
    ] },
    { type: 'code', language: 'typescript', code: 'const x = 1 < 2;', meta: 'example.ts' },
    { type: 'list', ordered: false, items: [
        { blocks: [{ type: 'paragraph', children: [{ type: 'text', text: 'first' }] }] },
        { blocks: [{ type: 'paragraph', children: [{ type: 'text', text: 'second' }] }] },
    ] },
    { type: 'image', resourceId: 'image', alt: 'Diagram' },
    { type: 'file', resourceId: 'file', label: 'report.txt', kind: 'file' },
    { type: 'disclosure', kind: 'reasoning', title: 'Reasoning', blocks: [
        { type: 'paragraph', children: [{ type: 'text', text: 'private outline' }] },
    ] },
    { type: 'unsupported', sourceType: 'future', text: 'Keep me' },
], { title: 'v2 Fixture', id: 'c1' });

test('v2 AST passes through all three real L4 text/Typst backends without a composer', () => {
    const before = structuredClone(document);
    const html = renderDocumentHtml(document, bindings);
    const md = renderDocumentMarkdown(document, bindings);
    const typst = renderDocumentTypst(document, bindings);
    assert.match(html.html, /<h2 class="gem-heading">Heading &lt;unsafe&gt;<\/h2>/);
    assert.ok(html.html.includes('assets/Chosen%20name.png'));
    assert.ok(html.html.includes('files/report.txt'));
    assert.ok(html.html.includes('private outline'));
    // The v2 HTML renderer reports an informational diagnostic for a future
    // unsupported node instead of silently losing the source fact.
    assert.deepEqual(html.diagnostics.map(d => d.code), ['HTML_UNKNOWN_BLOCK']);
    assert.equal(html.diagnostics.some(d => d.code === 'FORMAT_CONTENT_OMITTED'), false);
    assert.ok(md.includes('## Heading &lt;unsafe&gt;'));
    assert.ok(md.includes('assets/Chosen%20name.png'));
    assert.ok(md.includes('files/report.txt'));
    assert.ok(md.includes('<details>'));
    assert.equal(typst.messages.length, 1);
    assert.ok(typst.messages[0].blocks.length > 0);
    assert.deepEqual(document, before, 'L4 must not mutate upstream AST');
});

test('upstream bindings are required: missing resource remains visible without invoking acquisition', () => {
    const html = renderDocumentHtml(document, {});
    const md = renderDocumentMarkdown(document, {});
    const typst = renderDocumentTypst(document, {});
    assert.equal(html.diagnostics.filter(d => d.code === 'HTML_ASSET_UNRESOLVED').length, 2);
    assert.ok(html.html.includes('gem-missing-asset'));
    assert.ok(md.includes('Diagram') && md.includes('report.txt'));
    assert.ok(typst.messages[0].blocks.some(block => block.type === 'unknown'));
});

test('L4 safely degrades untrusted v2 link references', () => {
    const html = renderDocumentHtml(document, bindings).html;
    const markdown = renderDocumentMarkdown(document, bindings);
    assert.ok(html.includes('Untrusted'));
    assert.ok(markdown.includes('Untrusted'));
    assert.ok(!html.includes('href="javascript:'));
    assert.ok(!markdown.includes('](javascript:'));
    assert.ok(html.includes('href="https://example.com/path?q=1"'));
});

test('table spans are presented from L3b v2 cells without re-running composer layout', () => {
    const table = v2Document([{ type: 'table', columnAlignments: ['left', 'right'],
        headerRows: [[{ column: 0, colSpan: 2, rowSpan: 1, children: [{ type: 'text', text: 'Merged' }] }]],
        rows: [[
            { column: 0, colSpan: 1, rowSpan: 1, children: [{ type: 'text', text: 'left' }] },
            { column: 1, colSpan: 1, rowSpan: 1, children: [{ type: 'text', text: 'right' }] },
        ]] }]);
    const html = renderDocumentHtml(table, {}).html;
    const markdown = renderDocumentMarkdown(table, {});
    const typst = renderDocumentTypst(table, {});
    assert.ok(html.includes('colspan="2"'));
    assert.ok(markdown.includes('<th colspan="2">Merged</th>'));
    assert.equal(typst.messages[0].blocks[0].type, 'table');
});

test('locale is a renderer-only option, independent of the v2 document schema', () => {
    const en = renderDocumentHtml(document, bindings, { locale: 'en' }).html;
    const zh = renderDocumentHtml(document, bindings, { locale: 'zh' }).html;
    assert.notEqual(en, zh);
    assert.ok(renderDocumentMarkdown(document, bindings, { locale: 'zh' }).length > 0);
    assert.equal(renderDocumentTypst(document, bindings, { locale: 'zh' }).messages.length, 1);
});
