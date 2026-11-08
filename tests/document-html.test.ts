import { fixtureAccountFor } from './helpers/domainFixture.js';
import { validateParserDomain } from '../src/l2/runtimeValidation.js';
import { historicalFixture } from './helpers/nativeFixture.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { DomainConversationWithDetail } from '../src/l2/conversation.js';
import type { DocumentAst } from '../src/l3b/ast/ast.js';
import { composeDomainDocument } from '../src/l3b/compose/composeDomainDocument.js';
import { renderDocumentHtml } from '../src/l4/format/html/renderHtml.js';

function fixture(): DomainConversationWithDetail {
    return JSON.parse(readFileSync('tests/fixtures/document-domain/document-html.json', 'utf8'));
}

function freeze(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    Object.freeze(value);
    Object.values(value).forEach(freeze);
}

test('HTML consumes the neutral composition and preserves immutable semantic input', () => {
    const input = fixture();
    const before = JSON.stringify(input);
    freeze(input);
    const resources = Object.freeze({ img: 'assets/img.png' });
    const first = composeDomainDocument(validateParserDomain(input), fixtureAccountFor(validateParserDomain(input)));
    assert.deepEqual(composeDomainDocument(validateParserDomain(input), fixtureAccountFor(validateParserDomain(input))), first);
    assert.equal(JSON.stringify(input), before);
    const document = first;
    assert.equal(document.metadata.provider, 'example');
    assert.equal(document.messages[0].role, 'user');
    assert.ok(renderDocumentHtml(document, resources, { locale: 'en' }).html.includes('Show more'));
    const disclosure = document.messages[1].blocks[0];
    assert.equal(disclosure.type, 'disclosure');
    if (disclosure.type === 'disclosure') {
        assert.equal(disclosure.kind, 'reasoning');
        assert.ok(!('initiallyCollapsed' in disclosure));
    }
    assert.deepEqual(document.messages[1].sources, [{ id: 'c1', label: 'Source', href: 'https://example.com', number: 1 }]);
    assert.equal(document.messages[1].blocks.filter(b => b.type === 'image').length, 2, 'registry identity never deduplicates placements');
    assert.ok(renderDocumentHtml(document, resources).html.includes('<strong>123</strong>'), 'explicit caption is not tested as a filename');
});

test('JSON roundtrip and explicit presentation edits work without semantic input', () => {
    const resources = { img: 'assets/img.png' };
    const document = composeDomainDocument(validateParserDomain(fixture()), fixtureAccountFor(validateParserDomain(fixture())));
    const restored: DocumentAst = JSON.parse(JSON.stringify(document));
    assert.deepEqual(restored, document);
    assert.deepEqual(renderDocumentHtml(restored, resources), renderDocumentHtml(document, resources));
    restored.metadata.provider = 'Custom metadata';
    restored.messages[0].role = 'assistant';
    restored.messages[1].sources = [{ id: 'chosen', label: 'Chosen source', number: 1 }];
    const disclosure = restored.messages[1].blocks[0];
    assert.equal(disclosure.type, 'disclosure');
    if (disclosure.type === 'disclosure') disclosure.title = 'Chosen title';
    const html = renderDocumentHtml(restored, resources).html;
    assert.ok(html.includes('Custom metadata'));
    assert.ok(!html.includes('<div class="gem-user-bubble">'), 'renderer uses the AST role to select the presentation');
    assert.ok(html.includes('Chosen source') && html.includes('Chosen title'));
    assert.ok(!html.includes('gem-citation-chip" href="https://example.com'), 'renderer must not rebuild a source footer from registry');
});

test('table alignment follows logical columns for colSpan and rowSpan', () => {
    const input = fixture();
    input.detail.messages[0].content = [{ type: 'table', columns: [{ align: 'left' }, { align: 'right' }, { align: 'center' }], rows: [
        { cells: [{ children: [{ type: 'text', text: 'span' }], colSpan: 2, rowSpan: 2 }, { children: [{ type: 'text', text: 'last' }] }] },
        { cells: [{ children: [{ type: 'text', text: 'under' }] }] },
    ] }];
    const document = composeDomainDocument(validateParserDomain(input), fixtureAccountFor(validateParserDomain(input)));
    const table = document.messages[0].blocks[0];
    assert.equal(table.type, 'table');
    if (table.type === 'table') {
        assert.equal(table.rows[0][1].column, 2);
        assert.equal(table.columnAlignments[table.rows[0][1].column], 'center');
        assert.equal(table.rows[1][0].column, 2);
        assert.equal(table.columnAlignments[table.rows[1][0].column], 'center');
    }
    assert.ok(renderDocumentHtml(document, { img: 'assets/img.png' }).html.includes('style="text-align:center">under'));
});

