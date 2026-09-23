import { test, expect } from './fixtures';

test.describe('Selection recovery across filtering', () => {
  test('keeps selected conversations that are temporarily hidden by a filter', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/ui/options/options.html`);
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

    const stateAfterFiltering = await page.evaluate(() => {
      const listView = (globalThis as any).ListView;
      const store = (globalThis as any).ConversationsStore;
      if (!listView || !store) throw new Error('Workbench list/store globals unavailable');

      const selectedBeforeFilter = listView.getSelectedIds();
      const conversations = store.getConversations();
      listView.render(conversations, {}, selectedBeforeFilter, 'Visible recovery target');

      return {
        renderedIds: Array.from(document.querySelectorAll('#list .item')).map((el: any) => el.dataset.chatId),
        selectedIds: Array.from(listView.getSelectedIds()).sort()
      };
    });

    expect(stateAfterFiltering.renderedIds).toEqual(['visible_chat']);
    // Selection is user state, not DOM state. Filtering must not silently erase a
    // previously selected conversation from the recovery snapshot.
    expect(stateAfterFiltering.selectedIds).toEqual(['hidden_chat', 'visible_chat']);
  });
});
