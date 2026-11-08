import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type Page } from '@playwright/test';
import { buildSync } from 'esbuild';
import type * as Storage from '../src/l3a/storageService.js';
import type { GlobalSettings } from '../src/application/settings/index.js';

declare global {
    interface Window {
        storage: typeof Storage;
        settingsData: Record<string, Partial<GlobalSettings>>;
        settingsChanges: unknown[];
        failSettings: boolean;
    }
}
let browser: Browser;
let page: Page;
// This browser-based unit bundles actual L3a, so the Node Module._compile
// isolation guard cannot observe its imports. Inspect the esbuild graph too.
const build = buildSync({ entryPoints: ['src/l3a/storageService.ts'], bundle: true,
    format: 'iife', globalName: 'storage', write: false, metafile: true });
for (const input of Object.keys(build.metafile.inputs)) {
    if (input.startsWith('src/') && !input.startsWith('src/l3a/') && !input.startsWith('src/shared/'))
        throw new Error('L3a browser unit bundled another real v2 module: ' + input);
}
const bundle = build.outputFiles[0].text;

before(async () => {
    browser = await chromium.launch({ chromiumSandbox: true, headless: true });
    page = await browser.newPage();
    await page.route('http://localhost/storage-test', route => route.fulfill({ body: '<html></html>', contentType: 'text/html' }));
    await page.goto('http://localhost/storage-test');
});
after(async () => { await browser?.close(); });
beforeEach(async () => {
    await page.reload();
    await page.evaluate(async () => {
        await new Promise<void>((resolve, reject) => {
            const request = indexedDB.deleteDatabase('gemini_exporter_v2');
            request.onsuccess = () => resolve(); request.onerror = () => reject(request.error);
        });
        window.settingsData = {}; window.settingsChanges = []; window.failSettings = false;
        const listeners: ((changes: unknown, area: string) => void)[] = [];
        Object.defineProperty(window, 'chrome', { configurable: true, value: { storage: {
            onChanged: { addListener: (listener: (changes: unknown, area: string) => void) => listeners.push(listener) },
            local: {
                get: async (key: string) => {
                    if (window.failSettings) throw new Error('settings I/O');
                    return structuredClone({ [key]: window.settingsData[key] });
                },
                set: async (updates: Record<string, Partial<GlobalSettings>>) => {
                    if (window.failSettings) throw new Error('settings I/O');
                    for (const [key, value] of Object.entries(updates)) {
                        const change = { [key]: { oldValue: window.settingsData[key], newValue: structuredClone(value) } };
                        window.settingsData[key] = structuredClone(value);
                        for (const listener of listeners) listener(change, 'local');
                    }
                }
            }
        } } });
        chrome.storage.onChanged.addListener((changes, area) => window.settingsChanges.push({ changes, area }));
    });
    await page.addScriptTag({ content: bundle });
});

test('storage v2 initializes exactly six stores and only the specified indexes', async () => {
    const result = await page.evaluate(async () => {
        await window.storage.listAccounts();
        const db = await new Promise<IDBDatabase>(resolve => {
            const request = indexedDB.open('gemini_exporter_v2'); request.onsuccess = () => resolve(request.result);
        });
        const stores = Array.from(db.objectStoreNames);
        const tx = db.transaction(stores);
        const layout = stores.map(name => {
            const store = tx.objectStore(name);
            return { name, keyPath: store.keyPath, indexes: Array.from(store.indexNames) };
        });
        const version = db.version; db.close();
        return { version, layout, chromeKeys: Object.keys(window.settingsData) };
    });
    assert.deepEqual(result, { version: 1, chromeKeys: [], layout: [
        { name: 'accounts', keyPath: 'id', indexes: ['providerIdentity'] },
        { name: 'coverage', keyPath: ['accountId', 'streamId'], indexes: [] },
        { name: 'details', keyPath: ['key.accountId', 'key.conversationId'], indexes: [] },
        { name: 'directoryHandles', keyPath: null, indexes: [] },
        { name: 'exportRecords', keyPath: ['accountId', 'conversationId'], indexes: [] },
        { name: 'indexes', keyPath: ['key.accountId', 'key.conversationId'], indexes: [] }
    ] });
});

