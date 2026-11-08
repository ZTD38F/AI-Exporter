import test, { before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type Page } from 'playwright';
import { mount, read } from './helpers/uiPortHarness.js';
import { indexStorage } from './helpers/indexStorage.js';
import { getSettings, updateSettings } from '../src/application/settings/index.js';
import { isVersionGreater } from '../src/shared/utils/pathUtils.js';
import { FEATURE_RELEASES, getLatestEligibleFeature } from '../src/ui/guidance/featureReleases.js';
let browser: Browser, page: Page;
before(async () => { browser = await chromium.launch({ chromiumSandbox: true, headless: true }); });
afterEach(async () => { await page?.close(); }); after(async () => { await browser?.close(); });
test('feature version comparison uses numeric components at the current shared owner', () => {
    for (const [a, b, expected] of [['1.10.0', '1.9.0', true], ['1.5.0', '1.5.0', false], ['1.4.0', '1.5.0', false], ['2.0.0', '1.99.99', true]] as const) assert.equal(isVersionGreater(a, b), expected);
});
test('featureReleases - latest eligible release arbitration excludes old, future and unusable baselines', () => {
    assert.deepEqual(FEATURE_RELEASES, [{ version: '2.1.0', kind: 'platforms' }, { version: '2.0.0', kind: 'upgrade' }], 'only approved v2 announcements are eligible');
    assert.equal(getLatestEligibleFeature('1.4.0', '1.8.1'), null);
    // Supply explicit announcements only for testing the arbitration algorithm.
    const previous = FEATURE_RELEASES.slice();
    FEATURE_RELEASES.push({ version: '1.7.0', stepId: 'export' }, { version: '1.5.0', stepId: 'live_save' });
    try {
    assert.deepEqual(getLatestEligibleFeature('1.4.0', '1.8.1'), { version: '1.7.0', stepId: 'export' });
    assert.deepEqual(getLatestEligibleFeature('1.4.0', '1.5.0'), { version: '1.5.0', stepId: 'live_save' });
    for (const baseline of ['', 'invalid', '1.7.0', '1.8.1', '2.0.0']) assert.equal(getLatestEligibleFeature(baseline, '1.8.1'), null);
    } finally { FEATURE_RELEASES.splice(0, FEATURE_RELEASES.length, ...previous); }
});
test('2.0 release requires a previous version below 2.0.0, not a new installation', () => {
    assert.deepEqual(getLatestEligibleFeature('1.8.1', '2.0.0'), { version: '2.0.0', kind: 'upgrade' });
    assert.deepEqual(getLatestEligibleFeature('1.7.0', '2.0.1'), { version: '2.0.0', kind: 'upgrade' });
    for (const [seen, current] of [['2.0.0', '2.0.0'], ['2.0.0', '2.0.1'],
        ['1.8.1', '1.8.1'], ['', '2.0.0'], ['invalid', '2.0.0']]) {
        assert.equal(getLatestEligibleFeature(seen, current), null);
    }
});
test('last seen feature version persists through Application Settings', async () => {
    const env = indexStorage(); try {
        await updateSettings({ lastSeenFeatureVersion: '1.5.0' }); assert.equal((await getSettings()).lastSeenFeatureVersion, '1.5.0');
        await updateSettings({ lastSeenFeatureVersion: '1.7.0' }); assert.equal((await getSettings()).lastSeenFeatureVersion, '1.7.0');
    } finally { env.restore(); }
});
test('Options shows the 2.0 notice once for upgrades and opens the existing feedback form', async () => {
    page = await browser.newPage();
    await mount(page, 'options', { manifestVersion: '2.0.0', settings: { lastSeenFeatureVersion: '1.8.1' } });
    await page.getByRole('heading', { name: 'Gemini Exporter 2.0 is Here!' }).waitFor();
    assert.match(await page.locator('.tour-upgrade-copy').innerText(), /Your original Gemini chats are safe/);
    assert.deepEqual((await read(page, 'patches')).filter((patch: { lastSeenFeatureVersion?: string }) =>
        patch.lastSeenFeatureVersion), [{ lastSeenFeatureVersion: '2.0.0' }]);
    await page.getByRole('button', { name: 'Leave Feedback' }).click();
    assert.equal(await page.locator('.tour-popover').count(), 0);
    assert.deepEqual(await read(page, 'openedUrls'), ['https://tally.so/r/Y56ZBB?source=extension']);
});
test('Options does not show the 2.0 notice on a new 2.0 installation', async () => {
    page = await browser.newPage();
    await mount(page, 'options', { manifestVersion: '2.0.0', settings: { lastSeenFeatureVersion: '2.0.0' } });
    await page.locator('#list .item').waitFor();
    assert.equal(await page.locator('.tour-popover').count(), 0);
    assert.deepEqual(await read(page, 'patches'), []);
});
test('TourGuide - Spotlight activates, excludes competing modals and dismisses exactly once', async () => {
    page = await browser.newPage(); await mount(page, 'options'); await page.locator('#list .item').waitFor();
    const result = await page.evaluate(() => { const tour = Reflect.get(window, 'testUi').tour; const h = Reflect.get(window, 'harness'); h.dismissed = 0;
        return [tour.startFeatureSpotlight('1.7.0', 'export', () => h.dismissed++), tour.startFeatureSpotlight('1.5.0', 'live_save', () => h.dismissed++)]; });
    assert.deepEqual(result, [true, false]); await page.getByRole('button', { name: 'Got it', exact: true }).click();
    assert.equal(await page.locator('[role=dialog]').count(), 0); assert.equal(await read(page, 'dismissed'), 1);
    await page.evaluate(() => Reflect.get(window, 'testUi').tour.dismissFeatureSpotlight()); assert.equal(await read(page, 'dismissed'), 1);
});
test('format Spotlight dismissal restores focus without initiating PDF/HTML export', async () => {
    page = await browser.newPage(); await mount(page, 'options'); await page.locator('#format').focus();
    await page.evaluate(() => Reflect.get(window, 'testUi').tour.startFeatureSpotlight('1.7.0', 'format', () => {}));
    assert.equal(await page.locator('[role=dialog]').count(), 1); await page.getByRole('button', { name: 'Got it', exact: true }).click();
    assert.equal(await page.locator('#format').evaluate(el => document.activeElement === el), true);
    assert.deepEqual(await read(page, 'exports'), []);
});

