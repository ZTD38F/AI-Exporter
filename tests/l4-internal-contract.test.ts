import { test } from 'node:test';
import assert from 'node:assert/strict';
import { v2Conversation } from './helpers/l4V2Fixtures.js';
import { createExportPathPlanner, planExportPaths, buildExportFiles, packageExportFiles } from '../src/l4/packaging/index.js';
import { renderDocumentMarkdown } from '../src/l4/format/markdown/renderMarkdown.js';
import { renderDocumentHtml } from '../src/l4/format/html/renderHtml.js';
import { renderDocumentTypst } from './helpers/renderTypstFixture.js';
import { compileDocumentPdf } from '../src/l4/format/pdf/compileDocumentPdf.js';
import { PdfResourceError } from '../src/l4/format/pdf/errors.js';
import { missingResource, type PreparedResources } from '../src/shared/resources/resourceResult.js';
import type { DocumentAst } from '../src/l3b/ast/ast.js';
import type { IPdfCompiler } from '../src/l4/format/pdf/pdfCompiler.js';
import { __setZipConstructor } from '../src/l4/packaging/writers/zipWriter.js';

function domain() {
    // Mock the L2 v2 boundary using data only, not L2's production validator.
    return v2Conversation('Contract', [
        { id: 'image', kind: 'image', name: 'photo.png' },
        { id: 'file', kind: 'file', name: 'notes.txt' },
        { id: 'dual', kind: 'image', name: 'both.png' },
    ]);
}
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1]);
const fileBytes = new Uint8Array([65, 66, 67]);
const prepared: PreparedResources = new Map([
    ['image', { ok: true, resourceId: 'image', value: { bytes: png, mediaType: 'image/png' } }],
    ['file', { ok: true, resourceId: 'file', value: { bytes: fileBytes, mediaType: 'text/plain' } }],
    ['dual', { ok: true, resourceId: 'dual', value: { bytes: png, mediaType: 'image/png' } }],
]);

test('L4 Packaging uses AST File purposes, not source asset kind, to deliver PDF originals', async () => {
    const c = domain();
    const fileIds = new Set(['file', 'dual']);
    const plan = createExportPathPlanner('pdf')(c, prepared, fileIds);
    assert.deepEqual([...plan.externalResourceIds], ['file', 'dual']);
    assert.equal(Object.keys(plan.resources).length, 3);
    const pdfBytes = new TextEncoder().encode('%PDF-1.7\n' + ' '.repeat(80));
    const files = buildExportFiles('pdf', plan, pdfBytes, prepared);
    assert.deepEqual(files.map(f => f.fileName), [plan.fileName, plan.resources.file, plan.resources.dual]);
    assert.equal(files[1].content, fileBytes);
    assert.equal(files[2].content, png);
    const planned = planExportPaths([{ conversation: c, prepared, fileIds }], 'pdf');
    assert.deepEqual(planned[0], plan);
    const JSZip = require('../lib/jszip.min.js');
    __setZipConstructor(JSZip);
    const output = await packageExportFiles([files], 'browserDownload');
    assert.equal(output.length, 1);
    assert.equal(output[0].mimeType, 'application/zip');
    const zip = await JSZip.loadAsync(await (output[0].content as Blob).arrayBuffer());
    for (const f of files) assert.ok(zip.file(f.fileName), f.fileName);
    assert.equal(zip.file(plan.resources.image), null);
});

test('L4 Packaging externalizes every bound resource for Markdown, HTML and JSON', () => {
    for (const format of ['markdown', 'html', 'json'] as const) {
        const plan = planExportPaths([{ conversation: domain(), prepared, fileIds: new Set<string>() }], format)[0];
        assert.deepEqual([...plan.externalResourceIds], ['image', 'file', 'dual']);
        assert.equal(buildExportFiles(format, plan, 'body', prepared).length, 4);
    }
    const pdf = createExportPathPlanner('pdf')(domain(), prepared, new Set<string>());
    assert.equal(pdf.externalResourceIds.size, 0);
    assert.equal(buildExportFiles('pdf', pdf, new Uint8Array([1]), prepared).length, 1);
});

const document: DocumentAst = {
    title: 'Contract',
    metadata: { id: 'test', provider: 'gemini' },
    messages: [{
        role: 'assistant',
        blocks: [
            { type: 'paragraph', children: [
                { type: 'link', href: 'javascript:alert(1)', children: [{ type: 'text', text: 'Unsafe label' }] },
                { type: 'link', href: 'https://example.com/path?q=1', children: [{ type: 'text', text: 'Safe label' }] },
            ] },
            { type: 'disclosure', kind: 'reasoning', title: 'Reasoning', blocks: [
                { type: 'paragraph', children: [{ type: 'text', text: 'Visible thoughts' }] },
            ] },
        ],
    }],
};

