import test, { before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type Page } from 'playwright';
import { A, mount, read } from './helpers/uiPortHarness.js';

let browser: Browser;
let page: Page;
before(async () => { browser = await chromium.launch({ chromiumSandbox: true, headless: true }); });
afterEach(async () => { await page?.close(); });
after(async () => { await browser?.close(); });

test('Popup on an ungranted site reuses the tutorial selector and preselects only that provider', async () => {
    for (const [provider, url] of [
        ['gemini', 'https://gemini.google.com/app/example'],
        ['chatgpt', 'https://chatgpt.com/c/example'],
        ['chatgpt', 'https://chat.openai.com/c/example'],
        ['claude', 'https://claude.ai/chat/example'],
        ['grok', 'https://grok.com/c/example'],
    ]) {
        page = await browser.newPage();
        await mount(page, 'popup', { tabs: [{ id: 9, active: true, url }],
            geminiAccess: false, chatgptAccess: false, claudeAccess: false, grokAccess: false });
        await page.locator('#popupPermission').waitFor({ state: 'visible' });
        assert.equal(await page.locator('#popupMain').isVisible(), false);
        assert.equal(await page.locator('#popupPermissionTitle').textContent(), 'Authorize AI platforms');
        assert.equal(await page.locator('#popupPermission .platform-permission-row').count(), 4);
        for (const candidate of ['gemini', 'chatgpt', 'claude', 'grok']) {
            const checked = await page.locator(
                '#popupPermission .platform-permission-row[data-platform="' + candidate + '"] input').isChecked();
            assert.equal(checked, candidate === provider, url + ' incorrectly selected ' + candidate);
        }
        assert.deepEqual(await read(page, 'tabRequests'), []);
        await page.close();
    }
});

test('Popup stays in authorization after denial and switches to export after current-site permission', async () => {
    page = await browser.newPage();
    await mount(page, 'popup', { tabs: [{ id: 9, active: true, url: 'https://chatgpt.com/c/one' }],
        chatgptAccess: false, permissionDenied: true });
    await page.locator('#popupPermission').waitFor({ state: 'visible' });
    await page.locator('#btnAuthorizePlatforms').click();
    await page.waitForFunction(() => document.querySelector('#popupPermission [role="status"]')?.textContent?.includes('not granted'));
    assert.equal(await page.locator('#popupMain').isVisible(), false);
    assert.deepEqual(await read(page, 'connectionRequests'), [[['chatgpt'], true]]);

    await page.evaluate(() => { Reflect.get(window, 'harness').permissionDenied = false; });
    await page.locator('#btnAuthorizePlatforms').click();
    await page.locator('#popupMain').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#popupPermission').isVisible(), false);
    assert.deepEqual(await read(page, 'connectionRequests'), [[['chatgpt'], true], [['chatgpt'], true]]);
    assert.deepEqual(await read(page, 'activatedPlatforms'), ['chatgpt']);
});

test('Popup remains normal for already-authorized providers and unrelated sites', async () => {
    for (const [url, granted] of [
        ['https://gemini.google.com/app/a', true],
        ['https://example.com/', false],
        ['chrome://extensions/', false],
    ] as const) {
        page = await browser.newPage();
        await mount(page, 'popup', { tabs: [{ id: 1, active: true, url }], geminiAccess: granted });
        await page.locator('#popupMain').waitFor({ state: 'visible' });
        assert.equal(await page.locator('#popupPermission').isVisible(), false);
        assert.equal(await page.locator('#btnAuthorizePlatforms').count(), 0);
        await page.close();
    }
});

