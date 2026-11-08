/**
 * V2 cloud deletion isolation, exercised in a real extension page and IndexedDB.
 *
 * Only the authenticated L1 Provider source response / route is mocked. L1
 * GeminiProvider, L2 admission, L3a atomic Storage, Application Export and
 * browser reload all use their real v2 implementations. Unlike v1 there are
 * no retained Domain blobs, media byte caches, availability flags, or legacy
 * ExportOrchestrator/BatchWorker/AssetPipeline facades.
 */
import { test, expect, seedRegistryAccounts } from './fixtures';
import type { Page } from '@playwright/test';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';

const accountId = '10000000-0000-4000-8000-000000000001';
const otherAccountId = '10000000-0000-4000-8000-000000000002';
const id = 'deletion-isolation';
let bundle: string;

test.beforeAll(async () => {
    const output = await build({
        stdin: { contents: [
            "import * as storage from './src/l3a/storageService.ts';",
            "import { ingestDetail, ingestIndexes } from './src/l2/ingestion.ts';",
            "import { readConversation } from './src/l2/readConversation.ts';",
            "import { runExport } from './src/application/export/runExport.ts';",
            "import { GeminiProvider } from './src/l1/client/gemini/geminiProvider.ts';",
            "import { ConfirmedGeminiConversationNotFound } from './src/l1/client/gemini/geminiClient.ts';",
            "globalThis.deletionProbe = { ...storage, ingestDetail, ingestIndexes, readConversation, runExport, GeminiProvider, ConfirmedGeminiConversationNotFound };",
        ].join('\n'), resolveDir: path.resolve(__dirname, '../..'), loader: 'ts' },
        bundle: true, write: false, platform: 'browser', format: 'iife',
        conditions: ['worker', 'browser'], logLevel: 'silent',
        define: { __EXT_VERSION__: '"2.0.0"' },
    });
    bundle = output.outputFiles[0].text;
});
test.beforeEach(async ({ context }) => { await seedRegistryAccounts(context); });

async function openProbe(context: import('@playwright/test').BrowserContext, extensionId: string): Promise<Page> {
    const page = await context.newPage();
    await page.goto('chrome-extension://' + extensionId + '/src/ui/options/options.html?notour=1');
    await page.evaluate(bundle);
    return page;
}
async function seed(page: Page, includePeer = true): Promise<void> {
    await page.evaluate(async ({ accountId, otherAccountId, id, includePeer }) => {
        const api = Reflect.get(globalThis, 'deletionProbe');
        const detail = {
            savedAt: 100, quality: { status: 'complete' }, assets: [],
            messages: [{ role: 'assistant', content: [{
                type: 'paragraph', children: [{ type: 'text', text: 'Saved local answer from archive' }],
            }] }],
        };
        const metadata = { title: 'Retained archive', titleSource: 'provider', updatedAt: 100 };
        for (const owner of includePeer ? [accountId, otherAccountId] : [accountId]) {
            await api.ingestDetail(owner, id, detail, metadata);
            await api.putExportRecord({ accountId: owner, conversationId: id },
                { exportedAt: 200, format: 'markdown', status: 'ok', chatTime: 100 });
        }
        await api.patchStoredSettings({ language: 'en', lastSeenFeatureVersion: '999.0.0' });
    }, { accountId, otherAccountId, id, includePeer });
}
async function snapshot(page: Page) {
    return page.evaluate(async ({ accountId, otherAccountId, id }) => {
        const api = Reflect.get(globalThis, 'deletionProbe');
        const key = (accountId: string) => ({ accountId, conversationId: id });
        const current = key(accountId), peer = key(otherAccountId);
        return {
            index: await api.getIndex(current), detail: await api.getDetail(current),
            record: await api.getExportRecord(current), conversation: await api.readConversation(current),
            peerIndex: await api.getIndex(peer), peerDetail: await api.getDetail(peer),
            peerRecord: await api.getExportRecord(peer), peerConversation: await api.readConversation(peer),
        };
    }, { accountId, otherAccountId, id });
}
async function sourceRequest(page: Page, kind: 'confirmed' | 'network' | 'misleading' | 'wrong-id'
    | 'route-change' | 'aborted' | 'storage-failure') {
    return page.evaluate(async ({ kind, accountId, id }) => {
        const api = Reflect.get(globalThis, 'deletionProbe');
        const controller = new AbortController();
        const sourceIds: string[] = [];
        let routeCalls = 0;
        const client = { async getConversationDetail(conversationId: string) {
            sourceIds.push(conversationId);
            if (kind === 'network') throw new Error('HTTP 503');
            if (kind === 'misleading') throw new Error('BardErrorInfo: 1167 (unverified)');
            if (kind === 'wrong-id') throw new api.ConfirmedGeminiConversationNotFound('c_unrelated');
            if (kind === 'aborted') controller.abort();
            throw new api.ConfirmedGeminiConversationNotFound('c_' + conversationId);
        } };
        const provider = new api.GeminiProvider(client, async (_id: string) => {
            routeCalls++;
            return kind === 'route-change' && routeCalls > 1 ? 'u1' : 'u0';
        });
        const originalDelete = IDBObjectStore.prototype.delete;
        if (kind === 'storage-failure') {
            IDBObjectStore.prototype.delete = function (key: IDBValidKey | IDBKeyRange) {
                if (this.name === 'details') throw new Error('Injected deletion transaction failure');
                return originalDelete.call(this, key);
            };
        }
        let errorName = '', errorMessage = '';
        try {
            await provider.fetchConversationDetail(accountId, id, controller.signal);
        } catch (error) {
            errorName = error instanceof Error ? error.name : typeof error;
            errorMessage = error instanceof Error ? error.message : String(error);
        } finally {
            IDBObjectStore.prototype.delete = originalDelete;
        }
        return { errorName, errorMessage, sourceIds, routeCalls };
    }, { kind, accountId, id });
}

