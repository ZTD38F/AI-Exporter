import { test, expect } from './fixtures';

test.describe('Export Workflow & State Update', () => {
  test('should trigger batch export, update progress, and mark conversations as exported', async ({ context, extensionId }) => {
    // 1. Open mock Gemini page in background with valid credentials and network routing
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
              SNlM0e: 'mock_at_token_123',
              cfb2h: 'boq_assistant-bard-web-server_20260802.09_p1'
            };
          </script>
        </head>
        <body>Gemini Mock Session Active</body>
        </html>`
      });
    });

    const turns = [
      [
        ["c_exp_chat_001"],
        "turn_id_1",
        [["请概述深度学习神经网络的实践要点。"]],
        [
          [
            ["rc_cand_1", ["深度学习神经网络实践包含数据预处理、模型架构设计、超参数调优与正则化等关键环节。"]]
          ]
        ]
      ]
    ];
    const mockDetailInner = JSON.stringify([
      turns,
      "tC_sample_token",
      "深度学习神经网络实践"
    ]);
    const mockRpcResponse = `)]}'\n\n[["wrb.fr","hNvQHb",${JSON.stringify(mockDetailInner)}]]`;

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
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/ui/options/options.html?notour=1`);
    await page.waitForLoadState('domcontentloaded');

    // Seed test conversation
    await page.evaluate(async () => {
      const mockConvs = [
        { id: 'exp_chat_001', title: '深度学习神经网络实践', timestamp: 1700000000000 }
      ];
      await chrome.storage.local.set({
        gemini_conversations: mockConvs,
        exportedIds: {},
        has_completed_tour: true,
        last_seen_feature_version: '999.0.0'
      });
      if (typeof window.__workbenchLoadStore === 'function') {
        await window.__workbenchLoadStore(true);
      }
    });

    // Wait for item to be rendered in DOM
    const item = page.locator('[data-chat-id="exp_chat_001"]');
    await expect(item).toBeVisible();

    // 3. Select all items
    await page.click('#btnSelectAll');
    await expect(page.locator('#list input[type=checkbox]:checked')).toHaveCount(1);

    // 4. Trigger real Export through clicking #btnExport and wait for download
    const downloadPromise = page.waitForEvent('download', { timeout: 30000 });
    await page.click('#btnExport');

    const download = await downloadPromise;
    expect(download).toBeTruthy();

    // 5. Verify Exported Badge is rendered on the conversation item
    await expect(item.locator('.badge')).toBeVisible();
    await expect(item.locator('.badge')).toContainText(/已导出|Exported/);

    // 6. Verify Storage contains valid export record persisted by ExportEngine
    const storageData = await page.evaluate(async () => {
      return await chrome.storage.local.get(['exportedIds']);
    }) as Record<string, any>;
    expect(storageData.exportedIds['exp_chat_001']).toBeTruthy();
    expect(storageData.exportedIds['exp_chat_001'].title).toBe('深度学习神经网络实践');
  });

  test('should fast-skip already exported items without generating empty zip', async ({ context, extensionId }) => {
    // 1. Open Workbench Options page
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/ui/options/options.html?notour=1`);
    await page.waitForLoadState('domcontentloaded');

    // Seed test conversation and mark it already exported in exportedIds
    await page.evaluate(async () => {
      const mockConvs = [
        { id: 'exp_chat_skip_001', title: '跳过测试会话', timestamp: 1700000000000 }
      ];
      await chrome.storage.local.set({
        gemini_conversations: mockConvs,
        gemini_export_zip: true,
        exportedIds: {
          'exp_chat_skip_001': {
            exportedAt: 1700000000000,
            title: '跳过测试会话'
          }
        }
      });
      if (typeof (window as any).__workbenchLoadStore === 'function') {
        await (window as any).__workbenchLoadStore(true);
      }
    });

    const item = page.locator('[data-chat-id="exp_chat_skip_001"]');
    await expect(item).toBeVisible();

    // Select the conversation
    await page.click('#btnSelectAll');
    await expect(page.locator('#list input[type=checkbox]:checked')).toHaveCount(1);

    // Ensure skipExported is checked
    const skipCheckbox = page.locator('#skipExported');
    if (!(await skipCheckbox.isChecked())) {
      await skipCheckbox.check();
    }

    // Ensure includeZip is checked
    const zipCheckbox = page.locator('#includeZip');
    if (!(await zipCheckbox.isChecked())) {
      await zipCheckbox.check();
    }

    // Listen to download event to assert NO download occurs
    let downloadTriggered = false;
    page.on('download', () => {
      downloadTriggered = true;
    });

    // Click Export
    await page.click('#btnExport');

    // Verify fast-skip log and notification in progress area
    await expect(page.locator('#progText')).toContainText(/(跳过|skipped|无需生成 ZIP)/);

    // Verify export button becomes active again quickly (not stuck in disabled state)
    await expect(page.locator('#btnExport')).toBeEnabled();

    // Assert that no empty zip download was triggered
    expect(downloadTriggered).toBe(false);
  });

  test('should clear exported records via #btnClearExported, re-select chats, and not toggle #skipExported', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/ui/options/options.html?notour=1`);
    await page.waitForLoadState('domcontentloaded');

    await page.evaluate(async () => {
      const mockConvs = [
        { id: 'clear_chat_001', title: '已导出会话一', timestamp: 1700000000000 },
        { id: 'clear_chat_002', title: '已导出会话二', timestamp: 1700000000000 }
      ];
      await chrome.storage.local.set({
        gemini_conversations: mockConvs,
        exportedIds: {
          'clear_chat_001': { exportedAt: 1700000005000, title: '已导出会话一' },
          'clear_chat_002': { exportedAt: 1700000005000, title: '已导出会话二' }
        },
        has_completed_tour: true,
        last_seen_feature_version: '999.0.0'
      });
      if (typeof (window as any).__workbenchLoadStore === 'function') {
        await (window as any).__workbenchLoadStore(true);
      }
    });

    await expect(page.locator('#list .badge-exported')).toHaveCount(2);
    await expect(page.locator('#list input[type=checkbox]:checked')).toHaveCount(0);
    await expect(page.locator('#skipExported')).toBeChecked();

    // Click #btnClearExported
    await page.click('#btnClearExported');

    // Exported badges must be cleared, all items auto-checked for re-export, and #skipExported unchanged
    await expect(page.locator('#list .badge-exported')).toHaveCount(0);
    await expect(page.locator('#list input[type=checkbox]:checked')).toHaveCount(2);
    await expect(page.locator('#skipExported')).toBeChecked();

    // Verify storage keys (exportedIds) are cleared
    const storageAfter = await page.evaluate(async () => {
      return await chrome.storage.local.get(['exportedIds']);
    }) as Record<string, any>;
    expect(Object.keys(storageAfter.exportedIds || {})).toHaveLength(0);
  });
});



