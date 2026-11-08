import test from 'node:test';
import assert from 'node:assert/strict';
import { fixtureAccountFor, fixtureKey } from './helpers/domainFixture.js';
import { resourceValue } from './helpers/resources.js';
import { buildMinimalValidPdf } from './helpers/stubPdfCompiler.js';
import { RealWasmSandboxHost, repoRoot } from './helpers/realWasmSandbox.js';
import { extractPdfText } from './helpers/pdfTextExtract.js';
import type { DomainConversationWithDetail } from '../src/l2/conversation.js';
import type { BlockNode } from '../src/l2/content/blocks.js';
import { validateParserDomain } from '../src/l2/runtimeValidation.js';
import { composeDomainDocument } from '../src/l3b/compose/composeDomainDocument.js';
import { collectDocumentResources } from '../src/l3b/ast/resourceReferences.js';
import { prepareExportResources } from '../src/application/export/prepareExportResources.js';
import { createExportPathPlanner, buildExportFiles } from '../src/l4/packaging/index.js';
import { renderDocumentTypst } from './helpers/renderTypstFixture.js';
import { compileDocumentPdf } from '../src/l4/format/pdf/compileDocumentPdf.js';
import type { IPdfCompiler } from '../src/l4/format/pdf/pdfCompiler.js';
import { TypstSandboxCompiler } from '../src/l4/format/pdf/typst/typstSandboxCompiler.js';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const secondPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/nB0AAAAASUVORK5CYII=';
const imageBytes = new Uint8Array(Buffer.from(png, 'base64'));
const otherBytes = new Uint8Array(Buffer.from(secondPng, 'base64'));
const paragraph = (body: string): BlockNode => ({ type: 'paragraph', children: [{ type: 'text', text: body }] });
const context = () => ({ signal: new AbortController().signal, reportProgress() {} });

/** V2 starts at the trusted L2 schema, not the removed PDF-specific parser/item pipeline. */
function fixture(): DomainConversationWithDetail {
    const key = fixtureKey('direct-pdf');
    return {
        index: { key, title: 'Direct PDF boundary', titleSource: 'provider',
            createdAt: 1700000000000, updatedAt: 1700000000000 },
        detail: {
            key, savedAt: 1700000000000, quality: { status: 'complete' },
            assets: [
                { id: 'sample', kind: 'image', name: 'Sample', mediaType: 'image/png',
                    sourceUri: 'https://example.test/sample.png' },
                { id: 'report', kind: 'file', name: 'report.pdf', mediaType: 'application/pdf', byteLength: 1234567 },
            ],
            messages: [
                { role: 'user', content: [paragraph('Explain the pipeline.')] },
                { role: 'assistant', reasoning: [paragraph('Check every relation.')], content: [
                    { type: 'heading', level: 1, children: [{ type: 'text', text: 'Results' }] },
                    { type: 'paragraph', children: [
                        { type: 'strong', children: [{ type: 'text', text: 'Strong' }] },
                        { type: 'text', text: ' text and ' },
                        { type: 'link', href: 'https://example.test', children: [{ type: 'text', text: 'source' }] },
                    ] },
                    { type: 'quote', blocks: [paragraph('A quoted result.')] },
                    { type: 'list', ordered: true, start: 1,
                        items: [{ blocks: [paragraph('First')] }, { blocks: [paragraph('Second')] }] },
                    { type: 'code', language: 'ts', meta: 'filename=pipeline.ts', code: 'const layers = 2;' },
                    { type: 'math', source: '\\frac{a}{b}' },
                    { type: 'table', columns: [{}, { align: 'right' }],
                        headerRows: [{ cells: [{ children: [{ type: 'text', text: 'Item' }] },
                            { children: [{ type: 'text', text: 'Value' }] }] }],
                        rows: [{ cells: [{ children: [{ type: 'text', text: 'Result' }] },
                            { children: [{ type: 'text', text: '42' }] }] }] },
                    { type: 'image', assetId: 'sample', alt: 'Sample' },
                    ...Array.from({ length: 100 }, (_, i) =>
                        paragraph('Paragraph ' + i + ': This detailed explanation exercises physical page breaks and flowing text.')),
                ], attachmentIds: ['report'] },
            ],
        },
    };
}