for (const language of ['en', 'zh']) test(`2.1 highlights authorize sites and resume at the account switcher (${language})`, async () => {
    page = await browser.newPage();
    await mount(page, 'options', { manifestVersion: '2.1.0', geminiAccess: false, settings: { language, lastSeenFeatureVersion: '2.0.0' } });
    // Gemini-only users must never be interrupted by a multi-provider promotion.
    assert.equal(await page.locator('.tour-popover').count(), 0);
    // Dormant future-provider tour remains independently testable without an automatic announcement.
    await page.evaluate(() => Reflect.get(window, 'testUi').tour.showPlatformHighlights());
    const heading = language === 'en' ? 'Multi-platform support (Beta)' : '多平台支持（测试版）';
    await page.getByRole('heading', { name: heading, exact: true }).waitFor();
    assert.deepEqual((await read(page, 'patches')).filter((patch: { lastSeenFeatureVersion?: string }) =>
        patch.lastSeenFeatureVersion), [], 'manual dormant tour must not mark a retired release as shown');
    await page.locator('#tourNextBtn').click();
    await page.locator('#btnPlatformPermissions').click();
    await page.locator('#platformAuthorizationDone').waitFor();
    assert.equal(await page.locator('.tour-popover').count(), 1);
    await page.locator('#btnAuthorizePlatforms').click();
    await page.locator('.platform-permission-row[data-platform="chatgpt"]').waitFor({ state: 'hidden' });
    await page.locator('#platformAuthorizationDone').click();
    await page.getByRole('heading', { name: language === 'en' ? 'Switch platforms and accounts' : '切换平台与账号', exact: true }).waitFor();
    await page.locator('#accountIdSelect').selectOption({ index: 1 });
    await page.locator('#tourPrevBtn').click();
    await page.locator('#tourNextBtn').click();
    await page.locator('#tourNextBtn').click();
    assert.equal(await page.locator('.tour-popover').count(), 0);
});
test('2.1 highlights are eligible for upgrades and not replayed for seen or fresh installs', () => {
    assert.deepEqual(getLatestEligibleFeature('1.8.1', '2.1.0'), { version: '2.0.0', kind: 'upgrade' });
    for (const previous of ['2.0.0', '2.0.1', '2.1.0', 'invalid'])
        assert.equal(getLatestEligibleFeature(previous, '2.1.0'), null);
});
test('installation tutorial starts with authorization and continues through account switching', async () => {
    page = await browser.newPage();
    await mount(page, 'options', { manifestVersion: '2.1.0', geminiAccess: false }, '?startTour=1');
    await page.getByRole('heading', { name: 'Authorize AI platforms', exact: true }).waitFor();
    assert.equal(await page.locator('#tourNextBtn').isDisabled(), true);
    assert.equal(await page.locator('#tourSkipBtn').count(), 0);
    assert.equal(await page.locator('.tour-coach-card').count(), 2);
    await page.locator('#btnAuthorizePlatforms').click();
    await page.getByRole('heading', { name: 'Connect an account', exact: true }).waitFor();
    await page.locator('#btnDetectAccount:enabled').click();
    await page.getByRole('heading', { name: 'Switch platforms and accounts', exact: true }).waitFor();
});

test('the account lesson highlights the source area even before any account is connected', async () => {
    page = await browser.newPage({ viewport: { width: 640, height: 480 } });
    await mount(page, 'options', { accounts: [], manifestVersion: '2.1.0', settings: { lastSeenFeatureVersion: '2.0.0' } });
    await page.evaluate(() => Reflect.get(window, 'testUi').tour.showPlatformHighlights());
    await page.getByRole('heading', { name: 'Multi-platform support (Beta)', exact: true }).waitFor();
    await page.locator('#tourNextBtn').click();
    await page.locator('#btnPlatformPermissions').click();
    await page.keyboard.press('Escape');
    await page.getByRole('heading', { name: 'Switch platforms and accounts', exact: true }).waitFor();
    assert.equal(await page.locator('#accountName').isVisible(), true);
    assert.equal(await page.locator('.tour-spotlight').isVisible(), true);
    await page.locator('#tourNextBtn').click();
    assert.equal(await page.locator('.tour-popover').count(), 0);
});
