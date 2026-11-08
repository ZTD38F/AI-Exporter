import test, { before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type Page } from 'playwright';
import { A, B, mount, read } from './helpers/uiPortHarness.js';
let browser: Browser, page: Page;
before(async () => { browser = await chromium.launch({ chromiumSandbox: true, headless: true }); });
afterEach(async () => { await page?.close(); });
after(async () => { await browser?.close(); });
const records = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, i) => [String(i), { status: 'ok', format: 'markdown', exportedAt: 1 }]));
async function open(patch: Record<string, unknown> = {}) {
    page = await browser.newPage();
    await mount(page, 'options', patch);
    await page.locator('#list .item input').first().check();
}
async function exportSelected() {
    await page.locator('#btnExport').click();
    await page.waitForFunction(() => document.body.dataset.foregroundBusy === 'false');
    await page.waitForTimeout(100);
}

test('nine distinct conversations stay below the threshold even after repeated exports', async () => {
    await open({ records: { [A]: records(9) } });
    await exportSelected(); await exportSelected();
    assert.equal(await page.locator('#ratingPrompt').count(), 0);
});

test('the tenth successful conversation shows the invitation only after export completes; dismissal persists', async () => {
    await open({ holdExport: true, records: { [A]: records(9) } });
    await page.locator('#btnExport').click();
    await page.waitForFunction(() => typeof Reflect.get(window, 'harness').finishExport === 'function');
    assert.equal(await page.locator('#ratingPrompt').count(), 0);
    await page.evaluate(({ A }) => {
        const h = Reflect.get(window, 'harness');
        h.records[A].tenth = { status: 'ok', format: 'markdown', exportedAt: 2 };
        h.finishExport();
    }, { A });
    await page.locator('#ratingPrompt').waitFor();
    assert.equal(await page.locator('body').getAttribute('data-foreground-busy'), 'false');
    await page.locator('#ratingPromptDismiss').click();
    await page.waitForFunction(() => Reflect.get(window, 'harness').settings.ratingPromptDismissed);
    await page.evaluate(() => { Reflect.get(window, 'harness').holdExport = false; });
    await exportSelected();
    assert.equal(await page.locator('#ratingPrompt').count(), 0);
});

test('successful records count across accounts; partial outcomes do not count', async () => {
    await open({ records: { [A]: records(5), [B]: { ...records(4), partial: { status: 'partial', format: 'html', exportedAt: 1 } } } });
    await exportSelected();
    assert.equal(await page.locator('#ratingPrompt').count(), 0);
    await page.evaluate(({ B }) => { Reflect.get(window, 'harness').records[B].partial.status = 'ok'; }, { B });
    await exportSelected();
    await page.locator('#ratingPrompt').waitFor();
    assert.equal(await page.locator('#ratingPromptRate').getAttribute('href'), 'https://chromewebstore.google.com/detail/gemini-exporter/ldpbiafkgjlaooeplkiooljccpalpkgf/reviews');
    await page.locator('#ratingPromptRate').click();
    await page.waitForFunction(() => Reflect.get(window, 'harness').settings.ratingPromptDismissed);
    assert.equal(await page.locator('#ratingPrompt').count(), 0);
    await page.waitForFunction(() => (Reflect.get(window, 'harness').openedUrls ?? []).length === 1);
    assert.match((await read(page, 'openedUrls'))[0], /ldpbiafkgjlaooeplkiooljccpalpkgf\/reviews$/);
});

for (const patch of [{ failExport: true }, { failExport: true, partial: true }, { settings: { ratingPromptDismissed: true } }]) {
    test(`unsuccessful exports or an existing dismissal never show an invitation: ${JSON.stringify(patch)}`, async () => {
        await open({ records: { [A]: records(10) }, ...patch });
        await exportSelected();
        assert.equal(await page.locator('#ratingPrompt').count(), 0);
    });
}

test('the invitation waits behind the tutorial and Takeout, and appears when the overlay closes', async () => {
    await open({ records: { [A]: records(10) } });
    await page.evaluate(async () => { const tour = Reflect.get(window, 'testUi').tour; await tour.startTour(); await tour.goToStep(6); });
    await exportSelected();
    await page.waitForFunction(() => !!document.getElementById('ratingPrompt'));
    assert.equal(await page.locator('#ratingPrompt').isVisible(), false);
    assert.equal((await read(page, 'settings')).ratingPromptDismissed, undefined);
    await page.evaluate(() => Reflect.get(window, 'testUi').tour.showTakeoutPrompt(151, () => {}, () => {}, () => {}));
    await page.keyboard.press('Escape');
    await page.locator('#tourTakeoutDismissBtn').waitFor();
    assert.equal(await page.locator('#ratingPrompt').isVisible(), false);
    await page.keyboard.press('Escape');
    await page.locator('#ratingPrompt').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#ratingPrompt').evaluate(card => card.matches(':modal')), true);
    assert.deepEqual(await read(page, 'openedUrls'), undefined);
});

for (const theme of ['light', 'dark']) test(`popup export offers a review with readable ${theme} styling`, async () => {
    page = await browser.newPage({ viewport: { width: 380, height: 620 } });
    await mount(page, 'popup', { settings: { theme }, records: { [A]: records(10) } });
    await page.locator('#btnCurrent:enabled').click();
    await page.locator('#ratingPrompt').waitFor();
    const appearance = await page.locator('#ratingPrompt').evaluate(card => {
        const bounds = card.getBoundingClientRect();
        return { color: getComputedStyle(card).color, background: getComputedStyle(card).backgroundColor,
            fits: bounds.left >= 0 && bounds.top >= 0 && bounds.right <= innerWidth && bounds.bottom <= innerHeight };
    });
    assert.equal(appearance.fits, true);
    assert.equal(appearance.background, theme === 'light' ? 'rgb(255, 255, 255)' : 'rgb(32, 32, 35)');
    assert.notEqual(appearance.background, appearance.color);
    await page.screenshot({ path: `tests/output/visual_audit/rating-prompt-popup-${theme}.png` });
});

test('the thank-you dialog offers Discord and remembers the choice before opening it', async () => {
    await open({ settings: { language: 'zh' }, records: { [A]: records(10) } });
    await exportSelected();
    await page.locator('#ratingPrompt').waitFor();
    assert.equal(await page.locator('#ratingPromptTitle').innerText(), '感谢使用 Gemini Exporter！');
    assert.match(await page.locator('#ratingPromptDescription').innerText(), /你的评价对我们非常重要/);
    assert.equal(await page.locator('#ratingPromptRate').innerText(), '去评价');
    assert.equal(await page.locator('#ratingPromptDiscord').innerText(), '加入 Discord');
    await page.locator('#ratingPromptDiscord').click();
    await page.waitForFunction(() => (Reflect.get(window, 'harness').openedUrls ?? []).length === 1);
    assert.equal((await read(page, 'settings')).ratingPromptDismissed, true);
    assert.deepEqual(await read(page, 'openedUrls'), ['https://discord.gg/e3FgrXUZ8f']);
    assert.equal(await page.locator('#ratingPrompt').count(), 0);
});

test('showing the dialog once suppresses it after the page closes without a choice', async () => {
    await open({ records: { [A]: records(10) } });
    await exportSelected(); await page.locator('#ratingPrompt').waitFor();
    await page.waitForFunction(() => Reflect.get(window, 'harness').settings.ratingPromptDismissed);
    const settings = await read(page, 'settings');
    await page.close();
    await open({ settings, records: { [A]: records(10) } });
    await exportSelected();
    assert.equal(await page.locator('#ratingPrompt').count(), 0);
});
