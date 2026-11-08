/**
 * Retained cross-module regression behaviors on real v2 implementations:
 * L2 Detail/Index -> L3a -> Application -> L3b -> L4 -> Delivery/ExportRecord.
 * Legacy ExportEngine queues, AssetPipeline and source-text implementation locks
 * are not v2 interfaces. Only browser/network/IndexedDB host surfaces are faked.
 */
import { readDeliveredFiles } from './helpers/v2ExportHost.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { useIndexStorage } from './helpers/indexStorage.js';
import { fixtureAccount } from './helpers/domainFixture.js';
import { ingestDetail } from '../src/l2/ingestion.js';
import { getExportRecord, listExportRecords, putExportRecord, putAccount } from '../src/l3a/storageService.js';
import { updateSettings } from '../src/application/settings/index.js';
import { runExport } from '../src/application/export/runExport.js';
import type { ExportRequest } from '../src/application/export/types.js';
import { assertExportPath } from '../src/l4/packaging/exportPath.js';
import { sanitizeRelativePath } from '../src/shared/utils/pathUtils.js';
import { writeToFolder } from '../src/l4/delivery/index.js';
import { resolveAccountTab } from '../src/runtime/capabilities/tabService.js';
import { __setZipConstructor, __getZipConstructor } from '../src/l4/packaging/writers/zipWriter.js';

useIndexStorage();
const account = fixtureAccount('gemini');
test.beforeEach(async () => {
    await putAccount(account);
    await putAccount({ id: '10000000-0000-4000-8000-000000000002', providerId: 'gemini', providerAccountId: '10000000002' });
});
const JSZip = require('../lib/jszip.min.js');
const conversationKey = (conversationId: string) => ({ accountId: account.id, conversationId });
function request(conversationId: string, overrides: Partial<ExportRequest> = {}): ExportRequest {
    return { keys: [conversationKey(conversationId)], format: 'markdown',
        delivery: 'browserDownload', includeAssets: true, skipUnchanged: false, ...overrides };
}
function paragraph(text: string) {
    return { type: 'paragraph' as const, children: [{ type: 'text' as const, text }] };
}
async function seed(id: string, options: { doc?: boolean; image?: boolean } = {}) {
    const assets = options.doc ? [{
        id: 'doc', kind: 'file' as const, name: 'doc.md',
        sourceUri: 'https://example.test/doc.md', mediaType: 'text/markdown',
        document: { contentMarkdown: 'embedded doc body' },
    }] : options.image ? [{
        id: 'image', kind: 'image' as const, name: 'image.png',
        sourceUri: 'https://example.test/image.png', mediaType: 'image/png',
    }] : [];
    await ingestDetail(account.id, id, {
        savedAt: 100, quality: { status: 'complete' }, assets,
        messages: [
            { role: 'user', content: [paragraph('hello')] },
            { role: 'assistant', content: [
                paragraph('Answer ' + id),
                ...(options.image ? [{ type: 'image' as const, assetId: 'image' }] : []),
            ], ...(options.doc ? { attachmentIds: ['doc'] } : {}) },
        ],
    }, { title: 'Export ' + id, titleSource: 'provider', updatedAt: 100 });
    await updateSettings({ language: 'en' });
}
function fakeBrowser(t: { after: (fn: () => void) => void }, failClick = false) {
    const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    const previousLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
    const previousMouseEvent = Object.getOwnPropertyDescriptor(globalThis, 'MouseEvent');
    Object.defineProperty(globalThis, 'MouseEvent', { configurable: true, value: Event });
    const originalCreate = URL.createObjectURL;
    const blobs: Blob[] = [];
    const filenames: string[] = [];
    let clicks = 0;
    Object.defineProperty(globalThis, 'document', { configurable: true, value: {
        createElement: (tag: string) => {
            assert.equal(tag, 'a');
            return { href: '', download: '', remove() {}, dispatchEvent() {
                clicks++;
                filenames.push(this.download);
                if (failClick) throw new Error('Browser download refused');
                return true;
            } };
        },
        body: { appendChild() {} },
    } });
    Object.defineProperty(globalThis, 'location', {
        configurable: true, value: { hostname: 'example.test', protocol: 'https:' },
    });
    URL.createObjectURL = ((blob: Blob) => {
        blobs.push(blob);
        return originalCreate.call(URL, blob);
    }) as typeof URL.createObjectURL;
    t.after(() => {
        URL.createObjectURL = originalCreate;
        if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
        else Reflect.deleteProperty(globalThis, 'document');
        if (previousLocation) Object.defineProperty(globalThis, 'location', previousLocation);
        else Reflect.deleteProperty(globalThis, 'location');
        if (previousMouseEvent) Object.defineProperty(globalThis, 'MouseEvent', previousMouseEvent);
        else Reflect.deleteProperty(globalThis, 'MouseEvent');
    });
    return { blobs, filenames, clicks: () => clicks };
}
function fakeNetwork(t: { after: (fn: () => void) => void }, bytes: Uint8Array, mediaType: string) {
    const chromeHost = globalThis.chrome;
    const previousFetch = globalThis.fetch;
    const previousTabs = Object.getOwnPropertyDescriptor(chromeHost, 'tabs');
    globalThis.fetch = async () => new Response(new Uint8Array(bytes) as BodyInit, { status: 200,
        headers: { 'content-type': mediaType } });
    Object.defineProperty(chromeHost, 'tabs', { configurable: true, value: {
        query: async () => [{ id: 10, url: 'https://gemini.google.com/app/native' }],
        sendMessage: (_id: number, _message: unknown, reply?: (value: unknown) => void) => {
            const response = { ok: true, accountContext: { accountId: account.id, providerId: 'gemini', slot: 'u0' } };
            reply?.(response); return Promise.resolve(response);
        },
    } });
    t.after(() => { globalThis.fetch = previousFetch;
        if (previousTabs) Object.defineProperty(chromeHost, 'tabs', previousTabs);
        else Reflect.deleteProperty(chromeHost, 'tabs');
    });
}

