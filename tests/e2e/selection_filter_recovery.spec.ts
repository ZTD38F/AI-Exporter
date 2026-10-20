import { test, expect } from './fixtures';

test.describe('Selection recovery across filtering', () => {
  test('keeps selected conversations that are temporarily hidden by a filter', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/ui/options/options.html?notour=1`);
    await page.waitForLoadState('domcontentloaded');

    await page.evaluate(async () => {
      const mockConvs = [
        { id: 'visible_chat', title: 'Visible recovery target', timestamp: 1700000000000 },
        { id: 'hidden_chat', title: 'Hidden recovery target', timestamp: 1700000001000 }
      ];
      await chrome.storage.local.set({
        gemini_conversations: mockConvs,
        exportedIds: {}
      });
      if (typeof window.__workbenchLoadStore === 'function') {
        await window.__workbenchLoadStore(true);
      }
    });

    await expect(page.locator('#list .item')).toHaveCount(2);
    await page.click('#btnSelectAll');
    await expect(page.locator('#list input[type=checkbox]:checked')).toHaveCount(2);

    // Exercise the actual Workbench UI instead of relying on deprecated globals.
    await page.fill('#chatSearchInput', 'Visible recovery target');
    await expect(page.locator('#list .item')).toHaveCount(1);
    await expect(page.locator('[data-chat-id="visible_chat"] input[type="checkbox"]')).toBeChecked();
    await page.fill('#chatSearchInput', '');
    await expect(page.locator('#list .item')).toHaveCount(2);
    await expect(page.locator('[data-chat-id="visible_chat"] input[type="checkbox"]')).toBeChecked();
    await expect(page.locator('[data-chat-id="hidden_chat"] input[type="checkbox"]')).toBeChecked();

  });
});