test('trusted Domain and Document AST JSON round-trips preserve reasoning, content and resource identity', () => {
    const raw = fixture();
    const original = structuredClone(raw);
    const domain = validateParserDomain(raw);
    const restored = validateParserDomain(JSON.parse(JSON.stringify(domain)));
    const document = composeDomainDocument(domain, fixtureAccountFor(domain));
    assert.deepEqual(composeDomainDocument(restored, fixtureAccountFor(restored)), document);
    assert.deepEqual(JSON.parse(JSON.stringify(document)), document);

    assert.equal(document.metadata.id, domain.index.key.conversationId);
    assert.equal(document.metadata.provider, fixtureAccountFor(domain).providerId);
    assert.equal(document.metadata.updatedAt, 1700000000000);
    assert.equal(document.messages[1].blocks[0].type, 'disclosure', 'reasoning appears before content');
    assert.equal(document.messages[1].blocks[1].type, 'heading');
    const attachment = document.messages[1].blocks.at(-1);
    assert.ok(attachment && attachment.type === 'file');
    assert.equal(attachment.resourceId, 'report');
    assert.equal(attachment.byteLength, 1234567);
    const refs = collectDocumentResources(document);
    assert.deepEqual([...refs.imageIds], ['sample']);
    assert.deepEqual([...refs.fileIds], ['report']);
    assert.deepEqual([...refs.referencedIds], ['sample', 'report']);

    assert.ok(!('resources' in document) && !('byteStore' in document));
    assert.ok(!JSON.stringify(document).includes('dataBase64'));
    assert.deepEqual(raw, original);
});

test('unknown message roles and intrinsic file sizes survive v2 Domain JSON without formatter metadata', () => {
    const key = fixtureKey('file-facts');
    const domain = validateParserDomain({
        index: { key },
        detail: { key, quality: { status: 'complete' },
            assets: [{ id: 'note', kind: 'file', name: 'note.txt', byteLength: 3 }],
            messages: [{ role: 'unknown', content: [], attachmentIds: ['note'] }] },
    });
    assert.equal(domain.detail.assets[0].byteLength, 3);
    assert.equal(domain.detail.messages[0].role, 'unknown');
    assert.equal(Object.hasOwn(domain.detail.messages[0], 'provenance'), false);
    const restored = validateParserDomain(JSON.parse(JSON.stringify(domain)));
    const document = composeDomainDocument(restored, fixtureAccountFor(restored));
    assert.deepEqual(document, composeDomainDocument(domain, fixtureAccountFor(domain)));
    const file = document.messages[0].blocks[0];
    assert.equal(file.type, 'file');
    if (file.type === 'file') {
        assert.equal(file.resourceId, 'note');
        assert.equal(file.byteLength, 3);
        assert.equal(file.label, 'note.txt');
    }
});