test('P0: an asset-free v2 export downloads once and writes exactly one committed Record', async t => {
    const host = fakeBrowser(t);
    const id = 'aaaa1111bbbb2222';
    await seed(id);
    const result = await runExport(request(id));
    assert.equal(result.exported, 1);
    assert.equal(result.failed.length, 0);
    assert.equal(result.partial, 0);
    assert.equal(host.clicks(), 1);
    assert.equal(host.blobs.length, 1);
    assert.match(await host.blobs[0].text(), /hello/);
    assert.match(await host.blobs[0].text(), /Answer aaaa1111bbbb2222/);
    const record = await getExportRecord(conversationKey(id));
    assert.ok(record);
    assert.ok(Number.isSafeInteger(record.exportedAt));
    assert.equal(record.format, 'markdown');
    assert.equal(record.status, 'ok');
    assert.equal(record.chatTime, 100);
    const second = await runExport(request(id, { skipUnchanged: true }));
    assert.equal(second.exported, 0);
    assert.equal(second.skipped, 1);
    assert.equal(host.clicks(), 1, 'skip cannot deliver the same unchanged document twice');
});

test('P0: a v2 document attachment is present in ZIP and its ExportRecord lands after delivery', async t => {
    const host = fakeBrowser(t);
    const bytes = new TextEncoder().encode('# embedded doc body');
    fakeNetwork(t, bytes, 'text/markdown');
    const originalZip = __getZipConstructor();
    __setZipConstructor(JSZip);
    t.after(() => __setZipConstructor(originalZip));
    const id = 'cccc3333dddd4444';
    await seed(id, { doc: true });
    const result = await runExport(request(id));
    assert.equal(result.exported, 1);
    assert.equal(result.failed.length, 0);
    assert.equal(result.partial, 0);
    assert.equal(host.clicks(), 1);
    const files = await readDeliveredFiles(host);
    const main = files.find(file=>file.name.endsWith('.md') && !file.name.startsWith('files/'));
    const document = files.find(file=>file.name.startsWith('files/') && file.name.endsWith('doc.md'));
    assert.ok(main && document);
    assert.match(String(await main.async('string')), /Answer cccc3333dddd4444/);
    assert.equal(await document.async('string'), '# embedded doc body');
    assert.equal((await getExportRecord(conversationKey(id)))?.status, 'ok');
});

