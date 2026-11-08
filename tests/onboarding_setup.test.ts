import test, { before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type Page } from 'playwright';
import { A, B, mount, read } from './helpers/uiPortHarness.js';
let browser: Browser, page: Page;
before(async () => { browser = await chromium.launch({ chromiumSandbox: true, headless: true }); });
afterEach(async () => { await page?.close(); });
after(async () => { await browser?.close(); });

for (const language of ['en', 'zh']) test(`authorization opens first with two separate explanations (${language})`, async () => {
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await mount(page, 'options', { accounts: [], tabs: [], geminiAccess: false, manifestVersion: '2.1.0', settings: { language } }, '?startTour=1');
    await page.locator('#btnAuthorizePlatforms').waitFor();
    assert.equal(await page.locator('#tourNextBtn').isDisabled(), true);
    assert.equal(await page.locator('#tourSkipBtn').count(), 0);
    assert.equal(await page.locator('.tour-coach-card').count(), 2);
    for (const id of ['tourAuthorizationWhy', 'tourAuthorizationMore']) {
        assert.equal(await page.locator('#' + id).isVisible(), true);
        assert.equal(await page.locator('#' + id).evaluate(el => {
            const card = el.getBoundingClientRect();
            const menu = document.querySelector('.tour-authorization-menu')?.getBoundingClientRect();
            return !!menu && card.left >= 0 && card.right <= innerWidth && card.top >= 0 && card.bottom <= innerHeight
                && (card.right <= menu.left || card.left >= menu.right || card.bottom <= menu.top || card.top >= menu.bottom);
        }), true);
    }
    await page.screenshot({ path: `tests/output/visual_audit/onboarding-authorization-${language}.png`, animations: 'disabled' });
    for (const platform of ['gemini', 'grok', 'claude']) await page.locator(`input[value="${platform}"]`).uncheck();
    await page.locator('#btnAuthorizePlatforms').click();
    // Successful authorization advances without an extra Next click or a connected account.
    await page.locator('#btnConnectPlatform-chatgpt').waitFor();
    assert.deepEqual(await read(page, 'connectionRequests'), [[['chatgpt'], true]]);
    assert.equal(await page.locator('.tour-authorization-menu').count(), 0);
    assert.equal(await page.locator('.tour-title').innerText(), language === 'en' ? 'Connect an account' : '识别平台账号');
});

test('no accounts: visit only an authorized site, detect on return, then explain the account selector', async () => {
    page = await browser.newPage();
    await mount(page, 'options', { accounts: [], tabs: [], geminiAccess: false, chatgptAccess: true }, '?startTour=1');
    await page.locator('#tourNextBtn:enabled').waitFor();
    await page.locator('#tourNextBtn').click();
    await page.getByRole('heading', { name: 'Connect an account', exact: true }).waitFor();
    await page.locator('#btnDetectAccount:enabled').waitFor();
    assert.equal(await page.locator('.tour-platform-choices button').count(), 1);
    assert.equal(await page.locator('#tourNextBtn').isDisabled(), true);
    await page.evaluate(() => Reflect.get(window, 'testUi').tour.nextStep());
    assert.equal(await page.locator('.tour-title').innerText(), 'Connect an account');
    await page.locator('#btnConnectPlatform-chatgpt').click();
    assert.deepEqual(await read(page, 'openedUrls'), ['https://chatgpt.com/']);
    assert.deepEqual(await read(page, 'signInRequests'), [{platform:'chatgpt',active:false}]);
    await page.evaluate(({ B }) => {
        Reflect.get(window, 'harness').accounts = [{ id: B, providerId: 'chatgpt', providerAccountId: 'signed-in-user' }];
        Reflect.get(window, 'harness').source = B;
    }, { B });
    await page.getByRole('heading', { name: 'Switch platforms and accounts', exact: true }).waitFor();
    assert.equal(await page.locator('#accountIdSelect').inputValue(), B);
    await page.locator('#tourNextBtn').click();
    await page.getByRole('heading', { name: 'Scan conversations', exact: true }).waitFor();
});

