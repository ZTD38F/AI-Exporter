import { test, expect } from './fixtures';

test.describe('E2E: Direct Write Suggestion Prompt for Large Bulk Exports', () => {
  test('should show suggestion modal only once when exporting >= 50 conversations and never prompt again', async ({ context, extensionId }) => {
    const page = await context.newPage();

    // 1. Navigate to options page
    await page.goto(`chrome-extension://${extensionId}/src/ui/options/options.html`);
    await page.waitForLoadState('domcontentloaded');

    // 2. Seed 55 mock conversations into chrome.storage.local
    await page.evaluate(async () => {
      const mockConvs = [];
      for (let i = 1; i <= 55; i++) {
        mockConvs.push({
          id: `chat_bulk_${String(i).padStart(3, '0')}`,
          title: `大批量测试会话 ${i}`,
          timestamp: 1700000000000 + i * 1000
        });
      }
      await chrome.storage.local.set({
        gemini_conversations: mockConvs,
        exportedIds: {},
        gemini_suppress_direct_write_prompt: false
      });
      if (typeof window.__workbenchLoadStore === 'function') {
        await window.__workbenchLoadStore(true);
      }
    });

    // Verify 55 items rendered
    const listItems = page.locator('#list .item');
    await expect(listItems).toHaveCount(55);

    // 3. Select all items (55 items >= 50 threshold)
    await page.click('#btnSelectAll');
    await expect(page.locator('#selectedStat')).toContainText('55');

    // Ensure modal is initially hidden
    const modal = page.locator('#directWriteModal');
    await expect(modal).toBeHidden();

    // 4. Click Export button (in ZIP mode)
    await page.click('#btnExport');

    // 5. Verify modal appears with correct conversation count and buttons
    await expect(modal).toBeVisible({ timeout: 3000 });
    await expect(page.locator('#directWritePromptText')).toContainText('55');
    await expect(page.locator('#btnModalSwitchFolder')).toBeVisible();
    await expect(page.locator('#btnModalContinueZip')).toBeVisible();

    // 6. Click "Continue with ZIP"
    await page.click('#btnModalContinueZip');

    // Modal should close immediately
    await expect(modal).toBeHidden();

    // 7. Verify suppression flag is automatically persisted in storage
    const isSuppressed = await page.evaluate(async () => {
      const d = await chrome.storage.local.get('gemini_suppress_direct_write_prompt');
      return !!d.gemini_suppress_direct_write_prompt;
    });
    expect(isSuppressed).toBe(true);

    // 8. Next time exporting >= 50 items, modal should NEVER appear again
    await page.click('#btnExport');
    await page.waitForTimeout(300);
    await expect(modal).toBeHidden();
  });
});
