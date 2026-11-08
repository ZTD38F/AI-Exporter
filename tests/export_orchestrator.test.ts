/**
 * V2 cross-module Export integration regression suite.
 *
 * The old ExportOrchestrator, AsyncQueue, BatchWorker, ChatFormatter,
 * AssetPipeline, completion sessions and v1 StorageService are gone.
 * Every case below exercises real L2 admission, L3a IndexedDB, Application
 * runExport, L3b composition, and L4 rendering/packaging/delivery as relevant.
 * Only the extension browser/transport/IndexedDB host is simulated.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { DomainAsset } from '../src/l2/conversationDetail.js';
import { ingestDetail, ingestDeletedConversation } from '../src/l2/ingestion.js';
import { readConversation } from '../src/l2/readConversation.js';
import { getIndex, getDetail, getExportRecord, putExportRecord } from '../src/l3a/storageService.js';
import { runExport } from '../src/application/export/runExport.js';
import { __getZipConstructor, __setZipConstructor } from '../src/l4/packaging/writers/zipWriter.js';
import { v2ExportHost, readDeliveredFiles, exportKey, exportRequest, seedExportConversation, seedExportIndexOnly } from './helpers/v2ExportHost.js';

const JSZip = require('../lib/jszip.min.js');
const P = (text: string) => ({ type: 'paragraph' as const, children: [{ type: 'text' as const, text }] });

function realZip(t: { after(fn: () => void): void }) {
    const old = __getZipConstructor();
    __setZipConstructor(JSZip);
    t.after(() => __setZipConstructor(old));
}
async function contents(blob: Blob) {
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const files = Object.values(zip.files) as Array<{
        name: string; dir: boolean; async(type: string): Promise<string | Uint8Array>;
    }>;
    return { zip, files: files.filter(file => !file.dir) };
}
async function deliveredContents(host: {blobs: readonly Blob[]; filenames: readonly string[]}) {
    return {files:await readDeliveredFiles(host)};
}
async function seedAssets(id: string, assets: DomainAsset[], opts: {
    savedAt?: number; updatedAt?: number; quality?: 'complete' | 'partial';
    includeReferences?: boolean;
} = {}) {
    const savedAt = opts.savedAt ?? 100;
    const updatedAt = opts.updatedAt ?? savedAt;
    const includeReferences = opts.includeReferences !== false;
    await ingestDetail(exportKey(id).accountId, id, {
        savedAt, quality: { status: opts.quality ?? 'complete' }, assets,
        messages: [{
            role: 'user', content: [P('Prompt for ' + id)],
        }, {
            role: 'assistant',
            content: [P('Answer for ' + id), ...(includeReferences
                ? assets.filter(asset => asset.kind === 'image')
                    .map(asset => ({ type: 'image' as const, assetId: asset.id }))
                : [])],
            ...(includeReferences && assets.some(asset => asset.kind !== 'image')
                ? { attachmentIds: assets.filter(asset => asset.kind !== 'image').map(asset => asset.id) }
                : {}),
        }],
    }, { title: 'Conversation ' + id, titleSource: 'provider', updatedAt });
}
const source = (id: string, kind: DomainAsset['kind'], url: string,
    extra: Partial<DomainAsset> = {}): DomainAsset => ({
    id, kind, name: id + (kind === 'image' ? '.png' : '.md'),
    mediaType: kind === 'image' ? 'image/png' : 'text/markdown',
    sourceUri: url, ...extra,
});

/** Transport/cookie routing is external; the real GeminiProvider performs acquisition. */
function sourceTransport(t: { after(fn: () => void): void }, entries: Record<string, {
    bytes: Uint8Array; type: string;
}>) {
    const chromeHost = globalThis.chrome;
    const previousTabs = Object.getOwnPropertyDescriptor(globalThis.chrome, 'tabs');
    const oldFetch = globalThis.fetch;
    const requested: string[] = [];
    Object.defineProperty(chromeHost, 'tabs', { configurable: true, value: {
        query: async () => [{ id: 9, url: 'https://gemini.google.com/app/source' }],
        sendMessage: async () => ({ ok: true, accountContext: {
            accountId: exportKey('fixture').accountId, providerId: 'gemini', slot: 'u0',
        } }),
    } });
    globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
        requested.push(url);
        const item = entries[url];
        if (!item) return new Response(null, { status: 404 });
        return new Response(new Uint8Array(item.bytes) as BodyInit, {
            status: 200, headers: { 'content-type': item.type },
        });
    }) as typeof fetch;
    t.after(() => {
        globalThis.fetch = oldFetch;
        if (previousTabs) Object.defineProperty(chromeHost, 'tabs', previousTabs);
        else Reflect.deleteProperty(chromeHost, 'tabs');
    });
    return requested;
}

