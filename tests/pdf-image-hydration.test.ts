import test from 'node:test';
import assert from 'node:assert/strict';
import { fixtureAccountFor, fixtureKey } from './helpers/domainFixture.js';
import { prepareReadingResourcesFixture } from './helpers/pdfAcquisitionFixture.js';
import { buildMinimalValidPdf } from './helpers/stubPdfCompiler.js';
import { resourceValue } from './helpers/resources.js';
import { RealWasmSandboxHost, repoRoot } from './helpers/realWasmSandbox.js';
import { extractPdfText } from './helpers/pdfTextExtract.js';
import { validateParserDomain } from '../src/l2/runtimeValidation.js';
import type { DomainAsset } from '../src/l2/conversationDetail.js';
import type { BlockNode } from '../src/l2/content/blocks.js';
import type { SourceConversationParseResult } from '../src/l1/parsers/parsingResult.js';
import { createSourceResourceContext } from '../src/l1/resources/sourceResources.js';
import { collectDocumentResources } from '../src/l3b/ast/resourceReferences.js';
import { createExportPathPlanner, buildExportFiles } from '../src/l4/packaging/index.js';
import { compileDocumentPdf } from '../src/l4/format/pdf/compileDocumentPdf.js';
import type { IPdfCompiler } from '../src/l4/format/pdf/pdfCompiler.js';
import { TypstSandboxCompiler } from '../src/l4/format/pdf/typst/typstSandboxCompiler.js';

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_BYTES = new Uint8Array(Buffer.from(PNG_B64, 'base64'));
const paragraph = (text: string): BlockNode => ({ type: 'paragraph', children: [{ type: 'text', text }] });
const context = (signal = new AbortController().signal) => ({ signal, reportProgress() {} });

function imageDomain(id = 'image-chat', images: DomainAsset[] = [
    { id: 'image-1', kind: 'image', name: 'cat.png', mediaType: 'image/png',
        sourceUri: 'https://example.test/cat.png' },
], blocks: BlockNode[] = [paragraph('An image follows.'), { type: 'image', assetId: 'image-1' }]) {
    const key = fixtureKey(id);
    return validateParserDomain({
        index: { key, title: 'Image hydration', titleSource: 'provider' },
        detail: { key, quality: { status: 'complete' }, assets: images,
            messages: [{ role: 'assistant', content: blocks }] },
    });
}

