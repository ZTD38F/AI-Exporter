import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mount, A } from './helpers/uiPortHarness.js';
import { errorText } from '../src/ui/shared/settings.js';

test('headless UI status helpers present readable failures without requiring a DOM', () => {
    const expected = 'Operation failed. Please retry; details are available in the logs or diagnostic report.';
    assert.equal(errorText(new Error('Offline')), expected); assert.equal(errorText('Aborted'), expected);
});
test('body delivery advances its counter while attachments remain active, and cancellation reports the preserved document', async () => {
    const browser = await chromium.launch({chromiumSandbox: true, headless:true});
    try {
        const page = await browser.newPage();
        await mount(page,'options',{holdExport:true});
        await page.locator('#btnSelectAll').click();
        await page.locator('#btnExport').click();
        await page.evaluate(()=>{
            const h = Reflect.get(window,'harness');
            const key = h.exports[0].keys[0];
            h.exportOptions.onBodyDelivered(key);
            h.exportOptions.onResourceProgress({key,completed:0,total:2,downloaded:0});
        });
        assert.equal(await page.locator('#progText').textContent(),'Prepared 1 conversations · delivered 1 documents · downloaded 0 attachments');
        assert.equal(await page.locator('body').getAttribute('data-busy'),'true');
        assert.equal(await page.locator('#splitDeliveryHint').count(),0);
        assert.equal(await page.locator('.status-exported').count(),0);
        await page.locator('#btnCancel').click();
        await page.evaluate(()=>Reflect.get(window,'harness').finishExport());
        await page.waitForFunction(()=>document.body.dataset.busy!=='true');
        assert.match(await page.locator('#status').textContent()??'',/Cancelled; Documents already delivered: 1/);
    } finally { await browser.close(); }
});
test('current progress status displays committed counts, final result and clears busy controls', async () => {
    const browser = await chromium.launch({ chromiumSandbox: true, headless: true }); try {
        const page = await browser.newPage(); await mount(page, 'options', { holdScan: true });
        await page.locator('#btnSyncAll').click(); await page.waitForFunction(() => document.body.dataset.busy === 'true');
        assert.equal(await page.locator('#scanStatus').textContent(), 'Committed 2 pages, 150 source entries');
        assert.equal(await page.locator('#scanStatus').getAttribute('aria-live'), 'polite');
        assert.equal(await page.locator('#progWrap').isVisible(), false);
        assert.equal(await page.locator('#btnSyncAll').textContent(), 'Stop sync');
        assert.doesNotMatch(await page.locator('#scanStatus').textContent() ?? '', /%/);
        await page.evaluate(() => Reflect.get(window, 'harness').finishScan()); await page.waitForFunction(() => document.body.dataset.busy !== 'true');
        assert.match(await page.locator('#scanStatus').textContent() ?? '', /Local page budget reached/); assert.equal(await page.locator('#btnSyncAll').isEnabled(), true);
        assert.equal(await page.locator('#progWrap').isVisible(), false);
    } finally { await browser.close(); }
});
test('a subsequent operation keeps its current progress after the previous task completes; no stale delayed hide erases it', async () => {
    const browser = await chromium.launch({chromiumSandbox: true, headless:true});try{
        const page=await browser.newPage();await page.clock.install();await mount(page,'options',{holdScan:true});
        await page.locator('#btnSyncAll').click();await page.evaluate(()=>Reflect.get(window,'harness').finishScan());await page.waitForFunction(()=>document.body.dataset.busy!=='true');
        await page.locator('#btnSyncAll').click();await page.clock.fastForward(1000);assert.equal(await page.locator('#scanStatus').textContent(),'Committed 2 pages, 150 source entries');assert.equal(await page.locator('#btnSyncAll').isVisible(),true);
        await page.evaluate(()=>Reflect.get(window,'harness').finishScan());await page.waitForFunction(()=>document.body.dataset.busy!=='true');assert.equal(await page.locator('#btnSyncAll').textContent(),'Sync All');
    }finally{await browser.close();}
});


test('Browser export visibly stages each result before ZIP delivery without marking an ExportRecord', async () => {
    const browser = await chromium.launch({ chromiumSandbox: true, headless: true });
    try {
        const page = await browser.newPage();
        await mount(page, 'options', { holdExport: true, indexes: [
            { key: { accountId: A, conversationId: 'one' }, title: 'One', updatedAt: 100 },
            { key: { accountId: A, conversationId: 'two' }, title: 'Two', updatedAt: 100 },
        ] });
        await page.locator('#btnSelectAll').click();
        await page.locator('#btnExport').click();
        await page.waitForFunction(() => typeof Reflect.get(window, 'harness').finishExport === 'function');

        await page.evaluate(() => {
            const h = Reflect.get(window, 'harness');
            h.exportOptions.onItemUpdate({ key: h.indexes[0].key, status: 'prepared' });
        });
        assert.equal(await page.locator('[data-chat-id="one"] .status-prepared').textContent(), 'Rendered, awaiting download');
        assert.equal(await page.locator('[data-chat-id="one"] .status-exported').count(), 0);
        assert.match(await page.locator('#bar').getAttribute('style') ?? '', /width:\s*45%/);
        assert.equal(await page.evaluate(() => Object.keys(Reflect.get(window, 'harness').records).length), 0);

        await page.evaluate(() => {
            const h = Reflect.get(window, 'harness');
            const record = { format: 'markdown', exportedAt: 200, chatTime: 100, status: 'ok' };
            h.records[h.indexes[0].key.accountId] = { one: record };
            h.exportOptions.onItemUpdate({ key: h.indexes[0].key, status: 'exported', record });
        });
        assert.match(await page.locator('[data-chat-id="one"] .status-exported').textContent() ?? '', /^Export successful \(.+\)$/);
        assert.equal(await page.locator('.status-prepared').count(), 0);
        await page.evaluate(() => Reflect.get(window, 'harness').finishExport());
        await page.waitForFunction(() => document.body.dataset.busy !== 'true');
        assert.equal(await page.locator('[data-chat-id="one"] .status-exported').count(), 1);
    } finally { await browser.close(); }
});