// Linked documents and attachments share one final browser package.
test('S-2: a missing Detail fails its Key while two native v2 conversations land in one ZIP', async t => {
    const host = v2ExportHost(t); realZip(t);
    await seedExportConversation('accounting-one');
    await seedExportIndexOnly('accounting-missing');
    await seedExportConversation('accounting-two');
    const progress: string[] = [];
    const result = await runExport(exportRequest(['accounting-one', 'accounting-missing', 'accounting-two']), {
        onProgress: ({ key }) => progress.push(key.conversationId),
    });
    assert.deepEqual(progress, ['accounting-one', 'accounting-missing', 'accounting-two']);
    assert.equal(result.exported, 2);
    assert.equal(result.partial, 0);
    assert.equal(result.skipped, 0);
    assert.equal(result.aborted, false);
    assert.deepEqual(result.failed, [exportKey('accounting-missing')]);
    assert.equal(host.clicks(), 1);
    assert.match(host.filenames[0], /\.zip$/);
    const { files } = await contents(host.blobs[0]);
    const bodies = await Promise.all(files.filter(file => file.name.endsWith('.md')).map(file => file.async('string')));
    assert.equal(bodies.length, 2);
    assert.ok(bodies.some(text => String(text).includes('Answer for accounting-one')));
    assert.ok(bodies.some(text => String(text).includes('Answer for accounting-two')));
    assert.equal(await getExportRecord(exportKey('accounting-missing')), null);
    assert.equal((await getExportRecord(exportKey('accounting-one')))?.status, 'ok');
    assert.equal((await getExportRecord(exportKey('accounting-two')))?.status, 'ok');
});

test('S-5: a browser permission rejection fails all staged v2 Keys without a partial commit', async t => {
    const host = v2ExportHost(t, () => { throw new DOMException('Access revoked', 'NotAllowedError'); });
    realZip(t);
    for (const id of ['denied-a', 'denied-b', 'denied-c']) await seedExportConversation(id);
    const result = await runExport(exportRequest(['denied-a', 'denied-b', 'denied-c']));
    assert.equal(host.clicks(), 1);
    assert.equal(result.aborted, false);
    assert.equal(result.exported, 0);
    assert.deepEqual(result.failed, ['denied-a', 'denied-b', 'denied-c'].map(exportKey));
    for (const id of ['denied-a', 'denied-b', 'denied-c']) assert.equal(await getExportRecord(exportKey(id)), null);
});

test('skipUnchanged exports only new Keys while preserving a matching committed Record', async t => {
    const host = v2ExportHost(t);
    await seedExportConversation('cached');
    assert.equal((await runExport(exportRequest(['cached']))).exported, 1);
    const before = await getExportRecord(exportKey('cached'));
    await seedExportConversation('uncached');
    const result = await runExport(exportRequest(['cached', 'uncached'], { skipUnchanged: true }));
    assert.equal(result.skipped, 1);
    assert.equal(result.exported, 1);
    assert.deepEqual(result.failed, []);
    assert.equal(host.clicks(), 2);
    assert.deepEqual(await getExportRecord(exportKey('cached')), before);
    assert.equal((await getExportRecord(exportKey('uncached')))?.status, 'ok');
    assert.match(await host.blobs[1].text(), /Answer for uncached/);
    assert.doesNotMatch(await host.blobs[1].text(), /Answer for cached/);
});

