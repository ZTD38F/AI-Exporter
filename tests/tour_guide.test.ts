import { waitForAuthorization, continueToScan } from './helpers/tourNavigation';
import test, { before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium, type Browser, type Page } from 'playwright';
import { A, B, mount, read } from './helpers/uiPortHarness.js';
import { assertUiNodeIsolation, installUiV2Mocks } from './helpers/uiV2Mocks.js';

installUiV2Mocks();
const { STEPS } = require('../src/ui/guidance/tourSteps.js') as
    typeof import('../src/ui/guidance/tourSteps.js');
assertUiNodeIsolation();
let browser: Browser, page: Page;
before(async () => { browser = await chromium.launch({ chromiumSandbox: true, headless: true }); });
afterEach(async () => { await page?.close(); }); after(async () => { await browser?.close(); });
async function open(patch: Record<string, unknown> = {}, query = '') { page = await browser.newPage(); await mount(page, 'options', { tabs: [], ...patch }, query); await page.locator('#list .item').waitFor(); }
async function start(index = 0) { await page.evaluate(async index => { const tour = Reflect.get(window, 'testUi').tour; await tour.startTour(); await tour.goToStep((index === 0 ? 0 : index + 2)); }, index); }

test('tourGuide - module structure and all current steps remain available', () => {
    assert.deepEqual(STEPS.map(step => step.id), ['connect', 'identify_account', 'accounts', 'sync', 'select', 'format', 'export', 'live_save', 'feedback']);
    for (const step of STEPS) { assert.equal(typeof step.target, 'function'); assert.ok(step.title()); assert.ok(step.description()); }
});
test('tourGuide - navigation, back and completion operate on current in-page state', async () => {
    await open(); await start(1); assert.equal(await page.locator('.tour-popover h2').textContent(), 'Scan conversations');
    await page.getByRole('button', { name: 'Next', exact: true }).click(); assert.equal(await page.locator('.tour-popover h2').textContent(), 'Select conversations');
    await page.getByRole('button', { name: 'Back', exact: true }).click(); assert.equal(await page.locator('.tour-popover h2').textContent(), 'Scan conversations');
    await page.getByRole('button', { name: 'Back', exact: true }).click(); assert.equal(await page.locator('.tour-popover h2').textContent(), 'Switch platforms and accounts');
    await page.evaluate(() => Reflect.get(window, 'testUi').tour.goToStep(8)); await page.getByRole('button', { name: 'Start using', exact: true }).click();
    assert.equal(await page.locator('[role=dialog]').count(), 0); assert.deepEqual(await read(page, 'patches'), []);
});
async function choose(platforms: string[]) {
    for (const platform of ['Gemini', 'ChatGPT', 'Grok', 'Claude']) {
        const checkbox = page.getByRole('checkbox', { name: platform, exact: true });
        if (await checkbox.count()) await checkbox.setChecked(platforms.includes(platform));
    }
}

test('Tour starts at authorization even when all platform permissions are already granted', async () => {
    await open({ geminiAccess: true, chatgptAccess: true, grokAccess: true, claudeAccess: true });
    await start();
    await continueToScan(page);
    await page.waitForFunction(() => document.querySelector('.tour-popover h2')?.textContent === 'Scan conversations');
    assert.equal(await page.locator('#btnAuthorizePlatforms').count(), 0);
    assert.equal(await page.locator('#tourPrevBtn').count(), 1);
    await page.locator('#tourNextBtn').click();
    assert.equal(await page.locator('.tour-popover h2').textContent(), 'Select conversations');
    await page.locator('#tourPrevBtn').click();
    assert.equal(await page.locator('.tour-popover h2').textContent(), 'Scan conversations');
    assert.equal(await page.locator('#tourPrevBtn').count(), 1);
    assert.deepEqual(await read(page, 'connectionRequests'), []);
});

test('Authorization choices show only missing platforms and never request a granted one', async () => {
    await open({ geminiAccess: true, chatgptAccess: false, grokAccess: true, claudeAccess: false });
    await start();
    await page.locator('.platform-permission-row[data-platform="chatgpt"]').waitFor({ state: 'visible' });
    for (const provider of ['gemini', 'grok']) {
        assert.equal(await page.locator('.platform-permission-row[data-platform="' + provider + '"]').isVisible(), false);
    }
    for (const provider of ['chatgpt', 'claude'])
        assert.equal(await page.locator('.platform-permission-row[data-platform="' + provider + '"] input').isChecked(), true);
    await page.locator('#btnAuthorizePlatforms').click();
    await page.locator('.platform-permission-row[data-platform="chatgpt"]').waitFor({ state: 'hidden' });
    assert.deepEqual(await read(page, 'connectionRequests'), [[['chatgpt', 'claude'], true]]);
    await page.locator('#btnDetectAccount:enabled').click();
    await page.getByRole('heading', { name: 'Switch platforms and accounts', exact: true }).waitFor();
    await page.locator('#tourNextBtn').click();
    await page.waitForFunction(() => document.querySelector('.tour-popover h2')?.textContent === 'Scan conversations');
});

test('Authorization shows one button above a default-selected platform list without opening websites', async () => {
    await open({ geminiAccess: false }); await start();
    for (const name of ['Gemini', 'ChatGPT', 'Grok', 'Claude'])
        assert.equal(await page.getByRole('checkbox', { name, exact: true }).isChecked(), true);
    assert.equal(await page.locator('.platform-authorization button').count(), 1);
    assert.deepEqual(await read(page, 'events'), []);
    assert.equal(await page.locator('#tourNextBtn').isDisabled(), true);
    await page.evaluate(() => Reflect.get(window, 'testUi').tour.nextStep());
    assert.equal(await page.locator('.tour-popover h2').textContent(), 'Authorize AI platforms');
    await page.locator('#btnAuthorizePlatforms').click();
    await page.locator('#btnDetectAccount:enabled').click();
    await page.getByRole('heading', { name: 'Switch platforms and accounts', exact: true }).waitFor();
    await page.locator('#tourNextBtn').click();
    await page.waitForFunction(() => document.querySelector('.tour-popover h2')?.textContent === 'Scan conversations');
    assert.deepEqual(await read(page, 'connectionRequests'), [[['gemini', 'chatgpt', 'grok', 'claude'], true]]);
    assert.deepEqual(await read(page, 'openedUrls') ?? [], []);
    assert.equal(await page.locator('#btnAuthorizePlatforms').count(), 0);
    assert.equal(await page.locator('#tourPrevBtn').count(), 1);
});

test('Authorization requests only the selection, disables empty selection, and can retry denial', async () => {
    await open({ geminiAccess: false, permissionDenied: true }); await start();
    await choose([]);
    assert.equal(await page.locator('#btnAuthorizePlatforms').isDisabled(), true);
    await choose(['ChatGPT', 'Claude']);
    await page.locator('#btnAuthorizePlatforms').click();
    await page.waitForFunction(() => document.querySelector('.platform-authorization [role=status]')?.textContent?.includes('not granted'));
    assert.deepEqual(await read(page, 'connectionRequests'), [[['chatgpt', 'claude'], true]]);
    assert.equal(await page.locator('#tourNextBtn').isDisabled(), true);
    assert.deepEqual(await read(page, 'discoveryCalls'), []);
    await page.evaluate(() => { Reflect.get(window, 'harness').permissionDenied = false; });
    await page.locator('#btnAuthorizePlatforms').click();
    await page.getByRole('heading', { name: 'Connect an account', exact: true }).waitFor();
    assert.equal(await page.locator('#btnConnectPlatform-gemini').count(), 0);
});