test('Folder export updates persisted item badges and the bar before the full batch finishes', async () => {
    const browser = await chromium.launch({ chromiumSandbox: true, headless: true });
    try {
        const page = await browser.newPage();
        await mount(page, 'options', { holdExport: true, directoryName: 'exports',
            settings: { exportDelivery: 'folderWriter' }, indexes: [
                { key: { accountId: A, conversationId: 'one' }, title: 'One', updatedAt: 100 },
                { key: { accountId: A, conversationId: 'two' }, title: 'Two', updatedAt: 100 },
            ] });
        await page.locator('#btnSelectAll').click();
        await page.locator('#btnExport').click();
        await page.waitForFunction(() => typeof Reflect.get(window, 'harness').finishExport === 'function');

        await page.evaluate(() => {
            const h = Reflect.get(window, 'harness');
            const record = { format: 'markdown', exportedAt: 200, chatTime: 100, status: 'ok' };
            h.records[h.indexes[0].key.accountId] = { one: record };
            h.exportOptions.onItemUpdate({ key: h.indexes[0].key, status: 'exported', record });
        });
        assert.match(await page.locator('[data-chat-id="one"] .status-exported').textContent() ?? '', /^Export successful \(.+\)$/);
        assert.equal(await page.locator('[data-chat-id="two"] .status-exported').count(), 0);
        assert.match(await page.locator('#bar').getAttribute('style') ?? '', /width:\s*50%/);
        assert.equal(await page.locator('#status').textContent(), 'Prepared 1 conversations · delivered 1 documents · downloaded 0 attachments');

        await page.evaluate(() => Reflect.get(window, 'harness').finishExport());
        await page.waitForFunction(() => document.body.dataset.busy !== 'true');
    } finally { await browser.close(); }
});

test('failed export temporarily overrides an old success badge and retry clears it', async () => {
    const browser = await chromium.launch({ chromiumSandbox: true, headless: true });
    try {
        const page = await browser.newPage();
        await mount(page, 'options', { holdExport: true, failExport: true,
            indexes: [{ key: { accountId: A, conversationId: 'one' }, title: 'One', updatedAt: 100 }],
            records: { [A]: { one: { format: 'markdown', exportedAt: 200, chatTime: 100, status: 'ok' } } }
        });
        assert.match(await page.locator('[data-chat-id="one"] .status-exported').textContent() ?? '', /^Export successful/);
        await page.locator('#btnSelectAll').click();
        await page.locator('#btnExport').click();
        await page.waitForFunction(() => typeof Reflect.get(window, 'harness').finishExport === 'function');
        await page.evaluate(() => {
            const h = Reflect.get(window, 'harness');
            h.exportOptions.onItemUpdate({ key: h.indexes[0].key, status: 'failed', diagnostic: { stage: 'export', code: 'EXPORT_FAILED', message: 'Injected failure' } });
        });
        assert.equal(await page.locator('[data-chat-id="one"] .status-failed').textContent(), 'Export failed');
        assert.equal(await page.locator('[data-chat-id="one"] .status-exported').count(), 0);
        await page.evaluate(() => Reflect.get(window, 'harness').finishExport());
        await page.waitForFunction(() => document.body.dataset.busy !== 'true');
        assert.equal(await page.locator('[data-chat-id="one"] .status-failed').textContent(), 'Export failed');
        await page.evaluate(() => { const h = Reflect.get(window, 'harness'); h.failExport = false; h.holdExport = false; });
        await page.locator('#btnRetryFailed').click();
        await page.waitForFunction(() => Reflect.get(window, 'harness').exports.length === 2 && document.body.dataset.busy !== 'true');
        assert.match(await page.locator('[data-chat-id="one"] .status-exported').textContent() ?? '', /^Export successful/);
        assert.equal(await page.locator('.status-failed').count(), 0);
    } finally { await browser.close(); }
});