test('P0: a v2 image attachment is packaged once with its original bytes and a single Record', async t => {
    const host = fakeBrowser(t);
    const png = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3);
    fakeNetwork(t, png, 'image/png');
    const originalZip = __getZipConstructor();
    __setZipConstructor(JSZip);
    t.after(() => __setZipConstructor(originalZip));
    const id = 'eeee5555ffff6666';
    await seed(id, { image: true });
    const result = await runExport(request(id));
    assert.equal(result.exported, 1);
    assert.equal(result.failed.length, 0);
    assert.equal(host.clicks(), 1);
    const files = await readDeliveredFiles(host);
    const images = files.filter(file=>file.name.startsWith('assets/') && file.name.endsWith('.png'));
    assert.equal(images.length,1);
    assert.deepEqual(await images[0].async('uint8array'),png);
    assert.equal((await getExportRecord(conversationKey(id)))?.status, 'ok');
    assert.equal(Object.keys(await listExportRecords(account.id)).length, 1);
});

test('P0: v2 delivery failure must not mark the conversation successfully exported', async t => {
    const host = fakeBrowser(t, true);
    const id = 'delivery_refused';
    await seed(id);
    const result = await runExport(request(id));
    assert.equal(host.clicks(), 1);
    assert.equal(result.exported, 0);
    assert.deepEqual(result.failed, [conversationKey(id)]);
    assert.equal(await getExportRecord(conversationKey(id)), null);
});

test('L3a persists parallel per-conversation records without lost updates', async () => {
    const ids = Array.from({ length: 10 }, (_, i) => 'chat_' + (i + 1));
    await Promise.all(ids.map((id, i) => putExportRecord(conversationKey(id), {
        exportedAt: 1000 + i, format: 'markdown', status: 'ok', chatTime: 100 + i,
    })));
    const stored = await listExportRecords(account.id);
    assert.equal(Object.keys(stored).length, ids.length);
    for (const [i, id] of ids.entries()) assert.equal(stored[id].chatTime, 100 + i);
});

test('L4 rejects traversal paths instead of normalizing unsafe delivery targets', async () => {
    assert.equal(sanitizeRelativePath('a/../b'), 'a/_/b');
    assert.equal(sanitizeRelativePath('files/../../etc/passwd'), 'files/_/_/etc/passwd');
    for (const path of ['a/../b', 'files/../../etc/passwd', 'files/a..b', '/absolute']) {
        assert.throws(() => assertExportPath(path), /Noncanonical export path|Unsafe archive resource path/);
    }
    assert.doesNotThrow(() => assertExportPath('assets/ab1234_image-1.jpg'));
});

test('L4 folder delivery fails closed when a requested subdirectory cannot be created', async () => {
    let rootWrites = 0;
    const directory = {
        queryPermission: async () => 'granted',
        getDirectoryHandle: async () => { throw new Error('Unable to create subdirectory'); },
        getFileHandle: async () => { rootWrites++; throw new Error('Root fallback prohibited'); },
    } as unknown as FileSystemDirectoryHandle;
    await assert.rejects(writeToFolder([
        { fileName: 'files/doc.md', mimeType: 'text/markdown', content: '# content' },
    ], directory), /Unable to create subdirectory/);
    assert.equal(rootWrites, 0, 'a failed subfolder must not quietly write into the root');
});

test('verified v2 Runtime account routing never falls back to a different Gemini tab', async t => {
    const chromeHost = globalThis.chrome;
    const priorTabs = Object.getOwnPropertyDescriptor(chromeHost, 'tabs');
    Object.defineProperty(chromeHost, 'tabs', { configurable: true, value: {
        query: async () => [
            { id: 1, active: true, url: 'https://gemini.google.com/u/0/app/a' },
            { id: 2, active: false, url: 'https://gemini.google.com/u/1/app/b' },
        ],
        sendMessage: (_id: number, _message: unknown, reply: (value: unknown) => void) => {
            reply({ ok: true, accountContext: { accountId: account.id, providerId: 'gemini' } });
        },
    } });
    t.after(() => {
        if (priorTabs) Object.defineProperty(chromeHost, 'tabs', priorTabs);
        else Reflect.deleteProperty(chromeHost, 'tabs');
    });
    const tab = await resolveAccountTab(account.id);
    assert.equal(tab.id, 1);
    await assert.rejects(resolveAccountTab('10000000-0000-4000-8000-000000000002'),
        /No open Provider Tab matches this Account/);
});
