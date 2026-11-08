import test from 'node:test';
import assert from 'node:assert/strict';
import { indexStorage } from './helpers/indexStorage.js';
import { listExportRecords, putExportRecord } from '../src/l3a/storageService.js';
import { ensureUpgraded } from '../src/migration/upgradeV1.js';
import { ConversationViewState } from '../src/ui/options/state/conversationsStore.js';
import { v2ExportHost, exportKey, exportRequest, seedExportConversation } from './helpers/v2ExportHost.js';
import { runExport } from '../src/application/export/runExport.js';
import { ingestDetail } from '../src/l2/ingestion.js';
import { __getZipConstructor, __setZipConstructor } from '../src/l4/packaging/writers/zipWriter.js';

const accountId = exportKey('').accountId;
const record = (exportedAt: number) => ({ exportedAt, format: 'markdown' as const, status: 'ok' as const });
async function seedLegacyAccount() {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('gemini_exporter_domain', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('accounts', { keyPath: 'id' });
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    try { await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('accounts', 'readwrite');
        tx.objectStore('accounts').put({ id: accountId, providerId: 'gemini', providerAccountId: '10000000001' });
        tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
    }); } finally { db.close(); }
}

for (const entries of [
    { c_abc123: record(100) },
    { abc123: record(200), c_abc123: record(100) },
    { c_abc123: record(100), abc123: record(200) },
]) {
    test(`historical aliases migrate once, canonical wins regardless of insertion order: ${Object.keys(entries)}`, async () => {
        const env = indexStorage({ [`exported_${accountId}`]: entries });
        try {
            await seedLegacyAccount();
            assert.deepEqual(await listExportRecords(accountId), {});
            await ensureUpgraded();
            const expected = entries.abc123 ?? entries.c_abc123;
            assert.deepEqual(await listExportRecords(accountId), { abc123: expected });
            const writes = env.writes();
            await ensureUpgraded();
            assert.deepEqual(await listExportRecords(accountId), { abc123: expected });
            assert.equal(env.writes(), writes, 'normal reads and completed migration do not rewrite records');
        } finally { env.restore(); }
    });
}

test('real export writes a single canonical record; UI consumes the same key', async t => {
    v2ExportHost(t);
    await seedExportConversation('abc123');
    assert.equal((await runExport(exportRequest(['abc123']))).exported, 1);
    const stored = await listExportRecords(accountId);
    assert.deepEqual(Object.keys(stored), ['abc123']);
    assert.deepEqual(Object.keys(stored.abc123).sort(), ['chatTime', 'exportedAt', 'format', 'status']);
    const view = new ConversationViewState(); view.selectAccount(accountId); await view.refresh();
    assert.deepEqual(view.records, stored);
    assert.equal(view.records.c_abc123, undefined);
});

test('a completed request can be repeated with skip without another delivery', async t => {
    const host = v2ExportHost(t);
    await seedExportConversation('repeat');
    await runExport(exportRequest(['repeat']));
    assert.equal((await runExport(exportRequest(['repeat'], { skipUnchanged: true }))).skipped, 1);
    assert.equal(host.clicks(), 1);
    assert.deepEqual(Object.keys(await listExportRecords(accountId)), ['repeat']);
});

test('same conversation ID in two accounts never aliases their records', async () => {
    const env = indexStorage();
    try {
        const other = '10000000-0000-4000-8000-000000000002';
        await putExportRecord({ accountId, conversationId: 'same' }, record(100));
        await putExportRecord({ accountId: other, conversationId: 'same' }, record(200));
        assert.deepEqual(await listExportRecords(accountId), { same: record(100) });
        assert.deepEqual(await listExportRecords(other), { same: record(200) });
    } finally { env.restore(); }
});

test('failed resources persist only minimal partial status after real delivery', async t => {
    const host = v2ExportHost(t);
    const previousZip = __getZipConstructor();
    __setZipConstructor(require('../lib/jszip.min.js'));
    t.after(()=>__setZipConstructor(previousZip));
    await ingestDetail(accountId, 'partial', {
        savedAt: 100, quality: { status: 'complete' }, assets: [{ id: 'missing', kind: 'image' }],
        messages: [{ role: 'assistant', content: [{ type: 'image', assetId: 'missing' }] }],
    }, { title: 'Partial', titleSource: 'provider', updatedAt: 100 });
    const result = await runExport(exportRequest(['partial'], { includeAssets: true }));
    assert.equal(result.exported, 1); assert.equal(result.partial, 1); assert.equal(host.clicks(), 1);
    const records = await listExportRecords(accountId);
    assert.equal(records.partial.status, 'partial');
    assert.equal('hasFailedAssets' in records.partial, false);
    assert.equal('title' in records.partial, false);
});

test('empty conversations use current ok/partial status without the retired empty record state', async t => {
    v2ExportHost(t);
    await ingestDetail(accountId, 'empty', { savedAt: 100, quality: { status: 'complete' }, assets: [], messages: [] },
        { title: 'Empty', titleSource: 'provider', updatedAt: 100 });
    assert.equal((await runExport(exportRequest(['empty']))).exported, 1);
    assert.equal((await listExportRecords(accountId)).empty.status, 'ok');
});

test('legacy partial export record shows incomplete export badge in both locales', async () => {
    const { chromium } = await import('playwright');
    const { mount, A } = require('./helpers/uiPortHarness.js') as typeof import('./helpers/uiPortHarness.js');
    const browser = await chromium.launch({ chromiumSandbox: true, headless: true });
    try {
        const page = await browser.newPage();
        await mount(page, 'options', { records: { [A]: { a: { ...record(100), status: 'partial' } } } });
        await page.locator('.status-partial').waitFor();
        assert.equal(await page.locator('.status-partial').textContent(), 'Incomplete export');
        await page.locator('#langToggle').setChecked(false);
        await page.waitForFunction(() => document.querySelector('.status-partial')?.textContent === '导出不完整');
    } finally { await browser.close(); }
});