test('skipUnchanged with all v2 Keys up to date performs no acquisition, packaging or download', async t => {
    const host = v2ExportHost(t);
    realZip(t);
    await seedExportConversation('already-a'); await seedExportConversation('already-b');
    const first = await runExport(exportRequest(['already-a', 'already-b']));
    assert.equal(first.exported, 2);
    const events: string[] = [];
    const second = await runExport(exportRequest(['already-a', 'already-b'], { skipUnchanged: true }), {
        onProgress: ({ key }) => events.push(key.conversationId),
    });
    assert.deepEqual(events, ['already-a', 'already-b']);
    assert.equal(second.skipped, 2);
    assert.equal(second.exported, 0);
    assert.deepEqual(second.failed, []);
    assert.equal(host.clicks(), 1);
    assert.equal(host.blobs.length, 1);
});

test('skipUnchanged=false reexports the complete requested batch regardless of prior v2 records', async t => {
    const host = v2ExportHost(t); realZip(t);
    await seedExportConversation('redo-a'); await seedExportConversation('redo-b');
    assert.equal((await runExport(exportRequest(['redo-a', 'redo-b']))).exported, 2);
    const result = await runExport(exportRequest(['redo-a', 'redo-b'], { skipUnchanged: false }));
    assert.equal(result.skipped, 0);
    assert.equal(result.exported, 2);
    assert.equal(host.clicks(), 2);
    for (const id of ['redo-a', 'redo-b']) assert.equal((await getExportRecord(exportKey(id)))?.format, 'markdown');
});

test('partial, wrong-format, or older source records never suppress real v2 exports', async t => {
    const host = v2ExportHost(t); realZip(t);
    for (const id of ['was-partial', 'was-html', 'was-old']) await seedExportConversation(id, 200);
    await putExportRecord(exportKey('was-partial'), { exportedAt: 1, format: 'markdown', status: 'partial', chatTime: 200 });
    await putExportRecord(exportKey('was-html'), { exportedAt: 2, format: 'html', status: 'ok', chatTime: 200 });
    await putExportRecord(exportKey('was-old'), { exportedAt: 3, format: 'markdown', status: 'ok', chatTime: 199 });
    const result = await runExport(exportRequest(['was-partial', 'was-html', 'was-old'], { skipUnchanged: true }));
    assert.equal(result.skipped, 0);
    assert.equal(result.exported, 3);
    assert.equal(host.clicks(), 1);
    for (const id of ['was-partial', 'was-html', 'was-old']) {
        const record = await getExportRecord(exportKey(id));
        assert.equal(record?.status, 'ok');
        assert.equal(record?.format, 'markdown');
        assert.equal(record?.chatTime, 200);
    }
});

test('a missing Detail remains retryable and no fake empty export is recorded', async t => {
    const host = v2ExportHost(t);
    await seedExportIndexOnly('retryable');
    const first = await runExport(exportRequest(['retryable']));
    assert.deepEqual(first.failed, [exportKey('retryable')]);
    assert.equal(first.exported, 0);
    assert.equal(host.clicks(), 0);
    assert.equal(await getExportRecord(exportKey('retryable')), null);
    await seedExportConversation('retryable');
    const second = await runExport(exportRequest(['retryable'], { skipUnchanged: true }));
    assert.equal(second.exported, 1);
    assert.deepEqual(second.failed, []);
    assert.equal(host.clicks(), 1);
    assert.match(await host.blobs[0].text(), /Answer for retryable/);
});

test('confirmed v2 deletion clears Detail, Index and ExportRecord before later export requests', async t => {
    const host = v2ExportHost(t);
    await seedExportConversation('deleted');
    assert.equal((await runExport(exportRequest(['deleted']))).exported, 1);
    assert.ok(await getExportRecord(exportKey('deleted')));
    await ingestDeletedConversation(exportKey('deleted').accountId, 'deleted');
    assert.equal(await getIndex(exportKey('deleted')), null);
    assert.equal(await getDetail(exportKey('deleted')), null);
    assert.equal(await getExportRecord(exportKey('deleted')), null);
    const result = await runExport(exportRequest(['deleted'], { skipUnchanged: true }));
    assert.equal(result.exported, 0);
    assert.deepEqual(result.failed, [exportKey('deleted')]);
    assert.equal(host.clicks(), 1);
});

