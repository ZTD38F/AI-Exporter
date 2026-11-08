/**
 * V2 cross-module resource delivery: L2 facts -> L3a -> L1 acquisition ->
 * Application preparation -> L3b composition -> L4 packaging/delivery.
 * The deleted ExportOrchestrator, AssetPipeline, ChatFormatter, PDF stages and
 * Takeout media cache are not integration boundaries. Mock browser HTTP,
 * Chrome account-route IPC and the external PDF compiler only.
 */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { fixtureAccount } from './helpers/domainFixture.js';
import { v2ExportHost, readDeliveredFiles, exportKey, exportRequest } from './helpers/v2ExportHost.js';
import { ingestDetail } from '../src/l2/ingestion.js';
import { readConversation } from '../src/l2/readConversation.js';
import { getExportRecord } from '../src/l3a/storageService.js';
import { composeDomainDocument } from '../src/l3b/compose/composeDomainDocument.js';
import { collectDocumentResources } from '../src/l3b/ast/resourceReferences.js';
import { prepareExportResources } from '../src/application/export/prepareExportResources.js';
import { runExport } from '../src/application/export/runExport.js';
import { renderDocumentMarkdown } from '../src/l4/format/markdown/renderMarkdown.js';
import { renderDocumentHtml } from '../src/l4/format/html/renderHtml.js';
import { planExportPaths, buildExportFiles } from '../src/l4/packaging/index.js';
import { compileDocumentPdf } from '../src/l4/format/pdf/compileDocumentPdf.js';
import type { IPdfCompiler } from '../src/l4/format/pdf/pdfCompiler.js';
import { attemptResource, missingResource } from '../src/shared/resources/resourceResult.js';
import { __setZipConstructor, __getZipConstructor } from '../src/l4/packaging/writers/zipWriter.js';
import type { DomainAsset } from '../src/l2/conversationDetail.js';

const JSZip = require('../lib/jszip.min.js');
const account = fixtureAccount('gemini');
const png = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10, 9, 8, 7, 6);
const goodUri = 'https://source.example.test/good.png';
const badUri = 'https://source.example.test/bad.png';
const paragraph = (text: string) => ({ type: 'paragraph' as const, children: [{ type: 'text' as const, text }] });
const image = (id: string, uri: string, name = id + '.png'): DomainAsset => ({
    id, kind: 'image', name, sourceUri: uri, mediaType: 'image/png',
});
async function seed(id: string, assets: DomainAsset[] = [
    image('good', goodUri), image('bad', badUri),
], unreferenced: DomainAsset[] = []) {
    const fileIds = assets.filter(asset => asset.kind !== 'image').map(asset => asset.id);
    await ingestDetail(account.id, id, {
        savedAt: 100, quality: { status: 'complete' }, assets: [...assets, ...unreferenced],
        messages: [{
            role: 'assistant',
            content: [paragraph('Conversation survives resource failure'),
                ...assets.filter(asset => asset.kind === 'image').map(asset => ({
                    type: 'image' as const, assetId: asset.id, alt: asset.name,
                }))],
            ...(fileIds.length ? { attachmentIds: fileIds } : {}),
        }],
    }, { title: 'Resources ' + id, titleSource: 'provider', updatedAt: 100 });
}
function useZip(t: TestContext) {
    const old = __getZipConstructor();
    __setZipConstructor(JSZip);
    t.after(() => __setZipConstructor(old));
}
function network(t: TestContext, get: (url: string, signal?: AbortSignal) => Response | Promise<Response>) {
    const previousFetch = globalThis.fetch;
    // Keep the exact Chrome host instance; v2ExportHost may restore the global
    // before this test-specific network teardown runs.
    const chrome = globalThis.chrome;
    const previousTabs = Object.getOwnPropertyDescriptor(chrome, 'tabs');
    const requests: string[] = [];
    Object.defineProperty(chrome, 'tabs', { configurable: true, value: {
        query: async () => [{ id: 21, url: 'https://gemini.google.com/app/resource' }],
        sendMessage: async () => ({ ok: true, accountContext: {
            accountId: account.id, providerId: 'gemini', slot: 'u0',
        } }),
    } });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
        requests.push(url);
        return await get(url, init?.signal ?? undefined);
    }) as typeof fetch;
    t.after(() => {
        globalThis.fetch = previousFetch;
        if (previousTabs) Object.defineProperty(chrome, 'tabs', previousTabs);
        else Reflect.deleteProperty(chrome, 'tabs');
    });
    return requests;
}
function response(bytes: Uint8Array, type = 'image/png') {
    return new Response(new Uint8Array(bytes) as BodyInit, { status: 200,
        headers: { 'content-type': type } });
}

