import { test, expect } from './fixtures';

test.describe('Deep E2E: Real Gemini Scanning & Network Pagination', () => {
  test('should execute full GeminiClient scan, parse batchexecute list RPC, update progress, and populate workbench', async ({ context, extensionId }) => {
    // 1. Open mock Gemini page in the background with credentials and MaZiqc RPC routing
    const geminiPage = await context.newPage();

    await geminiPage.route('https://gemini.google.com/**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: `<!DOCTYPE html>
        <html>
        <head>
          <script>
            window._WIZ_global_data = {
              SNlM0e: 'mock_at_token_scan',
              cfb2h: 'boq_assistant-bard-web-server_20260802.09_p1'
            };
          </script>
        </head>
        <body>Gemini Mock Active Tab</body>
        </html>`
      });
    });

    // Mock Gemini list response (MaZiqc)
    const mockListItems = [
      ["c_scan_001", "量子计算与超导量子比特", [1700000000, 0], [1700000000, 0], 4],
      ["c_scan_002", "Rust 高性能异步网络编程", [1700000100, 0], [1700000100, 0], 6],
      ["c_scan_003", "微服务架构与分布式事务", [1700000200, 0], [1700000200, 0], 8]
    ];
    const mockListInner = JSON.stringify([
      null,
      mockListItems,
      null // null nextPageToken indicates end of list
    ]);
    const mockRpcResponse = `)]}'\n\n[["wrb.fr","MaZiqc",${JSON.stringify(mockListInner)}]]`;

    await geminiPage.route('**/batchexecute*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: mockRpcResponse
      });
    });

    await geminiPage.goto('https://gemini.google.com/app');
    await geminiPage.waitForLoadState('domcontentloaded');

    // 2. Open Workbench Options page
    const optionsPage = await context.newPage();
    await optionsPage.goto(`chrome-extension://${extensionId}/src/ui/options/options.html`);
    await optionsPage.waitForLoadState('domcontentloaded');

    // Ensure list is initially empty
    await optionsPage.evaluate(async () => {
      await chrome.storage.local.set({
        gemini_conversations: [],
        exportedIds: {}
      });
      if (typeof window.__workbenchLoadStore === 'function') {
        await window.__workbenchLoadStore(true);
      }
    });

    // 3. Click "Sync Latest" / "增量同步" button
    await optionsPage.click('#btnIncrementalScan');

    // 4. Verify list is populated with all 3 scanned conversations
    const listItems = optionsPage.locator('#list .item');
    await expect(listItems).toHaveCount(3, { timeout: 10000 });

    await expect(optionsPage.locator('[data-chat-id="scan_001"]')).toContainText('量子计算与超导量子比特');
    await expect(optionsPage.locator('[data-chat-id="scan_002"]')).toContainText('Rust 高性能异步网络编程');
    await expect(optionsPage.locator('[data-chat-id="scan_003"]')).toContainText('微服务架构与分布式事务');

    // 5. Verify conversations are stored in storage
    const storageData = await optionsPage.evaluate(async () => {
      return await chrome.storage.local.get(['gemini_conversations']);
    }) as Record<string, any>;
    const convs = (storageData.gemini_conversations || []) as any[];
    expect(convs.length).toBe(3);
    expect(convs.find((c: any) => c.id === 'scan_001').title).toBe('量子计算与超导量子比特');
  });
});