test('storage v2 missing values use the frozen null/list/map defaults', async () => {
    assert.deepEqual(await page.evaluate(async () => {
        const s = window.storage, key = { accountId: 'a', conversationId: 'missing' };
        return Promise.all([s.getAccount('a'), s.listAccounts(), s.getIndex(key), s.listIndexes('a'),
            s.getDetail(key), s.getCoverage('a', 'recent'), s.getExportRecord(key), s.listExportRecords('a'),
            s.getStoredSettings(), s.getDirectoryHandle()]);
    }), [null, [], null, [], null, null, null, {}, {}, null]);
});

test('storage v2 atomic account insertion reuses the identity and leaves profile choices to L2', async () => {
    const result = await page.evaluate(async () => {
        const s = window.storage;
        const account = { id: 'a', providerId: 'gemini', providerAccountId: 'subject', displayName: 'first' };
        const inserted = await Promise.all([s.insertAccountIfAbsent(account),
            s.insertAccountIfAbsent({ ...account, id: 'b', displayName: 'later' })]);
        await s.putAccount({ ...account, displayName: 'selected' });
        await s.insertAccountIfAbsent({ ...account, id: 'c', providerId: 'other' });
        let failed = false;
        try { await s.putAccount({ ...account, id: 'duplicate' }); } catch { failed = true; }
        return { inserted, current: await s.getAccount('a'), accounts: (await s.listAccounts()).length, failed };
    });
    assert.deepEqual(result.inserted.map(a => a.id), ['a', 'a']);
    assert.deepEqual(result.inserted.map(a => a.displayName), ['first', 'first']);
    assert.equal(result.current?.displayName, 'selected');
    assert.equal(result.accounts, 2); assert.equal(result.failed, true);
});

test('storage v2 batch indexes isolate accounts, replace without merge, and never manufacture details', async () => {
    const result = await page.evaluate(async () => {
        const s = window.storage, key = { accountId: 'a', conversationId: 'same' };
        await s.putIndexes([{ key, title: 'old', titleSource: 'provider', updatedAt: 100 },
            { key: { ...key, accountId: 'b' }, title: 'other', titleSource: 'provider' },
            { key: { ...key, conversationId: 'second' } }]);
        await s.putIndexes([{ key, title: 'accepted', titleSource: 'derived', updatedAt: 1 }]);
        await s.putIndexes([]);
        return { index: await s.getIndex(key), a: (await s.listIndexes('a')).length,
            b: (await s.listIndexes('b'))[0].title, detail: await s.getDetail(key) };
    });
    assert.deepEqual(result, { index: { key: { accountId: 'a', conversationId: 'same' }, title: 'accepted', titleSource: 'derived', updatedAt: 1 }, a: 2, b: 'other', detail: null });
});

test('storage v2 failed batch aborts all writes and propagates I/O errors', async () => {
    assert.deepEqual(await page.evaluate(async () => {
        const s = window.storage;
        let failed = false;
        try { await s.putIndexes([{ key: { accountId: 'a', conversationId: 'valid' } },
            { key: { accountId: 'a', conversationId: undefined! } }]); } catch { failed = true; }
        const indexes = await s.listIndexes('a');
        const original = indexedDB.open;
        indexedDB.open = () => { throw new Error('IDB I/O'); };
        let readFailed = false;
        try { await s.getAccount('a'); } catch { readFailed = true; }
        indexedDB.open = original;
        return { failed, indexes, readFailed };
    }), { failed: true, indexes: [], readFailed: true });
});