for (const format of ['markdown', 'html', 'json'] as const) for (const failure of ['throw', 'empty', 'http'] as const) {
    test(format + ': ' + failure + ' keeps healthy binary bytes and commits a partial ExportRecord after ZIP delivery', async t => {
        const host = v2ExportHost(t); useZip(t);
        const id = 'delivery-' + format + '-' + failure;
        await seed(id);
        const requests = network(t, url => {
            if (url.startsWith('https://gemini.google.com/')) return new Response(null, { status: 503 });
            if (url === goodUri) return response(png);
            if (url === badUri) {
                if (failure === 'throw') throw new Error('Source transport unavailable');
                if (failure === 'empty') return response(new Uint8Array());
                return new Response(null, { status: 404 });
            }
            throw new Error('Unexpected resource URL: ' + url);
        });
        const original = await readConversation(exportKey(id));
        const result = await runExport(exportRequest([id], { format, includeAssets: true }));
        assert.equal(result.aborted, false);
        assert.equal(result.exported, 1);
        assert.equal(result.partial, 1);
        assert.deepEqual(result.failed, []);
        assert.deepEqual(requests.filter(url => !url.startsWith('https://gemini.google.com/')), [goodUri, badUri],
            'the L1 provider acquires only requested resources');
        assert.equal(requests.filter(url => url.startsWith('https://gemini.google.com/')).length, failure === 'http' ? 1 : 0,
            'only an actual expiry response triggers one background refresh; failed refresh preserves healthy bytes');
        assert.equal(host.clicks(), 1);
        assert.match(host.filenames[0], /\.zip$/);
        const files = await readDeliveredFiles(host);
        const main = files.find(file => file.name.endsWith(format === 'markdown' ? '.md' : format === 'html' ? '.html' : '.json'));
        assert.ok(main);
        const body = String(await main.async('string'));
        assert.match(body, /Conversation survives resource failure/);
        const sidecars = files.filter(file => file.name.startsWith('assets/'));
        assert.equal(sidecars.length, 1);
        assert.deepEqual(await sidecars[0].async('uint8array'), png);
        if (format === 'json') {
            const archive = JSON.parse(body);
            assert.equal(archive.conversation.detail.quality.status, 'complete');
            assert.ok(archive.resources.good);
            assert.equal(archive.resources.bad, undefined, 'the final corrected document excludes failed bindings');
        } else {
            assert.ok(body.includes(sidecars[0].name), 'body references an actually packaged image');
            assert.match(body, {throw:/Attachment failed: Unknown error/,empty:/Attachment could not be processed/,http:/Source attachment unavailable.*HTTP 404/}[failure]);
            assert.match(body, /https:\/\/source\.example\.test\/bad\.png/, 'retain a source link for inspection');
            assert.doesNotMatch(body, /src="https:\/\/source\.example\.test\/bad\.png|!\[[^\]]*\]\(https:\/\/source\.example\.test\/bad\.png/, 'never embed a broken remote image');
        }
        const record = await getExportRecord(exportKey(id));
        assert.equal(record?.status, 'partial');
        assert.equal(record?.format, format);
        assert.equal(record?.chatTime, 100);
        assert.deepEqual(await readConversation(exportKey(id)), original, 'resource failures cannot rewrite stored Domain');
    });
}

for (const format of ['markdown', 'html', 'json'] as const) {
    test(format + ': includeAssets=false skips acquisition and delivers a complete main file without a ZIP', async t => {
        const host = v2ExportHost(t);
        const id = 'without-assets-' + format;
        await seed(id);
        const before = await readConversation(exportKey(id));
        const requests = network(t, () => { throw new Error('No resource should be fetched'); });
        const result = await runExport(exportRequest([id], { format, includeAssets: false }));
        assert.equal(result.exported, 1);
        assert.equal(result.partial, 0);
        assert.deepEqual(result.failed, []);
        assert.deepEqual(requests, []);
        assert.equal(host.clicks(), 1);
        const extension = { markdown: '.md', html: '.html', json: '.json' }[format];
        assert.ok(host.filenames[0].endsWith(extension));
        assert.equal(host.blobs.length, 1);
        const body = await host.blobs[0].text();
        assert.match(body, /Conversation survives resource failure/);
        if (format === 'json') {
            const archive = JSON.parse(body);
            assert.equal(archive.conversation.detail.assets.length, 2);
            assert.deepEqual(archive.resources, {});
        } else {
            assert.match(body, /unavailable/i, 'AST resource nodes remain readable without bytes');
            assert.doesNotMatch(body, /src="assets\/|!\[[^\]]+\]\(assets\//);
        }
        assert.equal((await getExportRecord(exportKey(id)))?.status, 'ok');
        assert.deepEqual(await readConversation(exportKey(id)), before);
    });
}

for (const format of ['markdown', 'json'] as const) {
    test(format + ': resource selection uses AST references for reading formats and all Domain assets for JSON', async t => {
        const host = v2ExportHost(t); useZip(t);
        const id = 'unreferenced-resource-' + format;
        const orphanUri = 'https://source.example.test/orphan.txt';
        const orphanBytes = new TextEncoder().encode('Unreferenced original');
        await seed(id, [image('good', goodUri)], [
            { id: 'orphan', kind: 'file', name: 'orphan.txt', mediaType: 'text/plain', sourceUri: orphanUri },
        ]);
        const requests = network(t, url => {
            if (url === goodUri) return response(png);
            if (url === orphanUri) return response(orphanBytes, 'text/plain');
            throw new Error('Unexpected resource URL: ' + url);
        });
        const result = await runExport(exportRequest([id], { format, includeAssets: true }));
        assert.equal(result.exported, 1);
        assert.equal(result.partial, 0);
        assert.deepEqual(result.failed, []);
        assert.deepEqual(requests, format === 'json' ? [goodUri, orphanUri] : [goodUri]);
        assert.equal(host.clicks(), 1);
        assert.match(host.filenames[0], /\.zip$/);
        const files = await readDeliveredFiles(host);
        const main = files.find(file => file.name.endsWith(format === 'json' ? '.json' : '.md'));
        assert.ok(main);
        const body = String(await main.async('string'));
        const orphan = files.find(file => file.name.includes('orphan.txt'));
        if (format === 'json') {
            const archive = JSON.parse(body);
            assert.equal(archive.conversation.detail.assets.length, 2);
            assert.ok(archive.resources.good);
            assert.equal(archive.resources.orphan, orphan?.name);
            assert.deepEqual(await orphan?.async('uint8array'), orphanBytes);
        } else {
            assert.equal(orphan, undefined);
            assert.doesNotMatch(body, /orphan\.txt/);
        }
        assert.equal((await getExportRecord(exportKey(id)))?.status, 'ok');
    });
}

test('L4 Markdown/HTML never emit a local sidecar link until an acquisition result has a planned binding', async t => {
    v2ExportHost(t);
    const id = 'unbound-resource';
    await seed(id, [image('unavailable', badUri)]);
    const conversation = await readConversation(exportKey(id));
    assert.ok(conversation);
    const document = composeDomainDocument(conversation, account);
    const refs = collectDocumentResources(document);
    const prepared = await prepareExportResources(conversation.detail.assets, refs.referencedIds,
        async () => { throw new Error('HTTP 404'); });
    const [plan] = planExportPaths([{ conversation, prepared, fileIds: refs.fileIds }], 'markdown');
    assert.deepEqual(Object.keys(plan.resources), []);
    const markdown = renderDocumentMarkdown(document, plan.resources);
    const html = renderDocumentHtml(document, plan.resources).html;
    assert.match(markdown, /unavailable/i);
    assert.match(html, /unavailable/i);
    assert.doesNotMatch(markdown, /assets\/[^)\s]+/);
    assert.doesNotMatch(html, /src="assets\//);
    assert.equal(prepared.get('unavailable')?.ok, false);
});

test('a file companion uses its original L1 bytes in the real ZIP files/ namespace', async t => {
    const host = v2ExportHost(t); useZip(t);
    const id = 'file-companion';
    const uri = 'https://source.example.test/notes.md', bytes = new TextEncoder().encode('# Original file bytes');
    await seed(id, [{ id: 'notes', kind: 'file', name: 'notes.md',
        mediaType: 'text/markdown', sourceUri: uri, document: { contentMarkdown: '# Derived preview' } }]);
    const calls = network(t, url => {
        assert.equal(url, uri);
        return response(bytes, 'text/markdown');
    });
    const result = await runExport(exportRequest([id], { format: 'markdown', includeAssets: true }));
    assert.equal(result.exported, 1);
    assert.equal(result.partial, 0);
    assert.deepEqual(calls, [uri]);
    const files = await readDeliveredFiles(host);
    const original = files.find(file => file.name.startsWith('files/') && file.name.endsWith('notes.md'));
    assert.ok(original);
    assert.deepEqual(await original.async('uint8array'), bytes);
    const main = files.find(file => !file.name.startsWith('files/') && file.name.endsWith('.md'));
    assert.ok(main);
    assert.ok(String(await main.async('string')).includes(original.name));
    assert.equal((await getExportRecord(exportKey(id)))?.status, 'ok');
});

test('failed Browser Download start does not commit an ExportRecord', async t => {
    const host = v2ExportHost(t, () => { throw new Error('Download start failed'); }); useZip(t);
    const id = 'delivery-start-failed';
    await seed(id, [image('good', goodUri)]);
    const requests = network(t, url => {
        assert.equal(url, goodUri);
        return response(png);
    });
    const result = await runExport(exportRequest([id], { includeAssets: true }));
    assert.equal(result.aborted, false);
    assert.equal(result.exported, 0);
    assert.equal(result.partial, 0);
    assert.deepEqual(result.failed, [exportKey(id)]);
    assert.deepEqual(requests, [goodUri]);
    assert.equal(host.clicks(), 1);
    assert.equal(await getExportRecord(exportKey(id)), null);
});

test('ordinary transport exceptions remain per-asset failures', async () => {
    const result = await attemptResource('rejected', async () => { throw new Error('Resource request failed'); });
    assert.deepEqual(result, missingResource('rejected', 'Resource request failed'));
});

test('cancel during L1 acquisition preserves the delivered body without committing a full ExportRecord', async t => {
    const host = v2ExportHost(t), id = 'cancel-media';
    await seed(id, [image('pending', badUri)]);
    let started!: () => void;
    const awaited = new Promise<void>(resolve => { started = resolve; });
    network(t, async (_url, signal) => {
        started();
        return await new Promise<Response>((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(signal.reason ?? new DOMException('Cancelled', 'AbortError')), { once: true });
        });
    });
    const controller = new AbortController();
    const pending = runExport(exportRequest([id], { includeAssets: true }), { signal: controller.signal });
    await awaited;
    assert.equal(host.clicks(), 0);
    controller.abort();
    const result = await pending;
    assert.equal(result.aborted, true);
    assert.equal(result.exported, 0);
    assert.deepEqual(result.failed, []);
    assert.equal(host.clicks(), 1);
    assert.match(await host.blobs[0].text(), /Conversation survives resource failure/);
    assert.equal(await getExportRecord(exportKey(id)), null);
});

test('long near-colliding media names get distinct actual ZIP paths and correct bytes', async t => {
    const host = v2ExportHost(t); useZip(t);
    const id = 'near-colliding-assets';
    const longName = 'same-repeated-segment-'.repeat(8);
    const assets = [
        image('first', 'https://source.example.test/one.png', longName + 'first.png'),
        image('second', 'https://source.example.test/two.png', longName + 'second.png'),
    ];
    await seed(id, assets);
    const calls = network(t, url => response(url.includes('/one.png') ? Uint8Array.of(1, 2) : Uint8Array.of(9, 8, 7)));
    const result = await runExport(exportRequest([id], { includeAssets: true }));
    assert.equal(result.exported, 1);
    assert.equal(result.partial, 0);
    assert.equal(calls.length, 2);
    const files = await readDeliveredFiles(host);
    const assetsWritten = files.filter(file => file.name.startsWith('assets/'));
    assert.equal(assetsWritten.length, 2);
    assert.equal(new Set(assetsWritten.map(file => file.name.toLowerCase())).size, 2);
    const bytes = await Promise.all(assetsWritten.map(file => file.async('uint8array')));
    assert.ok(bytes.some(value => Buffer.from(value as Uint8Array).equals(Buffer.from([1, 2]))));
    assert.ok(bytes.some(value => Buffer.from(value as Uint8Array).equals(Buffer.from([9, 8, 7]))));
    const main = files.find(file => file.name.endsWith('.md'));
    assert.ok(main);
    const body = String(await main.async('string'));
    for (const asset of assetsWritten) assert.ok(body.includes(asset.name));
    assert.equal((await getExportRecord(exportKey(id)))?.status, 'ok');
});

test('PDF Image/File dual-use resource is acquired once, embedded, and delivered as one original file', async t => {
    v2ExportHost(t);
    const id = 'pdf-dual-use';
    await ingestDetail(account.id, id, {
        savedAt: 100, quality: { status: 'complete' },
        assets: [image('both', goodUri)],
        messages: [{ role: 'assistant', content: [
            { type: 'image', assetId: 'both', alt: 'Embedded image' },
            { type: 'file', assetId: 'both', label: 'Original image file' },
        ] }],
    }, { title: 'Dual-use PDF', titleSource: 'provider', updatedAt: 100 });
    const conversation = await readConversation(exportKey(id));
    assert.ok(conversation);
    const document = composeDomainDocument(conversation, account);
    const refs = collectDocumentResources(document);
    assert.deepEqual([...refs.referencedIds], ['both']);
    assert.deepEqual([...refs.imageIds], ['both']);
    assert.deepEqual([...refs.fileIds], ['both']);
    let requests = 0;
    const prepared = await prepareExportResources(conversation.detail.assets, refs.referencedIds,
        async () => { requests++; return { bytes: png, mediaType: 'image/png' }; });
    const [plan] = planExportPaths([{ conversation, prepared, fileIds: refs.fileIds }], 'pdf');
    assert.equal(plan.externalResourceIds.has('both'), true);
    const compiler: IPdfCompiler = { name: 'PDF compiler host probe',
        async compile(payload, context) {
            assert.equal(payload.assetPaths.get('both'), plan.resources.both);
            assert.deepEqual((await context.assets.resolve('both'))?.bytes, png);
            return { pdfBytes: fakePdfBytes(), diagnostics: [] };
        },
    };
    const pdf = await compileDocumentPdf(document, plan.resources, prepared, compiler,
        { signal: new AbortController().signal, reportProgress() {} });
    assert.ok(!pdf.diagnostics.some(diagnostic => diagnostic.code === 'FORMAT_CONTENT_OMITTED'));
    const files = buildExportFiles('pdf', plan, pdf.pdfBytes, prepared);
    assert.equal(files.length, 2);
    assert.equal(files[1].fileName, plan.resources.both);
    assert.deepEqual(files[1].content, png);
    assert.equal(requests, 1);
});

function fakePdfBytes() {
    const bytes = new Uint8Array(100);
    bytes.set(new TextEncoder().encode('%PDF-1.7'));
    return bytes;
}
async function pdfPreparation(id: string, corruptBadImage = false) {
    await seed(id);
    const conversation = await readConversation(exportKey(id));
    assert.ok(conversation);
    const document = composeDomainDocument(conversation, account);
    const refs = collectDocumentResources(document);
    const acquisitions: string[] = [];
    const prepared = await prepareExportResources(conversation.detail.assets, refs.referencedIds, async asset => {
        acquisitions.push(asset.id);
        return { bytes: asset.id === 'good' ? png
            : corruptBadImage ? Uint8Array.of(1, 2, 3)
                : Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10, 1, 2),
            mediaType: 'image/png', name: asset.name };
    });
    const [plan] = planExportPaths([{ conversation, prepared, fileIds: refs.fileIds }], 'pdf');
    return { document, prepared, plan, acquisitions };
}