test('PDF acquisition and Packaging cannot conflate two image sources sharing an export name', async () => {
    const key = fixtureKey('collision');
    const domain = validateParserDomain({
        index: { key, title: 'Images', titleSource: 'provider' },
        detail: { key, quality: { status: 'complete' },
            assets: [
                { id: 'one', kind: 'image', name: 'same.png', mediaType: 'image/png', sourceUri: 'https://example.test/one' },
                { id: 'two', kind: 'image', name: 'same.png', mediaType: 'image/png', sourceUri: 'https://example.test/two' },
            ],
            messages: [{ role: 'assistant', content: [
                { type: 'image', assetId: 'one' }, { type: 'image', assetId: 'two' },
            ] }] },
    });
    const before = JSON.stringify(domain);
    const document = composeDomainDocument(domain, fixtureAccountFor(domain));
    const refs = collectDocumentResources(document);
    const urls: string[] = [];
    const prepared = await prepareExportResources(domain.detail.assets, refs.referencedIds, async asset => {
        urls.push(asset.sourceUri!);
        return { bytes: asset.id === 'one' ? imageBytes : otherBytes, mediaType: 'image/png' };
    });
    assert.deepEqual(urls, ['https://example.test/one', 'https://example.test/two']);
    assert.deepEqual(resourceValue(prepared.get('one')).bytes, imageBytes);
    assert.deepEqual(resourceValue(prepared.get('two')).bytes, otherBytes);

    const plan = createExportPathPlanner('pdf')(domain, prepared, refs.fileIds);
    assert.ok(plan.resources.one && plan.resources.two);
    assert.notEqual(plan.resources.one, plan.resources.two, 'Packaging must reserve separate paths for the same file name');
    assert.deepEqual([...plan.externalResourceIds], [], 'image-only PDF resources are embedded, not exported again');

    let compiled = 0;
    const compiler: IPdfCompiler = { name: 'capture-pdf-bindings', async compile(payload, ctx) {
        compiled++;
        assert.deepEqual([...payload.assetPaths], [['one', plan.resources.one], ['two', plan.resources.two]]);
        assert.deepEqual(await ctx.assets.resolve('one'), { bytes: imageBytes });
        assert.deepEqual(await ctx.assets.resolve('two'), { bytes: otherBytes });
        const blocks = payload.document.messages[0].blocks;
        assert.deepEqual(blocks.filter(block => block.type === 'image').map(block =>
            block.type === 'image' ? block.asset : ''), [plan.resources.one, plan.resources.two]);
        return { pdfBytes: buildMinimalValidPdf(), diagnostics: [] };
    } };
    const result = await compileDocumentPdf(document, plan.resources, prepared, compiler, context());
    assert.equal(compiled, 1);
    assert.equal(result.diagnostics.some(d => d.code === 'FORMAT_CONTENT_OMITTED'), false);
    assert.equal(buildExportFiles('pdf', plan, result.pdfBytes, prepared).length, 1);
    assert.equal(JSON.stringify(domain), before);
});

test('v2 PDF transport and real WASM compilation retain authored text across physical pages', async () => {
    const domain = validateParserDomain(fixture());
    const document = composeDomainDocument(domain, fixtureAccountFor(domain));
    const transport = renderDocumentTypst(document, {}, { locale: 'en' });
    assert.equal(transport.schemaVersion, 1);
    assert.equal(transport.profile.id, 'pdf');
    assert.equal(transport.title, 'Direct PDF boundary');
    assert.equal(transport.messages.length, 2);
    assert.match(JSON.stringify(transport.messages[1]), /const layers = 2/);
    assert.match(JSON.stringify(transport.messages[1]), /report\.pdf/);

    const compiler = new TypstSandboxCompiler({ host: new RealWasmSandboxHost(repoRoot()) });
    try {
        // includeAssets=false: the shared Export prepares an empty map; Image nodes remain readable.
        const compiled = await compileDocumentPdf(document, {}, new Map(), compiler, context(), { locale: 'en' });
        const physical = extractPdfText(compiled.pdfBytes);
        assert.ok(physical.pageCount >= 3, 'long source text must paginate in the compiled PDF');
        assert.match(physical.text, /Explain the pipeline/, 'actual PDF must contain the user question');
        assert.match(physical.text, /Paragraph 99:/, 'actual PDF must contain the end of the model answer');
        assert.match(physical.text, /Results/, 'actual PDF must preserve the authored heading');
        assert.ok(!compiled.diagnostics.some(d => d.code === 'FORMAT_CONTENT_OMITTED'),
            'intentional includeAssets=false placeholders are not unexpected content loss');
    } finally {
        compiler.dispose();
    }
});
