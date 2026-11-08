import test, { before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type Page } from 'playwright';
import { mount, read, B } from './helpers/uiPortHarness.js';

let browser: Browser, page: Page;
before(async () => { browser = await chromium.launch({ chromiumSandbox: true, headless: true }); });
afterEach(async () => { await page?.close(); });
after(async () => { await browser?.close(); });

test('reentrant cleanup cannot stack dialogs, and cancel followed by confirm clears only once', async () => {
    page = await browser.newPage();
    await mount(page, 'options');
    await page.locator('#btnMoreActions').click();
    await page.locator('#btnClearScan').click();
    await page.locator('#btnClearScan').dispatchEvent('click');
    assert.equal(await page.locator('dialog[open]').count(), 1);
    await page.locator('#btnCleanupCancel').click();
    assert.deepEqual(await read(page, 'clears'), []);
    await page.locator('#btnMoreActions').click();
    await page.locator('#btnClearScan').click();
    await page.locator('#btnCleanupConfirm').click();
    await page.waitForFunction(() => Reflect.get(window, 'harness').clears.length === 1);
    assert.equal((await read(page, 'clears'))[0][0], 'scan');
});

test('a confirmation for a previous account cannot clear either account after switching', async () => {
    page = await browser.newPage();
    await mount(page, 'options');
    await page.locator('#btnMoreActions').click();
    await page.locator('#btnClearScan').click();
    // Simulate account state changing from outside the inert modal background.
    await page.locator('#accountIdSelect').evaluate((node, accountId) => {
        (node as HTMLSelectElement).value = accountId;
        node.dispatchEvent(new Event('change'));
    }, B);
    await page.waitForFunction(accountId => (document.getElementById('accountIdSelect') as HTMLSelectElement).value === accountId && document.getElementById('list')?.textContent?.includes('B chat'), B);
    await page.locator('#btnCleanupConfirm').click();
    await page.waitForFunction(() => !document.querySelector('dialog[open]'));
    assert.deepEqual(await read(page, 'clears'), []);
});

test('busy scanning and an existing export suggestion cannot open a cleanup dialog', async () => {
    page = await browser.newPage();
    await mount(page, 'options', { holdScan: true });
    await page.locator('#btnSyncAll').click();
    await page.locator('#btnClearScan').dispatchEvent('click');
    assert.equal(await page.locator('#cleanupModal').isVisible(), false);
    assert.deepEqual(await read(page, 'clears'), []);
    await page.evaluate(() => Reflect.get(window, 'harness').finishScan());
    await page.waitForFunction(() => document.body.dataset.busy === 'false');
    // Use an existing modal to exercise modal exclusion without invoking IO.
    await page.locator('#directWriteModal').evaluate(node => (node as HTMLDialogElement).showModal());
    await page.locator('#btnClearScan').dispatchEvent('click');
    assert.equal(await page.locator('dialog[open]').count(), 1);
    assert.equal(await page.locator('#cleanupModal').isVisible(), false);
    assert.deepEqual(await read(page, 'clears'), []);
});