test('an import-only default account does not skip website account detection', async () => {
    page = await browser.newPage();
    await mount(page, 'options', { accounts: [{ id: A, providerId: 'gemini', providerAccountId: 'default' }], tabs: [] }, '?startTour=1');
    await page.locator('#tourNextBtn:enabled').waitFor();
    await page.locator('#tourNextBtn').click();
    await page.getByRole('heading', { name: 'Connect an account', exact: true }).waitFor();
    await page.locator('#btnDetectAccount:enabled').waitFor();
    assert.equal(await page.locator('#tourNextBtn').isDisabled(), true);
});

test('closing during detection discards late results; revoking all access returns to authorization', async () => {
    page = await browser.newPage();
    await mount(page, 'options', { accounts: [], tabs: [], holdDiscovery: true }, '?startTour=1');
    await page.locator('#tourNextBtn:enabled').waitFor();
    await page.locator('#tourNextBtn').click();
    await page.waitForFunction(() => typeof Reflect.get(window, 'harness').finishDiscovery === 'function');
    await page.locator('#tourCloseBtn').click();
    await page.evaluate(({ B }) => Reflect.get(window, 'harness').finishDiscovery(B), { B });
    assert.equal(await page.locator('.tour-popover').count(), 0);
    await page.evaluate(() => { Reflect.get(window, 'harness').holdDiscovery = false; });
    await page.locator('#btnTourGuide').click();
    await page.locator('#tourNextBtn:enabled').waitFor();
    await page.locator('#tourNextBtn').click();
    await page.locator('#btnDetectAccount:enabled').waitFor();
    await page.evaluate(() => { const h = Reflect.get(window, 'harness'); h.geminiAccess = false; h.accessListener(); });
    await page.locator('.tour-authorization-menu').waitFor();
    assert.equal(await page.locator('#tourNextBtn').isDisabled(), true);
});

test('existing recognized accounts wait for a user action before advancing connection', async () => {
    page = await browser.newPage();
    await mount(page, 'options', { initialOpenOptionsAccountId: B, source:B }, '?startTour=1');
    await page.locator('#tourNextBtn:enabled').waitFor();
    assert.equal(await page.locator('#accountIdSelect').inputValue(), B);
    await page.locator('#tourNextBtn').click();
    await page.locator('#btnDetectAccount:enabled').waitFor();
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.locator('#btnDetectAccount:enabled').waitFor();
    assert.equal(await page.locator('.tour-title').innerText(), 'Connect an account');
    assert.equal(await page.locator('#tourNextBtn').isEnabled(), true);
    await page.locator('#btnDetectAccount').click();
    await page.getByRole('heading', { name: 'Switch platforms and accounts', exact: true }).waitFor();
    assert.equal(await page.locator('#accountIdSelect').inputValue(), B);
    assert.equal(await page.locator('#btnDetectAccount').count(), 0);
    assert.deepEqual(await read(page, 'openedUrls'), undefined);
});

test('access revoked during a pending account lookup cannot advance the tutorial', async () => {
    page = await browser.newPage();
    await mount(page, 'options', { accounts: [], tabs: [], holdDiscovery: true }, '?startTour=1');
    await page.locator('#tourNextBtn:enabled').waitFor();
    await page.locator('#tourNextBtn').click();
    await page.waitForFunction(() => typeof Reflect.get(window, 'harness').finishDiscovery === 'function');
    await page.evaluate(({ B }) => {
        const h = Reflect.get(window, 'harness');
        h.geminiAccess = false;
        h.accessListener();
        h.finishDiscovery(B);
    }, { B });
    await page.locator('.tour-authorization-menu').waitFor();
    assert.equal(await page.locator('#tourNextBtn').isDisabled(), true);
});

