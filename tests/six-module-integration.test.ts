import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readDeliveredFiles } from './helpers/v2ExportHost.js';
import { indexStorage } from './helpers/indexStorage.js';
import { fixtureAccount } from './helpers/domainFixture.js';
import { sourceDetail, sourceList } from './helpers/l1SourceFixture.js';
import { GeminiProvider } from '../src/l1/client/gemini/geminiProvider.js';
import { ProviderRegistry } from '../src/l1/client/providerRegistry.js';
import type { SourceResourceContext } from '../src/l1/resources/sourceResources.js';
import type { GeminiProviderClient } from '../src/l1/client/gemini/geminiContracts.js';
import * as storage from '../src/l3a/storageService.js';
import type { DomainConversationDetail } from '../src/l2/conversationDetail.js';
import { getOrCreateAccount } from '../src/l2/accountAdmission.js';
import { readConversation } from '../src/l2/readConversation.js';
import { ingestDetail, ingestIndexes } from '../src/l2/ingestion.js';
import { scanAll } from '../src/application/sync/scanController.js';
import { clearLocalExportRecords, clearLocalScanRecords } from '../src/application/localCleanup.js';
import { getSettings, updateSettings } from '../src/application/settings/index.js';
import { getAccount, listAccounts } from '../src/runtime/api/accountRegistry.js';
import { __setZipConstructor } from '../src/l4/packaging/writers/zipWriter.js';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const account = fixtureAccount();
const key = { accountId: account.id, conversationId: 'source_chat_123' };
let client: GeminiProviderClient;
const contexts: SourceResourceContext[] = [];
// Inject only the network/route construction, retaining the real L1 provider and all downstream modules.
const filename = require.resolve('../src/l1/client/taskProvider.js');
require.cache[filename] = { id: filename, filename, loaded: true, exports: {
    createTaskProvider(_id: string, resources: SourceResourceContext) {
        contexts.push(resources);
        return new GeminiProvider(client, async () => 'u0', resources);
    }
} } as NodeModule;
const { runExport }: typeof import('../src/application/export/runExport.js') = require('../src/application/export/runExport.js');

function environment() {
    const env = indexStorage({}, { seedAccounts: false });
    const location = Object.getOwnPropertyDescriptor(globalThis, 'location');
    Object.defineProperty(globalThis, 'location', { configurable: true, value: { protocol: 'chrome-extension:' } });
    return { ...env, restore() {
        env.restore(); ProviderRegistry.unregister('gemini'); contexts.length = 0;
        if (location) Object.defineProperty(globalThis, 'location', location); else Reflect.deleteProperty(globalThis, 'location');
    } };
}

test('six modules: real L1 admission, IDB reload, Application scan/export, ZIP bytes, delivery and Record', async () => {
    const env = environment();
    const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    const oldMouseEvent = Object.getOwnPropertyDescriptor(globalThis, 'MouseEvent');
    Object.defineProperty(globalThis, 'MouseEvent', { configurable: true, value: Event });
    const deliveries: Promise<Blob>[] = [];
    const filenames: string[] = [];
    const recordsAtClick: ReturnType<typeof storage.getExportRecord>[] = [];
    Object.defineProperty(globalThis, 'document', { configurable: true, value: {
        body: { appendChild() {} }, createElement() { return { href: '', download: '', remove() {}, dispatchEvent() {
            filenames.push(this.download);
            deliveries.push(fetch(this.href).then(response => response.blob()));
            recordsAtClick.push(storage.getExportRecord(key));
            return true;
        } }; }
    } });
    __setZipConstructor(require('../lib/jszip.min.js'));
    try {
        await storage.putAccount(account);
        const parsed = sourceDetail();
        parsed.conversation.detail.quality.status = 'complete';
        parsed.conversation.detail.assets = [{ id: 'diagram', kind: 'image', mediaType: 'image/png' }];
        parsed.conversation.detail.messages[0].content.push({ type: 'image', assetId: 'diagram' });
        parsed.acquisitionHints = { diagram: { dataBase64: png } };
        client = { async getConversationList() { return sourceList('G_SOURCE_CHAT_01'); }, async getConversationDetail() { return parsed; } };
        ProviderRegistry.register(new GeminiProvider(client, async () => 'u0'));
        assert.equal((await scanAll({ accountId: account.id })).status, 'complete');
        assert.equal(await storage.getDetail(key), null);
        assert.ok((await storage.getCoverage(account.id, 'recent'))?.range);
        const result = await runExport({ keys: [key], format: 'markdown', delivery: 'browserDownload', includeAssets: true, skipUnchanged: false });
        assert.equal(result.exported, 1); assert.deepEqual(result.failed, []);
        assert.equal(await recordsAtClick[0], null, 'delivery precedes Record commit');
        const files = await readDeliveredFiles({filenames,blobs:await Promise.all(deliveries)});
        assert.equal(deliveries.length,1);
        const main = files.find(file=>file.name.endsWith('.md'));
        const image = files.find(file=>file.name.endsWith('.png'));
        assert.ok(main && image);
        assert.ok(String(await main.async('string')).includes(image.name));
        assert.deepEqual(await image.async('uint8array'), Uint8Array.from(atob(png), c => c.charCodeAt(0)));
        const detail = await storage.getDetail(key), record = await storage.getExportRecord(key);
        assert.equal(record?.chatTime, detail?.savedAt);
        assert.ok(!JSON.stringify(detail).includes(png));
        await assert.rejects(contexts[0].acquire(key, detail!.assets[0]), /released/);
        assert.equal((await readConversation(key))?.index.key.accountId, account.id);
        await clearLocalExportRecords(account.id);
        assert.ok(await storage.getDetail(key)); assert.equal(await storage.getExportRecord(key), null);
        assert.ok((await storage.getCoverage(account.id, 'recent'))?.range);
        await clearLocalScanRecords(account.id);
        assert.equal(await storage.getDetail(key), null); assert.equal(await storage.getIndex(key), null);
        assert.equal(await storage.getCoverage(account.id, 'recent'), null);
        assert.deepEqual(await storage.getAccount(account.id), account);
    } finally {
        if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument); else Reflect.deleteProperty(globalThis, 'document');
        if (oldMouseEvent) Object.defineProperty(globalThis, 'MouseEvent', oldMouseEvent); else Reflect.deleteProperty(globalThis, 'MouseEvent');
        env.restore();
    }
});

