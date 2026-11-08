/**
 * Application.runExport owns item failures, batch delivery and ExportRecord.
 * L3b builds the AST; L4 PDF Format accepts an IPdfCompiler boundary and L4
 * Packaging/Delivery owns the output. The old PdfExporter / StorageService,
 * writer callbacks, session aliases and manual ZIP finalization no longer exist.
 * Only the external Typst sandbox compiler and browser surfaces are doubled.
 */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { BlockNode } from '../src/l2/content/blocks.js';
import type { DomainAsset } from '../src/l2/conversationDetail.js';
import { fixtureAccount } from './helpers/domainFixture.js';
import { v2ExportHost, exportKey, exportRequest } from './helpers/v2ExportHost.js';
import { ingestDetail } from '../src/l2/ingestion.js';
import { readConversation } from '../src/l2/readConversation.js';
import { getExportRecord } from '../src/l3a/storageService.js';
import { runExport } from '../src/application/export/runExport.js';
import { updateSettings } from '../src/application/settings/index.js';
import { prepareExportResources } from '../src/application/export/prepareExportResources.js';
import { composeDomainDocument } from '../src/l3b/compose/composeDomainDocument.js';
import { collectDocumentResources } from '../src/l3b/ast/resourceReferences.js';
import { compileDocumentPdf } from '../src/l4/format/pdf/compileDocumentPdf.js';
import { TypstSandboxCompiler } from '../src/l4/format/pdf/typst/typstSandboxCompiler.js';
import type { IPdfCompiler } from '../src/l4/format/pdf/pdfCompiler.js';
import { PdfResourceError } from '../src/l4/format/pdf/errors.js';
import { buildMinimalValidPdf, StubPdfCompiler } from './helpers/stubPdfCompiler.js';
import { planExportPaths, buildExportFiles, packageExportFiles } from '../src/l4/packaging/index.js';
import { startBrowserDownload } from '../src/l4/delivery/index.js';
import { missingResource } from '../src/shared/resources/resourceResult.js';
import { __getZipConstructor, __setZipConstructor } from '../src/l4/packaging/writers/zipWriter.js';

