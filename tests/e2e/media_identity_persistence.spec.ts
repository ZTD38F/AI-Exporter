/**
 * V2 media: L1 native Takeout/online -> L2 admission -> L3a durable Domain ->
 * L3b Document -> Application resource acquisition -> L4 Markdown/HTML/PDF.
 * Bytes live in an export task's SourceResourceContext, never an IDB media cache.
 */
import { test, expect, seedRegistryAccounts } from './fixtures';
import { openOptions, accountId } from './uiFixture';
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import * as path from 'node:path';

let bundle: string;
test.beforeAll(async () => {
    const modules = [
        "import { mediaSources, mediaBytes } from './tests/helpers/mediaSourceFixture.ts';",
        "import { importTakeout } from './src/l1/imports/takeout/importTakeout.ts';",
        "import { createSourceResourceContext } from './src/l1/resources/sourceResources.ts';",
        "import { ingestDetail } from './src/l2/ingestion.ts';",
        "import { readConversation } from './src/l2/readConversation.ts';",
        "import { getDetail, getIndex } from './src/l3a/storageService.ts';",
        "import { composeDomainDocument } from './src/l3b/compose/composeDomainDocument.ts';",
        "import { collectDocumentResources } from './src/l3b/ast/resourceReferences.ts';",
        "import { prepareExportResources } from './src/application/export/prepareExportResources.ts';",
        "import { planExportPaths, buildExportFiles } from './src/l4/packaging/index.ts';",
        "import { renderDocumentMarkdown } from './src/l4/format/markdown/renderMarkdown.ts';",
        "import { renderDocumentHtml } from './src/l4/format/html/renderHtml.ts';",
        "import { compileDocumentPdf } from './src/l4/format/pdf/compileDocumentPdf.ts';",
        "import { TypstSandboxCompiler } from './src/l4/format/pdf/typst/typstSandboxCompiler.ts';",
        'globalThis.mediaProbeV2 = { mediaSources, mediaBytes, importTakeout, createSourceResourceContext, ingestDetail, readConversation, getDetail, getIndex, composeDomainDocument, collectDocumentResources, prepareExportResources, planExportPaths, buildExportFiles, renderDocumentMarkdown, renderDocumentHtml, compileDocumentPdf, TypstSandboxCompiler };',
    ];
    const built = await build({ stdin: {
        resolveDir: path.resolve(__dirname, '../..'), loader: 'ts', contents: modules.join('\n'),
    }, bundle: true, write: false, format: 'iife', platform: 'browser', conditions: ['worker', 'browser'] });
    bundle = built.outputFiles[0].text;
});
test.beforeEach(async ({ context }) => { await seedRegistryAccounts(context); });
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