test('storage v2 keeps Index and Detail atomic, rejects an orphan and deletes verified remote conversations', async () => {
    const result = await page.evaluate(async () => {
        const s = window.storage, key = { accountId: 'a', conversationId: 'same' };
        const detail = { key, messages: [], assets: [{ id: 'image', kind: 'image' as const,
            sourceUri: 'https://source.test/image' }], quality: { status: 'unknown' as const }, savedAt: 100 };
        let orphanRejected = false, mismatchRejected = false;
        try { await s.updateConversationAtomically(key, () => ({ detail, result: undefined })); }
        catch { orphanRejected = true; }
        try { await s.updateConversationAtomically(key, () => ({
            index: { key: { ...key, accountId: 'wrong' } }, detail, result: undefined
        })); } catch { mismatchRejected = true; }
        await s.updateConversationAtomically(key, () => ({ index: { key }, detail, result: undefined }));
        await s.updateCoverageAtomically('a', 'recent', () => ({ next: { range: null }, result: undefined }));
        await s.putExportRecord(key, { exportedAt: 1, format: 'markdown', status: 'ok' });
        const original = await s.getDetail(key);
        await s.updateConversationAtomically(key, () => ({
            detail: { ...detail, savedAt: 1, assets: [] }, result: undefined
        }));
        const replaced = await s.getDetail(key);
        await s.deleteStoredConversation(key);
        return { orphanRejected, mismatchRejected, original, replaced,
            removed: await s.getDetail(key), index: await s.getIndex(key),
            record: await s.getExportRecord(key), coverage: await s.getCoverage('a', 'recent') };
    });
    assert.equal(result.orphanRejected, true); assert.equal(result.mismatchRejected, true);
    assert.equal(result.original?.assets.length, 1);
    assert.equal(result.replaced?.savedAt, 1); assert.deepEqual(result.replaced?.assets, []);
    assert.equal(result.removed, null); assert.equal(result.index, null);
    assert.equal(result.record, null); assert.deepEqual(result.coverage, { range: null });
});

test('storage v2 clears ExportRecords alone or with Coverage while preserving other accounts', async () => {
    const result = await page.evaluate(async () => {
        const s = window.storage, key = { accountId: 'a', conversationId: '__proto__' };
        await s.putIndexes([{ key }]);
        await s.updateCoverageAtomically('a', 'recent', () => ({ next: { range: null }, result: undefined }));
        await s.updateCoverageAtomically('a', 'archive', () => ({ next: { range: null }, result: undefined }));
        await s.updateCoverageAtomically('b', 'recent', () => ({ next: { range: null }, result: undefined }));
        await s.putExportRecord(key, { exportedAt: 1, format: 'markdown', status: 'ok', chatTime: 5 });
        await s.putExportRecord(key, { exportedAt: 2, format: 'html', status: 'partial' });
        await s.putExportRecord({ ...key, accountId: 'b' }, { exportedAt: 3, format: 'json', status: 'ok' });
        const records = Object.entries(await s.listExportRecords('a'));
        await s.clearStoredAccountExportRecords('a');
        const coverageAfterExportClear = await s.getCoverage('a', 'recent');
        await s.putExportRecord(key, { exportedAt: 4, format: 'markdown', status: 'ok' });
        await s.clearStoredAccountScanRecords('a');
        return { records, coverageAfterExportClear, coverage: await s.getCoverage('a', 'recent'),
            archive: await s.getCoverage('a', 'archive'), record: await s.getExportRecord(key),
            other: await s.getExportRecord({ ...key, accountId: 'b' }),
            otherCoverage: await s.getCoverage('b', 'recent'), index: await s.getIndex(key) };
    });
    assert.deepEqual(result.records, [['__proto__', { exportedAt: 2, format: 'html', status: 'partial' }]]);
    assert.deepEqual(result.coverageAfterExportClear, { range: null });
    assert.equal(result.coverage, null); assert.equal(result.archive, null); assert.equal(result.record, null);
    assert.equal(result.other?.format, 'json'); assert.deepEqual(result.otherCoverage, { range: null });
    assert.equal(result.index, null);
});

test('storage v2 settings patch preserves false, omitted fields, and native change notification', async () => {
    const result = await page.evaluate(async () => {
        const s = window.storage;
        await s.patchStoredSettings({ includeAssets: true, enabledDisk: true, language: 'zh' });
        await s.patchStoredSettings({ includeAssets: false, enabledDisk: false });
        const settings = await s.getStoredSettings();
        window.failSettings = true;
        let readFailed = false, writeFailed = false;
        try { await s.getStoredSettings(); } catch { readFailed = true; }
        try { await s.patchStoredSettings({ includeAssets: true }); } catch { writeFailed = true; }
        return { settings, changes: window.settingsChanges, keys: Object.keys(window.settingsData), readFailed, writeFailed };
    });
    assert.deepEqual(result.settings, { includeAssets: false, enabledDisk: false, language: 'zh' });
    assert.deepEqual(result.keys, ['gemini_exporter_v2_settings']); assert.equal(result.changes.length, 2);
    assert.equal(result.readFailed, true); assert.equal(result.writeFailed, true);
});