test('a legitimate empty v2 Detail renders its title, never a fabricated placeholder message', async t => {
    const host = v2ExportHost(t);
    const key = exportKey('empty');
    await ingestDetail(key.accountId, key.conversationId, {
        savedAt: 100, quality: { status: 'complete' }, assets: [], messages: [],
    }, { title: 'Title of empty conversation', titleSource: 'provider', updatedAt: 100 });
    const result = await runExport(exportRequest(['empty']));
    assert.equal(result.exported, 1);
    assert.equal(result.partial, 0);
    const markdown = await host.blobs[0].text();
    assert.match(markdown, /Title of empty conversation/);
    assert.doesNotMatch(markdown, /Answer for empty/);
    assert.equal((await getExportRecord(key))?.status, 'ok');
});

test('ExportRecord chatTime comes from actual Detail.savedAt, not Index.updatedAt or run time', async t => {
    const host = v2ExportHost(t);
    await seedAssets('stale', [], { savedAt: 100, updatedAt: 200 });
    const result = await runExport(exportRequest(['stale']));
    assert.equal(result.exported, 1, 'a failed refresh retains readable local Detail');
    assert.equal(result.partial, 1, 'stale source facts cannot claim a complete export');
    assert.equal(host.clicks(), 1);
    const record = await getExportRecord(exportKey('stale'));
    assert.equal(record?.chatTime, 100);
    assert.equal(record?.status, 'partial');
    assert.equal((await getIndex(exportKey('stale')))?.updatedAt, 200);
});

test('L2 rejects a mutated typed Detail before Storage, leaving the last trusted body exportable', async t => {
    const host = v2ExportHost(t);
    await seedExportConversation('trusted');
    const before = await readConversation(exportKey('trusted'));
    assert.ok(before);
    await assert.rejects(ingestDetail(exportKey('trusted').accountId, 'trusted', {
        savedAt: 100, quality: { status: 'complete' }, assets: [],
        messages: [{ role: 'assistant', content: [P('should not persist')], untrusted: true }],
    } as never), /Domain contract/);
    assert.deepEqual(await readConversation(exportKey('trusted')), before);
    const result = await runExport(exportRequest(['trusted']));
    assert.equal(result.exported, 1);
    assert.match(await host.blobs[0].text(), /Answer for trusted/);
});

test('L4 JSON exports the canonical account-bound v2 Domain without old DTO or session fields', async t => {
    const host = v2ExportHost(t);
    await seedExportConversation('json-native');
    const stored = await readConversation(exportKey('json-native'));
    const result = await runExport(exportRequest(['json-native'], { format: 'json' }));
    assert.equal(result.exported, 1);
    assert.equal(host.clicks(), 1);
    const archive = JSON.parse(await host.blobs[0].text());
    assert.equal(archive.format, 'gemini-exporter-domain');
    assert.equal(archive.version, 1);
    assert.deepEqual(archive.conversation, stored);
    assert.equal(archive.account.id, exportKey('json-native').accountId);
    assert.equal('sourceVersion' in archive, false);
    assert.equal('sessionId' in archive, false);
    assert.equal((await getExportRecord(exportKey('json-native')))?.format, 'json');
});

test('L3b -> L4 HTML formats native v2 content without DOM source scraping', async t => {
    const host = v2ExportHost(t);
    await seedExportConversation('html-native');
    const result = await runExport(exportRequest(['html-native'], { format: 'html' }));
    assert.equal(result.exported, 1);
    assert.equal(host.clicks(), 1);
    const html = await host.blobs[0].text();
    assert.match(html, /Answer for html-native/);
    assert.match(html, /Prompt for html-native/);
    assert.match(html, /<html/i);
    assert.equal((await getExportRecord(exportKey('html-native')))?.format, 'html');
});

test('unreferenced v2 resource metadata never causes an acquisition request or sidecar', async t => {
    const host = v2ExportHost(t);
    const asset = source('unused', 'image', 'https://resources.example.test/unused.png');
    await seedAssets('unreferenced', [asset], { includeReferences: false });
    const result = await runExport(exportRequest(['unreferenced'], { includeAssets: true }));
    assert.equal(result.exported, 1);
    assert.equal(result.partial, 0);
    assert.equal(host.clicks(), 1);
    assert.match(host.filenames[0], /\.md$/);
    assert.equal(host.blobs.length, 1);
    assert.doesNotMatch(await host.blobs[0].text(), /resources\.example\.test/);
});