test('Popup omits already-authorized choices while keeping the active ungranted provider selected', async () => {
    page = await browser.newPage();
    await mount(page, 'popup', {
        tabs: [{ id: 7, active: true, url: 'https://claude.ai/chat/fixture' }],
        geminiAccess: true, grokAccess: true, chatgptAccess: false, claudeAccess: false,
    });
    await page.locator('#popupPermission').waitFor({ state: 'visible' });
    await page.locator('.platform-permission-row[data-platform="claude"]').waitFor({ state: 'visible' });
    for (const authorized of ['gemini', 'grok']) {
        assert.equal(await page.locator('.platform-permission-row[data-platform="' + authorized + '"]').isVisible(), false);
    }
    assert.equal(await page.getByRole('checkbox', { name: 'Claude', exact: true }).isChecked(), true);
    assert.equal(await page.getByRole('checkbox', { name: 'ChatGPT', exact: true }).isChecked(), false);
    await page.locator('#btnAuthorizePlatforms').click();
    await page.locator('#popupMain').waitFor({ state: 'visible' });
    assert.deepEqual(await read(page, 'connectionRequests'), [[['claude'], true]]);
});

test('A grant for a different provider does not bypass authorization for the current site', async () => {
    page = await browser.newPage();
    await mount(page, 'popup', { tabs: [{ id: 1, active: true, url: 'https://claude.ai/chat/test' }],
        claudeAccess: false, geminiAccess: true });
    await page.locator('#popupPermission').waitFor({ state: 'visible' });
    await page.getByRole('checkbox', { name: 'Claude', exact: true }).uncheck();
    await page.getByRole('checkbox', { name: 'Grok', exact: true }).check();
    await page.locator('#btnAuthorizePlatforms').click();
    await page.locator('.platform-permission-row[data-platform="grok"]').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('.platform-permission-row[data-platform="gemini"]').isVisible(), false);
    assert.equal(await page.locator('.platform-permission-row[data-platform="claude"]').isVisible(), true);
    assert.equal(await page.locator('#popupPermission').isVisible(), true);
    assert.equal(await page.locator('#popupMain').isVisible(), false);
    assert.deepEqual(await read(page, 'connectionRequests'), [[['grok'], true]]);
});

test('Popup admits only valid L2 conversation keys from Content IPC', async () => {
    for (const [conversationId, canExport] of [
        ['a', true],
        ['', false],
        ['   ', false],
        [' a ', false],
        [123, false],
        [null, false],
    ] as const) {
        page = await browser.newPage();
        await mount(page, 'popup', {
            contextReply: { ok: true, accountContext: { accountId: A, providerId: 'gemini' }, conversationId },
        });
        await page.locator('#popupMain').waitFor({ state: 'visible' });
        assert.equal(await page.locator('#btnCurrent').isEnabled(), canExport, JSON.stringify(conversationId));
        if (!canExport) {
            assert.equal(await page.locator('#status').textContent(), 'Open a supported conversation first');
        }
        await page.close();
    }
});

test('Popup displays the active 429 wait and restores export text when it ends', async () => {
    page = await browser.newPage();
    await mount(page, 'popup', { holdExport: true });
    await page.waitForFunction(() => !(document.getElementById('btnCurrent') as HTMLButtonElement).disabled);
    await page.locator('#btnCurrent').click();
    await page.waitForFunction(() => !!Reflect.get(window, 'harness').exportOptions);
    await page.evaluate(() => Reflect.get(window, 'harness').exportOptions.onDiagnostic({
        code: 'CHATGPT_BACKOFF_WAIT', details: { requestId: 'popup', retryAt: Date.now() + 60000 },
    }));
    assert.match(await page.locator('#status').innerText(), /429.*backing off/);
    await page.evaluate(() => Reflect.get(window, 'harness').exportOptions.onDiagnostic({
        code: 'CHATGPT_BACKOFF_END', details: { requestId: 'popup' },
    }));
    assert.equal(await page.locator('#status').innerText(), 'Preparing export…');
    await page.evaluate(() => Reflect.get(window, 'harness').finishExport());
    await page.waitForFunction(() => document.getElementById('status')?.textContent === 'Download initiated');
});