test('storage v2 real directory handles survive a context reload without permission state or memory fallback', async () => {
    await page.evaluate(async () => {
        const directory = await navigator.storage.getDirectory();
        await window.storage.setDirectoryHandle(await directory.getDirectoryHandle('first', { create: true }));
        await window.storage.setDirectoryHandle(await directory.getDirectoryHandle('selected', { create: true }));
    });
    await page.reload(); await page.addScriptTag({ content: bundle });
    assert.deepEqual(await page.evaluate(async () => {
        const handle = await window.storage.getDirectoryHandle();
        return { kind: handle?.kind, name: handle?.name };
    }), { kind: 'directory', name: 'selected' });
});

test('storage v2 scan cleanup removes local Index and Detail but retains Account/Settings/Handle and other accounts', async () => {
    const result = await page.evaluate(async () => {
        const s = window.storage;
        await s.putAccount({ id: 'a', providerId: 'gemini', providerAccountId: 'subject' });
        await s.patchStoredSettings({ includeAssets: false });
        await s.setDirectoryHandle(await navigator.storage.getDirectory());
        for (const accountId of ['a', 'b']) {
            const key = { accountId, conversationId: 'same' };
            await s.updateConversationAtomically(key, () => ({
                index: { key }, detail: { key, messages: [], assets: [], quality: { status: 'unknown' } },
                result: undefined
            }));
            await s.putExportRecord(key, { exportedAt: 1, format: 'markdown', status: 'ok' });
            for (const stream of ['recent', 'archive']) {
                await s.updateCoverageAtomically(accountId, stream, () => ({ next: { range: null }, result: undefined }));
            }
        }
        await s.clearStoredAccountScanRecords('a');
        const a = { accountId: 'a', conversationId: 'same' }, b = { ...a, accountId: 'b' };
        return { local: [ (await s.listIndexes('a')).length, !!await s.getDetail(a), await s.listExportRecords('a'),
            await s.getCoverage('a', 'recent'), await s.getCoverage('a', 'archive') ],
            retained: [!!await s.getAccount('a'), !!await s.getDirectoryHandle(),
                (await s.getStoredSettings()).includeAssets, (await s.listIndexes('b')).length,
                !!await s.getDetail(b), !!await s.getExportRecord(b),
                !!await s.getCoverage('b', 'recent'), !!await s.getCoverage('b', 'archive')] };
    });
    assert.deepEqual(result.local, [0, false, {}, null, null]);
    assert.deepEqual(result.retained, [true, true, false, 1, true, true, true, true]);
});


test('storage v2 protects existing Account provider identity and permits migration UUID insertion', async () => {
    const result = await page.evaluate(async () => {
        const s = window.storage;
        const base = { id: 'migration-uuid', providerId: 'gemini', providerAccountId: 'subject' };
        await s.putAccount(base);
        await s.putAccount({ ...base, email: 'known@example.com' });
        let rejected = false;
        try { await s.putAccount({ ...base, providerAccountId: 'different' }); }
        catch { rejected = true; }
        return { rejected, value: await s.getAccount(base.id) };
    });
    assert.deepEqual(result, { rejected: true,
        value: { id: 'migration-uuid', providerId: 'gemini', providerAccountId: 'subject', email: 'known@example.com' } });
});