test('includeAssets=false keeps a referenced image readable without fetching or false partial', async t => {
    const host = v2ExportHost(t);
    const asset = source('ignored-image', 'image', 'https://resources.example.test/ignored.png');
    await seedAssets('no-resources', [asset]);
    const result = await runExport(exportRequest(['no-resources'], { includeAssets: false }));
    assert.equal(result.exported, 1);
    assert.equal(result.partial, 0);
    assert.equal(host.clicks(), 1);
    assert.match(host.filenames[0], /\.md$/);
    assert.match(await host.blobs[0].text(), /Answer for no-resources/);
    assert.equal((await getExportRecord(exportKey('no-resources')))?.status, 'ok');
});

test('an unavailable resource leaves its document intact and delivers a failure report without fabricated image bytes', async t => {
    const host = v2ExportHost(t); realZip(t);
    const asset = source('lost-image', 'image', 'https://resources.example.test/missing.png');
    await seedAssets('resource-fails', [asset]);
    const result = await runExport(exportRequest(['resource-fails'], { includeAssets: true }));
    assert.equal(result.exported, 1);
    assert.equal(result.partial, 1);
    assert.deepEqual(result.failed, []);
    assert.equal(host.clicks(), 1);
    assert.match(host.filenames[0], /\.zip$/);
    const {files} = await deliveredContents(host);
    const markdown = String(await files.find(file => file.name.endsWith('.md'))!.async('string'));
    assert.match(markdown, /Answer for resource-fails/);
    assert.match(markdown, /unavailable|failed|missing/i);
    assert.doesNotMatch(markdown, /!\[[^\]]*\]\(https:/);
    assert.equal(files.filter(file=>file.name.startsWith('assets/')).length,0);
    const report = files.find(file=>file.name.startsWith('attachment-reports/'));
    assert.ok(report);
    assert.match(String(await report.async('string')), /resources\.example\.test\/missing\.png/);
    assert.equal((await getExportRecord(exportKey('resource-fails')))?.status, 'partial');
});

test('real Gemini L1 bytes follow the L4 resource binding while Domain asset identity remains unchanged', async t => {
    const host = v2ExportHost(t); realZip(t);
    const uri = 'https://resources.example.test/snapshot-image.png';
    const raw = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10, 22, 33);
    const calls = sourceTransport(t, { [uri]: { bytes: raw, type: 'image/png' } });
    await seedAssets('with-image', [source('snapshot', 'image', uri)]);
    const before = await readConversation(exportKey('with-image'));
    const result = await runExport(exportRequest(['with-image'], { includeAssets: true }));
    assert.equal(result.exported, 1);
    assert.equal(result.partial, 0);
    assert.deepEqual(calls, [uri]);
    assert.equal(host.clicks(), 1);
    assert.match(host.filenames[0], /\.zip$/);
    const { files } = await deliveredContents(host);
    const image = files.find(file => file.name.startsWith('assets/') && file.name.endsWith('.png'));
    assert.ok(image, 'planned asset path is present in the actual ZIP');
    assert.deepEqual(await image.async('uint8array'), raw);
    const markdown = files.find(file => file.name.endsWith('.md'));
    assert.ok(markdown);
    assert.match(String(await markdown.async('string')), /assets\//);
    assert.deepEqual(await readConversation(exportKey('with-image')), before);
    assert.equal((await getExportRecord(exportKey('with-image')))?.status, 'ok');
});