test('L4 reading formats have fixed en/front matter/collapse behavior and safe links', () => {
    const markdown = renderDocumentMarkdown(document, {});
    assert.ok(markdown.startsWith('---\ntitle: "Contract"\nid: "test"'));
    assert.ok(markdown.includes('<details>\n<summary>Reasoning</summary>'));
    assert.ok(!markdown.includes('](javascript:'));
    assert.ok(markdown.includes('[Safe label](https://example.com/path?q=1)'));
    const { html } = renderDocumentHtml(document, {});
    assert.ok(html.includes('1 messages'));
    assert.ok(html.includes('<details class="gem-thoughts">'));
    assert.ok(!html.includes('class="gem-thoughts" open'));
    assert.ok(!html.includes('href="javascript:'));
    assert.ok(html.includes('href="https://example.com/path?q=1"'));
    assert.ok(html.includes('Unsafe label'));
    const payload = renderDocumentTypst(document, {});
    const para = payload.messages[0].blocks[0];
    assert.equal(para.type, 'paragraph');
    if (para.type !== 'paragraph') return;
    assert.equal(para.children[0].type, 'text');
    assert.equal(para.children[1].type, 'link');
    assert.equal(payload.layout.page.widthMm > 0, true);
});

const pdfBytes = new TextEncoder().encode('%PDF-1.7\n' + ' '.repeat(80));
const pdfDocument: DocumentAst = {
    title: 'PDF',
    metadata: { id: 'one', provider: 'gemini' },
    messages: [{ role: 'assistant', blocks: [
        { type: 'image', resourceId: 'image', alt: 'Photo' },
        { type: 'file', resourceId: 'file', label: 'Notes', kind: 'file' },
    ] }],
};
function compileContext() {
    return { signal: new AbortController().signal, reportProgress() {} };
}

test('L4 PDF mounts AST Image bytes only, not successful File-only resources', async () => {
    const compiler: IPdfCompiler = { name: 'test', async compile(payload, context) {
        assert.deepEqual([...payload.assetPaths], [['image', 'assets/photo.png']]);
        assert.equal(await context.assets.resolve('file'), null);
        assert.deepEqual(await context.assets.resolve('image'), { bytes: png });
        return { pdfBytes, diagnostics: [] };
    } };
    const result = await compileDocumentPdf(pdfDocument,
        { image: 'assets/photo.png', file: 'files/notes.txt' }, prepared, compiler, compileContext());
    assert.equal(result.pdfBytes, pdfBytes);
    assert.ok(!result.diagnostics.some(d => d.code === 'FORMAT_CONTENT_OMITTED'));
});

test('L4 PDF marks acquired unsupported images as omitted, not acquisition failures', async () => {
    const corrupted: PreparedResources = new Map([
        ['image', { ok: true, resourceId: 'image', value: { bytes: new Uint8Array([1, 2]), mediaType: 'image/png' } }],
        ['file', { ok: true, resourceId: 'file', value: { bytes: fileBytes, mediaType: 'text/plain' } }],
    ]);
    const compiler: IPdfCompiler = { name: 'test', async compile(payload) {
        assert.equal(payload.assetPaths.size, 0);
        assert.equal(payload.document.messages[0].blocks[0].type, 'unknown');
        return { pdfBytes, diagnostics: [] };
    } };
    const out = await compileDocumentPdf(pdfDocument, { image: 'assets/photo.png' },
        corrupted, compiler, compileContext());
    assert.ok(out.diagnostics.some(d => d.code === 'FORMAT_CONTENT_OMITTED'));
});

test('L4 PDF safely degrades image-decoder failure without reacquiring resource', async () => {
    let compiles = 0;
    const compiler: IPdfCompiler = { name: 'test', async compile(payload) {
        compiles++;
        if (compiles === 1) {
            assert.equal(payload.assetPaths.has('image'), true);
            throw new PdfResourceError([missingResource('image', 'Unsupported decoder', 'TYPST_ASSET_DECODE_FAILED')]);
        }
        assert.equal(payload.assetPaths.size, 0);
        assert.equal(payload.document.messages[0].blocks[0].type, 'unknown');
        return { pdfBytes, diagnostics: [] };
    } };
    const out = await compileDocumentPdf(pdfDocument, { image: 'assets/photo.png' },
        prepared, compiler, compileContext());
    assert.equal(compiles, 2);
    assert.ok(out.diagnostics.some(d => d.code === 'FORMAT_CONTENT_OMITTED'));
});

test('L4 Markdown preserves merged table span structure and safely escapes HTML content', () => {
    const doc: DocumentAst = {
        title: 'Merged table',
        metadata: { id: 'merge', provider: 'gemini' },
        messages: [{ role: 'assistant', blocks: [{
            type: 'table',
            columnAlignments: ['left', 'right'],
            headerRows: [[{ children: [{ type: 'text', text: 'A' }], column: 0, colSpan: 2, rowSpan: 1 }]],
            rows: [[{ children: [{ type: 'text', text: '<unsafe>' }], column: 0, colSpan: 1, rowSpan: 1 },
                { children: [{ type: 'strong', children: [{ type: 'text', text: 'Emphasis' }] }], column: 1, colSpan: 1, rowSpan: 1 }]],
        }] }],
    };
    const markdown = renderDocumentMarkdown(doc, {});
    assert.ok(markdown.includes('<th colspan="2">A</th>'));
    assert.ok(markdown.includes('&lt;unsafe&gt;'));
    assert.ok(markdown.includes('<strong>Emphasis</strong>'));
    assert.ok(!markdown.includes('<unsafe>'));
});
