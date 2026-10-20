import { test, expect } from './fixtures';

test.describe('E2E: Export Session Recovery Banner & Interruption Handling', () => {
  test('should update chat title in storage & workbench during export, and restore session banner on reload', async ({ context, extensionId }) => {
    const optionsPage = await context.newPage();
    await optionsPage.goto(`chrome-extension://${extensionId}/src/ui/options/options.html?notour=1`);
    await optionsPage.waitForLoadState('domcontentloaded');

    // 1. Pre-populate initial Takeout imported chat
    await optionsPage.evaluate(async () => {
      const initialConvs = [
        {
          id: 'chat_session_test_1',
          title: 'Takeout Prompt 临时问题',
          titleSource: 'takeout',
          titles: { takeout: 'Takeout Prompt 临时问题' },
          timestamp: 1680000000000
        },
        {
          id: 'chat_session_test_2',
          title: '未导出第二个问题',
          titleSource: 'legacy',
          titles: { legacy: '未导出第二个问题' },
          timestamp: 1680000050000
        }
      ];
      await chrome.storage.local.set({
        gemini_conversations: initialConvs,
        exportedIds: {}
      });
      if (typeof window.__workbenchLoadStore === 'function') {
        await window.__workbenchLoadStore(true);
      }
    });

    const targetItem = optionsPage.locator('[data-chat-id="chat_session_test_1"]');
    await expect(targetItem).toContainText('Takeout Prompt 临时问题');

    // 2. Simulate export session in storage (interrupted state)
    await optionsPage.evaluate(async () => {
      await chrome.storage.local.set({
        gemini_exporter_lang: 'zh',
        gemini_last_export_session: {
          status: 'interrupted',
          slot: 'u0',
          total: 2,
          current: 1,
          lastChatId: 'chat_session_test_1',
          lastChatTitle: '深度学习架构与微调实战',
          updatedAt: Date.now()
        }
      });
    });

    // 3. Reload options workbench (user refreshed the page)
    await optionsPage.reload();
    await optionsPage.waitForLoadState('domcontentloaded');

    // 4. Verify Export Session Recovery Banner is rendered in Chinese
    const banner = optionsPage.locator('#exportSessionBanner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('发现未完成的导出任务');
    await expect(banner).toContainText('共 2 条');
    await expect(banner).toContainText('已处理 1 条');
    await expect(banner).toContainText('剩余 1 条未导出');
    await expect(banner).toContainText('深度学习架构与微调实战');

    const btnResume = optionsPage.locator('#btnResumeExport');
    await expect(btnResume).toBeVisible();
    await expect(btnResume).toContainText('继续导出未完成项');

    // 5. Test switching language to English dynamically updates banner
    await optionsPage.locator('#langToggle').check();
    await expect(banner).toContainText('Unfinished export task found');
    await expect(banner).toContainText('Total 2 chats, processed 1, 1 remaining');
    await expect(btnResume).toContainText('Resume Unfinished');

    // 6. Verify dismissing banner
    const btnDismiss = optionsPage.locator('#btnDismissExportBanner');
    await btnDismiss.click();
    await expect(banner).not.toBeVisible();

    const sessionData = await optionsPage.evaluate(async () => {
      return await chrome.storage.local.get(['gemini_last_export_session']);
    });
    expect(sessionData.gemini_last_export_session).toBeUndefined();
  });

  test('should disable scan during export and never show interruption banner during active run', async ({ context, extensionId }) => {
    // 1. Open mock Gemini page in background with delayed batchexecute response
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
              SNlM0e: 'mock_at_token_recovery',
              cfb2h: 'boq_assistant-bard-web-server_20260802.09_p1'
            };
          </script>
        </head>
        <body>Gemini Mock Session Active</body>
        </html>`
      });
    });

    let resolveRoute: () => void = () => {};
    const routeGate = new Promise<void>((resolve) => {
      resolveRoute = resolve;
    });

    const turns = [
      [
        ["c_chat_delay_001"],
        "turn_id_1",
        [["延迟测试提问"]],
        [
          [
            ["rc_cand_1", ["延迟测试回答"]]
          ]
        ]
      ]
    ];
    const mockDetailInner = JSON.stringify([
      turns,
      "tC_sample_token",
      "待导出延迟测试会话"
    ]);
    const mockRpcResponse = `)]}'\n\n[["wrb.fr","hNvQHb",${JSON.stringify(mockDetailInner)}]]`;

    await geminiPage.route('**/batchexecute*', async (route) => {
      await routeGate;
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
    await optionsPage.goto(`chrome-extension://${extensionId}/src/ui/options/options.html?notour=1`);
    await optionsPage.waitForLoadState('domcontentloaded');

    // Seed test conversation
    await optionsPage.evaluate(async () => {
      const convs = [
        { id: 'chat_delay_001', title: '待导出延迟测试会话', timestamp: 1700000000000 },
        ...Array.from({ length: 40 }, (_, i) => ({
          id: `chat_scroll_${i}`, title: `滚动测试会话 ${i}`, timestamp: 1699999999999 - i
        }))
      ];
      await chrome.storage.local.set({
        gemini_conversations: convs,
        exportedIds: {}
      });
      if (typeof window.__workbenchLoadStore === 'function') {
        await window.__workbenchLoadStore(true);
      }
    });

    await optionsPage.click('#btnSelectNone');
    await optionsPage.locator('[data-chat-id="chat_delay_001"] input[type=checkbox]').check();
    await expect(optionsPage.locator('#list input[type=checkbox]:checked')).toHaveCount(1);

    // 3. Trigger real export via clicking #btnExport to naturally enter running state
    await optionsPage.click('#btnExport');

    const banner = optionsPage.locator('#exportSessionBanner');
    await expect(banner).not.toBeVisible();

    const btnScan = optionsPage.locator('#btnIncrementalScan');
    const btnDeepScan = optionsPage.locator('#btnDeepScan');
    const btnExport = optionsPage.locator('#btnExport');

    // Buttons must be naturally disabled while ExportEngine is active
    await expect(btnScan).toBeDisabled();
    await expect(btnDeepScan).toBeDisabled();
    await expect(btnExport).toBeDisabled();

    const list = optionsPage.locator('#list');
    await expect(list.locator('input[type=checkbox]').first()).toBeDisabled();
    await list.locator('.chat-title').nth(1).click();
    await expect(list.locator('input[type=checkbox]:checked')).toHaveCount(1);
    await list.hover();
    await optionsPage.mouse.wheel(0, 450);
    await expect.poll(() => list.evaluate(el => el.scrollTop)).toBeGreaterThan(0);

    // 4. Trigger loadStore while export is running
    await optionsPage.evaluate(async () => {
      await chrome.storage.local.set({
        gemini_last_export_session: {
          status: 'running',
          slot: 'u0',
          total: 10,
          current: 3,
          updatedAt: Date.now()
        }
      });
      if (typeof window.__workbenchLoadStore === 'function') {
        await window.__workbenchLoadStore(true);
      }
    });

    // Banner MUST remain hidden while export is running
    await expect(banner).not.toBeVisible();

    // A render during export must preserve the selection lock.
    await expect(list.locator('input[type=checkbox]').first()).toBeDisabled();
    const checkedAfterRender = await list.locator('input[type=checkbox]:checked').count();
    await list.locator('.chat-title').first().click();
    await expect(list.locator('input[type=checkbox]:checked')).toHaveCount(checkedAfterRender);

    // 5. Unblock network gate so export completes cleanly without hanging context teardown
    const downloadPromise = optionsPage.waitForEvent('download', { timeout: 15000 }).catch(() => null);
    resolveRoute();
    await downloadPromise;

    // Export completes, naturally re-enabling all action buttons
    await expect(btnScan).toBeEnabled({ timeout: 10000 });
    await expect(btnDeepScan).toBeEnabled();
    await expect(btnExport).toBeEnabled();
    await expect(list.locator('input[type=checkbox]').first()).toBeEnabled();
  });
});
