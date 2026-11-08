import { fixtureAccountFor } from './helpers/domainFixture.js';
import { validateParserDomain } from '../src/l2/runtimeValidation.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { DomainConversationWithDetail } from '../src/l2/conversation.js';
import { composeDomainDocument } from '../src/l3b/compose/composeDomainDocument.js';
import { renderDocumentHtml } from '../src/l4/format/html/renderHtml.js';
import { renderDocumentMarkdown } from '../src/l4/format/markdown/renderMarkdown.js';
import { renderDocumentTypst, defaultPdfLayout } from './helpers/renderTypstFixture.js';
import { renderTypstFixture } from './helpers/renderTypstFixture.js';

function fixture(): DomainConversationWithDetail {
    return JSON.parse(readFileSync('tests/fixtures/document-domain/document-neutral.json', 'utf8'));
}

function freeze(value: unknown): void { if (!value || typeof value !== 'object') return; Object.freeze(value); Object.values(value).forEach(freeze); }

test('one immutable JSON document serves all three backends without losing rich structure', () => {
    const input = fixture(), inputBefore = JSON.stringify(input); freeze(input);
    const document = composeDomainDocument(validateParserDomain(input), fixtureAccountFor(validateParserDomain(input)));
    assert.deepEqual(composeDomainDocument(validateParserDomain(input), fixtureAccountFor(validateParserDomain(input))), document);
    const restored = JSON.parse(JSON.stringify(document)) as typeof document; freeze(restored);
    const before = JSON.stringify(restored), resources = { image: 'assets/image.png', file: 'assets/report.pdf' };
    const md = renderDocumentMarkdown(restored, resources, { locale: 'en' });
    const pdf = renderDocumentTypst(restored, resources, { locale: 'en' });
    const html = renderDocumentHtml(restored, resources, { locale: 'en' }).html;
    assert.ok(md.includes('<table>') && md.includes('colspan="2"') && md.includes('H2') && md.includes('H3'));
    assert.ok(html.includes('colspan="2"') && html.includes('<strong>Rich caption</strong>') && html.includes('<em>Image caption</em>'));
    const table = pdf.messages[0].blocks[2]; assert.equal(table.type, 'table');
    if (table.type !== 'table') throw new Error('Expected table');
    assert.equal(table.headers.length, 2); assert.equal(table.headers[0][0].colspan, 2); assert.deepEqual(table.caption, [{ type: 'strong', children: [{ type: 'text', text: 'Rich caption' }] }]);
    const file = restored.messages[0].blocks[4]; assert.equal(file.type, 'file');
    if (file.type !== 'file') throw new Error('Expected file');
    assert.equal(file.mediaType, 'application/pdf'); assert.equal(file.byteLength, 1234567);
    assert.equal(pdf.messages[0].blocks[4].type === 'file' && pdf.messages[0].blocks[4].metadata, 'PDF · 1.18 MB');
    assert.equal(JSON.stringify(restored), before); assert.equal(JSON.stringify(input), inputBefore);
    assert.deepEqual(renderDocumentTypst(document, resources), renderDocumentTypst(restored, resources));
});

test('Locale changes renderer chrome; HTML and PDF keep fixed internal presentation defaults', () => {
    const document = composeDomainDocument(validateParserDomain(fixture()), fixtureAccountFor(validateParserDomain(fixture())));
    const resources = { image: 'assets/image.png', file: 'assets/report.pdf' };
    const before = JSON.stringify(document);
    const en = renderDocumentHtml(document, resources, { locale: 'en' }).html;
    const zh = renderDocumentHtml(document, resources, { locale: 'zh' }).html;
    assert.ok(en.includes('<html>') && en.includes('Thinking Process'));
    assert.ok(en.includes('copyCode(this)'), 'code copying is a fixed HTML feature');
    assert.ok(en.includes('prefers-color-scheme: light'), 'theme follows system CSS instead of public settings');
    assert.ok(zh.includes('Thinking Process') && zh.includes('复制'));
    const pdf = renderDocumentTypst(document, resources, { locale: 'zh' });
    assert.deepEqual(pdf.layout, defaultPdfLayout(), 'public Renderer cannot change PDF layout');
    const table = pdf.messages[0].blocks.find(b => b.type === 'table');
    assert.ok(table && table.type === 'table' && table.repeatHeader === true);
    assert.ok(renderDocumentMarkdown(document, resources, { locale: 'zh' }).includes('**来源:**'));
    assert.equal(JSON.stringify(document), before);
});

test('AST: neutral tree has no output controls and renderers do not import source models', () => {
    const document = composeDomainDocument(validateParserDomain(fixture()), fixtureAccountFor(validateParserDomain(fixture())));
    const forbidden = new Set(['pdfLayout', 'layout', 'gapBeforePt', 'gapAfterPt', 'measurementText', 'minWidthCards', 'profile', 'theme', 'frontMatter', 'copy', 'repeatHeader', 'locale', 'badge', 'openLabel', 'showHeader', 'initiallyCollapsed', 'emptyNotice']);
    function check(value: unknown): void { if (!value || typeof value !== 'object') return; for (const [key, child] of Object.entries(value)) { assert.ok(!forbidden.has(key), key); check(child); } }
    check(document);
    // Inspect import/export declarations, not unrelated implementation tokens.
    // TypeScript 7 no longer exposes preProcessFile; keep this guard test-only.
    const importSources = (file: string): string[] =>
        [...readFileSync(file, 'utf8').matchAll(/^\s*(?:import|export)\s+(?:(?:type\s+)?[^;]*?\bfrom\s+)?(['"])([^'"]+)\1/gm)]
            .map(match => match[2]);
    for (const name of ['html/renderHtml', 'markdown/renderMarkdown', 'typst/renderTypstCore', 'shared/backendPresentation', 'shared/renderOptions', 'shared/renderStrings']) {
        for (const source of importSources(`src/l4/format/${name}.ts`)) {
            assert.doesNotMatch(source, /(^|\/)(?:canonical|domain|provider|content)\//,
                `Renderer ${name} cannot import source-model module ${source}`);
        }
    }
    const composerImports = importSources('src/l3b/compose/composeDomainDocument.ts');
    assert.ok(composerImports.every(source => !source.includes('/renderers/')),
        'Document composition must not import an output backend');
});


test('prepared resource absence is reported by each backend without deleting the display reference', () => {
    const input = fixture(); input.detail.messages[0].reasoning = undefined; input.detail.messages[0].content = [{ type: 'paragraph', children: [{ type: 'image', assetId: 'image' }] }];
    const document = composeDomainDocument(validateParserDomain(input), fixtureAccountFor(validateParserDomain(input))), before = JSON.stringify(document);
    const { payload: pdf, diagnostics } = renderTypstFixture(document);
    assert.ok(diagnostics.some(d => d.code === 'TYPST_V8_INLINE_IMAGE_MISSING'));
    const paragraph = pdf.messages[0].blocks[0]; if (paragraph.type !== 'paragraph') throw new Error('Expected paragraph');
    assert.deepEqual(paragraph.children[0], { type: 'text', text: 'Image unavailable: image.png' });
    const html = renderDocumentHtml(document, {}, { locale: 'en' });
    assert.ok(html.html.includes('Image unavailable: image.png') && html.diagnostics.some(d => d.code === 'HTML_ASSET_UNRESOLVED'));
    assert.ok(renderDocumentMarkdown(document, {}).includes('[Image unavailable: image.png]'));
    assert.equal(JSON.stringify(document), before);
});