test('confirmed L1 cloud deletion atomically removes only that account Index, Detail and ExportRecord', async ({ context, extensionId }) => {
    const page = await openProbe(context, extensionId);
    await seed(page);
    const before = await snapshot(page);
    expect(before.index).toBeTruthy();
    expect(before.detail).toBeTruthy();
    expect(before.record?.format).toBe('markdown');
    const request = await sourceRequest(page, 'confirmed');
    expect(request.errorMessage).toBe('conversation_not_found');
    expect(request.sourceIds).toEqual([id]);
    expect(request.routeCalls).toBe(2);
    const after = await snapshot(page);
    expect(after.index).toBeNull();
    expect(after.detail).toBeNull();
    expect(after.record).toBeNull();
    expect(after.conversation).toBeNull();
    expect(after.peerConversation).toEqual(before.peerConversation);
    expect(after.peerRecord).toEqual(before.peerRecord);
    await page.reload();
    await page.evaluate(bundle);
    const persisted = await snapshot(page);
    expect(persisted.index).toBeNull();
    expect(persisted.detail).toBeNull();
    expect(persisted.record).toBeNull();
    expect(persisted.peerConversation).toEqual(before.peerConversation);
});

for (const scenario of [
    { kind: 'network' as const, error: 'HTTP 503' },
    { kind: 'misleading' as const, error: 'BardErrorInfo: 1167 (unverified)' },
    { kind: 'wrong-id' as const, error: 'Confirmed Gemini Detail not found' },
    { kind: 'route-change' as const, error: 'Gemini account route changed' },
    { kind: 'aborted' as const, error: 'aborted' },
]) {
    test('cloud deletion requires verified identity and source outcome: ' + scenario.kind, async ({ context, extensionId }) => {
        const page = await openProbe(context, extensionId);
        await seed(page);
        const before = await snapshot(page);
        const request = await sourceRequest(page, scenario.kind);
        expect(request.errorMessage.toLowerCase()).toContain(scenario.error.toLowerCase());
        expect(request.sourceIds).toEqual([id]);
        const after = await snapshot(page);
        expect(after.conversation).toEqual(before.conversation);
        expect(after.record).toEqual(before.record);
        expect(after.peerConversation).toEqual(before.peerConversation);
        await page.reload();
        await page.evaluate(bundle);
        expect((await snapshot(page)).conversation).toEqual(before.conversation);
    });
}

test('unverified network failure leaves local Detail available for real v2 Markdown export', async ({ context, extensionId }, testInfo) => {
    const page = await openProbe(context, extensionId);
    await seed(page, false);
    const rejected = await sourceRequest(page, 'network');
    expect(rejected.errorMessage).toBe('HTTP 503');
    const download = page.waitForEvent('download');
    const result = await page.evaluate(async ({ accountId, id }) =>
        Reflect.get(globalThis, 'deletionProbe').runExport({
            keys: [{ accountId, conversationId: id }], format: 'markdown',
            delivery: 'browserDownload', includeAssets: false, skipUnchanged: false,
        }), { accountId, id });
    expect(result.exported).toBe(1);
    expect(result.failed).toEqual([]);
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/\.md$/);
    const filePath = testInfo.outputPath('retained-on-network-error.md');
    await file.saveAs(filePath);
    expect(await readFile(filePath, 'utf8')).toContain('Saved local answer from archive');
    const persisted = await snapshot(page);
    expect(persisted.record?.status).toBe('ok');
    expect(persisted.detail?.messages[0].content[0].children[0].text).toBe('Saved local answer from archive');
});

test('storage failure aborts the entire three-store deletion; no tombstone or partial erase', async ({ context, extensionId }) => {
    const page = await openProbe(context, extensionId);
    await seed(page);
    const before = await snapshot(page);
    const request = await sourceRequest(page, 'storage-failure');
    expect(request.errorMessage).toContain('Injected deletion transaction failure');
    const after = await snapshot(page);
    expect(after.index).toEqual(before.index);
    expect(after.detail).toEqual(before.detail);
    expect(after.record).toEqual(before.record);
    expect(after.peerConversation).toEqual(before.peerConversation);
    await page.reload();
    await page.evaluate(bundle);
    expect(await snapshot(page)).toEqual(before);
});

test('missing from a later Index scan is not reliable evidence of deletion', async ({ context, extensionId }) => {
    const page = await openProbe(context, extensionId);
    await seed(page);
    const before = await snapshot(page);
    await page.evaluate(async accountId =>
        Reflect.get(globalThis, 'deletionProbe').ingestIndexes(accountId, []), accountId);
    expect(await snapshot(page)).toEqual(before);
});
