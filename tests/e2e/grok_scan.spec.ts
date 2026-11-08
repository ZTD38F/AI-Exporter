import { waitForAuthorization } from '../helpers/tourNavigation';
import { test, expect, seedRegistryAccounts } from './fixtures';
import { openOptions, accountId } from './uiFixture';
import { detailGen as grokDetailGen, metadataGen, treeGen, responsesGen } from '../fixtures/providers/grokDetail.js';
import { listGen as grokListGen } from '../fixtures/providers/grokList.js';
import { userGen as grokUserGen } from '../fixtures/providers/grokUser.js';
const wire = grokDetailGen('GR_DETAIL_TEXT_01');

async function grokBoundary(page: import('@playwright/test').Page, allow: boolean) {
    await page.evaluate(({ allow, replies }) => {
        let granted = false;
        const origin = 'https://grok.com/*';
        Object.defineProperty(chrome.permissions, 'contains', { configurable: true,
            value: async (request: { origins: string[] }) => granted && request.origins.includes(origin) });
        Object.defineProperty(chrome.permissions, 'request', { configurable: true,
            value: async () => { granted = allow; return allow; } });
        Object.defineProperty(chrome.tabs, 'query', { configurable: true,
            value: async (request: { url?: string | string[] }) => Array.isArray(request.url) && request.url.includes(origin)
                ? [{ id: 99, url: 'https://grok.com/' }] : [] });
        Object.defineProperty(chrome.tabs, 'get', { configurable: true, value: async () => ({ id: 99, url: 'https://grok.com/' }) });
        Object.defineProperty(chrome.tabs, 'sendMessage', { configurable: true, value: async () => ({ ok: true }) });
        const scripts: chrome.scripting.RegisteredContentScript[] = [];
        Object.defineProperty(chrome.scripting, 'getRegisteredContentScripts', { configurable: true, value: async () => scripts });
        Object.defineProperty(chrome.scripting, 'registerContentScripts', { configurable: true,
            value: async (items: chrome.scripting.RegisteredContentScript[]) => { scripts.push(...items); } });
        const calls: string[] = [];
        Reflect.set(window, 'grokHttpCalls', calls);
        Object.defineProperty(chrome.scripting, 'executeScript', { configurable: true,
            value: async (request: { args?: unknown[] }) => {
                const apiPath = String(request.args?.[0]); calls.push(apiPath);
                if (apiPath === '/rest/auth/get-user') return [{ result: { ok: true, value: replies.user } }];
                if (apiPath.includes('pageSize=60')) return [{ result: { ok: true, value: replies.list } }];
                if (apiPath.includes('conversations_v2')) return [{ result: { ok: true, value: replies.metadata } }];
                if (apiPath.includes('response-node')) return [{ result: { ok: true, value: replies.tree } }];
                if (apiPath.includes('load-responses')) return [{ result: { ok: true, value: replies.bodies } }];
                throw new Error('Unexpected Grok fixture endpoint: ' + apiPath);
            } });
    }, { allow, replies: { user: grokUserGen('GR_USER_E2E_01'), list: grokListGen('GR_LIST_TERMINAL_01'),
        metadata: metadataGen('GR_METADATA_01'), tree: treeGen('GR_TREE_STABLE_01'), bodies: responsesGen('GR_RESPONSES_01') } });
}

for (const allow of [true, false]) test(`Grok site authorization ${allow ? 'connects and syncs its native history' : 'denial leaves its account absent'}`, async ({ context, extensionId }) => {
    const page = await openOptions(context, extensionId);
    await grokBoundary(page, allow);
    await page.locator('#btnTourGuide').click(); await waitForAuthorization(page);
    for (const name of ['Gemini', 'ChatGPT', 'Claude']) await page.getByRole('checkbox', { name, exact: true }).uncheck();
    await page.locator('#btnAuthorizePlatforms').click();
    if (!allow) {
        await expect(page.locator('.tour-popover [role=status]')).toContainText('Access was not granted');
        await expect(page.locator('#tourNextBtn')).toBeDisabled();
        expect(await page.evaluate(() => Reflect.get(window, 'grokHttpCalls'))).toEqual([]);
        return;
    }
    await expect(page.locator('#tourNextBtn')).toBeEnabled();
    await page.locator('#tourNextBtn').click();
    await page.locator('#tourSkipBtn').click();
    await page.locator('#btnSyncAll').click();
    await expect(page.locator('#scanStatus')).toHaveText('Sync complete · 1 new conversation · 0 conversations updated');
    await expect(page.locator('#list .item')).toHaveCount(1);
    await expect(page.locator('#list')).toContainText(wire.metadata.conversation.title);
    await expect(page.locator('#list .open-link')).toHaveAttribute('href', 'https://grok.com/c/' + wire.id);
    await expect(page.locator('#list .open-link')).toHaveAttribute('aria-label', 'Open in Grok');
    await expect(page.locator('#btnImportTakeout')).toBeDisabled();
    expect(await page.evaluate(() => Reflect.get(window, 'grokHttpCalls'))).toContain('/rest/app-chat/conversations?pageSize=60');
});

test('an unavailable selected Gemini account stays selected while Grok is connected', async ({ context, extensionId }) => {
    await seedRegistryAccounts(context);
    const page = await openOptions(context, extensionId);
    await grokBoundary(page, true);
    await page.locator('#btnTourGuide').click(); await waitForAuthorization(page);
    for (const name of ['Gemini', 'ChatGPT', 'Claude']) await page.getByRole('checkbox', { name, exact: true }).uncheck();
    await page.locator('#btnAuthorizePlatforms').click();
    await expect(page.locator('#tourNextBtn')).toBeEnabled();
    await page.locator('#tourNextBtn').click();
    await page.locator('#tourSkipBtn').click();
    await page.locator('#accountIdSelect').selectOption(accountId);
    await page.locator('#btnSyncAll').click();
    await expect(page.locator('.tour-popover h2')).toHaveText('Connect Gemini account');
    await expect(page.getByRole('button', { name: 'Go to Gemini', exact: true })).toBeEnabled();
    await expect(page.locator('.tour-footer button')).toHaveCount(1);
    await expect(page.locator('#accountIdSelect')).toHaveValue(accountId);
    expect((await page.evaluate(() => Reflect.get(window, 'grokHttpCalls'))).some((path: string) => path.includes('pageSize=60'))).toBe(false);
});