for (const [provider, name] of [['chatgpt', 'ChatGPT'], ['claude', 'Claude']]) {
    test(`Authorization can select an existing ${name} account without requiring login for the grant`, async () => {
        const account = { id: B, providerId: provider, providerAccountId: `${provider}-account` };
        await open({ accounts: [{ id: A, providerId: 'gemini', providerAccountId: 'A' }, account],
            [`${provider}Accounts`]: [account], tabs: [{ id: 2, url: provider === 'chatgpt' ? 'https://chatgpt.com/' : 'https://claude.ai/' }] });
        await page.locator('#btnPlatformPermissions').click(); await waitForAuthorization(page);
        await choose([name]);
        await page.locator('#btnAuthorizePlatforms').click();
        await page.waitForFunction(() => document.querySelector('.platform-authorization [role=status]')?.textContent?.includes('Selected platforms authorized'));
        assert.deepEqual(await read(page, 'connectionRequests'), [[[provider], true]]);
        assert.deepEqual(await read(page, 'discoveryCalls'), [provider]);
        assert.equal(await page.locator('#accountIdSelect').inputValue(), B);
    });
}

test('Existing access enables Next; unchecking never revokes access, and revocation refreshes the view', async () => {
    await open(); await start();
    await page.waitForFunction(() => !(document.querySelector('#tourNextBtn') as HTMLButtonElement)?.disabled);
    await choose([]);
    assert.equal(await page.locator('#tourNextBtn').isDisabled(), false);
    assert.deepEqual(await read(page, 'connectionRequests'), []);
    await page.evaluate(() => { const h = Reflect.get(window, 'harness'); h.geminiAccess = false; h.accessListener(); });
    await page.waitForFunction(() => (document.querySelector('#tourNextBtn') as HTMLButtonElement)?.disabled);
    assert.equal(await page.locator('.platform-permission-row[data-platform="gemini"]').isVisible(), true);
});

test('Standalone authorization reuses the same list and stays outside the tutorial', async () => {
    await open({ geminiAccess: false });
    await page.locator('#btnPlatformPermissions').click();
    assert.equal(await page.locator('#tourNextBtn').count(), 0);
    assert.equal(await page.locator('.tour-step-badge').textContent(), 'Site access');
    await choose(['Gemini']);
    await page.locator('#btnAuthorizePlatforms').click();
    await page.locator('.platform-permission-row[data-platform="gemini"]').waitFor({ state: 'hidden' });
    await page.locator('#platformAuthorizationDone').click();
    assert.equal(await page.locator('.tour-popover').count(), 0);
    await page.locator('#btnPlatformPermissions').click();
    assert.equal(await page.getByRole('checkbox', { name: 'Gemini', exact: true }).count(), 0);
    for (const name of ['ChatGPT', 'Grok', 'Claude'])
        assert.equal(await page.getByRole('checkbox', { name, exact: true }).isChecked(), true);
    await page.keyboard.press('Escape');
    assert.deepEqual(await read(page, 'patches'), []);
});

test('Closing discards a pending authorization result and does not change account selection', async () => {
    await open({ geminiAccess: false, holdPermission: true }); await start();
    await page.locator('#btnAuthorizePlatforms').click();
    assert.equal(await page.getByRole('checkbox', { name: 'Gemini', exact: true }).isDisabled(), true);
    await page.keyboard.press('Escape');
    await page.evaluate(() => Reflect.get(window, 'harness').finishPermission(true));
    assert.equal(await page.locator('.tour-popover').count(), 0);
    assert.deepEqual(await read(page, 'discoveryCalls'), []);
    assert.equal(await page.locator('#accountIdSelect').inputValue(), A);
});

test('Slow account discovery does not block authorization and closing discards its late selection', async () => {
    await open({ geminiAccess: false, holdDiscovery: true });
    await page.locator('#btnPlatformPermissions').click(); await waitForAuthorization(page);
    await choose(['Gemini']);
    await page.locator('#btnAuthorizePlatforms').click();
    await page.waitForFunction(() => typeof Reflect.get(window, 'harness').finishDiscovery === 'function');
    await page.waitForFunction(() => !(document.querySelector('#platformAuthorizationDone') as HTMLButtonElement)?.disabled);
    assert.equal(await page.locator('#btnAuthorizePlatforms').isEnabled(), false);
    await page.keyboard.press('Escape');
    await page.evaluate(({ B }) => Reflect.get(window, 'harness').finishDiscovery(B), { B });
    assert.equal(await page.locator('#accountIdSelect').inputValue(), A);
});

test('Account discovery failure does not negate a successful authorization or cause polling', async () => {
    await open({ geminiAccess: false, tabs: [{ id: 2, url: 'https://chatgpt.com/' }], discoveryError: 'session failed: 429' });
    await page.locator('#btnPlatformPermissions').click(); await waitForAuthorization(page); await choose(['ChatGPT']);
    await page.locator('#btnAuthorizePlatforms').click();
    await page.waitForFunction(() => !(document.querySelector('#platformAuthorizationDone') as HTMLButtonElement)?.disabled);
    assert.deepEqual(await read(page, 'discoveryCalls'), ['chatgpt']);
    await page.waitForTimeout(1100);
    assert.deepEqual(await read(page, 'discoveryCalls'), ['chatgpt']);
    assert.deepEqual(await read(page, 'openedUrls') ?? [], []);
});

test('Authorization stays visible in both languages and a narrow viewport', async () => {
    fs.mkdirSync('tests/output/visual_audit', { recursive: true });
    for (const language of ['en', 'zh']) {
        await open({ settings: { language }, geminiAccess: false });
        await page.setViewportSize({ width: 360, height: 640 }); await start();
        await page.waitForFunction(() => {
            const popover = document.querySelector('.tour-popover') as HTMLElement | null;
            return !!popover?.style.top && popover.getBoundingClientRect().bottom <= innerHeight;
        });
        for (const selector of ['#btnAuthorizePlatforms', '.platform-permission-list', '#tourNextBtn']) {
            await page.locator(selector).scrollIntoViewIfNeeded();
            const bounds = await page.locator(selector).boundingBox();
            assert.ok(bounds && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 360 && bounds.y + bounds.height <= 640, `${selector}: ${JSON.stringify(bounds)}`);
        }
        await page.screenshot({ path: `tests/output/visual_audit/authorization-${language}.png`, animations: 'disabled' });
        await page.close();
    }
});

