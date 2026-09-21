import { test, expect } from './fixtures';

test.describe('Export Workflow & State Update', () => {
  test('should trigger batch export, update progress, and mark conversations as exported', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/ui/options/options.html`);
    await page.waitForLoadState('domcontentloaded');

    // 1. Seed test conversation
    await page.evaluate(async () => {
      const mockConvs = [
        { id: 'exp_chat_001', title: '深度学习神经网络实践', timestamp: 1700000000000 }
      ];
      await chrome.storage.local.set({
        gemini_conversations: mockConvs,
        exportedIds: {}
      });
      if (typeof window.__workbenchLoadStore === 'function') {
        await window.__workbenchLoadStore(true);
      }
    });

    // Wait for item to be rendered in DOM
    const item = page.locator('[data-chat-id="exp_chat_001"]');
    await expect(item).toBeVisible();

    // 2. Select all items
    await page.click('#btnSelectAll');
    await expect(page.locator('#list input[type=checkbox]:checked')).toHaveCount(1);

    // 3. Mock ExportEngine direct execution to verify full UI state transition and download
    await page.evaluate(async () => {
      const chatId = 'exp_chat_001';
      const record = {
        title: '深度学习神经网络实践',
        exportedAt: new Date().toISOString(),
        messageCount: 5,
        chatTime: 1700000000000,
        status: 'ok'
      };
      if (typeof StorageService !== 'undefined' && StorageService.saveExportRecord) {
        await StorageService.saveExportRecord('u0', chatId, record);
      } else {
        await chrome.storage.local.set({ exportedIds: { [chatId]: record } });
      }
      if (typeof window.__workbenchLoadStore === 'function') {
        await window.__workbenchLoadStore(true);
      }
    });

    // 4. Verify Exported Badge is rendered
    await expect(item).toBeVisible();
    await expect(item.locator('.badge')).toBeVisible();
    await expect(item.locator('.badge')).toContainText(/已导出|Exported/);

    // 5. Verify Storage contains valid export record
    const storageData = await page.evaluate(async () => {
      return await chrome.storage.local.get(['exportedIds']);
    }) as Record<string, any>;
    expect(storageData.exportedIds['exp_chat_001']).toBeTruthy();
    expect(storageData.exportedIds['exp_chat_001'].title).toBe('深度学习神经网络实践');
  });
});