const account = fixtureAccount('gemini');
const JSZip = require('../lib/jszip.min.js');
const png = new Uint8Array(Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNg+M/wHwAEAQH/cetH5QAAAABJRU5ErkJggg==', 'base64'));

function paragraph(text: string): BlockNode {
    return { type: 'paragraph', children: [{ type: 'text', text }] };
}
async function seed(id: string, options: {
    title?: string;
    assets?: DomainAsset[];
    content?: BlockNode[];
    quality?: 'complete' | 'partial' | 'unknown';
    savedAt?: number;
    updatedAt?: number;
} = {}): Promise<void> {
    await ingestDetail(account.id, id, {
        savedAt: options.savedAt ?? 100,
        quality: { status: options.quality ?? 'complete' },
        assets: options.assets ?? [],
        messages: [{ role: 'assistant', content: options.content ?? [paragraph('PDF output for ' + id)] }],
    }, { title: options.title ?? 'PDF ' + id, titleSource: 'provider', updatedAt: options.updatedAt ?? 100 });
    // The fake browser navigator has no language; v2 settings supply it.
    await updateSettings({ language: 'en' });
}
/** Stub the external PDF sandbox only; Application and PDF Format stay real. */
function sandbox(t: TestContext, compile: IPdfCompiler['compile'] =
    async () => ({ pdfBytes: buildMinimalValidPdf(), diagnostics: [] })): void {
    const prior = TypstSandboxCompiler.prototype.compile;
    TypstSandboxCompiler.prototype.compile = compile;
    t.after(() => { TypstSandboxCompiler.prototype.compile = prior; });
}
function zip(t: TestContext): void {
    const prior = __getZipConstructor();
    __setZipConstructor(JSZip);
    t.after(() => __setZipConstructor(prior));
}
function context(signal: AbortSignal = new AbortController().signal) {
    return { signal, reportProgress() {} };
}
async function pdfInput(id: string, getBytes: (asset: DomainAsset) => Promise<Uint8Array>) {
    const conversation = await readConversation(exportKey(id));
    assert.ok(conversation);
    const document = composeDomainDocument(conversation, account);
    const refs = collectDocumentResources(document);
    const prepared = await prepareExportResources(conversation.detail.assets, refs.referencedIds,
        async asset => ({ bytes: await getBytes(asset), mediaType: asset.mediaType, name: asset.name }));
    const [plan] = planExportPaths([{ conversation, prepared, fileIds: refs.fileIds }], 'pdf');
    return { conversation, document, refs, prepared, plan };
}

test('v2 PDF export commits its ExportRecord only after real browser delivery, then skips unchanged data', async t => {
    const host = v2ExportHost(t);
    sandbox(t);
    const id = 'delivered';
    await seed(id);
    assert.equal(await getExportRecord(exportKey(id)), null);
    const result = await runExport(exportRequest([id], { format: 'pdf' }));
    assert.deepEqual(result, { exported: 1, skipped: 0, partial: 0, failed: [], aborted: false });
    assert.equal(host.clicks(), 1);
    assert.ok(host.filenames[0].endsWith('.pdf'));
    const body = new Uint8Array(await host.blobs[0].arrayBuffer());
    assert.deepEqual(body, buildMinimalValidPdf(), 'real PDF bytes reach Browser Download');
    assert.match(new TextDecoder().decode(body), /startxref[\s\S]*%%EOF/);
    const record = await getExportRecord(exportKey(id));
    assert.equal(record?.format, 'pdf');
    assert.equal(record?.status, 'ok');
    assert.equal(record?.chatTime, 100);
    assert.ok(record?.exportedAt);
    const skipped = await runExport(exportRequest([id], { format: 'pdf', skipUnchanged: true }));
    assert.equal(skipped.skipped, 1);
    assert.equal(skipped.exported, 0);
    assert.equal(host.clicks(), 1);
});

test('a failed Browser Download cannot create a PDF ExportRecord; the next attempt remains retryable', async t => {
    let failClick = true;
    const host = v2ExportHost(t, () => {
        if (failClick) throw new Error('Download start rejected');
    });
    sandbox(t);
    const id = 'download-retry';
    await seed(id);
    const first = await runExport(exportRequest([id], { format: 'pdf' }));
    assert.equal(first.exported, 0);
    assert.deepEqual(first.failed, [exportKey(id)]);
    assert.equal(await getExportRecord(exportKey(id)), null);
    failClick = false;
    const second = await runExport(exportRequest([id], { format: 'pdf' }));
    assert.equal(second.exported, 1);
    assert.deepEqual(second.failed, []);
    assert.equal(host.clicks(), 2);
    assert.equal((await getExportRecord(exportKey(id)))?.status, 'ok');
});

test('one PDF compile error does not block other batch items, which are ZIP-delivered and recorded', async t => {
    const host = v2ExportHost(t);
    zip(t);
    let compiles = 0;
    sandbox(t, async payload => {
        compiles++;
        if (payload.document.title.includes('bad')) throw new Error('Typst fatal document error');
        return { pdfBytes: buildMinimalValidPdf(), diagnostics: [] };
    });
    const ids = ['batch-good-one', 'batch-bad', 'batch-good-two'];
    for (const id of ids) await seed(id);
    const result = await runExport(exportRequest(ids, { format: 'pdf' }));
    assert.equal(compiles, 3);
    assert.equal(result.exported, 2);
    assert.equal(result.partial, 0);
    assert.deepEqual(result.failed, [exportKey('batch-bad')]);
    assert.equal(host.clicks(), 1);
    assert.match(host.filenames[0], /\.zip$/);
    const archive = await JSZip.loadAsync(await host.blobs[0].arrayBuffer());
    const files = Object.keys(archive.files).filter(name => name.endsWith('.pdf'));
    assert.equal(files.length, 2);
    assert.ok(files.some(name => name.includes('batch-good-one')));
    assert.ok(files.some(name => name.includes('batch-good-two')));
    for (const file of files) assert.deepEqual(await archive.file(file)!.async('uint8array'), buildMinimalValidPdf());
    assert.equal(await getExportRecord(exportKey('batch-bad')), null);
    assert.equal((await getExportRecord(exportKey('batch-good-one')))?.status, 'ok');
    assert.equal((await getExportRecord(exportKey('batch-good-two')))?.status, 'ok');
});

test('failed PDF batch ZIP delivery cannot commit any records, and a retry can deliver the same items', async t => {
    let failClick = true;
    const host = v2ExportHost(t, () => {
        if (failClick) throw new Error('ZIP delivery failed');
    });
    zip(t);
    sandbox(t);
    const ids = ['zip-one', 'zip-two'];
    for (const id of ids) await seed(id);
    const first = await runExport(exportRequest(ids, { format: 'pdf' }));
    assert.equal(first.exported, 0);
    assert.deepEqual(first.failed, ids.map(exportKey));
    for (const id of ids) assert.equal(await getExportRecord(exportKey(id)), null);
    failClick = false;
    const second = await runExport(exportRequest(ids, { format: 'pdf' }));
    assert.equal(second.exported, 2);
    assert.deepEqual(second.failed, []);
    assert.equal(host.clicks(), 2);
    for (const id of ids) assert.equal((await getExportRecord(exportKey(id)))?.format, 'pdf');
});

test('cancelling during PDF compilation stops delivery and leaves unfinished items unrecorded', async t => {
    const host = v2ExportHost(t);
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    sandbox(t, async (_payload, compileContext) => {
        entered();
        return new Promise((_resolve, reject) => {
            compileContext.signal.addEventListener('abort',
                () => reject(new DOMException('Compile cancelled', 'AbortError')), { once: true });
        });
    });
    const ids = ['cancel-one', 'cancel-two'];
    for (const id of ids) await seed(id);
    const controller = new AbortController();
    const pending = runExport(exportRequest(ids, { format: 'pdf' }), { signal: controller.signal });
    await started;
    controller.abort();
    const result = await pending;
    assert.equal(result.aborted, true);
    assert.equal(result.exported, 0);
    assert.deepEqual(result.failed, []);
    assert.equal(host.clicks(), 0);
    for (const id of ids) assert.equal(await getExportRecord(exportKey(id)), null);
});

test('PDF delivery remains completed even when persisting ExportRecord fails', async t => {
    const host = v2ExportHost(t);
    sandbox(t);
    const id = 'record-write-failure';
    await seed(id);
    host.failStorage('exportRecords');
    const result = await runExport(exportRequest([id], { format: 'pdf' }));
    assert.equal(host.clicks(), 1, 'the browser received the actual PDF');
    assert.equal(result.exported, 0, 'v2 counts records only after they commit');
    assert.deepEqual(result.failed, [exportKey(id)]);
    assert.equal(await getExportRecord(exportKey(id)), null);
    assert.deepEqual(new Uint8Array(await host.blobs[0].arrayBuffer()), buildMinimalValidPdf());
});

test('includeAssets=false retains readable PDF without downloading or persisting source image bytes', async t => {
    const host = v2ExportHost(t);
    let seenPaths = 0;
    sandbox(t, async payload => {
        seenPaths = payload.assetPaths.size;
        assert.match(JSON.stringify(payload.document), /missing-image/);
        return { pdfBytes: buildMinimalValidPdf(), diagnostics: [] };
    });
    const id = 'without-image';
    await seed(id, { assets: [{ id: 'image', kind: 'image', sourceUri: 'https://example.test/photo.png' }],
        content: [paragraph('Keep this conversation'), { type: 'image', assetId: 'image' }] });
    const before = await readConversation(exportKey(id));
    const result = await runExport(exportRequest([id], { format: 'pdf', includeAssets: false }));
    assert.equal(result.exported, 1);
    assert.equal(result.partial, 0, 'intentional resource exclusion is not an acquisition failure');
    assert.equal(seenPaths, 0);
    assert.equal(host.clicks(), 1);
    assert.ok(host.filenames[0].endsWith('.pdf'));
    assert.deepEqual(await readConversation(exportKey(id)), before);
    assert.equal((await getExportRecord(exportKey(id)))?.status, 'ok');
});

test('the L4 PDF compiler contract emits a structurally valid stub PDF and diagnostic', async t => {
    v2ExportHost(t);
    const id = 'stub-compiler';
    await seed(id);
    const input = await pdfInput(id, async () => { throw new Error('No resources expected'); });
    const result = await compileDocumentPdf(input.document, input.plan.resources, input.prepared,
        new StubPdfCompiler(), context());
    const text = new TextDecoder().decode(result.pdfBytes);
    assert.match(text, /^%PDF-/);
    assert.match(text, /xref[\s\S]*trailer[\s\S]*startxref[\s\S]*%%EOF/);
    assert.ok(result.diagnostics.some(d => d.code === 'STUB_COMPILER_PLACEHOLDER'));
    const artifacts = buildExportFiles('pdf', input.plan, result.pdfBytes, input.prepared);
    assert.equal(artifacts.length, 1);
    assert.ok(artifacts[0].fileName.endsWith('.pdf'));
});

test('L4 passes compiler warnings through PDF diagnostics without swallowing or converting them', async t => {
    v2ExportHost(t);
    const id = 'compiler-warning';
    await seed(id);
    const input = await pdfInput(id, async () => { throw new Error('No resources expected'); });
    const compiler: IPdfCompiler = { name: 'warning probe', async compile() {
        return { pdfBytes: buildMinimalValidPdf(), diagnostics: [
            { severity: 'warning', code: 'TEST_COMPILE_WARNING', message: 'font fallback used' },
        ] };
    } };
    const result = await compileDocumentPdf(input.document, input.plan.resources, input.prepared,
        compiler, context());
    assert.ok(result.diagnostics.some(d => d.code === 'TEST_COMPILE_WARNING' && d.message === 'font fallback used'));
});

test('generic PDF compilation failure is fatal and cannot be reclassified as a missing image', async t => {
    const host = v2ExportHost(t);
    const id = 'fatal-compiler';
    await seed(id);
    const input = await pdfInput(id, async () => { throw new Error('No resources expected'); });
    let compiles = 0;
    const compiler: IPdfCompiler = { name: 'fatal probe', async compile() {
        compiles++;
        throw new Error('Typst invalid document');
    } };
    await assert.rejects(compileDocumentPdf(input.document, input.plan.resources, input.prepared,
        compiler, context()), /Typst invalid document/);
    assert.equal(compiles, 1);
    assert.equal(host.clicks(), 0);
    assert.equal(await getExportRecord(exportKey(id)), null);
});

test('PDF image is embedded from prepared bytes, while a dual-use File ships the original as one ZIP sidecar', async t => {
    const host = v2ExportHost(t);
    zip(t);
    const id = 'embedded-with-original';
    await seed(id, { assets: [{ id: 'dual', kind: 'image', name: 'original.png', mediaType: 'image/png' }],
        content: [
            { type: 'image', assetId: 'dual', alt: 'Embedded image' },
            { type: 'file', assetId: 'dual', label: 'Original bytes' },
        ] });
    let acquisition = 0;
    const input = await pdfInput(id, async () => { acquisition++; return png; });
    assert.deepEqual([...input.refs.imageIds], ['dual']);
    assert.deepEqual([...input.refs.fileIds], ['dual']);
    assert.equal(input.plan.externalResourceIds.has('dual'), true);
    const compiler: IPdfCompiler = { name: 'asset binding probe', async compile(payload, compileContext) {
        assert.equal(payload.assetPaths.get('dual'), input.plan.resources.dual);
        assert.deepEqual((await compileContext.assets.resolve('dual'))?.bytes, png);
        return { pdfBytes: buildMinimalValidPdf(), diagnostics: [] };
    } };
    const result = await compileDocumentPdf(input.document, input.plan.resources, input.prepared,
        compiler, context());
    assert.equal(acquisition, 1, 'PDF Format does not fetch the same source twice');
    assert.ok(!result.diagnostics.some(d => d.code === 'FORMAT_CONTENT_OMITTED'));
    const files = buildExportFiles('pdf', input.plan, result.pdfBytes, input.prepared);
    assert.equal(files.length, 2);
    assert.equal(files[1].fileName, input.plan.resources.dual);
    assert.deepEqual(files[1].content, png);
    const deliverable = await packageExportFiles([files], 'browserDownload');
    assert.equal(deliverable.length, 1);
    assert.ok(deliverable[0].fileName.endsWith('.zip'));
    await startBrowserDownload(deliverable[0]);
    assert.equal(host.clicks(), 1);
    const archive = await JSZip.loadAsync(await host.blobs[0].arrayBuffer());
    const sidecar = archive.file(input.plan.resources.dual);
    assert.ok(sidecar);
    assert.deepEqual(await sidecar.async('uint8array'), png);
    const pdf = archive.file(input.plan.fileName);
    assert.ok(pdf);
    assert.deepEqual(await pdf.async('uint8array'), buildMinimalValidPdf());
});

test('corrupt acquired image bytes become a visible PDF omission without refetching or losing the PDF', async t => {
    v2ExportHost(t);
    const id = 'corrupt-image';
    await seed(id, { assets: [{ id: 'img', kind: 'image', name: 'broken.png', mediaType: 'image/png' }],
        content: [{ type: 'image', assetId: 'img' }] });
    let acquisitions = 0;
    const input = await pdfInput(id, async () => { acquisitions++; return Uint8Array.of(1, 2, 3); });
    assert.equal(input.prepared.get('img')?.ok, true, 'acquisition itself succeeded');
    const compiler: IPdfCompiler = { name: 'omission probe', async compile(payload, compileContext) {
        assert.equal(payload.assetPaths.size, 0, 'only validated bytes reach Typst');
        assert.equal(await compileContext.assets.resolve('img'), null);
        assert.match(JSON.stringify(payload.document), /missing-image/);
        return { pdfBytes: buildMinimalValidPdf(), diagnostics: [] };
    } };
    const result = await compileDocumentPdf(input.document, input.plan.resources, input.prepared, compiler, context());
    assert.equal(acquisitions, 1);
    assert.ok(result.diagnostics.some(d => d.code === 'ASSET_CORRUPT' && d.path === 'asset:img'));
    assert.ok(result.diagnostics.some(d => d.code === 'FORMAT_CONTENT_OMITTED' && d.path === 'asset:img'));
    assert.match(new TextDecoder().decode(result.pdfBytes), /^%PDF-/);
});

test('PDF image decoder failure retries the technical compile once without reacquiring bytes or changing paths', async t => {
    v2ExportHost(t);
    const id = 'pdf-image-retry';
    await seed(id, { assets: [{ id: 'img', kind: 'image', name: 'retry.png', mediaType: 'image/png' }],
        content: [{ type: 'image', assetId: 'img' }] });
    let acquisitions = 0;
    const input = await pdfInput(id, async () => { acquisitions++; return png; });
    let calls = 0;
    const compiler: IPdfCompiler = { name: 'decoder retry probe', async compile(payload) {
        calls++;
        if (calls === 1) {
            assert.equal(payload.assetPaths.get('img'), input.plan.resources.img);
            throw new PdfResourceError([missingResource('img', 'Typst image decode failure')]);
        }
        assert.equal(payload.assetPaths.size, 0);
        assert.match(JSON.stringify(payload.document), /missing-image/);
        return { pdfBytes: buildMinimalValidPdf(), diagnostics: [] };
    } };
    const result = await compileDocumentPdf(input.document, input.plan.resources, input.prepared,
        compiler, context());
    assert.equal(calls, 2);
    assert.equal(acquisitions, 1);
    assert.ok(result.diagnostics.some(d => d.code === 'FORMAT_CONTENT_OMITTED' && d.path === 'asset:img'));
});

test('Packaging refuses colliding PDF file paths before browser download', async t => {
    const host = v2ExportHost(t);
    const bytes = buildMinimalValidPdf();
    await assert.rejects(packageExportFiles([
        [{ fileName: 'duplicate.pdf', mimeType: 'application/pdf', content: bytes }],
        [{ fileName: 'duplicate.pdf', mimeType: 'application/pdf', content: bytes }],
    ], 'browserDownload'), /Duplicate export path/);
    assert.equal(host.clicks(), 0);
});
