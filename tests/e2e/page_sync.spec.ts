import { test, expect } from './fixtures';

test.describe('In-Page Active Chat & Real Title Synchronization', () => {
  test('should detect active Gemini conversation and update real title in place', async ({ context, extensionId }) => {
    // 1. Seed initial conversation list with an untitled historical conversation
    const optionsPage = await context.newPage();
    await optionsPage.goto(`chrome-extension://${extensionId}/src/ui/options/options.html`);
    await optionsPage.waitForLoadState('domcontentloaded');

    await optionsPage.evaluate(async () => {
      const initialConvs = [
        { id: '39d5b41870e49a67', title: '未命名对话(39d5b4)', timestamp: 1680000000000 },
        { id: 'newer_chat_999', title: '最新对话', timestamp: 1700000000000 }
      ];
      await chrome.storage.local.set({ gemini_conversations: initialConvs });
      if (typeof window.__workbenchLoadStore === 'function') {
        await window.__workbenchLoadStore(true);
      }
    });

    await expect(optionsPage.locator('#list .item')).toHaveCount(2);

    // 2. Open simulated Gemini chat page
    const geminiPage = await context.newPage();

    // Route HTML to avoid Google auth redirect during testing
    await geminiPage.route('https://gemini.google.com/app/**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: `<!DOCTYPE html>
        <html>
        <head>
          <title>量子纠缠物理原理深度解析 - Google Gemini</title>
        </head>
        <body>
          <h1 data-test-id="conversation-title">量子纠缠物理原理深度解析</h1>
          <user-query><div class="query-text">什么是量子纠缠？详细解释一下它的物理原理。</div></user-query>
        </body>
        </html>`
      });
    });

    // Mock network batchexecute response for conversation detail
    const mockDetailInner = JSON.stringify([
      [
        ["c_39d5b41870e49a67", "turn_1", [null, null, ["什么是量子纠缠？详细解释一下它的物理原理。"]]]
      ],
      "tC_token_xyz",
      "量子纠缠物理原理深度解析"
    ]);
    const mockRpcResponse = `)]}'\n\n[["wrb.fr","hNvQHb",${JSON.stringify(mockDetailInner)}]]`;

    await geminiPage.route('**/batchexecute*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: mockRpcResponse
      });
    });

    // Navigate to simulated gemini chat URL
    await geminiPage.goto('https://gemini.google.com/app/39d5b41870e49a67');
    await geminiPage.waitForLoadState('domcontentloaded');

    // Trigger in-page sync in content script
    await geminiPage.evaluate(async () => {
      window.postMessage({
        type: 'GEMINI_NETWORK_BATCHEXECUTE',
        payload: {
          text: `)]}'\n\n[["wrb.fr","hNvQHb",${JSON.stringify(JSON.stringify([
            [["c_39d5b41870e49a67", "turn_1", [null, null, ["什么是量子纠缠？详细解释一下它的物理原理。"]]]],
            "tC_token_xyz",
            "量子纠缠物理原理深度解析"
          ]))}]]`,
          slot: 'u0'
        }
      }, location.origin);
    });

    // 3. Switch back to options page and verify title updated in place without breaking order
    await optionsPage.bringToFront();
    await optionsPage.waitForTimeout(600);

    await optionsPage.evaluate(async () => {
      if (typeof window.__workbenchLoadStore === 'function') {
        await window.__workbenchLoadStore(true);
      }
    });

    const targetItem = optionsPage.locator('[data-chat-id="39d5b41870e49a67"]');
    await expect(targetItem).toBeVisible();
    await expect(targetItem).toContainText('量子纠缠物理原理深度解析');

    // Verify ordering is preserved: newer_chat_999 is still at index 0, 39d5b41870e49a67 at index 1
    const allItems = optionsPage.locator('#list .item');
    await expect(allItems.nth(0)).toContainText('最新对话');
    await expect(allItems.nth(1)).toContainText('量子纠缠物理原理深度解析');
  });

  test('should keep clean title without "- Google Gemini" suffix when opening an existing Takeout imported chat', async ({ context, extensionId }) => {
    // 1. Seed Takeout imported chat
    const optionsPage = await context.newPage();
    await optionsPage.goto(`chrome-extension://${extensionId}/src/ui/options/options.html`);
    await optionsPage.waitForLoadState('domcontentloaded');

    await optionsPage.evaluate(async () => {
      const takeoutConvs = [
        { id: 'takeout_chat_888', title: '微服务与分布式事务设计', timestamp: 1670000000000 }
      ];
      await chrome.storage.local.set({ gemini_conversations: takeoutConvs });
      if (typeof window.__workbenchLoadStore === 'function') {
        await window.__workbenchLoadStore(true);
      }
    });

    await expect(optionsPage.locator('[data-chat-id="takeout_chat_888"]')).toContainText('微服务与分布式事务设计');

    // 2. Open chat in Gemini with branding suffix in document.title and header
    const geminiPage = await context.newPage();
    await geminiPage.route('https://gemini.google.com/app/**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: `<!DOCTYPE html>
        <html>
        <head>
          <title>微服务与分布式事务设计 - Google Gemini</title>
        </head>
        <body>
          <h1 data-test-id="conversation-title">微服务与分布式事务设计 - Google Gemini</h1>
        </body>
        </html>`
      });
    });

    await geminiPage.goto('https://gemini.google.com/app/takeout_chat_888');
    await geminiPage.waitForLoadState('domcontentloaded');
    await geminiPage.waitForTimeout(800); // Allow content.js syncOnce to run

    // 3. Verify in storage and options page that title NEVER contains "- Google Gemini"
    const storageData = await optionsPage.evaluate(async () => {
      return await chrome.storage.local.get(['gemini_conversations']);
    }) as Record<string, any>;
    const chat = (storageData.gemini_conversations || []).find((c: any) => c.id === 'takeout_chat_888');

    expect(chat).toBeTruthy();
    expect(chat.title).toBe('微服务与分布式事务设计');
    expect(chat.title).not.toContain('Google Gemini');
    expect(chat.title).not.toContain('Gemini');

    await optionsPage.bringToFront();
    await optionsPage.evaluate(async () => {
      if (typeof window.__workbenchLoadStore === 'function') {
        await window.__workbenchLoadStore(true);
      }
    });
    const itemText = await optionsPage.locator('[data-chat-id="takeout_chat_888"]').innerText();
    expect(itemText).toContain('微服务与分布式事务设计');
    expect(itemText).not.toContain('Google Gemini');
  });

  test('should NOT overwrite existing conversation title with "Google Gemini" while page is in initial loading state', async ({ context, extensionId }) => {
    // 1. Seed existing chat with Takeout prompt title
    const optionsPage = await context.newPage();
    await optionsPage.goto(`chrome-extension://${extensionId}/src/ui/options/options.html`);
    await optionsPage.waitForLoadState('domcontentloaded');

    await optionsPage.evaluate(async () => {
      const convs = [
        { id: 'loading_chat_777', title: '如何用Rust实现异步Actor模型', timestamp: 1670000000000 }
      ];
      await chrome.storage.local.set({ gemini_conversations: convs });
      if (typeof window.__workbenchLoadStore === 'function') {
        await window.__workbenchLoadStore(true);
      }
    });

    // 2. Open page when it is in initial loading state: document.title is literally "Google Gemini" and no DOM chat elements yet
    const geminiPage = await context.newPage();
    await geminiPage.route('https://gemini.google.com/app/**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: `<!DOCTYPE html>
        <html>
        <head>
          <title>Google Gemini</title>
        </head>
        <body>
          <div class="loading-spinner">Loading...</div>
        </body>
        </html>`
      });
    });

    await geminiPage.goto('https://gemini.google.com/app/loading_chat_777');
    await geminiPage.waitForLoadState('domcontentloaded');
    await geminiPage.waitForTimeout(600);

    // 3. Verify that storage and options page RETAINED the real title and NEVER became "Google Gemini"
    const storageData = await optionsPage.evaluate(async () => {
      return await chrome.storage.local.get(['gemini_conversations']);
    }) as Record<string, any>;
    const chat = (storageData.gemini_conversations || []).find((c: any) => c.id === 'loading_chat_777');
    expect(chat).toBeTruthy();
    expect(chat.title).toBe('如何用Rust实现异步Actor模型');
    expect(chat.title).not.toBe('Google Gemini');
    expect(chat.title).not.toBe('Gemini');
  });

  test('should render draggable export badge with default top 68px and persist dragged position', async ({ context, extensionId }) => {
    const geminiPage = await context.newPage();

    await geminiPage.route('https://gemini.google.com/app/**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: `<!DOCTYPE html>
        <html>
        <head>
          <title>测试对话 - Google Gemini</title>
        </head>
        <body style="width: 1000px; height: 800px;">
          <h1 data-test-id="conversation-title">测试对话</h1>
        </body>
        </html>`
      });
    });

    await geminiPage.goto('https://gemini.google.com/app/test_drag_badge');
    await geminiPage.waitForLoadState('domcontentloaded');

    const badge = geminiPage.locator('#geminiExportBadge');
    await expect(badge).toBeVisible();

    // 1. Verify default positioning (clears top bar: top is around 68px)
    const initialBox = await badge.boundingBox();
    expect(initialBox).toBeTruthy();
    expect(initialBox!.y).toBeGreaterThanOrEqual(60);

    // 2. Drag badge via pointer down, move, up
    await geminiPage.mouse.move(initialBox!.x + initialBox!.width / 2, initialBox!.y + initialBox!.height / 2);
    await geminiPage.mouse.down();
    await geminiPage.mouse.move(initialBox!.x - 100, initialBox!.y + 150, { steps: 5 });
    await geminiPage.mouse.up();

    // 3. Verify badge moved
    const movedBox = await badge.boundingBox();
    expect(movedBox).toBeTruthy();
    expect(movedBox!.y).toBeGreaterThan(initialBox!.y + 100);

    // 4. Verify position was stored in localStorage
    const storedPos = await geminiPage.evaluate(() => {
      return JSON.parse(localStorage.getItem('gemini_export_badge_pos') || 'null');
    });
    expect(storedPos).toBeTruthy();
    expect(typeof storedPos.left).toBe('number');
    expect(typeof storedPos.top).toBe('number');

    // 5. Reload page and check restored position
    await geminiPage.reload();
    await geminiPage.waitForLoadState('domcontentloaded');
    const reloadedBadge = geminiPage.locator('#geminiExportBadge');
    await expect(reloadedBadge).toBeVisible();
    const reloadedBox = await reloadedBadge.boundingBox();
    expect(reloadedBox).toBeTruthy();
    expect(Math.abs(reloadedBox!.x - movedBox!.x)).toBeLessThanOrEqual(5);
    expect(Math.abs(reloadedBox!.y - movedBox!.y)).toBeLessThanOrEqual(5);
  });

  test('should update active conversation timestamp and re-order to top when stream completes', async ({ context, extensionId }) => {
    // 1. Seed options workbench with an older chat and a newer chat
    const optionsPage = await context.newPage();
    await optionsPage.goto(`chrome-extension://${extensionId}/src/ui/options/options.html`);
    await optionsPage.waitForLoadState('domcontentloaded');

    await optionsPage.evaluate(async () => {
      const initialConvs = [
        { id: 'top_active_999', title: '原本排第一的新对话', timestamp: 1700000000000, updatedAt: 1700000000000, createdAt: 1690000000000, sidebarIndex: 0 },
        { id: 'historical_old_111', title: '原本沉在底部的老对话', timestamp: 1600000000000, updatedAt: 1600000000000, createdAt: 1590000000000, sidebarIndex: 1 }
      ];
      await chrome.storage.local.set({ gemini_conversations: initialConvs });
      if (typeof window.__workbenchLoadStore === 'function') {
        await window.__workbenchLoadStore(true);
      }
    });

    await expect(optionsPage.locator('#list .item')).toHaveCount(2);
    // Initial verification: top_active_999 is item 0, historical_old_111 is item 1
    await expect(optionsPage.locator('#list .item').nth(0)).toContainText('原本排第一的新对话');
    await expect(optionsPage.locator('#list .item').nth(1)).toContainText('原本沉在底部的老对话');

    // 2. Open Gemini page for the old conversation
    const geminiPage = await context.newPage();
    await geminiPage.route('https://gemini.google.com/app/**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: `<!DOCTYPE html>
        <html>
        <head>
          <title>原本沉在底部的老对话 - Google Gemini</title>
        </head>
        <body>
          <h1 data-test-id="conversation-title">原本沉在底部的老对话</h1>
          <user-query><div class="query-text">继续这个老话题...</div></user-query>
        </body>
        </html>`
      });
    });

    await geminiPage.goto('https://gemini.google.com/app/historical_old_111');
    await geminiPage.waitForLoadState('domcontentloaded');

    // 3. Simulate user sending a message and model completing generation via STREAM_COMPLETE
    await geminiPage.evaluate(async () => {
      window.postMessage({
        type: 'GEMINI_STREAM_GENERATE_COMPLETE',
        payload: {
          id: 'historical_old_111',
          slot: 'u0',
          url: 'https://gemini.google.com/app/historical_old_111'
        }
      }, location.origin);
    });

    // 4. In options page: without manual reload, the list should update reactively via syncUpdate
    await optionsPage.bringToFront();
    await expect(optionsPage.locator('#list .item').nth(0)).toContainText('原本沉在底部的老对话', { timeout: 4000 });
    await expect(optionsPage.locator('#list .item').nth(1)).toContainText('原本排第一的新对话');

    // 5. Verify storage persistence: historical_old_111 updatedAt was bumped and createdAt preserved
    const storageData = await optionsPage.evaluate(async () => {
      return await chrome.storage.local.get(['gemini_conversations']);
    }) as Record<string, any>;
    const oldChatInStorage = (storageData.gemini_conversations || []).find((c: any) => c.id === 'historical_old_111');
    expect(oldChatInStorage).toBeTruthy();
    expect(oldChatInStorage.updatedAt).toBeGreaterThan(1700000000000);
    expect(oldChatInStorage.timestamp).toBeGreaterThan(1700000000000);
    expect(oldChatInStorage.createdAt).toBe(1590000000000);
  });
});

