import test, { before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type Page } from 'playwright';
import { mount, read } from './helpers/uiPortHarness.js';
let browser: Browser, page: Page;
before(async () => { browser = await chromium.launch({ chromiumSandbox: true, headless: true }); });
afterEach(async () => { await page?.close(); }); after(async () => { await browser?.close(); });
async function open(patch: Record<string, unknown>) { page = await browser.newPage(); await mount(page, 'options', patch); await page.locator('#list .item').waitFor(); }

test('Options restores directory capability and toggles only the Settings enabledDisk intention', async () => {
    await open({ directoryName: 'MyVault', settings: { enabledDisk: false } });
    assert.equal(await page.locator('#liveSaveDiskToggle').isChecked(), false);
    assert.equal(await page.locator('input[name="delivery"][value="browserDownload"]').isChecked(), true);
    assert.equal(await page.locator('#btnSetDir').isDisabled(), true);
    assert.equal(await page.locator('#liveSaveDiskToggle').isDisabled(), true);
    assert.equal(await page.locator('.local-card-details #dirBox').isVisible(), true);
    assert.equal(await page.locator('.local-card-details #liveSaveControls').count(), 1);
    assert.match(await page.locator('#dirLabel').textContent() ?? '', /MyVault/);
    await page.locator('input[name="delivery"][value="folderWriter"]').check();
    await page.locator('#liveSaveDiskToggle').check(); await page.waitForFunction(() => document.body.dataset.busy !== 'true');
    assert.equal((await read(page, 'settings')).enabledDisk, true); assert.deepEqual((await read(page, 'patches')).at(-1), { enabledDisk: true });
    await page.locator('#liveSaveDiskToggle').uncheck(); await page.waitForFunction(() => document.body.dataset.busy !== 'true');
    assert.equal((await read(page, 'settings')).enabledDisk, false); assert.deepEqual((await read(page, 'patches')).at(-1), { enabledDisk: false });
});
test('Options explicit folder authorization persists the handle and resumes effective Live Save', async () => {
    await open({ settings: { enabledDisk: true, exportDelivery: 'folderWriter' } });
    await page.locator('#btnSetDir').click(); await page.waitForFunction(() => document.body.dataset.busy !== 'true');
    assert.ok((await read(page, 'events')).includes('picker')); assert.match(await page.locator('#dirLabel').textContent() ?? '', /Chosen folder/);
    assert.equal((await read(page, 'settings')).enabledDisk, true);
    assert.match(await page.locator('#liveSaveStatus').textContent() ?? '', /active/i);
});
test('cancelling the folder picker preserves the existing enabled intention and does not invent a handle', async () => {
    await open({ cancelPicker: true, settings: { enabledDisk: false } });
    assert.equal(await page.locator('input[name="delivery"][value="browserDownload"]').isChecked(), true);
    assert.equal(await page.locator('#btnSetDir').isDisabled(), true);
    await page.locator('input[name="delivery"][value="folderWriter"]').check();
    await page.locator('#btnSetDir').click(); await page.waitForFunction(() => document.body.dataset.busy !== 'true');
    assert.equal(await read(page, 'directory'), null); assert.equal((await read(page, 'settings')).enabledDisk, false);
    assert.equal(await page.locator('#liveSaveDiskToggle').isChecked(), false);
});
test('an unavailable directory pauses Live Save without clearing the persisted enabled intention', async () => {
    await open({ directoryName: 'MissingVault', permission: 'denied', settings: { enabledDisk: true, exportDelivery: 'folderWriter' } });
    assert.equal(await page.locator('#liveSaveDiskToggle').isChecked(), true);
    assert.equal(await page.locator('#liveSaveDiskToggle').isDisabled(), true);
    assert.equal((await read(page, 'settings')).enabledDisk, true);
    assert.match(await page.locator('#liveSaveStatus').textContent() ?? '', /authorize|Paused/i);
    assert.equal((await read(page, 'patches')).length, 0);
});
