import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mount, read } from './helpers/uiPortHarness.js';

// Runtime IPC timers, chrome.runtime.lastError and directory permission internals
// are tested by Runtime's own suites, not by UI unit tests. Here only the
// Popup/Options response to the frozen mocked v2 transport is under test.

test('failed Scan releases Options controls and reports the Runtime/Sync error', async () => {
    const browser = await chromium.launch({ chromiumSandbox: true, headless: true });
    try {
        const page = await browser.newPage();
        await mount(page, 'options', { failScan: true });
        await page.locator('#btnSyncAll').click();
        await page.waitForFunction(() => document.body.dataset.busy !== 'true');
        assert.equal(await page.locator('#scanStatus').textContent(), 'Operation failed. Please retry; details are available in the logs or diagnostic report.');
        assert.equal(await page.locator('#btnSyncAll').isEnabled(), true);
    } finally { await browser.close(); }
});

test('Popup passes a bounded v2 current-context request and releases busy state on error', async () => {
    const browser = await chromium.launch({ chromiumSandbox: true, headless: true });
    try {
        const page = await browser.newPage();
        await mount(page, 'popup');
        await page.waitForFunction(() => !(document.getElementById('btnCurrent') as HTMLButtonElement).disabled);
        const first = await read(page, 'tabRequests');
        assert.deepEqual(first, [{ tabId: 1, message: { action: 'getAccountContext' }, timeoutMs: 3000 }]);
        await page.evaluate(() => {
            chrome.tabs.sendMessage = (async () => { throw new Error('Context request timed out'); }) as typeof chrome.tabs.sendMessage;
        });
        await page.locator('#btnCurrent').click();
        await page.waitForFunction(() => document.getElementById('status')?.textContent === 'Operation failed. Please retry; details are available in the logs or diagnostic report.');
        assert.equal(await page.locator('#btnCurrent').isEnabled(), true);
        const second = await read(page, 'tabRequests');
        assert.deepEqual(second.at(-1), { tabId: 1, message: { action: 'getAccountContext' }, timeoutMs: 3000 });
        assert.equal(second.length, 2);
    } finally { await browser.close(); }
});
