import { fixtureAccountFor } from './helpers/domainFixture.js';
import { validateParserDomain } from '../src/l2/runtimeValidation.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { DomainConversationWithDetail } from '../src/l2/conversation.js';
import type { DocumentAst } from '../src/l3b/ast/ast.js';
import { composeDomainDocument } from '../src/l3b/compose/composeDomainDocument.js';
import { renderDocumentTypst, defaultPdfLayout } from './helpers/renderTypstFixture.js';
import { TypstSandboxCompiler } from '../src/l4/format/pdf/typst/typstSandboxCompiler.js';
import { RealWasmSandboxHost, repoRoot } from './helpers/realWasmSandbox.js';
import { extractPdfText } from './helpers/pdfTextExtract.js';
import { renderTypstFixture } from './helpers/renderTypstFixture.js';

function fixture(): DomainConversationWithDetail {
    return JSON.parse(readFileSync('tests/fixtures/document-domain/document-pdf.json', 'utf8'));
}

function freeze(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    Object.freeze(value); Object.values(value).forEach(freeze);
}
const resources = { image: 'assets/image.png' };

test('PDF backend derives policies and metadata from immutable JSON display data', () => {
    const input = fixture(); const before = JSON.stringify(input); freeze(input);
    const document = composeDomainDocument(validateParserDomain(input), fixtureAccountFor(validateParserDomain(input)));
    const restored: DocumentAst = JSON.parse(JSON.stringify(document)); freeze(document);
    const payload = renderDocumentTypst(document, resources);
    assert.deepEqual(renderDocumentTypst(restored, resources), payload); assert.equal(JSON.stringify(input), before);
    assert.deepEqual(payload.messages[0].minWidthCards, [{ label: 'Reference.pdf', metadata: 'PDF · 4.00 KB' }]);
    const gaps = payload.messages.map(message => message.gapAfterPt);
    assert.equal(gaps.at(-1), 0, 'the last turn has no trailing gap');
    assert.ok(gaps.slice(0, -1).every(gap => gap > 0), 'adjacent turns remain separated');
    assert.ok(gaps[2] > gaps[1], 'flow-to-bubble transitions have stronger separation than flow-to-flow');
    assert.equal(payload.messages[1].blocks[0].layout.keepWithNext, true);
    const table = document.messages[1].blocks[4]; if (table.type !== 'table') throw new Error('Expected table');
    assert.deepEqual(table.caption, [{ type: 'strong', children: [{ type: 'text', text: 'Table caption' }] }]);
    const changed = renderDocumentTypst(restored, resources, { locale: 'zh' });
    assert.equal(changed.messages[1].blocks[4].type === 'table' && changed.messages[1].blocks[4].repeatHeader, true);
    assert.deepEqual(changed.messages[1].blocks[5].type === 'image' && changed.messages[1].blocks[5].caption, [{ type: 'strong', children: [{ type: 'text', text: '123' }] }]);
});

test('real PDF compiler honors its internal layout payload without changing the public renderer', async () => {
    const input = fixture(); input.detail.messages = [{ id: 'a', role: 'assistant', content: Array.from({ length: 25 }, (_, index) => ({ type: 'paragraph', children: [{ type: 'text', text: `Passage ${index}. ` + 'Page layout remains an engine responsibility. '.repeat(8) }] })) }];
    const document = composeDomainDocument(validateParserDomain(input), fixtureAccountFor(validateParserDomain(input))); const originalJson = JSON.stringify(document);
    const layout = defaultPdfLayout(); layout.page.heightMm = 150;
    const compiler = new TypstSandboxCompiler({ host: new RealWasmSandboxHost(repoRoot()) });
    const context = { assets: { resolve: async () => null }, signal: new AbortController().signal, reportProgress: () => undefined };
    try {
        const original = extractPdfText((await compiler.compile({ rendererSchemaVersion: 1, document: renderDocumentTypst(document, {}), assetPaths: new Map() }, context)).pdfBytes);
        const technicalPayload = renderDocumentTypst(document, {});
        technicalPayload.layout = layout;
        const changed = extractPdfText((await compiler.compile({ rendererSchemaVersion: 1, document: technicalPayload, assetPaths: new Map() }, context)).pdfBytes);
        assert.ok(changed.pageCount > original.pageCount); assert.ok(changed.text.includes('Passage 24.')); assert.ok(original.text.includes('Passage 24.'));
        assert.equal(JSON.stringify(document), originalJson);
    } finally { compiler.dispose(); }
});

test('PDF renderer follows edited Document AST presentation, not the original Domain roles', () => {
    const document = composeDomainDocument(validateParserDomain(fixture()), fixtureAccountFor(validateParserDomain(fixture())));
    const altered: DocumentAst = structuredClone(document);
    altered.title = 'Chosen export title';
    altered.messages[0].role = 'assistant';
    altered.messages[1].modelLabel = 'Selected model';

    const original = renderDocumentTypst(document, resources);
    const changed = renderDocumentTypst(altered, resources);
    assert.equal(original.messages[0].variant, 'bubble');
    assert.equal(changed.messages[0].variant, 'flow');
    assert.equal(original.messages[0].blocks[1].layout.width, 'container');
    assert.equal(changed.messages[0].blocks[1].layout.width, 'reading',
        'text width must derive from the AST message role');
    assert.equal(changed.title, 'Chosen export title');
    assert.equal(changed.messages[1].model, 'Selected model');
    assert.equal(original.messages[1].model, undefined);
});

test('PDF missing placements preserve authored numeric captions and descriptions', () => {
    const input = fixture(); input.detail.messages[1].content = [
        { type: 'image', assetId: 'image', caption: [{ type: 'strong', children: [{ type: 'text', text: '123' }] }] },
        { type: 'file', assetId: 'missing', label: 'Missing.pdf', description: [{ type: 'strong', children: [{ type: 'text', text: 'Authored description' }] }] },
    ];
    input.detail.assets.push({ id: 'missing', kind: 'file' });
    const document = composeDomainDocument(validateParserDomain(input), fixtureAccountFor(validateParserDomain(input)));
    const { payload, diagnostics } = renderTypstFixture(document);
    assert.ok(diagnostics.some(d => d.code === 'TYPST_V8_IMAGE_MISSING'), 'technical lowering must generate a reportable missing-image warning');
    const image = payload.messages[1].blocks[0], file = payload.messages[1].blocks[1];
    assert.deepEqual(image.type === 'unknown' && image.details, [{ type: 'strong', children: [{ type: 'text', text: '123' }] }]);
    assert.ok(file.type === 'file');
    assert.equal(file.name, 'Missing.pdf');
    assert.deepEqual(file.description, [{ type: 'strong', children: [{ type: 'text', text: 'Authored description' }] }]);
    assert.doesNotMatch(JSON.stringify(document), /"type":"placeholder"/);

});
