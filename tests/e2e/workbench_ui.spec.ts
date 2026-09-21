import { test, expect } from './fixtures';

test.describe('Workbench UI & Selection Controls', () => {
  test('should render workbench list, handle selection controls, search, and language switch', async ({ context, extensionId }) => {
    const page = await context.newPage();

    // 1. Navigate to options page
    await page.goto(`chrome-extension://${extensionId}/src/ui/options/options.html`);
    await page.waitForLoadState('domcontentloaded');

    // 2. Seed mock conversations into chrome.storage.local via page execution
    await page.evaluate(async () => {
      const mockConvs = [
        { id: 'chat_001', title: '量子计算的基本原理', timestamp: 1700000000000 },
        { id: 'chat_002', title: 'AI 架构与设计模式', timestamp: 1700000100000 },
        { id: 'chat_003', title: 'Python 性能优化指南', timestamp: 1700000200000 }
      ];
      const mockExported = {
        'chat_001': { exportedAt: '2026-08-30T00:00:00Z', title: '量子计算的基本原理' }
      };
      await chrome.storage.local.set({
        gemini_conversations: mockConvs,
        exportedIds: mockExported
      });
      if (typeof window.__workbenchLoadStore === 'function') {
        await window.__workbenchLoadStore(true);
      }
    });

    // Wait for the 3 list items to be rendered
    const listItems = page.locator('#list .item');
    await expect(listItems).toHaveCount(3);

    // 3. Test Select All
    await page.click('#btnSelectAll');
    const checkedAfterSelectAll = await page.locator('#list input[type=checkbox]:checked').count();
    expect(checkedAfterSelectAll).toBe(3);
    await expect(page.locator('#selectedStat')).toContainText('3');

    // 4. Test Select None / Deselect All
    await page.click('#btnSelectNone');
    const checkedAfterSelectNone = await page.locator('#list input[type=checkbox]:checked').count();
    expect(checkedAfterSelectNone).toBe(0);
    await expect(page.locator('#selectedStat')).toContainText('0');

    // 4b. Test Row Click Toggle (clicking anywhere on the row toggles selection)
    const firstRow = page.locator('#list .item').first();
    const firstCheckbox = firstRow.locator('input[type=checkbox]');
    const firstTitle = firstRow.locator('.chat-title');

    // Click on title -> should select first item
    await firstTitle.click();
    expect(await firstCheckbox.isChecked()).toBe(true);
    expect(await page.locator('#list input[type=checkbox]:checked').count()).toBe(1);
    await expect(page.locator('#selectedStat')).toContainText('1');

    // Click on row again -> should deselect first item
    await firstRow.click();
    expect(await firstCheckbox.isChecked()).toBe(false);
    expect(await page.locator('#list input[type=checkbox]:checked').count()).toBe(0);
    await expect(page.locator('#selectedStat')).toContainText('0');

    // 5. Test Select All & Select None, and verify removed filter buttons
    await page.click('#btnSelectAll');
    expect(await page.locator('#list input[type=checkbox]:checked').count()).toBe(3);
    await page.click('#btnSelectNone');
    expect(await page.locator('#list input[type=checkbox]:checked').count()).toBe(0);

    // Filter buttons must no longer exist
    expect(await page.locator('#btnSelectUnexported').count()).toBe(0);
    expect(await page.locator('#btnSelectUpdated').count()).toBe(0);

    // 6. Test Real-time Search Filtering
    await page.fill('#chatSearchInput', '量子');
    const visibleCount = await page.locator('#list .item').count();
    expect(visibleCount).toBe(1);
    await expect(page.locator('#list .item').first()).toContainText('量子计算的基本原理');

    // Clear search
    await page.fill('#chatSearchInput', '');
    await expect(page.locator('#list .item')).toHaveCount(3);

    // 7. Test Language Toggle Preserves Selected Items
    // Uncheck everything then check only chat_002
    await page.click('#btnSelectNone');
    await page.locator('[data-chat-id="chat_002"] input[type=checkbox]').check();
    expect(await page.locator('#list input[type=checkbox]:checked').count()).toBe(1);

    // Switch to English
    await page.click('#labelLangEn');
    await expect(page.locator('#btnSelectAll')).toHaveText('All');
    // Selection must remain exactly 1 item (chat_002)
    expect(await page.locator('#list input[type=checkbox]:checked').count()).toBe(1);
    expect(await page.locator('[data-chat-id="chat_002"] input[type=checkbox]').isChecked()).toBe(true);

    // Switch back to Chinese
    await page.click('#labelLangZh');
    await expect(page.locator('#btnSelectAll')).toHaveText('全选');
    // Selection must still remain exactly 1 item (chat_002)
    expect(await page.locator('#list input[type=checkbox]:checked').count()).toBe(1);
    expect(await page.locator('[data-chat-id="chat_002"] input[type=checkbox]').isChecked()).toBe(true);

    // 8. Test Feedback Box as an interactive button link
    const feedbackBox = page.locator('#feedbackBox');
    await expect(feedbackBox).toBeVisible();
    await expect(feedbackBox).toHaveAttribute('href', 'https://tally.so/r/Y56ZBB');
    await expect(feedbackBox).toHaveAttribute('target', '_blank');
    await expect(feedbackBox).toContainText('遇到问题或有新建议？');

    // Standalone #btnFeedback must no longer exist
    expect(await page.locator('#btnFeedback').count()).toBe(0);

    // Switch to English and check feedback text
    await page.click('#labelLangEn');
    await expect(page.locator('[data-i18n="feedbackPrompt"]')).toHaveText('Got questions or suggestions?');

    // Switch back to Chinese
    await page.click('#labelLangZh');
    await expect(page.locator('[data-i18n="feedbackPrompt"]')).toHaveText('遇到问题或有新建议？');
  });

  test('should display "已更新" badge for previously exported conversations with new activity and auto-select', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/ui/options/options.html`);
    await page.waitForLoadState('domcontentloaded');

    await page.evaluate(async () => {
      await chrome.storage.local.clear();
      const Store = (window as any).Store;
      if (Store && typeof Store.setConversations === 'function') {
        Store.setConversations([]);
      }
      const now = Date.now();
      const mockConvs = [
        { id: 'chat_fresh', title: '未导出新会话', timestamp: now - 3600000 },
        { id: 'chat_exported', title: '已导出未变动会话', timestamp: now - 7200000, updatedAt: now - 7200000 },
        { id: 'chat_updated', title: '已导出又有新对话', timestamp: now - 7200000, updatedAt: now }
      ];
      const mockExported = {
        'chat_exported': { exportedAt: new Date(now - 3600000).toISOString(), title: '已导出未变动会话' },
        'chat_updated': { exportedAt: new Date(now - 3600000).toISOString(), title: '已导出又有新对话' }
      };
      await chrome.storage.local.set({
        gemini_conversations: mockConvs,
        exportedIds: mockExported
      });
      if (typeof window.__workbenchLoadStore === 'function') {
        await window.__workbenchLoadStore(true);
      }
    });

    const listItems = page.locator('#list .item');
    await expect(listItems).toHaveCount(3);

    // 1. Verify "Updated" badge on chat_updated (default headless locale is en)
    const updatedItem = page.locator('#list .item[data-chat-id="chat_updated"]');
    await expect(updatedItem.locator('.badge-updated')).toBeVisible();
    await expect(updatedItem.locator('.badge-updated')).toContainText('Updated');

    // 2. Verify "Exported" badge on chat_exported
    const exportedItem = page.locator('#list .item[data-chat-id="chat_exported"]');
    await expect(exportedItem.locator('.badge-exported')).toBeVisible();
    await expect(exportedItem.locator('.badge-exported')).toContainText('Exported');

    // 3. Verify unexported item has no badge
    const freshItem = page.locator('#list .item[data-chat-id="chat_fresh"]');
    expect(await freshItem.locator('.badge').count()).toBe(0);

    // 4. Verify default selection: chat_fresh and chat_updated are checked, chat_exported is unchecked
    expect(await freshItem.locator('input[type=checkbox]').isChecked()).toBe(true);
    expect(await updatedItem.locator('input[type=checkbox]').isChecked()).toBe(true);
    expect(await exportedItem.locator('input[type=checkbox]').isChecked()).toBe(false);
    expect(await page.locator('#list input[type=checkbox]:checked').count()).toBe(2);

    // 5. Test Chinese language switch: badge updates to "已更新" and "已导出"
    await page.click('#labelLangZh');
    await expect(updatedItem.locator('.badge-updated')).toContainText('已更新');
    await expect(exportedItem.locator('.badge-exported')).toContainText('已导出');
  });
});