for (const order of ['online-first', 'takeout-first'] as const) {
    test('v2 ' + order + ': a complete native snapshot owns task bytes for MD, HTML and PDF without persistent media cache',
    async ({ context, extensionId }) => {
        test.setTimeout(120000);
        const page = await openOptions(context, extensionId);
        await page.evaluate(bundle);
        const output = await page.evaluate(async ({ accountId, order }) => {
            const api = Reflect.get(globalThis, 'mediaProbeV2');
            const { online } = api.mediaSources();
            const id: string = online.conversationId;
            const key = { accountId, conversationId: id };
            const png: Uint8Array = api.mediaBytes;
            const image = online.conversation.detail.assets.find((asset: {kind:string}) => asset.kind === 'image');
            if (!image) throw new Error('L1 Gemini parser did not preserve image facts');
            const source = { ...online, acquisitionHints: {
                ...online.acquisitionHints,
                [image.id]: { dataBase64: btoa(String.fromCharCode(...png)) },
            } };
            const resources = api.createSourceResourceContext();
            const priorFetch = globalThis.fetch;
            let networkRequests = 0;
            globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
                const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
                if (/^https?:\/\//.test(url)) {
                    networkRequests++;
                    throw new Error('Unexpected remote media request');
                }
                return priorFetch(input, init);
            }) as typeof fetch;
            const activity = '<div class="outer-cell"><a href="https://gemini.google.com/app/c_' + id +
                '">Chat</a><div class="content-cell mdl-cell mdl-cell--6-col mdl-typography--body-1">' +
                'Prompted Draw a diagram of a green bridge<br>2026-09-02T12:00:00Z<br>' +
                '<p>Takeout image <img src="archive-0.png"></p></div>1 generated image</div>';
            const archive = { file() {}, files: {
                'Takeout/Gemini Apps/MyActivity.html': {
                    _data: { uncompressedSize: activity.length }, async: async () => activity,
                },
                'Takeout/Gemini Apps/archive-0.png': {
                    _data: { uncompressedSize: png.length }, async: async () => png.slice(),
                },
            } };
            const onlineAdmission = async () => {
                const result = await api.ingestDetail(accountId, id, source.conversation.detail, source.conversation.index);
                if (result.accepted) resources.retainParsed(key, source);
            };
            try {
                if (order === 'online-first') await onlineAdmission();
                const takeout = await api.importTakeout(archive, accountId, undefined, resources);
                if (order === 'takeout-first') await onlineAdmission();
                const conversation = await api.readConversation(key);
                if (!conversation) throw new Error('No selected v2 Domain conversation');
                const account = { id: accountId, providerId: 'gemini', providerAccountId: '10000000001' };
                const document = api.composeDomainDocument(conversation, account);
                const needed = api.collectDocumentResources(document);
                const prepared = await api.prepareExportResources(conversation.detail.assets, needed.referencedIds,
                    (asset: unknown, signal?: AbortSignal) => resources.acquire(key, asset, signal));
                const current = prepared.get(image.id);
                if (!current?.ok) throw new Error('Selected media source bytes are missing');
                const input = [{ conversation, prepared, fileIds: needed.fileIds }];
                const [mdPlan] = api.planExportPaths(input, 'markdown');
                const [htmlPlan] = api.planExportPaths(input, 'html');
                const [pdfPlan] = api.planExportPaths(input, 'pdf');
                const markdown: string = api.renderDocumentMarkdown(document, mdPlan.resources);
                const html: string = api.renderDocumentHtml(document, htmlPlan.resources).html;
                const binary = (files: Array<{fileName:string;content:string|Uint8Array}>) =>
                    files.filter(file => file.fileName.startsWith('assets/')).map(file => ({
                        path: file.fileName, bytes: [...(file.content as Uint8Array)],
                    }));
                const mdFiles = binary(api.buildExportFiles('markdown', mdPlan, markdown, prepared));
                const htmlFiles = binary(api.buildExportFiles('html', htmlPlan, html, prepared));
                const compiler = new api.TypstSandboxCompiler();
                let pdf: {pdfBytes:Uint8Array};
                try {
                    pdf = await api.compileDocumentPdf(document, pdfPlan.resources, prepared, compiler,
                        { signal: new AbortController().signal, reportProgress() {} });
                } finally { compiler.dispose(); }
                const db = await new Promise<IDBDatabase>((resolve, reject) => {
                    const request = indexedDB.open('gemini_exporter_v2');
                    request.onsuccess = () => resolve(request.result);
                    request.onerror = () => reject(request.error);
                });
                const stores = [...db.objectStoreNames];
                db.close();
                const detail = await api.getDetail(key);
                resources.release();
                let released = false;
                try { await resources.acquire(key, image); } catch (error) {
                    released = /Resource context released/.test(String(error));
                }
                return {
                    id, takeout, status: conversation.detail.quality.status,
                    messageCount: conversation.detail.messages.length,
                    indexSaved: !!await api.getIndex(key), detail: JSON.stringify(detail),
                    original: [...png], acquired: [...current.value.bytes], md: markdown, html,
                    mdFiles, htmlFiles, pdfMagic: String.fromCharCode(...pdf.pdfBytes.subarray(0, 5)),
                    pdfLength: pdf.pdfBytes.length, stores, released, networkRequests,
                };
            } finally {
                resources.release();
                globalThis.fetch = priorFetch;
            }
        }, { accountId, order });
        expect(output.id).toBe('source-media');
        expect(output.takeout).toMatchObject({ imported: 1, status: 'partial' });
        expect(output.status).toBe('complete');
        expect(output.messageCount).toBeGreaterThan(0);
        expect(output.indexSaved).toBe(true);
        expect(output.detail).not.toContain('dataBase64');
        expect(output.stores).toContain('details');
        expect(output.stores).not.toContain('resource_bytes');
        expect(output.networkRequests).toBe(0);
        expect(output.released).toBe(true);
        expect(output.mdFiles).toHaveLength(1);
        expect(output.htmlFiles).toHaveLength(1);
        const original = Uint8Array.from(output.original);
        expect(sha256(Uint8Array.from(output.acquired))).toBe(sha256(original));
        expect(sha256(Uint8Array.from(output.mdFiles[0].bytes))).toBe(sha256(original));
        expect(sha256(Uint8Array.from(output.htmlFiles[0].bytes))).toBe(sha256(original));
        expect(output.md).toContain(output.mdFiles[0].path);
        expect(output.html).toContain(output.htmlFiles[0].path);
        expect(output.pdfMagic).toBe('%PDF-');
        expect(output.pdfLength).toBeGreaterThan(1000);

        await page.reload();
        await page.evaluate(bundle);
        const stored = await page.evaluate(async ({ accountId, id }) => {
            const api = Reflect.get(globalThis, 'mediaProbeV2');
            const detail = await api.getDetail({ accountId, conversationId: id });
            return { present: !!detail, status: detail?.quality.status, serialized: JSON.stringify(detail) };
        }, { accountId, id: output.id });
        expect(stored.present).toBe(true);
        expect(stored.status).toBe('complete');
        expect(stored.serialized).not.toContain('dataBase64');
    });
}