test('v2 PDF hydrates the remote image by Asset ID and mounts the exact bytes without an external image file', async () => {
    const domain = imageDomain();
    const source = structuredClone(domain);
    const calls: string[] = [];
    const { document, references, resources } = await prepareReadingResourcesFixture(domain, {
        acquire: async asset => {
            calls.push(asset.id);
            assert.equal(asset.sourceUri, 'https://example.test/cat.png');
            return { bytes: PNG_BYTES, mediaType: 'image/png' };
        },
    });
    assert.deepEqual(calls, ['image-1']);
    assert.deepEqual([...references.imageIds], ['image-1']);
    assert.deepEqual(resourceValue(resources.get('image-1')).bytes, PNG_BYTES);
    assert.deepEqual(domain, source, 'resource acquisition cannot mutate trusted L2 facts');

    const plan = createExportPathPlanner('pdf')(domain, resources, references.fileIds);
    assert.match(plan.resources['image-1'], /^assets\//);
    assert.deepEqual([...plan.externalResourceIds], [], 'PDF embeds images without an assets/ sidecar');
    let compiled = 0;
    const compiler: IPdfCompiler = { name: 'capture-image', async compile(payload, ctx) {
        compiled++;
        assert.deepEqual([...payload.assetPaths], [['image-1', plan.resources['image-1']]]);
        assert.deepEqual(await ctx.assets.resolve('image-1'), { bytes: PNG_BYTES });
        assert.equal(payload.document.messages[0].blocks.filter(b => b.type === 'image').length, 1);
        assert.equal(payload.document.messages[0].blocks.some(b => b.type === 'unknown' && b.sourceType === 'missing-image'), false);
        return { pdfBytes: buildMinimalValidPdf(), diagnostics: [] };
    } };
    const result = await compileDocumentPdf(document, plan.resources, resources, compiler, context());
    assert.equal(compiled, 1);
    assert.equal(result.diagnostics.some(d => d.code === 'TYPST_V8_IMAGE_MISSING'), false);
    const files = buildExportFiles('pdf', plan, result.pdfBytes, resources);
    assert.equal(files.length, 1);
    assert.match(files[0].fileName, /\.pdf$/);
});

test('inline Markdown-style images and separate source attachments retain distinct v2 Asset identities', async () => {
    const assets: DomainAsset[] = [
        { id: 'inline', kind: 'image', name: 'same.png', mediaType: 'image/png',
            sourceUri: 'https://example.test/inline' },
        { id: 'attached', kind: 'image', name: 'same.png', mediaType: 'image/png',
            sourceUri: 'https://example.test/attached' },
    ];
    const domain = imageDomain('inline-plus-attachment', assets, [
        { type: 'paragraph', children: [{ type: 'text', text: 'Remote inline: ' },
            { type: 'image', assetId: 'inline', alt: 'inline' }] },
        { type: 'image', assetId: 'attached', alt: 'attachment' },
    ]);
    const seen: string[] = [];
    const { document, resources, references } = await prepareReadingResourcesFixture(domain, {
        acquire: async asset => { seen.push(asset.id); return { bytes: PNG_BYTES }; },
    });
    assert.deepEqual(seen, ['inline', 'attached']);
    assert.deepEqual([...references.imageIds], seen);
    const plan = createExportPathPlanner('pdf')(domain, resources, references.fileIds);
    assert.notEqual(plan.resources.inline, plan.resources.attached, 'same source names cannot collide');

    const compiler: IPdfCompiler = { name: 'capture-mixed-images', async compile(payload, ctx) {
        const blocks = payload.document.messages[0].blocks;
        const inline = blocks.flatMap(block => block.type === 'paragraph' ? block.children : [])
            .filter(node => node.type === 'image');
        assert.equal(inline.length, 1);
        assert.equal(blocks.filter(block => block.type === 'image').length, 1);
        assert.deepEqual([...payload.assetPaths.keys()], ['inline', 'attached']);
        assert.deepEqual(await ctx.assets.resolve('inline'), { bytes: PNG_BYTES });
        assert.deepEqual(await ctx.assets.resolve('attached'), { bytes: PNG_BYTES });
        return { pdfBytes: buildMinimalValidPdf(), diagnostics: [] };
    } };
    const compiled = await compileDocumentPdf(document, plan.resources, resources, compiler, context());
    assert.ok(compiled.pdfBytes.length > 64);
    assert.equal(buildExportFiles('pdf', plan, compiled.pdfBytes, resources).length, 1);
});

test('task-owned Takeout/source bytes rescue a failed remote image fetch without entering Domain or AST', async () => {
    const domain = imageDomain('takeout-image');
    const asset = domain.detail.assets[0];
    const { key: _key, ...detail } = domain.detail;
    const parsed: SourceConversationParseResult = {
        conversationId: domain.index.key.conversationId,
        conversation: { index: {}, detail },
        diagnostics: [], acquisitionHints: { [asset.id]: { dataBase64: PNG_B64 } },
    };
    const domainJson = JSON.stringify(domain);
    const resources = createSourceResourceContext();
    let remoteCalls = 0;
    try {
        resources.retainParsed(domain.index.key, parsed);
        const prepared = await prepareReadingResourcesFixture(domain, {
            acquire: item => resources.acquire(domain.index.key, item, undefined, async () => {
                remoteCalls++;
                throw new Error('HTTP 403 expired source URL');
            }),
        });
        assert.equal(remoteCalls, 0, 'task source bytes should precede remote fallback');
        assert.deepEqual(resourceValue(prepared.resources.get(asset.id)).bytes, PNG_BYTES);
        assert.equal(JSON.stringify(domain), domainJson);
        assert.ok(!JSON.stringify(prepared.document).includes(PNG_B64));

        const plan = createExportPathPlanner('pdf')(domain, prepared.resources, prepared.references.fileIds);
        const compiler: IPdfCompiler = { name: 'takeout-source', async compile(payload, ctx) {
            assert.deepEqual([...payload.assetPaths.keys()], [asset.id]);
            assert.deepEqual(await ctx.assets.resolve(asset.id), { bytes: PNG_BYTES });
            return { pdfBytes: buildMinimalValidPdf(), diagnostics: [] };
        } };
        await compileDocumentPdf(prepared.document, plan.resources, prepared.resources, compiler, context());
    } finally { resources.release(); }
    await assert.rejects(resources.acquire(domain.index.key, asset), /released/);
});

test('failed acquisition remains a structured failure and PDF renders a readable missing-image placeholder', async () => {
    const domain = imageDomain('missing-image');
    const { document, resources } = await prepareReadingResourcesFixture(domain, {
        acquire: async () => { throw new Error('HTTP 404 Not Found'); },
    });
    const missing = resources.get('image-1');
    assert.equal(missing?.ok, false);
    if (missing && !missing.ok) {
        assert.equal(missing.code, 'RESOURCE_UNAVAILABLE');
        assert.match(missing.reason, /HTTP 404/);
    }
    const compiler: IPdfCompiler = { name: 'missing-image-stub', async compile(payload) {
        assert.equal([...payload.assetPaths].length, 0);
        assert.equal(payload.document.messages[0].blocks.some(block =>
            block.type === 'unknown' && block.sourceType === 'missing-image'), true);
        return { pdfBytes: buildMinimalValidPdf(), diagnostics: [] };
    } };
    const compiled = await compileDocumentPdf(document, {}, resources, compiler, context());
    assert.ok(compiled.diagnostics.some(d => d.code === 'TYPST_V8_IMAGE_MISSING'
        && d.severity === 'warning'));
    assert.equal(String.fromCharCode(...compiled.pdfBytes.subarray(0, 5)), '%PDF-');
});

test('acquisition abort stops v2 PDF preparation before compilation and does not convert abort into partial', async () => {
    const domain = imageDomain('cancel-image');
    const controller = new AbortController();
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    let compiled = 0;
    const compiler: IPdfCompiler = { name: 'must-not-compile', async compile() {
        compiled++;
        return { pdfBytes: buildMinimalValidPdf(), diagnostics: [] };
    } };
    const pending = (async () => {
        const { document, references, resources } = await prepareReadingResourcesFixture(domain, {
            signal: controller.signal,
            acquire: async (_asset, signal) => {
                entered();
                return new Promise((_resolve, reject) => {
                    signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
                });
            },
        });
        const plan = createExportPathPlanner('pdf')(domain, resources, references.fileIds);
        await compileDocumentPdf(document, plan.resources, resources, compiler, context(controller.signal));
    })();
    await started;
    controller.abort(new DOMException('cancelled', 'AbortError'));
    await assert.rejects(pending, /cancelled/);
    assert.equal(compiled, 0);
});

test('includeAssets=false leaves referenced image placeholders and does not fetch bytes', async () => {
    const domain = imageDomain('no-images');
    const { document, references, resources } = await prepareReadingResourcesFixture(domain, {
        includeAssets: false,
        acquire: async () => assert.fail('includeAssets=false must not acquire a resource'),
    });
    assert.deepEqual([...references.imageIds], ['image-1']);
    assert.equal(resources.size, 0);
    assert.equal(collectDocumentResources(document).referencedIds.size, 1);
    const compiler: IPdfCompiler = { name: 'image-placeholder', async compile(payload) {
        assert.equal(payload.document.messages[0].blocks.some(block =>
            block.type === 'unknown' && block.sourceType === 'missing-image'), true);
        return { pdfBytes: buildMinimalValidPdf(), diagnostics: [] };
    } };
    const result = await compileDocumentPdf(document, {}, resources, compiler, context());
    assert.ok(result.pdfBytes.length > 64);
});

test('real Typst WASM embeds one acquired PNG into the PDF instead of a missing-image marker', async () => {
    const domain = imageDomain('real-image-pdf');
    const { document, references, resources } = await prepareReadingResourcesFixture(domain, {
        acquire: async () => ({ bytes: PNG_BYTES, mediaType: 'image/png' }),
    });
    const plan = createExportPathPlanner('pdf')(domain, resources, references.fileIds);
    const compiler = new TypstSandboxCompiler({ host: new RealWasmSandboxHost(repoRoot()) });
    try {
        const compiled = await compileDocumentPdf(document, plan.resources, resources, compiler, context());
        const physical = extractPdfText(compiled.pdfBytes);
        assert.equal(physical.imageXObjectCount, 1);
        assert.ok(!physical.text.includes('missing-image'));
    } finally { compiler.dispose(); }
});
