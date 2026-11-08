import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DocumentAst } from '../src/l3b/ast/ast.js';
import type { ResourceBindings } from '../src/l4/packaging/resourceBindings.js';
import type { PreparedResources } from '../src/shared/resources/resourceResult.js';
import type { IPdfCompiler } from '../src/l4/format/pdf/pdfCompiler.js';
import { compileDocumentPdf } from '../src/l4/format/pdf/compileDocumentPdf.js';
import { renderDocumentHtml } from '../src/l4/format/html/renderHtml.js';
import { renderDocumentMarkdown } from '../src/l4/format/markdown/renderMarkdown.js';
import { renderDocumentTypst } from './helpers/renderTypstFixture.js';
import { simulateMitexInitFailureForTesting, resetMitexForTesting } from '../src/l4/format/typst/mathConverter.js';

const document: DocumentAst = {
    title: 'Title', metadata: { id: 'c', provider: 'p' },
    messages: [{ role: 'assistant', blocks: [
        { type: 'image', resourceId: 'image', alt: 'Figure' },
        { type: 'file', resourceId: 'file', label: 'notes.pdf', kind: 'file' },
        { type: 'math', source: 'x^2' },
    ] }],
};
const image = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1]);
const prepared: PreparedResources = new Map([['image', { ok: true, resourceId: 'image', value: { bytes: image, mediaType: 'image/png' } }]]);
const bindings = { image: 'assets/Chosen name.png', file: 'files/notes.pdf' };
const pdf = new TextEncoder().encode('%PDF-1.7\n' + ' '.repeat(80));
const context = () => ({ signal: new AbortController().signal, reportProgress() {} });

test('PDF mounts the Packaging path verbatim and only resolves supplied image bytes', async () => {
    const before = structuredClone(document);
    let calls = 0;
    const compiler: IPdfCompiler = { name: 'test', async compile(payload, ctx) {
        calls++;
        assert.deepEqual([...payload.assetPaths], [['image', bindings.image]]);
        assert.equal((payload.document.messages[0].blocks[0] as { asset: string }).asset, bindings.image);
        assert.deepEqual(await ctx.assets.resolve('image'), { bytes: image });
        assert.equal(await ctx.assets.resolve('file'), null);
        assert.equal(await ctx.assets.resolve('unknown'), null);
        assert.equal(payload.document.messages[0].blocks[1].type, 'file');
        return { pdfBytes: pdf, diagnostics: [{ severity: 'info', code: 'COMPILED', message: 'ok' }] };
    } };
    const result = await compileDocumentPdf(document, bindings, prepared, compiler, context());
    assert.equal(calls, 1);
    assert.equal(result.pdfBytes, pdf);
    assert.equal(result.diagnostics.at(-1)?.code, 'COMPILED');
    assert.deepEqual(document, before);
});

test('corrupt and absent images produce readable placeholders, retaining captions', async () => {
    const doc = structuredClone(document);
    doc.messages[0].blocks[0] = { type: 'image', resourceId: 'image', alt: 'Figure', caption: [{ type: 'text', text: 'Important caption' }] };
    const compiler: IPdfCompiler = { name: 'test', async compile(payload) {
        assert.equal(payload.assetPaths.size, 0);
        const block = payload.document.messages[0].blocks[0];
        assert.equal(block.type, 'unknown');
        assert.match(JSON.stringify(block), /Important caption/);
        return { pdfBytes: pdf, diagnostics: [] };
    } };
    const corrupt: PreparedResources = new Map([['image', { ok: true, resourceId: 'image', value: { bytes: new Uint8Array([1]), mediaType: 'image/png' } }]]);
    const result = await compileDocumentPdf(doc, bindings, corrupt, compiler, context());
    assert.ok(result.diagnostics.some(d => d.code === 'ASSET_CORRUPT'));
    assert.ok(result.diagnostics.some(d => d.code === 'FORMAT_CONTENT_OMITTED'), 'acquired-but-unrenderable image is partial');
    await compileDocumentPdf(doc, {}, new Map(), compiler, context());
});

test('compile failure propagates without a second render, retry or delivery', async () => {
    let calls = 0;
    const compiler: IPdfCompiler = { name: 'test', async compile() { calls++; throw new Error('sandbox failed'); } };
    await assert.rejects(compileDocumentPdf(document, bindings, prepared, compiler, context()), /sandbox failed/);
    assert.equal(calls, 1);
});

test('invalid PDF output and cancellation are explicit failures', async () => {
    for (const bytes of [new Uint8Array(), new Uint8Array(100), new TextEncoder().encode('%PDF-')]) {
        const compiler: IPdfCompiler = { name: 'test', async compile() { return { pdfBytes: bytes, diagnostics: [] }; } };
        await assert.rejects(compileDocumentPdf(document, {}, new Map(), compiler, context()), /invalid PDF/);
    }
    const abort = new AbortController(); abort.abort();
    const compiler: IPdfCompiler = { name: 'test', async compile() { assert.fail('aborted compilation must not start'); } };
    await assert.rejects(compileDocumentPdf(document, {}, new Map(), compiler, { ...context(), signal: abort.signal }), { name: 'AbortError' });
});

test('each conversation retains its own bindings and bytes for overlapping resource IDs', async () => {
    for (const path of ['assets/first.png', 'assets/second.png']) {
        const compiler: IPdfCompiler = { name: 'test', async compile(payload) {
            assert.equal(payload.assetPaths.get('image'), path);
            return { pdfBytes: pdf, diagnostics: [] };
        } };
        await compileDocumentPdf(document, { image: path }, prepared, compiler, context());
    }
});

test('all renderers use supplied local bindings and visibly degrade invalid paths', () => {
    for (const path of ['', '../image.png', '/image.png', 'https://example.test/image.png', 'javascript:alert(1)']) {
        const resources: ResourceBindings = { image: path };
        assert.doesNotMatch(renderDocumentMarkdown(document, resources), /!\[/);
        assert.ok(renderDocumentHtml(document, resources).diagnostics.some(d => d.code === 'HTML_ASSET_UNRESOLVED'));
        assert.equal(renderDocumentTypst(document, resources).messages[0].blocks[0].type, 'unknown');
    }
    assert.match(renderDocumentMarkdown(document, bindings), /assets\/Chosen%20name.png/);
    assert.match(renderDocumentHtml(document, bindings).html, /assets\/Chosen%20name.png/);
});

test('MiTeX initialization failure preserves source math with a diagnostic', async () => {
    resetMitexForTesting();
    simulateMitexInitFailureForTesting(() => new Error('unavailable'));
    const compiler: IPdfCompiler = { name: 'test', async compile(payload) {
        const math = payload.document.messages[0].blocks[2];
        assert.equal(math.type, 'math');
        assert.match(JSON.stringify(math), /x\^2/);
        assert.equal('typst' in math, false);
        return { pdfBytes: pdf, diagnostics: [] };
    } };
    try {
        const result = await compileDocumentPdf(document, {}, new Map(), compiler, context());
        assert.ok(result.diagnostics.some(d => d.code === 'TYPST_MATH_INIT_FAILED'));
    } finally {
        simulateMitexInitFailureForTesting(null);
        resetMitexForTesting();
    }
});

test('abort during compilation rejects even when the compiler returns bytes', async () => {
    const abort = new AbortController();
    const compiler: IPdfCompiler = { name: 'test', async compile() {
        abort.abort();
        return { pdfBytes: pdf, diagnostics: [] };
    } };
    await assert.rejects(compileDocumentPdf(document, {}, new Map(), compiler, { ...context(), signal: abort.signal }), { name: 'AbortError' });
});

