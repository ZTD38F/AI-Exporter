import { test, expect, seedRegistryAccounts } from './fixtures';
import { listGen as geminiListGen } from '../fixtures/providers/gemini.js';
import { openOptions, accountId } from './uiFixture';

test.beforeEach(async ({context, extensionId}) => {
    void extensionId;
    await seedRegistryAccounts(context);
});

test.describe('Deep E2E: Real Gemini Scanning & Network Pagination', () => {
  test('should execute full GeminiClient scan, parse batchexecute list RPC, update progress, and populate workbench', async ({ context, extensionId }) => {
    const geminiPage = await context.newPage();

    await geminiPage.route('https://gemini.google.com/**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: `<!DOCTYPE html>
        <html>
        <head>
          <script>
            window.WIZ_global_data = {
              qDCSke: '10000000001', SNlM0e: 'mock_at_token_scan',
              cfb2h: 'boq_assistant-bard-web-server_20260802.09_p1'
            };
          </script>
        </head>
        <body><button aria-label="Google Account: Scan (scan@example.com)">Scan</button>Gemini Mock Active Tab</body>
        </html>`
      });
    });

    // The initial, renamed and pinned List pages are immutable keyed wire samples.
    let renamed = false;
    const requestedKinds: string[] = [];
    await context.route('**/batchexecute*', async (route) => {
      const wire = new URLSearchParams(route.request().postData() || '').get('f.req');
      const args = JSON.parse(JSON.parse(wire!)[0][0][1]);
      const pinned = args[2][0] === 1;
      requestedKinds.push(pinned ? 'pinned' : 'recent');
      // Gemini list's v2 terminal evidence is the explicit null next cursor in
      // slot 1, with item rows in slot 2. [null, rows, null] may still parse
      // indexes via the legacy fallback slot, but is not a trusted source_end
      // and therefore must NOT establish L2 Coverage.
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: geminiListGen(pinned ? 'G_DYNAMIC_SCAN_FLOW_PINNED_01'
          : renamed ? 'G_DYNAMIC_SCAN_FLOW_LIST_02' : 'G_DYNAMIC_SCAN_FLOW_LIST_01')
      });
    });

    await geminiPage.goto('https://gemini.google.com/app');
    await geminiPage.waitForLoadState('domcontentloaded');

    const optionsPage = await openOptions(context,extensionId);
    await expect(optionsPage.locator('#list .item')).toHaveCount(0);
    await optionsPage.click('#btnSyncAll');

    // 4. Ordinary Scan All admits Recent; the separate pinned item stays absent.
    const listItems = optionsPage.locator('#list .item');
    await expect(listItems).toHaveCount(3, { timeout: 10000 });
    await expect(optionsPage.locator('[data-chat-id="scan_pinned"]')).toHaveCount(0);
    await expect(optionsPage.locator('body')).toHaveAttribute('data-scanning', 'false');

    await expect(optionsPage.locator('[data-chat-id="scan_001"]')).toContainText('量子计算与超导量子比特');
    await expect(optionsPage.locator('[data-chat-id="scan_002"]')).toContainText('Rust 高性能异步网络编程');
    await expect(optionsPage.locator('[data-chat-id="scan_003"]')).toContainText('微服务架构与分布式事务');

    const storageData = await optionsPage.evaluate(async accountId => {
      const api = Reflect.get(globalThis,'uiFixture');
      return { indexes: await api.listIndexes(accountId), coverage: await api.getCoverage(accountId,'recent') };
    },accountId);
    expect(storageData.indexes).toHaveLength(3);
    expect(storageData.coverage.range.head.time).toBe(1700000200000);
    const oldChat = storageData.indexes.find((c: {key:{conversationId:string}})=>c.key.conversationId==='scan_001');
    expect(oldChat.title).toBe('量子计算与超导量子比特');expect(oldChat.updatedAt).toBe(1700000000000);
    // Badge reads local count on source attachment/passive commits; Options owns no new broadcast channel.
    await geminiPage.reload();
    await expect(geminiPage.locator('#geminiExportBadge')).toContainText('3');
    // Renaming an old item does not change its timestamp or move it ahead of the head.
    renamed = true;
    await optionsPage.click('#btnSyncAll');
    await expect(optionsPage.locator('body')).toHaveAttribute('data-scanning', 'false');
    await expect(listItems).toHaveCount(3);
    await expect(optionsPage.locator('[data-chat-id="scan_001"]')).toContainText('改名后的老会话');
    const repeated = await optionsPage.evaluate(async accountId => {
      const api = Reflect.get(globalThis,'uiFixture');
      return { indexes: await api.listIndexes(accountId), coverage: await api.getCoverage(accountId,'recent') };
    },accountId);
    expect(repeated.coverage.range.head.time).toBe(1700000200000);
    expect(repeated.indexes.find((c: {key:{conversationId:string}})=>c.key.conversationId==='scan_001').updatedAt).toBe(oldChat.updatedAt);
    expect(requestedKinds).toEqual(['recent', 'recent']);
  });
});

