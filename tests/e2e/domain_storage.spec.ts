import { test, expect, seedRegistryAccounts } from './l2Fixtures';
import { build } from 'esbuild';
import * as path from 'node:path';

let bundle: string;
test.beforeAll(async () => {
    const output = await build({ stdin: { contents: `
        import * as admission from './src/l2/ingestion.ts';
        import * as storage from './src/l3a/storageService.ts';
        import { openStorageDB as openDomainDB } from './src/l3a/idb.ts';
        import { readConversation } from './src/l2/readConversation.ts';
        import { createSourceResourceContext } from './src/l1/resources/sourceResources.ts';
        import { historicalFixture } from './tests/helpers/nativeFixture.ts';
        import { bindFixture } from './tests/helpers/domainFixture.ts';
        import { admitFixture } from './tests/helpers/admitFixture.ts';
        globalThis.storageProbe = { ...admission, ...storage, openDomainDB, readConversation, createSourceResourceContext, historicalFixture, bindFixture, admitFixture };
    `, resolveDir: path.resolve(__dirname, '../..'), loader: 'ts' }, bundle: true, write: false, platform: 'browser', format: 'iife' });
    bundle = output.outputFiles[0].text;
});
test.beforeEach(async ({ context }) => { await seedRegistryAccounts(context); });
async function install(page: import('@playwright/test').Page, extensionId: string) {
    await page.goto(`chrome-extension://${extensionId}/src/ui/options/options.html?notour=1`);
    await page.evaluate(bundle);
}

test('Index and Detail have independent physical authorities and restore a composed view after reload', async ({ context, extensionId }) => {
    const page = await context.newPage(); await install(page, extensionId);
    const saved = await page.evaluate(async () => {
        const api = Reflect.get(globalThis, 'storageProbe');
        const parsed = api.historicalFixture({ id: 'physical', title: 'Original', completeness: { status: 'complete' }, messages: [{ role: 'user', content: 'Saved body' }] });
        await api.admitFixture(parsed.account.id, parsed);
        await api.ingestIndexes(parsed.account.id, [{ conversationId: 'physical', fields: { title: 'User title', titleSource: 'user', updatedAt: 999 } }]);
        const db = await api.openDomainDB();
        const disk = await new Promise<unknown[]>((resolve, reject) => {
            const tx = db.transaction('details', 'readonly'), req = tx.objectStore('details').getAll();
            tx.oncomplete = () => resolve(req.result); tx.onabort = tx.onerror = () => reject(tx.error);
        });
        const names = [...db.objectStoreNames]; db.close();
        return { accountId: parsed.account.id, detail: parsed.conversation.detail, disk, names };
    });
    expect(saved.disk).toEqual([saved.detail]);
    expect(saved.names).not.toContain('resource_bytes');
    await page.reload(); await page.evaluate(bundle);
    const restored = await page.evaluate(async accountId => Reflect.get(globalThis, 'storageProbe').readConversation({ accountId, conversationId: 'physical' }), saved.accountId);
    expect(restored.detail).toEqual(saved.detail);
    expect(restored.index.title).toBe('User title');
    expect(restored.index.updatedAt).toBe(999);
});

test('Index-only stays body-free; shorter complete snapshots replace while partial snapshots cannot truncate', async ({ context, extensionId }) => {
    const page = await context.newPage(); await install(page, extensionId);
    const result = await page.evaluate(async () => {
        const api = Reflect.get(globalThis, 'storageProbe');
        const parsed = api.historicalFixture({ id: 'select', title: 'Title', completeness: { status: 'complete' }, messages: [{ role: 'user', content: 'A' }, { role: 'model', content: 'B' }] });
        await api.ingestIndexes(parsed.account.id, [{ conversationId: 'select', fields: {} }]);
        const empty = await api.getDetail(parsed.conversation.index.key);
        await api.admitFixture(parsed.account.id, parsed);
        await api.ingestDetail(parsed.account.id, 'select', { ...parsed.conversation.detail, quality: { status: 'partial' }, messages: [] });
        const protectedDetail = await api.getDetail(parsed.conversation.index.key);
        await api.ingestDetail(parsed.account.id, 'select', { ...parsed.conversation.detail, messages: [parsed.conversation.detail.messages[0]] });
        return { empty, protectedDetail, selected: await api.getDetail(parsed.conversation.index.key) };
    });
    expect(result.empty).toBeNull();
    expect(result.protectedDetail.messages).toHaveLength(2);
    expect(result.selected.messages).toHaveLength(1);
});

