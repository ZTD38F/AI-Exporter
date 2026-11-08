import test, { before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type Page } from 'playwright';
import { mount, read, A } from './helpers/uiPortHarness.js';

let browser: Browser, page: Page;
before(async () => { browser = await chromium.launch({ chromiumSandbox: true, headless: true }); });
afterEach(async () => { await page?.close(); });
after(async () => { await browser?.close(); });

async function open(count: number): Promise<void> {
    page = await browser.newPage();
    const indexes = Array.from({ length: count }, (_, i) => ({
        key: { accountId: A, conversationId: `bulk_${i}` }, title: `Bulk ${i}`, updatedAt: i,
    }));
    await mount(page, 'options', { indexes });
    await page.locator('#list .item').first().waitFor();
    await page.locator('#btnSelectAll').click();
}

test('up to 20 selected conversations export without a suggestion', async () => {
    await open(20);
    await page.locator('#btnExport').click();
    await page.waitForFunction(() => Reflect.get(window, 'harness').exports.length === 1);
    assert.equal(await page.locator('#directWriteModal').isVisible(), false);
    assert.deepEqual(await read(page, 'patches'), []);
    assert.equal((await read(page, 'exports'))[0].delivery, 'browserDownload');
});

test('21 conversations show a suggestion once, including when it is closed without exporting', async () => {
    await open(21);
    await page.locator('#btnExport').click();
    await page.locator('#directWriteModal').waitFor({ state: 'visible' });
    assert.match(await page.locator('#directWritePromptText').textContent() ?? '', /21 conversations/);
    assert.deepEqual(await read(page, 'patches'), [{ directWritePromptCompleted: true }]);
    assert.deepEqual(await read(page, 'exports'), []);

    await page.locator('#btnDirectWriteClose').click();
    assert.equal(await page.locator('#directWriteModal').isVisible(), false);
    await page.locator('#btnExport').click();
    await page.waitForFunction(() => Reflect.get(window, 'harness').exports.length === 1);
    assert.equal(await page.locator('#directWriteModal').isVisible(), false);
    assert.deepEqual(await read(page, 'patches'), [{ directWritePromptCompleted: true }]);
});

test('suggestion folder choice obtains permission in its click and auto-exports to the folder', async () => {
    await open(21);
    await page.locator('#btnExport').click();
    await page.locator('#directWriteModal').waitFor({ state: 'visible' });
    await page.locator('#btnModalSwitchFolder').click();
    await page.waitForFunction(() => Reflect.get(window, 'harness').exports.length === 1);
    const exports = await read(page, 'exports');
    assert.equal(exports[0].delivery, 'folderWriter');
    assert.equal(exports[0].keys.length, 21);
    assert.ok((await read(page, 'events')).includes('picker'));
    assert.deepEqual(await read(page, 'patches'), [
        { directWritePromptCompleted: true },
        { exportDelivery: 'folderWriter' },
    ]);
});