test('tutorial authorization reuses the Site access page title, description and menu', async () => {
    page = await browser.newPage();
    await mount(page, 'options', { geminiAccess: false });
    const readPage = () => page.locator('.tour-popover').evaluate(popover => ({
        title: popover.querySelector('.tour-title')?.textContent,
        description: popover.querySelector('.tour-content')?.textContent,
        menu: popover.querySelector('.platform-authorization')?.textContent,
    }));
    await page.locator('#btnPlatformPermissions').click();
    await page.locator('#btnAuthorizePlatforms').waitFor();
    const siteAccess = await readPage();
    await page.locator('#platformAuthorizationDone').click();
    await page.locator('#btnTourGuide').click();
    await page.locator('#btnAuthorizePlatforms').waitFor();
    assert.deepEqual(await readPage(), siteAccess);
    assert.equal(await page.locator('.tour-coach-card').count(), 2);
    assert.equal(await page.locator('#tourNextBtn').isDisabled(), true);
});

test('account discovery gives each authorized platform a full button row', async () => {
    page = await browser.newPage();
    await mount(page, 'options', {accounts:[],tabs:[],geminiAccess:true,chatgptAccess:true,grokAccess:true,claudeAccess:true}, '?startTour=1');
    await page.locator('#tourNextBtn:enabled').waitFor(); await page.locator('#tourNextBtn').click();
    await page.locator('#btnDetectAccount:enabled').waitFor();
    const bounds = await page.locator('.tour-platform-choices button').evaluateAll(buttons => buttons.map(button => {
        const {x,y,width,height}=button.getBoundingClientRect(); return {x,y,width,height};
    }));
    assert.equal(bounds.length,4);
    for(let i=1;i<bounds.length;i++) {
        assert.equal(bounds[i].x,bounds[0].x); assert.equal(bounds[i].width,bounds[0].width);
        assert.ok(bounds[i].y>=bounds[i-1].y+bounds[i-1].height);
    }
});

test('returning to account connection keeps the lesson open and allows Next with an existing account', async () => {
    page = await browser.newPage();
    await mount(page, 'options', { initialOpenOptionsAccountId: B, source:B, chatgptAccess:true }, '?startTour=1');
    await page.locator('#tourNextBtn:enabled').waitFor();
    await page.locator('#tourNextBtn').click();
    await page.locator('#btnDetectAccount:enabled').click();
    await page.getByRole('heading',{name:'Switch platforms and accounts',exact:true}).waitFor();
    await page.locator('#tourPrevBtn').click();
    await page.getByRole('heading',{name:'Connect an account',exact:true}).waitFor();
    await page.locator('#tourNextBtn:enabled').waitFor();
    await page.getByRole('button',{name:'Connect ChatGPT',exact:true}).waitFor();
    await page.locator('#btnDetectAccount').click();
    await page.locator('#btnDetectAccount:enabled').waitFor();
    assert.equal(await page.locator('.tour-title').innerText(),'Connect an account');
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.locator('#btnDetectAccount:enabled').waitFor();
    assert.equal(await page.locator('.tour-title').innerText(),'Connect an account');
    await page.locator('#tourNextBtn').click();
    await page.getByRole('heading',{name:'Switch platforms and accounts',exact:true}).waitFor();
});

test('a stored ChatGPT account cannot advance connection until the scan source is verified', async () => {
    page=await browser.newPage();
    await mount(page,'options',{accounts:[{id:A,providerId:'chatgpt',providerAccountId:'stored'}],tabs:[],chatgptAccess:true,geminiAccess:false,connectionFailure:'chatgpt'},'?startTour=1');
    await page.locator('#tourNextBtn:enabled').waitFor(); await page.locator('#tourNextBtn').click();
    await page.getByRole('heading',{name:'Connect an account',exact:true}).waitFor();
    await page.locator('#btnDetectAccount:enabled').waitFor();
    assert.equal(await page.locator('#tourNextBtn').isEnabled(),false);
    await page.locator('#btnConnectPlatform-chatgpt').click();
    await page.locator('#btnDetectAccount:enabled').waitFor();
    assert.equal(await page.locator('.tour-title').innerText(),'Connect an account');
    await page.evaluate(()=>{Reflect.get(window,'harness').connectionFailure=null;});
    await page.getByRole('heading',{name:'Switch platforms and accounts',exact:true}).waitFor();
    assert.equal(await page.locator('#accountIdSelect').inputValue(),A);
});