test('real Storage + L2 serialize identity/profile and concurrent Index/Detail arbitration', async () => {
    const env = environment();
    try {
        const accounts = await Promise.all(Array.from({ length: 10 }, (_, i) => getOrCreateAccount('gemini', 'subject', `user${i}@example.test`)));
        assert.equal(new Set(accounts.map(item => item.id)).size, 1);
        assert.equal((await storage.listAccounts()).length, 1);
        assert.equal((await getAccount(accounts[0].id))?.email, 'user9@example.test');
        assert.equal((await listAccounts('chatgpt')).length, 0);
        const fallback = await getOrCreateAccount('gemini', 'default', 'discard@example.test');
        assert.equal(fallback.id, accounts[0].id, 'unknown source reuses existing verified Account');
        assert.equal(fallback.email, 'user9@example.test', 'unknown metadata cannot replace verified profile');
        assert.equal((await storage.listAccounts()).length, 1, 'no new default Account is created');
        await storage.putAccount(account);
        await Promise.all(Array.from({ length: 12 }, (_, i) => ingestIndexes(account.id, [{ conversationId: `id${i}`, fields: { updatedAt: i } }])));
        assert.equal((await storage.listIndexes(account.id)).length, 12);
        const facts = { quality: { status: 'complete' as const }, assets: [], messages: [] };
        await Promise.all([ingestDetail(account.id, key.conversationId, { ...facts, savedAt: 20 }),
            ingestDetail(account.id, key.conversationId, { ...facts, savedAt: 10, quality: { status: 'partial' } })]);
        assert.equal((await storage.getDetail(key))?.savedAt, 20);
        await updateSettings({ includeAssets: false });
        assert.deepEqual(await storage.getStoredSettings(), { includeAssets: false });
        assert.equal((await getSettings()).defaultFormat, 'markdown');
        assert.deepEqual(await storage.getStoredSettings(), { includeAssets: false });
    } finally { env.restore(); }
});

test('failed IDB commits never advance coverage or replace accepted Detail; raw disk facts regain trust in L2', async () => {
    const env = environment();
    try {
        await storage.putAccount(account);
        const facts = { quality: { status: 'complete' as const }, assets: [], messages: [], savedAt: 10 };
        await ingestDetail(account.id, key.conversationId, facts);
        env.fail('details');
        await assert.rejects(ingestDetail(account.id, key.conversationId, { ...facts, savedAt: 20 }, { updatedAt: 20 }), /write failed/);
        env.fail();
        assert.equal((await storage.getIndex(key))?.updatedAt, undefined);
        assert.equal((await storage.getDetail(key))?.savedAt, 10);
        env.fail('coverage');
        const page = { streamId: 'recent', requestCursor: null, nextCursor: null, requestedAt: 1,
            requestKnown: true, valid: true, ordered: true, keys: [{ id: 'page', time: 30 }] };
        await assert.rejects(ingestIndexes(account.id, [{ conversationId: 'page', fields: { updatedAt: 30 } }], page), /write failed/);
        env.fail();
        assert.equal(await storage.getCoverage(account.id, 'recent'), null);
        assert.ok(await storage.getIndex({ accountId: account.id, conversationId: 'page' }));
        // A retry must establish the chain from durable state, never from failed admission.
        await ingestIndexes(account.id, [{ conversationId: 'page', fields: { updatedAt: 30 } }], page);
        assert.ok((await storage.getCoverage(account.id, 'recent'))?.range);
        const corrupted = { ...facts, key, messages: [{ role: 'assistant', content: [{ type: 'image', assetId: 'missing' }] }] };
        // Simulate an invalid persisted snapshot through the physical transaction port.
        await storage.updateConversationAtomically(key, () => ({
            detail: corrupted as unknown as DomainConversationDetail, result: undefined
        }));
        await assert.rejects(readConversation(key), /asset|closure|reference/i);
        await assert.rejects(ingestDetail(account.id, key.conversationId, facts), /asset|closure|reference/i);
    } finally { env.restore(); }
});