test('storage v2 atomic Index admission validates all output keys and handles an empty trusted page', async () => {
    const result = await page.evaluate(async () => {
        const s = window.storage;
        const key = { accountId: 'a', conversationId: 'atomic' };
        await s.updateIndexesAtomically([key], old => {
            if (old.length !== 1 || old[0] !== null) throw new Error('old mismatch');
            return [{ key, updatedAt: 1 }];
        });
        await s.updateIndexesAtomically([key], old => [{ ...old[0]!, updatedAt: 2 }]);
        let duplicateRejected = false, invalidRejected = false, emptyRejected = false, called = false;
        try { await s.updateIndexesAtomically([key, key], () => []); } catch { duplicateRejected = true; }
        try { await s.updateIndexesAtomically([key], () => [{ key: { ...key, conversationId: 'wrong' } }]); }
        catch { invalidRejected = true; }
        await s.updateIndexesAtomically([], old => { called = old.length === 0; return []; });
        try { await s.updateIndexesAtomically([], () => [{ key }]); } catch { emptyRejected = true; }
        return { duplicateRejected, invalidRejected, emptyRejected, called, index: await s.getIndex(key) };
    });
    assert.deepEqual(result, { duplicateRejected: true, invalidRejected: true,
        emptyRejected: true, called: true, index: { key: { accountId: 'a', conversationId: 'atomic' }, updatedAt: 2 } });
});

test('storage v2 concurrent Settings patches preserve distinct fields via the single Web Lock', async () => {
    const result = await page.evaluate(async () => {
        const s = window.storage;
        await Promise.all([
            s.patchStoredSettings({ language: 'en' }),
            s.patchStoredSettings({ enabledDisk: true }),
            s.patchStoredSettings({ includeAssets: false })
        ]);
        return { data: await s.getStoredSettings(), keys: Object.keys(window.settingsData) };
    });
    assert.deepEqual(result, {
        data: { language: 'en', enabledDisk: true, includeAssets: false },
        keys: ['gemini_exporter_v2_settings']
    });
});

test('storage v2 scan cleanup rolls back Index, Detail, Coverage and ExportRecords together on failure', async () => {
    const result = await page.evaluate(async () => {
        const s = window.storage, key = { accountId: 'a', conversationId: 'same' };
        await s.putExportRecord(key, { exportedAt: 1, format: 'markdown', status: 'ok' });
        await s.updateCoverageAtomically('a', 'recent', () => ({ next: { range: null }, result: undefined }));
        await s.updateConversationAtomically(key, () => ({ index: { key },
            detail: { key, messages: [], assets: [], quality: { status: 'unknown' } }, result: undefined }));
        const nativeDelete = IDBObjectStore.prototype.delete;
        let rejected = false;
        IDBObjectStore.prototype.delete = function(query: IDBValidKey | IDBKeyRange) {
            if (this.name === 'exportRecords') throw new Error('injected cleanup failure');
            return nativeDelete.call(this, query);
        };
        try { await s.clearStoredAccountScanRecords('a'); } catch { rejected = true; }
        finally { IDBObjectStore.prototype.delete = nativeDelete; }
        return { rejected, index: !!await s.getIndex(key), detail: !!await s.getDetail(key),
            coverage: await s.getCoverage('a', 'recent'), record: await s.getExportRecord(key) };
    });
    assert.deepEqual(result, { rejected: true, index: true, detail: true, coverage: { range: null },
        record: { exportedAt: 1, format: 'markdown', status: 'ok' } });
});


test('storage v2 uses the correct native put signature for each key mode', async () => {
    const result = await page.evaluate(async () => {
        const nativePut = IDBObjectStore.prototype.put;
        const calls: Array<[string, number]> = [];
        IDBObjectStore.prototype.put = function(this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
            if (this.name === 'exportRecords' || this.name === 'directoryHandles')
                calls.push([this.name, arguments.length]);
            return arguments.length === 1 ? nativePut.call(this, value) : nativePut.call(this, value, key);
        };
        try {
            const key = { accountId: 'a', conversationId: 'check' };
            const record = { exportedAt: 1, format: 'markdown' as const, status: 'ok' as const };
            await window.storage.putExportRecord(key, record);
            await window.storage.setDirectoryHandle(await navigator.storage.getDirectory());
            return { calls, record: await window.storage.getExportRecord(key),
                handle: (await window.storage.getDirectoryHandle())?.kind };
        } finally {
            IDBObjectStore.prototype.put = nativePut;
        }
    });
    assert.deepEqual(result, { calls: [['exportRecords', 1], ['directoryHandles', 2]],
        record: { exportedAt: 1, format: 'markdown', status: 'ok' }, handle: 'directory' });
});