test('Detail and Index failures roll back the same atomic conversation admission', async ({ context, extensionId }) => {
    const page = await context.newPage(); await install(page, extensionId);
    const result = await page.evaluate(async () => {
        const api = Reflect.get(globalThis, 'storageProbe');
        const parsed = api.historicalFixture({ id: 'failed-detail', title: 'Committed index', messages: [{ role: 'user', content: 'Body' }] });
        const put = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function (...args) { if (this.name === 'details') throw new Error('injected Detail failure'); return put.apply(this, args); };
        let detailError = '';
        try { await api.ingestDetail(parsed.account.id, 'failed-detail', parsed.conversation.detail, parsed.conversation.index); } catch (error) { detailError = String(error); }
        finally { IDBObjectStore.prototype.put = put; }
        const index = await api.getIndex(parsed.conversation.index.key);
        const absent = await api.getDetail(parsed.conversation.index.key);
        IDBObjectStore.prototype.put = function (...args) { if (this.name === 'indexes') throw new Error('injected Index failure'); return put.apply(this, args); };
        let indexError = '';
        try { const { key: _, ...body } = parsed.conversation.detail; await api.ingestDetail(parsed.account.id, 'failed-index', body); } catch (error) { indexError = String(error); }
        finally { IDBObjectStore.prototype.put = put; }
        return { detailError, indexError, index, absent, other: await api.getDetail({ accountId: parsed.account.id, conversationId: 'failed-index' }) };
    });
    expect(result.detailError).toContain('injected Detail failure');
    expect(result.indexError).toContain('injected Index failure');
    expect(result.index).toBeNull();
    expect(result.absent).toBeNull(); expect(result.other).toBeNull();
});

test('untrusted admission and IPC reject invalid AST and dangling assets before persistence', async ({ context, extensionId }) => {
    const page = await context.newPage(); await install(page, extensionId);
    const result = await page.evaluate(async () => {
        const api = Reflect.get(globalThis, 'storageProbe');
        const parsed = api.historicalFixture({ id: 'invalid', messages: [{ role: 'user', content: 'Body' }] });
        const detail = structuredClone(parsed.conversation.detail);
        detail.messages[0].attachmentIds = ['missing'];
        let rejected = false;
        try { await api.ingestDetail(parsed.account.id, 'invalid', detail); } catch { rejected = true; }
        const reply = await chrome.runtime.sendMessage({ action: 'domainStorage', command: 'put', payload: { detail } });
        return { rejected, reply, stored: await api.getDetail(detail.key), indexes: await api.listIndexes(parsed.account.id) };
    });
    expect(result.rejected).toBe(true); expect(result.reply).toBeUndefined(); // Removed privileged Storage IPC is not handled.
    expect(result.stored).toBeNull();
    expect(Object.values(result.indexes).flat()).toEqual([]);
});


test('inline bytes remain outside persisted Detail and belong to one acquisition task', async ({ context, extensionId }) => {
    const page = await context.newPage(); await install(page, extensionId);
    const result = await page.evaluate(async () => {
        const api = Reflect.get(globalThis, 'storageProbe');
        const parsed = api.historicalFixture({ id: 'inline-bytes', title: 'Image',
            messages: [{ role: 'user', content: '![image](data:image/png;base64,AQID)' }] });
        await api.admitFixture(parsed.account.id, parsed);
        const asset = parsed.conversation.detail.assets[0];
        const resources = api.createSourceResourceContext();
        resources.retainParsed(parsed.conversation.index.key, { ...parsed, conversationId: 'inline-bytes' });
        const bytes = (await resources.acquire(parsed.conversation.index.key, asset)).bytes;
        resources.release();
        return { bytes: bytes && Array.from(bytes), detail: await api.getDetail(parsed.conversation.detail.key) };
    });
    expect(result.bytes).toEqual([1, 2, 3]);
    expect(JSON.stringify(result.detail)).not.toMatch(/data:|dataBase64|acquisitionHints|resources/);
});