test('v2 source readers are scoped by Account UUID and invalidated on task replacement and release', async ({ context, extensionId }) => {
    const page = await openOptions(context, extensionId);
    await page.evaluate(bundle);
    const result = await page.evaluate(async accountId => {
        const api = Reflect.get(globalThis, 'mediaProbeV2');
        const other = '10000000-0000-4000-8000-000000000002', id = 'cross-account-media';
        const asset = { id: 'shared-image', kind: 'image', mediaType: 'image/png' };
        const detail = { quality: { status: 'complete' }, assets: [asset],
            messages: [{ role: 'assistant', content: [{ type: 'image', assetId: asset.id }] }] };
        await api.ingestDetail(accountId, id, detail, { title: 'A', titleSource: 'provider' });
        await api.ingestDetail(other, id, detail, { title: 'B', titleSource: 'provider' });
        const a = { accountId, conversationId: id }, b = { accountId: other, conversationId: id };
        const resources = api.createSourceResourceContext();
        resources.retain(a, asset.id, async () => ({ bytes: Uint8Array.of(1, 2, 3) }));
        resources.retain(b, asset.id, async () => ({ bytes: Uint8Array.of(9, 8, 7) }));
        const initialA = [...(await resources.acquire(a, asset)).bytes];
        const initialB = [...(await resources.acquire(b, asset)).bytes];
        resources.retainParsed(a, { conversationId: id, acquisitionHints: {},
            conversation: { index: {}, detail } });
        let staleRejected = false;
        try { await resources.acquire(a, asset); } catch (error) {
            staleRejected = /No supported source locator/.test(String(error));
        }
        const stillB = [...(await resources.acquire(b, asset)).bytes];
        resources.releaseConversation(b);
        let releasedB = false;
        try { await resources.acquire(b, asset); } catch (error) {
            releasedB = /No supported source locator/.test(String(error));
        }
        resources.release();
        let closed = false;
        try { await resources.acquire(a, asset); } catch (error) {
            closed = /Resource context released/.test(String(error));
        }
        return { initialA, initialB, stillB, staleRejected, releasedB, closed,
            titleA: (await api.readConversation(a))?.index.title,
            titleB: (await api.readConversation(b))?.index.title };
    }, accountId);
    expect(result).toEqual({
        initialA: [1, 2, 3], initialB: [9, 8, 7], stillB: [9, 8, 7],
        staleRejected: true, releasedB: true, closed: true, titleA: 'A', titleB: 'B',
    });
});