test('native file attachment is written as original L1 bytes under its planned files/ path', async t => {
    const host = v2ExportHost(t); realZip(t);
    const uri = 'https://resources.example.test/source.md';
    const bytes = new TextEncoder().encode('# original attachment source\nAnd some content');
    sourceTransport(t, { [uri]: { bytes, type: 'text/markdown' } });
    await seedAssets('with-document', [source('notes', 'file', uri, {
        document: { contentMarkdown: '# parsed document text' },
    })]);
    const result = await runExport(exportRequest(['with-document'], { includeAssets: true }));
    assert.equal(result.exported, 1);
    assert.equal(result.partial, 0);
    const { files } = await deliveredContents(host);
    const attachment = files.find(file => file.name.startsWith('files/') && file.name.endsWith('notes.md'));
    assert.ok(attachment);
    assert.deepEqual(await attachment.async('uint8array'), bytes);
    const main = files.find(file => !file.name.startsWith('files/') && file.name.endsWith('.md'));
    assert.ok(main);
    assert.match(String(await main.async('string')), /files\//);
    assert.equal((await getExportRecord(exportKey('with-document')))?.status, 'ok');
});

test('a captured document without a remote locator exports its semantic source as UTF-8', async t => {
    const host = v2ExportHost(t); realZip(t);
    const markdown = '# Captured source\n中文 and exact document content';
    const calls = sourceTransport(t, {});
    await seedAssets('captured-document', [source('notes', 'file', 'rc_captured', {
        document: { contentMarkdown: markdown },
    })]);
    const result = await runExport(exportRequest(['captured-document'], { includeAssets: true }));
    assert.equal(result.exported, 1);
    assert.equal(result.partial, 0);
    assert.deepEqual(calls, []);
    const { files } = await deliveredContents(host);
    const attachment = files.find(file => file.name.startsWith('files/') && file.name.endsWith('notes.md'));
    assert.ok(attachment);
    assert.equal(await attachment.async('string'), markdown);
});

test('two v2 conversations with identical asset IDs never share bytes or packaging paths', async t => {
    const host = v2ExportHost(t); realZip(t);
    const firstUri = 'https://resources.example.test/a.png';
    const secondUri = 'https://resources.example.test/b.png';
    const a = Uint8Array.of(1, 2, 3);
    const b = Uint8Array.of(4, 5, 6, 7);
    const calls = sourceTransport(t, { [firstUri]: { bytes: a, type: 'image/png' },
        [secondUri]: { bytes: b, type: 'image/png' } });
    await seedAssets('owner-a', [source('shared', 'image', firstUri)]);
    await seedAssets('owner-b', [source('shared', 'image', secondUri)]);
    const result = await runExport(exportRequest(['owner-a', 'owner-b'], { includeAssets: true }));
    assert.equal(result.exported, 2);
    assert.equal(result.partial, 0);
    assert.deepEqual(calls, [firstUri, secondUri]);
    assert.equal(host.clicks(), 1);
    const { files } = await deliveredContents(host);
    const images = files.filter(file => file.name.startsWith('assets/') && file.name.endsWith('.png'));
    assert.equal(images.length, 2);
    assert.notEqual(images[0].name, images[1].name);
    const bodies = await Promise.all(images.map(file => file.async('uint8array')));
    assert.ok(bodies.some(bytes => Buffer.from(bytes as Uint8Array).equals(Buffer.from(a))));
    assert.ok(bodies.some(bytes => Buffer.from(bytes as Uint8Array).equals(Buffer.from(b))));
    assert.equal((await getExportRecord(exportKey('owner-a')))?.status, 'ok');
    assert.equal((await getExportRecord(exportKey('owner-b')))?.status, 'ok');
});

test('resource failure makes only the affected v2 conversation partial, not its healthy batch peer', async t => {
    const host = v2ExportHost(t); realZip(t);
    const good = 'https://resources.example.test/good.png';
    const bad = 'https://resources.example.test/bad.png';
    sourceTransport(t, { [good]: { bytes: Uint8Array.of(10, 11), type: 'image/png' } });
    await seedAssets('one-good', [source('good', 'image', good)]);
    await seedAssets('one-bad', [source('bad', 'image', bad)]);
    const result = await runExport(exportRequest(['one-good', 'one-bad'], { includeAssets: true }));
    assert.equal(result.exported, 2);
    assert.equal(result.partial, 1);
    assert.deepEqual(result.failed, []);
    assert.equal(host.clicks(), 1);
    assert.equal((await getExportRecord(exportKey('one-good')))?.status, 'ok');
    assert.equal((await getExportRecord(exportKey('one-bad')))?.status, 'partial');
    const { files } = await deliveredContents(host);
    assert.equal(files.filter(file => file.name.startsWith('assets/')).length, 1);
    assert.equal(files.filter(file => file.name.endsWith('.md')).length, 2);
});

test('L4 ZIP generation failure after staging delivers nothing and cannot commit any records', async t => {
    const host = v2ExportHost(t);
    const prior = __getZipConstructor();
    __setZipConstructor(class {
        file() {}
        async generateAsync(): Promise<never> { throw new Error('Broken ZIP generator'); }
    });
    t.after(() => __setZipConstructor(prior));
    await seedExportConversation('zip-one');
    await seedExportConversation('zip-two');
    const result = await runExport(exportRequest(['zip-one', 'zip-two']));
    assert.equal(result.exported, 0);
    assert.deepEqual(result.failed, [exportKey('zip-one'), exportKey('zip-two')]);
    assert.equal(host.clicks(), 0);
    assert.equal(host.blobs.length, 0);
    assert.equal(await getExportRecord(exportKey('zip-one')), null);
    assert.equal(await getExportRecord(exportKey('zip-two')), null);
});

test('a failed post-delivery v2 ExportRecord write is reported, never counted or downloaded twice', async t => {
    const host = v2ExportHost(t); realZip(t);
    await seedExportConversation('record-a');
    await seedExportConversation('record-b');
    host.failStorage('exportRecords');
    const result = await runExport(exportRequest(['record-a', 'record-b']));
    assert.equal(host.clicks(), 1, 'delivery is complete, and records never trigger a second ZIP');
    assert.equal(result.exported, 0);
    assert.deepEqual(result.failed, [exportKey('record-a'), exportKey('record-b')]);
    assert.equal(await getExportRecord(exportKey('record-a')), null);
    assert.equal(await getExportRecord(exportKey('record-b')), null);
    const { files } = await contents(host.blobs[0]);
    assert.equal(files.filter(file => file.name.endsWith('.md')).length, 2);
    host.failStorage();
});

test('the same v2 Domain can be exported as Markdown, JSON and HTML without reinterpreting its facts', async t => {
    const host = v2ExportHost(t);
    await seedExportConversation('source-preserved');
    const before = await readConversation(exportKey('source-preserved'));
    assert.ok(before);
    for (const format of ['markdown', 'json', 'html'] as const) {
        const result = await runExport(exportRequest(['source-preserved'], { format }));
        assert.equal(result.exported, 1);
        assert.deepEqual(result.failed, []);
        assert.deepEqual(await readConversation(exportKey('source-preserved')), before);
        assert.equal((await getExportRecord(exportKey('source-preserved')))?.format, format);
    }
    assert.equal(host.clicks(), 3);
    assert.match(await host.blobs[0].text(), /Answer for source-preserved/);
    const archive = JSON.parse(await host.blobs[1].text());
    assert.deepEqual(archive.conversation, before);
    assert.match(await host.blobs[2].text(), /Answer for source-preserved/);
});

test('404 and retryable attachment failures deliver text, persist reasons and never count as failed conversations', async t => {
    const host = v2ExportHost(t); realZip(t);
    sourceTransport(t, {});
    globalThis.fetch = async input => new Response('', {status:String(input).includes('expired') ? 404 : 503});
    await seedAssets('expired-only', [source('expired', 'image', 'https://example.test/expired')]);
    await seedAssets('mixed-resources', [source('expired', 'image', 'https://example.test/expired'), source('retry', 'image', 'https://example.test/retry')]);
    const result = await runExport(exportRequest(['expired-only','mixed-resources'], {includeAssets:true}));
    assert.equal(result.exported, 2);
    assert.equal(result.partial, 2);
    assert.equal(result.expiredConversations, 2);
    assert.equal(result.otherPartial, 0);
    assert.deepEqual(result.failed, []);
    assert.equal(result.attachmentIssues?.length, 3);
    const record = await getExportRecord(exportKey('mixed-resources'));
    assert.deepEqual(record?.attachmentIssues?.map(issue => issue.httpStatus), [404,503]);
    assert.equal(record?.attachmentIssues?.[0].sourceUrl, 'https://example.test/expired');
    const {files} = await deliveredContents(host);
    for (const file of files.filter(file => file.name.endsWith('.md'))) {
        const body = await file.async('string') as string;
        assert.match(body, /HTTP 404/);
        assert.match(body, /Answer for/);
    }
    const reports = files.filter(file=>file.name.startsWith('attachment-reports/'));
    assert.equal(reports.length,2);
    const issues = (await Promise.all(reports.map(async file=>JSON.parse(String(await file.async('string'))).failures))).flat();
    assert.deepEqual(issues.map(issue=>issue.httpStatus).sort(),[404,404,503]);
});