test('Tour startup intent is consumed once from URL with no durable completion preference', async () => {
    await open({}, '?startTour=1&keep=yes'); assert.equal(await page.locator('[role=dialog]').count(), 1);
    assert.equal(new URL(page.url()).searchParams.has('startTour'), false); assert.equal(new URL(page.url()).searchParams.get('keep'), 'yes');
    await page.evaluate(() => Reflect.get(window, 'testUi').tour.finishTour());
    assert.equal(await page.evaluate(() => Reflect.get(window, 'testUi').tour.consumeTourIntent()), false);
    assert.deepEqual(await read(page, 'patches'), []);
});
test('Takeout prompt marks Settings when shown, including before dismissal', async () => {
    await open(); await page.evaluate(() => { const h=Reflect.get(window, 'harness'); h.scanCount=151;
        h.scanResult={status:'partial_limit',reason:'provider_limit',pagesFetched:4,conversationsFetched:151}; });
    await page.locator('#btnSyncAll').click(); await page.locator('.tour-popover').waitFor();
    await page.waitForFunction(() => Reflect.get(window, 'harness').patches.some((patch: { takeoutPromptCompleted?: boolean }) => patch.takeoutPromptCompleted));
    assert.deepEqual(await read(page, 'patches'), [{ takeoutPromptCompleted: true }]);
    await page.getByRole('button', { name: 'Got it, don’t show again', exact: true }).click();
    assert.deepEqual(await read(page, 'patches'), [{ takeoutPromptCompleted: true }]);
});
test('tourGuide - action-driven advancement covers scan, selection, format, export, Live Save and feedback', async () => {
    await open({settings:{enabledDisk:false}});
    await page.locator('#btnTourGuide').click(); await waitForAuthorization(page);
    await page.evaluate(() => Reflect.get(window,'testUi').tour.goToStep(3));
    await page.locator('#btnSyncAll').click();
    await page.waitForFunction(() => document.querySelector('.tour-popover h2')?.textContent === 'Select conversations');
    await page.locator('#list .item input').first().check(); await page.waitForFunction(() => document.querySelector('.tour-popover h2')?.textContent === 'Choose a format');
    await page.locator('#format').selectOption('html'); await page.waitForFunction(() => document.querySelector('.tour-popover h2')?.textContent === 'Export selected conversations');
    await page.locator('#btnExport').click(); await page.waitForFunction(() => document.querySelector('.tour-popover h2')?.textContent === 'Live Save');
    await page.locator('input[name="delivery"][value="folderWriter"]').check();
    await page.locator('#liveSaveDiskToggle:enabled').waitFor();
    await page.locator('#liveSaveDiskToggle').check(); await page.waitForFunction(() => document.querySelector('.tour-popover h2')?.textContent === 'Optional feedback');
    // Prevent external navigation; the actual DOM click still advances the current step.
    await page.locator('#feedbackBox').evaluate(el => el.addEventListener('click', event => event.preventDefault()));
    await page.locator('#feedbackBox').click(); await page.waitForFunction(() => !document.querySelector('.tour-popover'));
});
test('tourGuide - navigating backwards cleans the previous action listener and delayed timer', async () => {
    await open(); await start(2);
    await page.locator('#list .item input').first().check(); await page.evaluate(() => Reflect.get(window, 'testUi').tour.prevStep());
    await page.waitForTimeout(350); assert.equal(await page.locator('.tour-popover h2').textContent(), 'Scan conversations');
    await page.locator('#list input').first().dispatchEvent('change'); await page.waitForTimeout(350);
    assert.equal(await page.locator('.tour-popover h2').textContent(), 'Scan conversations');
});
test('tourGuide - clicking the backdrop preserves the tutorial until explicitly closed', async () => {
    await open(); await start(); await page.locator('.tour-backdrop').first().dispatchEvent('click');
    assert.equal(await page.locator('.tour-overlay-container').count(), 1);
    await page.locator('#tourCloseBtn').click();
    assert.equal(await page.locator('.tour-overlay-container').count(), 0);
    assert.equal(await page.evaluate(() => Reflect.get(window, 'testUi').tour.isActive()), false);
    assert.deepEqual(await read(page, 'patches'), []);
});
test('tourGuide - internal Blob downloads work while unrelated synthetic clicks remain blocked', async () => {
    await open(); await start(4);
    const file = page.waitForEvent('download');
    const dispatched = await page.evaluate(() => {
        const anchor = document.createElement('a');
        anchor.href = URL.createObjectURL(new Blob(['tutorial download contents'], { type: 'text/markdown' }));
        anchor.download = 'tutorial.md'; document.body.append(anchor);
        const started = anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        anchor.remove();
        const button = document.createElement('button'); document.body.append(button);
        let action = false; button.addEventListener('click', () => { action = true; });
        const background = button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        button.remove();
        return { started, background, action };
    });
    assert.deepEqual(dispatched, { started: true, background: false, action: false });
    const downloaded = await file;
    assert.equal(downloaded.suggestedFilename(), 'tutorial.md');
    const downloadedPath = await downloaded.path(); assert.ok(downloadedPath);
    assert.equal(fs.readFileSync(downloadedPath, 'utf8'), 'tutorial download contents');
    assert.equal(await page.locator('.tour-popover h2').textContent(), 'Export selected conversations');
});

test('Takeout prompt exposes three actions and closes before delivering their callbacks', async () => {
    await open();
    const cases = [
        { name: 'Import Takeout ZIP', want: ['closed', 'import'] },
        { name: 'Open Google Takeout', want: ['closed', 'web'] },
        { name: 'Got it, don’t show again', want: ['closed'] },
        { name: '×', want: ['closed'] }
    ];
    for (const item of cases) {
        const shown = await page.evaluate(() => {
            const events: string[] = [];
            Reflect.set(window, 'takeoutEvents', events);
            return Reflect.get(window, 'testUi').tour.showTakeoutPrompt(151,
                () => events.push('closed'), () => events.push('import'), () => events.push('web'));
        });
        assert.equal(shown, true);
        assert.match(await page.locator('.tour-popover').textContent() ?? '', /This scan fetched 151 conversations/);
        await page.locator('.tour-popover').getByRole('button', { name: item.name, exact: true }).click();
        assert.equal(await page.locator('.tour-popover').count(), 0);
        assert.deepEqual(await page.evaluate(() => Reflect.get(window, 'takeoutEvents')), item.want);
    }
});

for (const ending of ['finish', 'close', 'skip', 'destroy']) {
    test(`Takeout discovered during a tutorial waits for ${ending} and is marked only on display`, async () => {
        await open({scanCount:151}); await start(1);
        await page.locator('#btnSyncAll').click();
        await page.waitForFunction(() => document.body.dataset.scanning === 'false');
        await page.getByRole('heading',{name:'Select conversations',exact:true}).waitFor();
        assert.deepEqual(await read(page,'patches'),[]);
        if (ending === 'close') await page.locator('#tourCloseBtn').click();
        else await page.evaluate(ending => {
            const tour = Reflect.get(window,'testUi').tour;
            return ending === 'finish' ? tour.finishTour() : ending === 'skip' ? tour.skipTour() : tour.destroy();
        },ending);
        if (ending === 'destroy') {
            assert.equal(await page.locator('.tour-popover').count(),0);
            assert.deepEqual(await read(page,'patches'),[]);
            return;
        }
        await page.getByRole('heading',{name:'💡 Supplement Your History with Google Takeout',exact:true}).waitFor();
        await page.waitForFunction(() => Reflect.get(window,'harness').patches.some((p:{takeoutPromptCompleted?:boolean}) => p.takeoutPromptCompleted));
        assert.deepEqual(await read(page,'patches'),[{takeoutPromptCompleted:true}]);
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('.tour-popover').count(),0);
    });
}