test('cancelling and final refresh keep one operation owner and reject subsequent progress', async () => {
    const browser = await chromium.launch({ chromiumSandbox: true, headless: true });
    try {
        const page = await browser.newPage();
        await mount(page, 'options', { holdExport: true, holdRefresh: true });
        await page.locator('#btnSelectAll').click();
        await page.locator('#btnExport').click();
        await page.waitForFunction(() => !!Reflect.get(window, 'harness').finishExport);
        await page.evaluate(() => {
            const h = Reflect.get(window, 'harness');
            h.aborts = 0;
            h.exportOptions.signal.addEventListener('abort', () => h.aborts++);
        });
        await page.locator('#btnCancel').click();
        assert.equal(await page.locator('#btnCancel').isDisabled(), true);
        assert.equal(await page.locator('#btnCancel').innerText(), 'Cancelling…');
        await page.locator('#btnCancel').dispatchEvent('click');
        await page.evaluate(() => {
            const h = Reflect.get(window, 'harness');
            h.exportOptions.onResourceProgress({ downloaded: 99, completed: 99, total: 100 });
        });
        assert.equal(await page.locator('#status').innerText(), 'Cancelling…');
        assert.equal(await page.evaluate(() => Reflect.get(window, 'harness').aborts), 1);
        await page.evaluate(() => Reflect.get(window, 'harness').finishExport());
        await page.waitForFunction(() => !!Reflect.get(window, 'harness').finishRefresh);
        assert.equal(await page.locator('#btnCancel').innerText(), 'Refreshing history…');
        assert.equal(await page.locator('#btnExport').isDisabled(), true);
        assert.equal(await page.locator('#btnSyncAll').isDisabled(), true);
        await page.locator('#langToggle').uncheck();
        assert.equal(await page.locator('#btnCancel').innerText(), '正在刷新记录…');
        await page.evaluate(() => Reflect.get(window, 'harness').finishRefresh());
        await page.waitForFunction(() => document.body.dataset.foregroundBusy === 'false');
        assert.equal(await page.locator('#btnCancel').isVisible(), false);
        assert.equal(await page.locator('#btnExport').isEnabled(), true);
    } finally { await browser.close(); }
});

test('a settled export cannot mutate a new task through retained Application callbacks', async () => {
    const browser = await chromium.launch({ chromiumSandbox: true, headless: true });
    try {
        const page = await browser.newPage();
        await mount(page, 'options', { holdExport: true });
        await page.locator('#btnSelectAll').click();
        await page.locator('#btnExport').click();
        await page.waitForFunction(() => !!Reflect.get(window, 'harness').finishExport);
        await page.evaluate(() => {
            const h = Reflect.get(window, 'harness');
            h.oldOptions = h.exportOptions;
            h.finishExport();
        });
        await page.waitForFunction(() => document.body.dataset.foregroundBusy === 'false');
        await page.locator('#btnExport').click();
        await page.waitForFunction(() => Reflect.get(window, 'harness').exports.length === 2);
        const before = await page.locator('#progText').innerText();
        await page.evaluate(() => {
            const h = Reflect.get(window, 'harness');
            const key = h.exports[0].keys[0];
            h.oldOptions.onResourceProgress({ key, downloaded: 999, completed: 999, total: 999 });
            h.oldOptions.onItemUpdate({ key, status: 'failed', diagnostic: { key, stage: 'export', code: 'EXPORT_FAILED', message: 'Old task failure' } });
            h.oldOptions.onDiagnostic({ key, stage: 'source_parse', code: 'OLD_WARNING', severity: 'warning', message: 'Old task warning' });
        });
        assert.equal(await page.locator('#progText').innerText(), before);
        assert.equal(await page.locator('.status-failed').count(), 0);
        assert.equal(await page.locator('#exportFailureCard').isVisible(), false);
        await page.evaluate(() => Reflect.get(window, 'harness').finishExport());
        await page.waitForFunction(() => document.body.dataset.foregroundBusy === 'false');
    } finally { await browser.close(); }
});

test('live failure details retain their expansion across progress and language changes', async () => {
    const browser = await chromium.launch({ chromiumSandbox: true, headless: true });
    try {
        const page = await browser.newPage();
        await mount(page, 'options', { holdExport: true });
        await page.locator('#btnSelectAll').click();
        await page.locator('#btnExport').click();
        await page.evaluate(() => {
            const h = Reflect.get(window, 'harness');
            const key = h.exports[0].keys[0];
            h.exportOptions.onItemUpdate({ key, status: 'failed', diagnostic: { key, stage: 'export', code: 'EXPORT_FAILED', message: 'Live failure' } });
        });
        const details = page.locator('#exportFailureList details');
        await details.locator('summary').click();
        assert.equal(await page.locator('#btnRetryFailed').isDisabled(), true);
        await page.locator('#langToggle').uncheck();
        await page.evaluate(() => Reflect.get(window, 'harness').exportOptions.onResourceProgress({ downloaded: 2, completed: 2, total: 3 }));
        assert.equal(await details.evaluate((node: HTMLDetailsElement) => node.open), true);
        assert.match(await details.locator('summary').innerText(), /未知错误/);
        await page.evaluate(() => Reflect.get(window, 'harness').finishExport());
        await page.waitForFunction(() => document.body.dataset.foregroundBusy === 'false');
    } finally { await browser.close(); }
});
