import { test, expect, seedRegistryAccounts } from './fixtures';
import { openOptions, seedConversations, accountId } from './uiFixture';
import { listGen as geminiListGen } from '../fixtures/providers/gemini.js';
import { detailGen as geminiDetailGen } from '../fixtures/providers/geminiDetail.js';
import { requestGen as geminiListRequestGen } from '../fixtures/providers/geminiListRequest.js';
import { requestGen as geminiDetailRequestGen } from '../fixtures/providers/geminiDetailRequest.js';

/** Cross-module v2 title authority: L1 source -> L2 Index -> L3a -> real Options UI. */
test.beforeEach(async ({ context }) => { await seedRegistryAccounts(context); });

async function sourcePage(context: import('@playwright/test').BrowserContext) {
    const source = await context.newPage();
    await source.route('https://gemini.google.com/**', route => route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><title>Google Gemini</title><script>window.WIZ_global_data={qDCSke:"10000000001",SNlM0e:"test",cfb2h:"test"}</script><main>Source</main>',
    }));
    await source.goto('https://gemini.google.com/app');
    await expect(source.locator('#geminiExportBadge')).toBeVisible();
    return source;
}
async function index(options: import('@playwright/test').Page, id: string) {
    return options.evaluate(async ({ id, accountId }) =>
        Reflect.get(globalThis, 'uiFixture').getIndex({ accountId, conversationId: id }), { id, accountId });
}
async function refresh(options: import('@playwright/test').Page) {
    await options.evaluate(() => window.dispatchEvent(new Event('focus')));
}
async function providerList(source: import('@playwright/test').Page, key: Parameters<typeof geminiListGen>[0]) {
    await source.route('**/batchexecute*', route => route.fulfill({
        contentType: 'application/json',
        body: geminiListGen(key),
    }));
    await source.evaluate(async body => fetch('/_/BardChatUi/data/batchexecute', {
        method: 'POST', body: new URLSearchParams(body),
    }), geminiListRequestGen('G_E2E_TITLE_ARBITRATION_LIST_REQUEST_01'));
}

test('v2 title precedence is user > provider > derived across actual passive RPC and L2 admissions', async ({ context, extensionId }) => {
    const id = 'arbitration_chat_999';
    const options = await openOptions(context, extensionId);
    await seedConversations(options, [
        { id, title: 'Takeout Prompt 原始提问', titleSource: 'derived', updatedAt: 1670000000000 },
    ]);
    const source = await sourcePage(context);
    await expect(options.locator('[data-chat-id="' + id + '"]')).toContainText('Takeout Prompt 原始提问');

    // Loading tab/title is not an Index admission; a verified source response is.
    expect((await index(options, id))?.titleSource).toBe('derived');
    await providerList(source, 'G_DYNAMIC_TITLE_ARBITRATION_01');
    await expect.poll(async () => (await index(options, id))?.title).toBe('官方服务端RPC最终权威标题');
    expect((await index(options, id))?.titleSource).toBe('provider');
    await refresh(options);
    await expect(options.locator('[data-chat-id="' + id + '"]')).toContainText('官方服务端RPC最终权威标题');

    // A second provider fact of equal authority is the most recently admitted.
    await options.evaluate(async ({ accountId, id }) => Reflect.get(globalThis, 'uiFixture').ingestIndexes(accountId, [{
        conversationId: id, fields: { title: 'RPC 新标题', titleSource: 'provider', updatedAt: 1700000100000 },
    }]), { accountId, id });
    await expect.poll(async () => (await index(options, id))?.title).toBe('RPC 新标题');

    // User-chosen title is the highest authority; later RPC and derived evidence
    // cannot overwrite it, even when the provider reports a later activity time.
    await options.evaluate(async ({ accountId, id }) => Reflect.get(globalThis, 'uiFixture').ingestIndexes(accountId, [{
        conversationId: id, fields: { title: '用户手动标题', titleSource: 'user' },
    }]), { accountId, id });
    await providerList(source, 'G_DYNAMIC_TITLE_ARBITRATION_02');
    // The MAIN fetch has returned, but the isolated Sniffer -> Background L2
    // admission is asynchronous. The user title cannot signal the commit: it
    // intentionally remains unchanged by this lower-priority provider fact.
    await expect.poll(async () => (await index(options, id))?.updatedAt).toBe(1700000200000);
    await options.evaluate(async ({ accountId, id }) => Reflect.get(globalThis, 'uiFixture').ingestIndexes(accountId, [{
        conversationId: id, fields: { title: '过时的离线标题', titleSource: 'derived' },
    }]), { accountId, id });
    const stored = await index(options, id);
    expect(stored?.title).toBe('用户手动标题');
    expect(stored?.titleSource).toBe('user');
    expect(stored?.updatedAt).toBe(1700000200000);
    expect(stored).not.toHaveProperty('titles');
    expect(stored).not.toHaveProperty('hasTakeoutImport');
    await refresh(options);
    await expect(options.locator('[data-chat-id="' + id + '"]')).toContainText('用户手动标题');
    await expect(options.locator('[data-chat-id="' + id + '"]')).not.toContainText('RPC 更晚的标题');
});

test('a native Gemini detail with no titled metadata derives a v2 Index title from its first authored user question', async ({ context, extensionId }) => {
    const options = await openOptions(context, extensionId);
    const source = await sourcePage(context);
    const id = 'sniff_test_chat_888';
    const answer = '构建高性能分布式缓存需要注意这些要点';
    await source.route('**/batchexecute*', route => route.fulfill({
        contentType: 'application/json',
        body: geminiDetailGen('G_DYNAMIC_TITLE_ARBITRATION_DETAIL_01'),
    }));
    // Native request parameters are the v2 characterized hNvQHb request contract.
    // The shipped MAIN hook and isolated MessageBridge parse/commit the real body.
    await source.evaluate(async body => fetch('/_/BardChatUi/data/batchexecute', {
        method: 'POST', body: new URLSearchParams(body),
    }), geminiDetailRequestGen('G_E2E_TITLE_ARBITRATION_DETAIL_REQUEST_01'));
    await expect.poll(async () => (await index(options, id))?.title ?? '').toContain('如何构建高性能分布式缓存');
    const stored = await index(options, id);
    expect(stored?.titleSource).toBe('derived');
    expect(stored).not.toHaveProperty('titles');

    const domain = await options.evaluate(async ({ accountId, id }) =>
        Reflect.get(globalThis, 'uiFixture').readConversation({ accountId, conversationId: id }), { accountId, id });
    expect(domain?.detail.messages.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(domain?.detail.messages)).toContain(answer);
    await refresh(options);
    await expect(options.locator('[data-chat-id="' + id + '"]')).toContainText('如何构建高性能分布式缓存');
    await expect(options.locator('.tour-popover')).toHaveCount(0);
});