test('Takeout prompt stays blocked by other modals without queueing', async () => {
    await open();
    const blocked = await page.evaluate(() => {
        const modal = document.createElement('dialog'); document.body.append(modal); modal.showModal();
        return Reflect.get(window,'testUi').tour.showTakeoutPrompt(151,()=>{},()=>{},()=>{});
    });
    assert.equal(blocked,false);
    await page.evaluate(() => document.querySelector('dialog[open]')?.remove());
    assert.equal(await page.locator('.tour-popover').count(),0);
    assert.deepEqual(await read(page,'patches'),[]);
});

test('tutorial hides Select All and restores it after closing', async () => {
    await open(); await start(2);
    assert.equal(await page.locator('#btnSelectAll').isVisible(),false);
    await page.locator('#list .item input').first().check();
    await page.getByRole('heading',{name:'Choose a format',exact:true}).waitFor();
    assert.equal(await page.locator('#btnSelectAll').isVisible(),false);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#btnSelectAll').isVisible(),true);
});

test('tourGuide - a deselection change does not advance, while a checked input does', async () => {
    await open(); await start(2);
    await page.evaluate(() => {
        const input = document.querySelector('#list input');
        if (!(input instanceof HTMLInputElement)) throw new Error('Missing conversation checkbox');
        input.checked = false;
        input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForTimeout(350);
    assert.equal(await page.locator('.tour-popover h2').textContent(), 'Select conversations');
    await page.locator('#list .item input').first().check();
    await page.waitForFunction(() => document.querySelector('.tour-popover h2')?.textContent === 'Choose a format');
});

test('tourGuide - dismissal restores HTML and SVG focus, and nested SVG clicks stay inside the card', async () => {
    await open();
    for (const svg of [false, true]) {
        await page.evaluate(svg => {
            document.getElementById('focusOrigin')?.remove();
            const element = svg ? document.createElementNS('http://www.w3.org/2000/svg', 'svg') : document.createElement('button');
            element.id = 'focusOrigin'; element.setAttribute('tabindex', '0');
            document.body.append(element); element.focus();
        }, svg);
        await start(1);
        await page.evaluate(() => {
            const next = document.getElementById('tourNextBtn');
            if (!next) throw new Error('Missing Next button');
            const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            next.append(icon);
            icon.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        assert.equal(await page.locator('.tour-popover h2').textContent(), 'Select conversations');
        await page.keyboard.press('Escape');
        assert.equal(await page.evaluate(() => document.activeElement?.id), 'focusOrigin');
        await page.evaluate(() => window.dispatchEvent(new Event('resize')));
        assert.equal(await page.locator('.tour-overlay-container').count(), 0);
    }
});

test('tourGuide - a replaced list row becomes the live spotlight target after scanning', async () => {
    await open(); await start(2);
    await page.evaluate(() => {
        const list = document.getElementById('list')!;
        const old = list.querySelector<HTMLElement>('.item')!;
        const replacement = old.cloneNode(true) as HTMLElement;
        replacement.style.marginTop = '64px';
        list.replaceChildren(replacement);
    });
    await page.waitForFunction(() => {
        const current = document.querySelector('#list .item')?.getBoundingClientRect();
        const spotlight = document.querySelector<HTMLElement>('.tour-spotlight');
        return !!current && !!spotlight && Math.abs(parseFloat(spotlight.style.top) + parseFloat(spotlight.style.height) - Math.min(innerHeight, current.bottom + 6)) < 2;
    });
    await page.locator('#list .item input').check();
    await page.waitForFunction(() => document.querySelector('.tour-popover h2')?.textContent === 'Choose a format');
    assert.equal(await page.evaluate(() => Reflect.get(window, 'testUi').tour.isActive()), true);
});


test('tourGuide - final action stays inside the viewport immediately after resize', async () => {
    await open();
    await page.setViewportSize({ width: 1280, height: 1080 });
    await start(6);
    assert.equal(await page.locator('#tourSkipBtn').count(), 0);
    await page.locator('#tourPrevBtn').click();
    assert.equal(await page.locator('#tourSkipBtn').count(), 1);
    await page.locator('#tourNextBtn').click();
    assert.equal(await page.locator('#tourSkipBtn').count(), 0);
    await page.waitForTimeout(350);
    for (const viewport of [{ width: 1280, height: 800 }, { width: 640, height: 360 }]) {
        await page.setViewportSize(viewport);
        const card = await page.locator('.tour-popover').boundingBox();
        const finish = await page.getByRole('button', { name: 'Start using', exact: true }).boundingBox();
        assert.ok(card && card.x >= 11 && card.y >= 11);
        assert.ok(card.x + card.width <= viewport.width - 11 && card.y + card.height <= viewport.height - 11);
        assert.ok(finish && finish.y >= 0 && finish.y + finish.height <= viewport.height,
            'Completion must be visible without Playwright scrolling it into view');
    }
    await page.getByRole('button', { name: 'Start using', exact: true }).click();
    assert.equal(await page.locator('.tour-overlay-container').count(), 0);
});

for (const format of ['html', 'pdf', 'json']) {
    test(`Live Save tutorial switches ${format} to persisted Markdown before showing the step`, async () => {
        await open({ settings: { defaultFormat: format, exportDelivery: 'folderWriter', enabledDisk: false },
            directoryName: 'Exports' });
        await page.locator('#btnTourGuide').click(); await waitForAuthorization(page);
        await page.evaluate(() => Reflect.get(window, 'testUi').tour.goToStep(7));
        assert.equal(await page.locator('#format').inputValue(), 'markdown');
        assert.equal(await page.locator('#liveSaveDiskToggle').isEnabled(), true);
        assert.equal(await page.locator('#liveSaveDiskToggle').isChecked(), false);
        assert.match(await page.locator('.tour-content').textContent() ?? '', /only effective with MD format/);
        assert.deepEqual(await read(page, 'patches'), [{ defaultFormat: 'markdown' }]);
        await page.locator('#tourPrevBtn').click();
        await page.locator('#tourNextBtn').click();
        assert.deepEqual(await read(page, 'patches'), [{ defaultFormat: 'markdown' }]);
    });
}

test('export tutorial waits for completion before changing format and enabling Live Save controls', async () => {
    await open({ holdExport: true, settings: { defaultFormat: 'html', enabledDisk: false,
        exportDelivery: 'browserDownload' } });
    await page.locator('#list .item input').first().check();
    await page.locator('#btnTourGuide').click(); await waitForAuthorization(page);
    await page.evaluate(() => Reflect.get(window, 'testUi').tour.goToStep(6));
    await page.locator('#btnExport').click();
    assert.equal(await page.locator('.tour-popover h2').textContent(),'Export selected conversations');
    assert.equal(await page.locator('#tourNextBtn').isEnabled(),false);
    assert.equal(await page.locator('#format').inputValue(),'html');
    await page.evaluate(() => Reflect.get(window,'testUi').tour.nextStep());
    assert.equal(await page.locator('.tour-popover h2').textContent(),'Export selected conversations');
    assert.equal((await read(page, 'exports'))[0].format, 'html');
    await page.evaluate(() => Reflect.get(window, 'harness').finishExport());
    await page.getByRole('heading',{name:'Live Save',exact:true}).waitFor();
    assert.equal(await page.locator('body').getAttribute('data-foreground-busy'),'false');
    assert.equal(await page.locator('#format').inputValue(),'markdown');
    assert.equal(await page.locator('input[name="delivery"][value="folderWriter"]').isEnabled(),true);
});

for (const outcome of ['failed','error','cancelled']) {
    test(`a ${outcome} export keeps the tutorial at export and restores Next`, async () => {
        await open({holdExport:true,failExport:outcome==='failed',throwExport:outcome==='error'});
        await page.locator('#list .item input').first().check();
        await start(4);
        await page.locator('#btnExport').click();
        if (outcome === 'cancelled') await page.locator('#btnCancel').click();
        if (outcome !== 'error') await page.evaluate(() => Reflect.get(window,'harness').finishExport());
        await page.waitForFunction(() => document.body.dataset.foregroundBusy === 'false');
        assert.equal(await page.locator('.tour-popover h2').textContent(),'Export selected conversations');
        assert.equal(await page.locator('#tourNextBtn').isEnabled(),true);
    });
}

test('an export finishing after navigating away cannot advance another tutorial card', async () => {
    await open({holdExport:true});
    await page.locator('#list .item input').first().check(); await start(4);
    await page.locator('#btnExport').click(); await page.locator('#tourPrevBtn').click();
    await page.evaluate(() => Reflect.get(window,'harness').finishExport());
    await page.waitForFunction(() => document.body.dataset.foregroundBusy === 'false');
    assert.equal(await page.locator('.tour-popover h2').textContent(),'Choose a format');
});

for (const step of [{ index: 2, targets: ['#list .item'] }, { index: 3, targets: ['#format'] }]) {
    test(`tourGuide - step ${step.index + 1} border and cutout share target bounds after resize`, async () => {
        await open(); await start(step.index);
        for (const viewport of [{ width: 1280, height: 800 }, { width: 1000, height: 720 }]) {
            await page.setViewportSize(viewport);
            await page.waitForFunction(targets => {
                const spotlight = document.querySelector('.tour-spotlight')?.getBoundingClientRect();
                const targetsBounds = targets.map(selector => document.querySelector(selector)?.getBoundingClientRect());
                if (!spotlight || targetsBounds.some(rect => !rect)) return false;
                const bounds = targetsBounds.filter((rect): rect is DOMRect => !!rect);
                return Math.abs(spotlight.left - Math.max(0, Math.min(...bounds.map(rect => rect.left)) - 6)) < 1 &&
                    Math.abs(spotlight.top - Math.max(0, Math.min(...bounds.map(rect => rect.top)) - 6)) < 1 &&
                    Math.abs(spotlight.right - Math.min(innerWidth, Math.max(...bounds.map(rect => rect.right)) + 6)) < 1 &&
                    Math.abs(spotlight.bottom - Math.min(innerHeight, Math.max(...bounds.map(rect => rect.bottom)) + 6)) < 1;
            }, step.targets);
            await page.waitForFunction(() => {
                const spotlight = document.querySelector('.tour-spotlight')?.getBoundingClientRect();
                const backdrop = document.querySelector('.tour-backdrop');
                if (!spotlight || !(backdrop instanceof HTMLElement)) return false;
                if (backdrop.getBoundingClientRect().width !== innerWidth) return false;
                // Rounded corners stay dimmed and intercept clicks; the open area does not.
                const at = (x: number, y: number) => document.elementFromPoint(x, y) === backdrop;
                return getComputedStyle(backdrop).clipPath.startsWith('path(') &&
                    at(spotlight.left + 0.5, spotlight.top + 0.5) &&
                    !at(spotlight.left + spotlight.width / 2, spotlight.top + 3) &&
                    at(spotlight.left - 1, spotlight.top + spotlight.height / 2);

            });
        }
    });
}


for (const platform of ['chatgpt', 'claude', 'grok', 'gemini']) {
    test(`A single ${platform} action grants access, opens login, and waits for explicit continuation`, async () => {
        await open({ accounts: [{ id: A, providerId: platform, providerAccountId: 'selected', email: 'selected@example.com' }],
            [platform + 'Access']: false });
        await page.locator('#btnSyncAll').click();
        const action = page.locator('#btnAccountConnection');
        await action.waitFor();
        assert.equal(await page.locator('.tour-footer button').count(), 1);
        await action.click();
        await page.waitForFunction(() => (Reflect.get(window, 'harness').openedUrls ?? []).length === 1);
        assert.deepEqual(await read(page, 'connectionRequests'), [[[platform], true]]);
        assert.deepEqual(await read(page, 'scans'), []);
        await page.evaluate(() => window.dispatchEvent(new Event('focus')));
        await page.getByRole('button', { name: 'Continue sync', exact: true }).waitFor();
        assert.equal(await page.locator('.tour-popover').count(), 1);
        assert.deepEqual(await read(page, 'scans'), []);
        await action.click();
        await page.waitForFunction(() => Reflect.get(window, 'harness').scans.length === 1);
        assert.equal(await page.locator('#accountIdSelect').inputValue(), A);
    });
}

test('Returning with the selected account changes the single action to Continue without syncing or closing', async () => {
    await open({ accounts: [{ id: A, providerId: 'chatgpt', providerAccountId: 'selected', email: 'selected@example.com' }],
        chatgptAccess: true, connectionFailure: 'chatgpt' });
    await page.locator('#btnSyncAll').click();
    const action = page.locator('#btnAccountConnection');
    await page.getByRole('button', { name: 'Go to ChatGPT', exact: true }).waitFor();
    await action.click();
    await page.waitForFunction(() => (Reflect.get(window, 'harness').openedUrls ?? []).length === 1);
    assert.deepEqual(await read(page, 'openedUrls'), ['https://chatgpt.com/']);
    assert.deepEqual(await read(page, 'connectionRequests'), []);
    await page.evaluate(() => {
        Reflect.get(window, 'harness').connectionFailure = null;
        document.dispatchEvent(new Event('visibilitychange'));
        window.dispatchEvent(new Event('focus'));
    });
    await page.getByRole('button', { name: 'Continue sync', exact: true }).waitFor();
    assert.equal(await page.locator('.tour-title').innerText(), 'Account connected');
    assert.equal(await page.locator('.tour-content').isVisible(), false);
    assert.equal(await page.locator('.tour-status-indicator').isVisible(), false);
    assert.equal(await page.locator('.tour-footer button').count(), 1);
    assert.deepEqual(await read(page, 'scans'), []);
    await action.click();
    await page.waitForFunction(() => Reflect.get(window, 'harness').scans.length === 1);
    assert.equal(await page.locator('.tour-popover').count(), 0);
    assert.equal(await page.locator('#accountIdSelect').inputValue(), A);
});

test('Returning with a different account never enables continuation or changes the selected account', async () => {
    await open({ accounts: [{ id: A, providerId: 'chatgpt', providerAccountId: 'selected' }],
        chatgptAccess: true, connectionFailure: 'chatgpt' });
    await page.locator('#btnSyncAll').click();
    await page.getByRole('button', { name: 'Go to ChatGPT', exact: true }).waitFor();
    await page.evaluate(({ source }) => {
        const h = Reflect.get(window, 'harness'); h.connectionFailure = null; h.source = source;
        window.dispatchEvent(new Event('focus'));
    }, { source: B });
    await page.waitForFunction(() => document.querySelector('.tour-popover [role=status]')?.textContent?.includes('not connected'));
    assert.equal(await page.getByRole('button', { name: 'Go to ChatGPT', exact: true }).count(), 1);
    assert.equal(await page.locator('#accountIdSelect').inputValue(), A);
    assert.deepEqual(await read(page, 'scans'), []);
});

test('Continue verifies the selected account again instead of using stale connected state', async () => {
    await open({ accounts: [{ id: A, providerId: 'chatgpt', providerAccountId: 'selected' }],
        chatgptAccess: true, connectionFailure: 'chatgpt' });
    await page.locator('#btnSyncAll').click();
    await page.locator('#btnAccountConnection').waitFor();
    await page.evaluate(() => { Reflect.get(window, 'harness').connectionFailure = null; window.dispatchEvent(new Event('focus')); });
    await page.getByRole('button', { name: 'Continue sync', exact: true }).waitFor();
    await page.evaluate(() => { Reflect.get(window, 'harness').connectionFailure = 'chatgpt'; });
    await page.locator('#btnAccountConnection').click();
    await page.getByRole('button', { name: 'Go to ChatGPT', exact: true }).waitFor();
    assert.deepEqual(await read(page, 'scans'), []);
    assert.equal(await page.locator('.tour-popover').count(), 1);
});

test('Standalone access reports granted website permissions without assuming account state', async () => {
    await open({ geminiAccess: true, chatgptAccess: true, grokAccess: true, claudeAccess: true });
    await page.locator('#btnPlatformPermissions').click();
    await page.waitForFunction(() => document.querySelector('.platform-authorization [role=status]')?.textContent?.trim() === 'All supported platforms have website access.');
    assert.equal(await page.locator('#btnAuthorizePlatforms').isVisible(), false);
});

test('Declining access keeps the single Go action available and never scans or opens a site', async () => {
    await open({ accounts: [{ id: A, providerId: 'chatgpt', providerAccountId: 'selected' }],
        chatgptAccess: false, permissionDenied: true });
    await page.locator('#btnSyncAll').click();
    await page.locator('#btnAccountConnection').click();
    await page.waitForFunction(() => document.querySelector('.tour-popover [role=status]')?.textContent?.includes('not granted'));
    assert.equal(await page.getByRole('button', { name: 'Go to ChatGPT', exact: true }).isEnabled(), true);
    assert.deepEqual(await read(page, 'scans'), []);
    assert.deepEqual(await read(page, 'openedUrls') ?? [], []);
});

test('Returning during an older connection check refreshes after it settles', async () => {
    await open({ accounts: [{ id: A, providerId: 'chatgpt', providerAccountId: 'selected' }],
        chatgptAccess: true, connectionFailure: 'chatgpt' });
    await page.locator('#btnSyncAll').click();
    await page.getByRole('button', { name: 'Go to ChatGPT', exact: true }).waitFor();
    await page.evaluate(() => { const h = Reflect.get(window, 'harness'); h.holdConnectionCheck = true; window.dispatchEvent(new Event('focus')); });
    await page.waitForFunction(() => typeof Reflect.get(window, 'harness').finishConnectionCheck === 'function');
    await page.evaluate(() => {
        const h = Reflect.get(window, 'harness'); h.holdConnectionCheck = false; h.connectionFailure = null;
        window.dispatchEvent(new Event('focus')); h.finishConnectionCheck();
    });
    await page.getByRole('button', { name: 'Continue sync', exact: true }).waitFor();
    assert.deepEqual(await read(page, 'scans'), []);
});

test('Closing during connection detection ignores the pending result', async () => {
    await open({ accounts: [{ id: A, providerId: 'chatgpt', providerAccountId: 'selected' }],
        chatgptAccess: true, connectionFailure: 'chatgpt' });
    await page.locator('#btnSyncAll').click();
    await page.getByRole('button', { name: 'Go to ChatGPT', exact: true }).waitFor();
    await page.evaluate(() => {
        const h = Reflect.get(window, 'harness'); h.holdConnectionCheck = true; h.connectionFailure = null;
        window.dispatchEvent(new Event('focus'));
    });
    await page.waitForFunction(() => typeof Reflect.get(window, 'harness').finishConnectionCheck === 'function');
    await page.keyboard.press('Escape');
    await page.evaluate(() => Reflect.get(window, 'harness').finishConnectionCheck());
    assert.equal(await page.locator('.tour-popover').count(), 0);
    assert.deepEqual(await read(page, 'scans'), []);
});

test('tutorial waits for committed results and allows selection while scanning continues', async () => {
    await open({ scanCount: 0, holdScan: true }); await start(1);
    await page.locator('#btnSyncAll').click();
    await page.waitForFunction(() => Reflect.get(window, 'harness').scans.length === 1);
    await page.waitForTimeout(400);
    assert.equal(await page.locator('.tour-popover h2').textContent(), 'Scan conversations');
    assert.equal(await page.locator('#tourNextBtn').isDisabled(), true);
    await page.evaluate(() => {
        const h = Reflect.get(window, 'harness');
        h.scanCount = 2;
        h.scanProgress({ pagesFetched: 1, conversationsFetched: 2 });
    });
    await page.waitForFunction(() => document.querySelector('.tour-popover h2')?.textContent === 'Select conversations');
    assert.equal(await page.locator('body').getAttribute('data-busy'), 'true');
    assert.equal(await page.locator('#btnSyncAll').isVisible(), true);
    assert.equal(await page.locator('#list input').first().isEnabled(), true);
    await page.locator('#list input').first().check();
});

test('tutorial advances when a later domain refresh displays rows after the progress read was empty', async () => {
    await open({ scanCount: 8, holdScan: true }); await start(1);
    await page.evaluate(() => { Reflect.get(window, 'harness').indexes = []; });
    await page.locator('#btnSyncAll').click();
    await page.waitForFunction(() => document.querySelectorAll('#list .item').length === 0);
    assert.equal(await page.locator('.tour-popover h2').textContent(), 'Scan conversations');
    await page.evaluate(({ A }) => {
        const h = Reflect.get(window, 'harness');
        h.indexes = [{ key: { accountId: A, conversationId: 'new' }, title: 'Committed conversation', updatedAt: 10 }];
        h.domainListener(A);
    }, { A });
    await page.getByRole('heading', { name: 'Select conversations', exact: true }).waitFor();
    await page.evaluate(() => Reflect.get(window, 'harness').finishScan());
    await page.waitForFunction(() => document.body.dataset.busy === 'false');
    assert.equal(await page.locator('.tour-popover h2').textContent(), 'Select conversations');
});

test('empty and failed tutorial scans stay on scan; stale completion cannot advance a new card', async () => {
    await open({ scanCount: 0, scanResult: { status: 'complete', pagesFetched: 1, conversationsFetched: 0 } });
    await start(1); await page.locator('#btnSyncAll').click();
    await page.waitForFunction(() => document.body.dataset.busy === 'false');
    assert.equal(await page.locator('.tour-popover h2').textContent(), 'Scan conversations');
    assert.equal(await page.locator('#tourNextBtn').isEnabled(), true);
    await page.evaluate(() => { const h = Reflect.get(window, 'harness'); h.failScan = true; });
    await page.locator('#btnSyncAll').click();
    await page.waitForFunction(() => document.body.dataset.busy === 'false');
    assert.match(await page.locator('#scanStatus').textContent() ?? '', /Operation failed/);
    assert.match(await page.locator('#log').textContent() ?? '', /Injected scan failure/);
    assert.equal(await page.locator('.tour-popover h2').textContent(), 'Scan conversations');
    await page.evaluate(() => { const h = Reflect.get(window, 'harness'); h.failScan = false; h.holdScan = true; });
    await page.locator('#btnSyncAll').click();
    await page.waitForFunction(() => Reflect.get(window, 'harness').finishScan);
    await page.keyboard.press('Escape'); await start(1);
    await page.evaluate(() => {
        const h = Reflect.get(window, 'harness'); h.scanCount = 1;
        h.scanProgress({ pagesFetched: 1, conversationsFetched: 1 }); h.finishScan();
    });
    await page.waitForFunction(() => document.body.dataset.busy === 'false');
    assert.equal(await page.locator('.tour-popover h2').textContent(), 'Scan conversations');
    assert.equal(await page.locator('#tourNextBtn').isEnabled(), true);
});

test('tutorial scan exposes connection recovery and resumes the same lesson before retrying', async () => {
    await open({connectionFailure:'gemini'}); await start(1);
    await page.locator('#btnSyncAll').click();
    await page.getByRole('heading',{name:'Connect Gemini account',exact:true}).waitFor();
    assert.equal(await page.locator('#btnAccountConnection').textContent(),'Go to Gemini');
    await page.evaluate(()=>{
        Reflect.get(window,'harness').connectionFailure=null;
        window.dispatchEvent(new Event('focus'));
    });
    await page.getByRole('button',{name:'Continue sync',exact:true}).waitFor();
    await page.getByRole('button',{name:'Continue sync',exact:true}).click();
    await page.getByRole('heading',{name:'Select conversations',exact:true}).waitFor();
    assert.equal((await read(page,'scans')).length,1);
    assert.equal(await page.locator('#list input').first().isEnabled(),true);
});

test('choosing another account advances to scanning without a Next click', async () => {
    await open(); await start(1); await page.locator('#tourPrevBtn').click();
    await page.getByRole('heading',{name:'Switch platforms and accounts',exact:true}).waitFor();
    assert.equal(await page.locator('#accountIdSelect').evaluate(element => element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))), true);
    assert.equal(await page.locator('.tour-popover h2').textContent(), 'Switch platforms and accounts');
    await page.locator('#accountIdSelect').click();
    assert.equal(await page.locator('.tour-popover h2').textContent(), 'Switch platforms and accounts');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await page.getByRole('heading',{name:'Scan conversations',exact:true}).waitFor();
    assert.equal(await page.locator('#accountIdSelect').inputValue(),B);
    assert.equal((await read(page,'scans')).length,0);
});

test('clicking a conversation title selects it and advances to format without a Next click', async () => {
    await open(); await start(2);
    await page.locator('#list .item .chat-title').first().click();
    assert.equal(await page.locator('#list .item input').first().isChecked(),true);
    await page.getByRole('heading',{name:'Choose a format',exact:true}).waitFor();
    assert.equal(await page.locator('#selectedStat').textContent(),'1 of 1 selected');
});

for (const multiple of [false, true]) {
    test(`clicking the current account in a ${multiple ? 'multiple' : 'single'}-account menu advances only after confirmation`, async () => {
        await open(multiple ? {} : {accounts:[{id:A,providerId:'gemini',providerAccountId:'A'}]});
        await start(1); await page.locator('#tourPrevBtn').click();
        await page.locator('#accountIdSelect').click();
        assert.equal(await page.locator('#accountIdSelect').evaluate(element => element.matches(':open')),true);
        assert.equal(await page.locator('.tour-popover h2').textContent(),'Switch platforms and accounts');
        await page.locator('#accountIdSelect option').first().click();
        await page.getByRole('heading',{name:'Scan conversations',exact:true}).waitFor();
        assert.equal(await page.locator('#accountIdSelect').inputValue(),A);
        assert.equal((await read(page,'scans')).length,0);
        await page.locator('#tourNextBtn').click();
        await page.getByRole('heading',{name:'Select conversations',exact:true}).waitFor();
    });
}

for (const method of ['mouse', 'Space']) {
    test(`opening with ${method} waits for Enter to confirm the current option`, async () => {
        await open({accounts:[{id:A,providerId:'gemini',providerAccountId:'A'}]});
        await start(1); await page.locator('#tourPrevBtn').click();
        await page.locator('#accountIdSelect').focus();
        if (method === 'mouse') await page.locator('#accountIdSelect').click();
        else await page.keyboard.press('Space');
        assert.equal(await page.locator('#accountIdSelect').evaluate(element => element.matches(':open')),true);
        assert.equal(await page.locator('.tour-popover h2').textContent(),'Switch platforms and accounts');
        await page.keyboard.press('Enter');
        await page.getByRole('heading',{name:'Scan conversations',exact:true}).waitFor();
    });
}

test('leaving account guidance removes account confirmation listeners', async () => {
    await open({accounts:[{id:A,providerId:'gemini',providerAccountId:'A'}]});
    await start(1); await page.locator('#tourPrevBtn').click();
    await page.keyboard.press('Escape');
    await page.locator('#accountIdSelect').click();
    await page.locator('#accountIdSelect option').click();
    assert.equal(await page.locator('.tour-popover').count(),0);
});

test('starting a tutorial with multiple existing selections keeps and exports only one', async () => {
    await open();
    await page.evaluate(() => {
        const h = Reflect.get(window,'harness');
        h.indexes.push({...h.indexes[0],key:{...h.indexes[0].key,conversationId:'second'},title:'Second conversation'});
        window.dispatchEvent(new Event('focus'));
    });
    await page.locator('#list .item').nth(1).waitFor();
    await page.locator('#btnSelectAll').check();
    assert.equal(await page.locator('#list input:checked').count(),2);
    await page.locator('#btnTourGuide').click(); await waitForAuthorization(page);
    assert.equal(await page.locator('#list input:checked').count(),1);
    await page.evaluate(() => Reflect.get(window,'testUi').tour.goToStep(6));
    await page.locator('#btnExport').click();
    await page.getByRole('heading',{name:'Live Save',exact:true}).waitFor();
    assert.equal((await read(page,'exports'))[0].keys.length,1);
    await page.keyboard.press('Escape');
    await page.locator('#btnSelectAll').check();
    assert.equal(await page.locator('#list input:checked').count(),2);
});

test('choosing the current Markdown option advances without changing format', async () => {
    await open(); await start(3);
    await page.locator('#format').click();
    assert.equal(await page.locator('.tour-title').innerText(),'Choose a format');
    await page.locator('#format option[value="markdown"]').click();
    await page.getByRole('heading',{name:'Export selected conversations',exact:true}).waitFor();
    assert.equal(await page.locator('#format').inputValue(),'markdown');
});

test('queued Takeout cannot replace a tutorial while exporting or on an off-target click', async () => {
    await open({holdExport:true}); await page.locator('#list input').first().check(); await start(4);
    await page.locator('#btnExport').click();
    await page.evaluate(() => Reflect.get(window,'testUi').tour.showTakeoutPrompt(400,()=>{},()=>{},()=>{}));
    await page.locator('.tour-backdrop').first().dispatchEvent('click');
    assert.equal(await page.locator('.tour-title').innerText(),'Export selected conversations');
    await page.evaluate(() => Reflect.get(window,'harness').finishExport());
    await page.getByRole('heading',{name:'Live Save',exact:true}).waitFor();
    await page.locator('#tourCloseBtn').click();
    await page.getByRole('heading',{name:'💡 Supplement Your History with Google Takeout',exact:true}).waitFor();
});

test('attachment toggle is visible below Skip exported and configuration sizes stay stable during export', async () => {
    await open({holdExport:true,settings:{includeAssets:false}});
    assert.equal(await page.locator('#includeAssets').isVisible(),true);
    assert.equal(await page.locator('#includeAssets').isChecked(),false);
    const skip = await page.locator('#skipExported').boundingBox();
    const assets = await page.locator('#includeAssets').boundingBox();
    assert.ok(skip && assets && assets.y > skip.y);
    await page.locator('#list input').first().check();
    const sizes = async () => page.locator('.export-preferences, .export-destination').evaluateAll(elements => elements.map(element => {
        const r = element.getBoundingClientRect(); return {width:r.width,height:r.height};
    }));
    const before = await sizes();
    await page.locator('#btnExport').click();
    assert.deepEqual(await sizes(),before);
    await page.evaluate(() => Reflect.get(window,'harness').finishExport());
    await page.waitForFunction(() => document.body.dataset.foregroundBusy === 'false');
    assert.deepEqual(await sizes(),before);
});

test('starting an export leaves the button in place and the tutorial cutout follows it', async () => {
    await open({holdExport:true});
    await page.setViewportSize({width:1280,height:800});
    await page.locator('#list input').first().check(); await start(4);
    const before = await page.locator('#btnExport').boundingBox();
    await page.locator('#btnExport').click();
    await page.waitForFunction(() => document.body.dataset.foregroundBusy === 'true');
    const after = await page.locator('#btnExport').boundingBox();
    assert.ok(before && after);
    assert.ok(Math.abs(before.x-after.x)<2,`Export button x: ${before.x} -> ${after.x}`);
    assert.ok(Math.abs(before.y-after.y)<2,`Export button y: ${before.y} -> ${after.y}`);
    await page.waitForFunction(() => {
        const button=document.getElementById('btnExport')?.getBoundingClientRect();
        const spotlight=document.querySelector('.tour-spotlight')?.getBoundingClientRect();
        return button && spotlight && Math.abs(spotlight.top-Math.max(0,button.top-6))<2
            && spotlight.left<=button.left && spotlight.right>=button.right && spotlight.bottom>=button.bottom;
    });
    await page.evaluate(() => Reflect.get(window,'harness').finishExport());
    await page.getByRole('heading',{name:'Live Save',exact:true}).waitFor();
});

for (const cancelled of [false,true]) {
    test(`Live Save folder selection opens the picker directly and ${cancelled?'can be cancelled and retried':'waits for enabling Live Save'}`, async () => {
        await open({cancelPicker:cancelled,settings:{exportDelivery:'browserDownload',enabledDisk:false}});
        await start(5);
        await page.locator('input[name="delivery"][value="folderWriter"]').check();
        await page.waitForFunction(() => document.body.dataset.foregroundBusy === 'false');
        assert.equal((await read(page,'events')).filter((event:string)=>event==='picker').length,1);
        assert.equal(await page.locator('.tour-title').innerText(),'Live Save');
        if (cancelled) {
            assert.equal(await page.locator('#liveSaveDiskToggle').isEnabled(),false);
            await page.evaluate(() => { Reflect.get(window,'harness').cancelPicker=false; });
            await page.locator('#btnSetDir').click();
            await page.waitForFunction(() => document.body.dataset.foregroundBusy === 'false');
            assert.equal(await page.locator('.tour-title').innerText(),'Live Save');
        }
        await page.locator('#liveSaveDiskToggle:enabled').waitFor();
        await page.waitForFunction(() => {
            const target = document.getElementById('liveSaveControls')?.getBoundingClientRect();
            const spotlight = document.querySelector('.tour-spotlight')?.getBoundingClientRect();
            return !!target && !!spotlight && Math.abs(spotlight.top - (target.top - 6)) < 1
                && Math.abs(spotlight.bottom - (target.bottom + 6)) < 1;
        });
        // The directory chooser is no longer part of the highlighted area.
        assert.equal(await page.locator('.tour-spotlight').evaluate(el => {
            const chooser = document.getElementById('btnSetDir')?.getBoundingClientRect();
            return !!chooser && el.getBoundingClientRect().top > chooser.bottom;
        }), true);
        await page.locator('#liveSaveDiskToggle').check();
        await page.getByRole('heading',{name:'Optional feedback',exact:true}).waitFor();
    });
}

for (const lesson of ['format', 'live_save']) {
    test(`${lesson} auto-advance requires a successful settings write after user action`, async () => {
        await open({ settings: { exportDelivery: 'folderWriter', enabledDisk: false }, directoryName: 'Authorized folder' });
        await start(lesson === 'format' ? 3 : 5);
        await page.evaluate(() => { Reflect.get(window, 'harness').holdSettingWrite = true; });
        if (lesson === 'format') await page.locator('#format').selectOption('html');
        else await page.locator('#liveSaveDiskToggle').check();
        await page.waitForFunction(() => typeof Reflect.get(window, 'harness').finishSettingWrite === 'function');
        await page.waitForTimeout(400);
        assert.equal(await page.locator('.tour-title').innerText(), lesson === 'format' ? 'Choose a format' : 'Live Save');
        await page.evaluate(() => Reflect.get(window, 'harness').finishSettingWrite());
        await page.getByRole('heading', { name: lesson === 'format' ? 'Export selected conversations' : 'Optional feedback', exact: true }).waitFor();
    });
    test(`${lesson} failed settings write stays in the current lesson`, async () => {
        await open({ settings: { exportDelivery: 'folderWriter', enabledDisk: false }, directoryName: 'Authorized folder' });
        await start(lesson === 'format' ? 3 : 5);
        await page.evaluate(() => { Reflect.get(window, 'harness').rejectSettingWrite = true; });
        if (lesson === 'format') await page.locator('#format').selectOption('html');
        else await page.locator('#liveSaveDiskToggle').click();
        await page.waitForFunction(() => document.body.dataset.foregroundBusy === 'false');
        await page.waitForTimeout(400);
        assert.equal(await page.locator('.tour-title').innerText(), lesson === 'format' ? 'Choose a format' : 'Live Save');
        assert.equal(await page.locator('#tourNextBtn').isEnabled(), true);
    });
}

test('unchecking the conversation before delayed confirmation keeps the selection lesson open', async () => {
    await open(); await start(2);
    await page.locator('#list .item input').first().check();
    await page.locator('#list .item input').first().uncheck();
    await page.waitForTimeout(400);
    assert.equal(await page.locator('.tour-title').innerText(), 'Select conversations');
});
