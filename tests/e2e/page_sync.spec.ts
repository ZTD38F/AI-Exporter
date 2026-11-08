import { test, expect, seedRegistryAccounts } from './fixtures';
import { openOptions, seedConversations, accountId } from './uiFixture';
import { listGen as geminiListGen } from '../fixtures/providers/gemini.js';
import { requestGen as geminiListRequestGen } from '../fixtures/providers/geminiListRequest.js';

test.beforeEach(async ({ context }) => { await seedRegistryAccounts(context); });

async function sourcePage(context: import('@playwright/test').BrowserContext, title: string) {
    const page = await context.newPage();
    await page.route('https://gemini.google.com/**', route => route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: '<!doctype html><html><head><title>' + title +
            '</title><script>window.WIZ_global_data={qDCSke:"10000000001",SNlM0e:"test",cfb2h:"build"}</script></head><body><h1>Gemini Chat</h1></body></html>',
    }));
    await page.goto('https://gemini.google.com/app/c_39d5b41870e49a67');
    await expect(page.locator('#geminiExportBadge')).toBeVisible();
    return page;
}
async function captureProviderList(source: import('@playwright/test').Page, key: Parameters<typeof geminiListGen>[0]) {
    await source.route('**/batchexecute*', route => route.fulfill({
        contentType: 'application/json',
        body: geminiListGen(key),
    }));
    // The real MAIN fetch hook captures this response and the isolated L1 bridge
    // commits it through the v2 Background Domain-ingestion port.
    await source.evaluate(async body => fetch('/_/BardChatUi/data/batchexecute', {
        method: 'POST', body: new URLSearchParams(body),
    }), geminiListRequestGen('G_E2E_PAGE_SYNC_LIST_REQUEST_01'));
}
async function storedIndex(options: import('@playwright/test').Page, id: string) {
    return options.evaluate(async ({ accountId, id }) =>
        Reflect.get(globalThis, 'uiFixture').getIndex({ accountId, conversationId: id }), { accountId, id });
}

test('provider list evidence updates a derived title in v2 without moving a newer conversation', async ({ context, extensionId }) => {
    const oldId = '39d5b41870e49a67', newerId = 'newer_chat_999';
    const options = await openOptions(context, extensionId);
    await seedConversations(options, [
        { id: oldId, title: '未命名对话(39d5b4)', titleSource: 'derived', updatedAt: 1680000000000 },
        { id: newerId, title: '最新对话', titleSource: 'provider', updatedAt: 1700001000000 },
    ]);
    const source = await sourcePage(context, 'Initial loading - Google Gemini');
    await captureProviderList(source, 'G_DYNAMIC_PAGE_SYNC_01');
    await expect.poll(async () => (await storedIndex(options, oldId))?.title).toBe('量子纠缠物理原理深度解析');
    expect((await storedIndex(options, oldId))?.titleSource).toBe('provider');
    await options.bringToFront();
    await options.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(options.locator('[data-chat-id="' + oldId + '"]')).toContainText('量子纠缠物理原理深度解析');
    await expect(options.locator('#list .item').nth(0)).toContainText('最新对话');
    await expect(options.locator('#list .item').nth(1)).toContainText('量子纠缠物理原理深度解析');
    await expect(options.locator('#list .item')).toHaveCount(2);
});

test('user-authoritative v2 title ignores lower-authority RPC title and branded browser document title', async ({ context, extensionId }) => {
    const id = 'takeout_chat_888';
    const options = await openOptions(context, extensionId);
    await seedConversations(options, [{ id, title: '微服务与分布式事务设计', titleSource: 'user', updatedAt: 1680000000000 }]);
    const source = await sourcePage(context, '微服务与分布式事务设计 - Google Gemini');
    await captureProviderList(source, 'G_DYNAMIC_PAGE_SYNC_02');
    await expect.poll(async () => (await storedIndex(options, id))?.updatedAt).toBe(1700000200000);
    const index = await storedIndex(options, id);
    expect(index?.title).toBe('微服务与分布式事务设计');
    expect(index?.titleSource).toBe('user');
    await options.bringToFront();
    await options.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(options.locator('[data-chat-id="' + id + '"]')).toContainText('微服务与分布式事务设计');
    await expect(options.locator('[data-chat-id="' + id + '"]')).not.toContainText('Google Gemini');
});

test('an empty provider page named Google Gemini does not manufacture a v2 title update', async ({ context, extensionId }) => {
    const id = 'loading_chat_777';
    const options = await openOptions(context, extensionId);
    await seedConversations(options, [{ id, title: '如何用Rust实现异步Actor模型', titleSource: 'derived',
        updatedAt: 1670000000000 }]);
    const source = await sourcePage(context, 'Google Gemini');
    await expect(source.locator('#geminiExportBadge')).toBeVisible();
    const index = await storedIndex(options, id);
    expect(index?.title).toBe('如何用Rust实现异步Actor模型');
    expect(index?.updatedAt).toBe(1670000000000);
    await options.bringToFront();
    await options.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(options.locator('[data-chat-id="' + id + '"]')).toContainText('如何用Rust实现异步Actor模型');
});

test('dragged Gemini badge is restored from v2 Settings, not page localStorage', async ({ context, extensionId }) => {
    const options = await openOptions(context, extensionId);
    const source = await sourcePage(context, 'Badge test');
    const badge = source.locator('#geminiExportBadge');
    const initial = await badge.boundingBox();
    expect(initial).toBeTruthy();
    expect(initial!.y).toBeGreaterThanOrEqual(60);
    await source.mouse.move(initial!.x + initial!.width / 2, initial!.y + initial!.height / 2);
    await source.mouse.down();
    await source.mouse.move(initial!.x + initial!.width / 2 - 100, initial!.y + initial!.height / 2 + 150, { steps: 5 });
    await source.mouse.up();
    const moved = await badge.boundingBox();
    expect(moved).toBeTruthy();
    expect(moved!.y).toBeGreaterThan(initial!.y + 100);
    await expect.poll(async () => options.evaluate(async () =>
        (await Reflect.get(globalThis, 'uiFixture').getSettings()).badgePosition?.top)).toBe(Math.round(moved!.y));
    const position = await options.evaluate(async () =>
        (await Reflect.get(globalThis, 'uiFixture').getSettings()).badgePosition);
    expect(position).toMatchObject({ left: Math.round(moved!.x), top: Math.round(moved!.y) });
    await source.reload();
    await expect(badge).toBeVisible();
    await expect.poll(async () => {
        const restored = await badge.boundingBox();
        return !!restored && Math.abs(restored.x - moved!.x) <= 5
            && Math.abs(restored.y - moved!.y) <= 5;
    }).toBe(true);
});