test('PDF uses the canonical Packaging image path and reports corrupt acquired bytes as Format omission', async t => {
    v2ExportHost(t);
    const { document, prepared, plan, acquisitions } = await pdfPreparation('pdf-image-validation', true);
    assert.equal(prepared.get('bad')?.ok, true, 'acquisition succeeded; the failure belongs to PDF Format');
    let compiles = 0;
    const compiler: IPdfCompiler = { name: 'PDF compiler host probe',
        async compile(payload, context) {
            compiles++;
            assert.deepEqual([...payload.assetPaths.keys()], ['good']);
            assert.equal(payload.assetPaths.get('good'), plan.resources.good);
            assert.deepEqual((await context.assets.resolve('good'))?.bytes, png);
            assert.equal(await context.assets.resolve('bad'), null);
            assert.match(JSON.stringify(payload.document), /missing-image/);
            return { pdfBytes: fakePdfBytes(), diagnostics: [] };
        },
    };
    const pdf = await compileDocumentPdf(document, plan.resources, prepared, compiler,
        { signal: new AbortController().signal, reportProgress() {} });
    assert.equal(compiles, 1);
    assert.deepEqual(acquisitions, ['good', 'bad'], 'Format does not reacquire resources');
    assert.equal(String.fromCharCode(...pdf.pdfBytes.subarray(0, 5)), '%PDF-');
    assert.ok(pdf.diagnostics.some(diagnostic =>
        diagnostic.code === 'FORMAT_CONTENT_OMITTED' && diagnostic.path === 'asset:bad'));
});

test('an unrelated PDF compiler error remains fatal and never becomes a recoverable asset failure', async t => {
    v2ExportHost(t);
    const { document, prepared, plan } = await pdfPreparation('pdf-fatal');
    let calls = 0;
    const compiler: IPdfCompiler = { name: 'PDF compiler host probe',
        async compile() { calls++; throw new Error('Typst document compile error'); },
    };
    await assert.rejects(compileDocumentPdf(document, plan.resources, prepared, compiler,
        { signal: new AbortController().signal, reportProgress() {} }), /Typst document compile error/);
    assert.equal(calls, 1);
});
