import { geminiListPage, GEMINI_LIST_CAPTURE } from '../fixtures/providers/geminiListCapture.js';
import { test, expect, seedRegistryAccounts } from './fixtures';
import { openOptions, accountId } from './uiFixture';
import { listGen as geminiListGen } from '../fixtures/providers/gemini.js';
import { detailGen as geminiDetailGen } from '../fixtures/providers/geminiDetail.js';
import { requestGen as geminiListRequestGen } from '../fixtures/providers/geminiListRequest.js';
import { requestGen as geminiDetailRequestGen } from '../fixtures/providers/geminiDetailRequest.js';

test.beforeEach(async ({ context }) => { await seedRegistryAccounts(context); });

async function sourcePage(context: import('@playwright/test').BrowserContext, email = 'same@example.com') {
    const source = await context.newPage();
    await source.route('https://gemini.google.com/app', route => route.fulfill({
        contentType: 'text/html',
        body: '<script>window.WIZ_global_data={qDCSke:"10000000001",oPEP7c:"' + email + '"}</script><body>Fixture</body>',
    }));
    await source.goto('https://gemini.google.com/app');
    await expect(source.locator('#geminiExportBadge')).toBeVisible();
    return source;
}
function capturedContext(options: import('@playwright/test').Page) {
    return options.evaluate(async () => {
        const tabs = await chrome.tabs.query({ url: 'https://gemini.google.com/*' });
        return (await chrome.tabs.sendMessage(tabs[0].id!, { action: 'getAccountContext' })).accountContext;
    });
}
async function readIndexes(options: import('@playwright/test').Page, id: string) {
    return options.evaluate(async accountId => Reflect.get(globalThis, 'uiFixture').listIndexes(accountId), id) as Promise<Array<{ key: { conversationId: string } }>>;
}
async function send(source: import('@playwright/test').Page, transport: 'fetch' | 'xhr',
    rpc: 'MaZiqc' | 'hNvQHb', id: string) {
    const body = rpc === 'MaZiqc' ? geminiListRequestGen('G_E2E_UUID_LIST_REQUEST_01')
        : geminiDetailRequestGen(id === 'staleuuid123'
            ? 'G_E2E_UUID_DETAIL_REQUEST_STALE_01' : 'G_E2E_UUID_DETAIL_REQUEST_CURRENT_01');
    await source.evaluate(async ({ transport, body }) => {
        const url = '/_/BardChatUi/data/batchexecute';
        if (transport === 'fetch') await fetch(url, { method: 'POST', body });
        else await new Promise<void>((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open('POST', url);
            xhr.onload = () => resolve();
            xhr.onerror = () => reject(new Error('XHR failed'));
            xhr.send(body);
        });
    }, { transport, body });
}

for (const transport of ['fetch', 'xhr'] as const) {
    for (const kind of ['list', 'detail'] as const) {
        test(transport + ' ' + kind + ' binds delayed source evidence to the request UUID after a same-slot Gaia switch', async ({ context, extensionId }) => {
            const options = await openOptions(context, extensionId);
            const source = await sourcePage(context);
            const original = await capturedContext(options);
            expect(original.accountId).toBe(accountId);
            let release!: () => void;
            const held = new Promise<void>(resolve => { release = resolve; });
            let arrived!: () => void;
            const requestArrived = new Promise<void>(resolve => { arrived = resolve; });
            let index = 0;
            const rpc = kind === 'list' ? 'MaZiqc' : 'hNvQHb';
            await source.route('**/batchexecute*', async route => {
                const current = index++;
                if (current === 0) { arrived(); await held; }
                const response = kind === 'list'
                    ? geminiListGen(current === 0 ? 'G_E2E_UUID_LIST_STALE_01' : 'G_E2E_UUID_LIST_CURRENT_01')
                    : geminiDetailGen(current === 0 ? 'G_E2E_UUID_DETAIL_STALE_01' : 'G_E2E_UUID_DETAIL_CURRENT_01');
                await route.fulfill({ contentType: 'application/json', body: response });
            });
            const pending = send(source, transport, rpc, 'staleuuid123');
            await requestArrived;
            await source.evaluate(() => { (window as unknown as { WIZ_global_data: { qDCSke: string } }).WIZ_global_data.qDCSke = '10000000002'; });
            await expect.poll(async () => (await capturedContext(options)).accountId).toBe('10000000-0000-4000-8000-000000000002');
            release();
            await pending;
            await send(source, transport, rpc, 'currentuuid123');
            const other = '10000000-0000-4000-8000-000000000002';
            await expect.poll(async () => (await readIndexes(options, other)).some(row =>
                row.key.conversationId === 'currentuuid123')).toBe(true);
            await expect.poll(async () => (await readIndexes(options, accountId)).some(row =>
                row.key.conversationId === 'staleuuid123')).toBe(true);
            expect((await readIndexes(options, other)).some(row => row.key.conversationId === 'staleuuid123')).toBe(false);
            expect((await readIndexes(options, accountId)).some(row => row.key.conversationId === 'currentuuid123')).toBe(false);
        });
    }
}

test('delayed response keeps original v2 Account UUID without rolling back a newer display email', async ({ context, extensionId }) => {
    const options = await openOptions(context, extensionId);
    const source = await sourcePage(context, 'old@example.com');
    const original = await capturedContext(options);
    expect(original.accountId).toBe(accountId);
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let arrived!: () => void;
    const requestArrived = new Promise<void>(resolve => { arrived = resolve; });
    await source.route('**/batchexecute*', async route => {
        arrived(); await held;
        await route.fulfill({ contentType: 'application/json',
            body: geminiListPage().responseBody });
    });
    const pending = send(source, 'fetch', 'MaZiqc', 'profile_delay');
    await requestArrived;
    await source.evaluate(() => { (window as unknown as { WIZ_global_data: { oPEP7c: string } }).WIZ_global_data.oPEP7c = 'new@example.com'; });
    await expect.poll(async () => (await options.evaluate(async id =>
        Reflect.get(globalThis, 'uiFixture').getAccount(id), accountId))?.email).toBe('new@example.com');
    expect((await capturedContext(options)).accountId).toBe(original.accountId);
    release();
    await pending;
    await expect.poll(async () => (await readIndexes(options, original.accountId)).some(row =>
        row.key.conversationId === GEMINI_LIST_CAPTURE.first.id)).toBe(true);
    const account = await options.evaluate(async id => Reflect.get(globalThis, 'uiFixture').getAccount(id), original.accountId);
    expect(account.email).toBe('new@example.com');
});