test('backend decides unavailable resources, preserves caption, and keeps nested diagnostics', () => {
    const document = composeDomainDocument(validateParserDomain(fixture()), fixtureAccountFor(validateParserDomain(fixture())));
    assert.ok(renderDocumentHtml(document, {}).diagnostics.some(d => d.code === 'HTML_ASSET_UNRESOLVED'));
    const html = renderDocumentHtml(document, {}).html;
    assert.ok(html.includes('gem-missing-inline'));
    assert.ok(html.includes('<strong>123</strong>'));
    assert.ok(!html.includes('<img'));
    assert.ok(renderDocumentHtml(document, {}).diagnostics.some(d => d.code === 'HTML_UNKNOWN_BLOCK'));
});

test('renderer requires prepared bindings and escapes text and URL attributes', () => {
    const document = composeDomainDocument(validateParserDomain(fixture()), fixtureAccountFor(validateParserDomain(fixture())));
    assert.ok(renderDocumentHtml(document, {}).html.includes('gem-missing-asset'));
    const invalidBinding = renderDocumentHtml(document, { img: 'assets/a" onload="evil.png' });
    assert.ok(invalidBinding.diagnostics.some(d => d.code === 'HTML_ASSET_UNRESOLVED'));
    assert.ok(!invalidBinding.html.includes('onload="evil.png'), 'invalid physical path cannot reach an attribute');
    assert.ok(invalidBinding.html.includes('&lt;x&gt;'));
    document.messages[0].blocks = [{ type: 'paragraph', children: [{ type: 'link', href: 'https://example.com?a=1&b=2', children: [{ type: 'text', text: 'Query' }] }] }];
    const queryHtml = renderDocumentHtml(document, { img: 'assets/img.png' }).html;
    assert.ok(queryHtml.includes('href="https://example.com/?a=1&amp;b=2"'));
    assert.ok(!queryHtml.includes('&amp;amp;'));
});

test('known empty state uses shared localized text without claiming acquisition failure', () => {
    const input = fixture(); input.detail.messages = [];
    const document = composeDomainDocument(validateParserDomain(input), fixtureAccountFor(validateParserDomain(input)));
    assert.ok(!('emptyNotice' in document));
    assert.ok(renderDocumentHtml(document, {}, { locale: 'en' }).html.includes('Empty conversation.'));
    assert.ok(renderDocumentHtml(document, {}, { locale: 'zh' }).html.includes('暂无对话记录。'));
});



test('HTML backend uses supplied Packaging paths consistently', async () => {
    const native = historicalFixture({ id: 'production', title: 'Production', messages: [{ role: 'model', content: 'Body', attachments: [{ type: 'image', localName: 'assets/p.png', name: 'p.png' }] }] });
    const document = composeDomainDocument(native.conversation, native.account);
    const result = renderDocumentHtml(document, Object.fromEntries(native.conversation.detail.assets.map(asset => [asset.id, 'assets/p.png'])));
    assert.ok(result.html.includes('assets/p.png'));
    assert.ok(!result.html.includes('gem-missing-asset">'));
});

test('backend accepts safe custom bindings and reports unsafe bindings as unavailable', () => {
    const document = composeDomainDocument(validateParserDomain(fixture()), fixtureAccountFor(validateParserDomain(fixture())));
    const custom = renderDocumentHtml(document, { img: 'assets/custom.png' });
    assert.deepEqual(custom.diagnostics.filter(d => d.code === 'HTML_ASSET_UNRESOLVED'), []);
    assert.ok(custom.html.includes('src="assets/custom.png"'));
    const unsafe = renderDocumentHtml(document, { img: 'javascript:alert(1)' });
    assert.ok(unsafe.diagnostics.some(d => d.code === 'HTML_ASSET_UNRESOLVED'));
    assert.ok(!unsafe.html.includes('javascript:'));
    assert.ok(unsafe.html.includes('gem-missing-inline'));
});

test('HTML exposes collapsed user prompt content without JavaScript', () => {
    const input = fixture();
    const document = composeDomainDocument(validateParserDomain(input), fixtureAccountFor(validateParserDomain(input)));
    const html = renderDocumentHtml(document, {}, { locale: 'en' }).html;
    assert.ok(html.includes('gem-prompt-content collapsed'), 'long prompt has the regular interactive fold');
    assert.match(html, /<noscript><style>\.gem-prompt-content\.collapsed\s*\{\s*max-height:\s*none;\s*overflow:\s*visible;/);
    assert.match(html, /\.gem-prompt-toggle\s*\{\s*display:\s*none;\s*\}<\/style><\/noscript>/);
});
