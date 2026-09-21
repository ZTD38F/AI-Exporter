import { test, expect } from './fixtures';

test.describe('E2E: Legacy Dirty Data Self-Healing & Migration', () => {
  test('should automatically detect and heal dirty historical titles stored from older versions', async ({ context, extensionId }) => {
    const optionsPage = await context.newPage();

    // 1. Seed storage with dirty historical titles left over by older versions
    await optionsPage.goto(`chrome-extension://${extensionId}/src/ui/options/options.html`);
    await optionsPage.waitForLoadState('domcontentloaded');

    await optionsPage.evaluate(async () => {
      const dirtyLegacyConvs = [
        { id: 'legacy_001', title: '量子计算与超导量子比特 - Google Gemini', timestamp: 1680000000000 },
        { id: 'legacy_002', title: 'Google Gemini - 深度学习反向传播算法', timestamp: 1680000100000 },
        { id: 'legacy_003', title: '微服务架构设计 | Google Gemini', timestamp: 1680000200000 },
        { id: 'legacy_004', title: '纯净标题无需处理', timestamp: 1680000300000 }
      ];
      await chrome.storage.local.set({
        gemini_conversations: dirtyLegacyConvs,
        exportedIds: {}
      });
      // Trigger loadStore to simulate user opening options workbench on upgrade
      if (typeof window.__workbenchLoadStore === 'function') {
        await window.__workbenchLoadStore(true);
      }
    });

    // 2. Assert that the rendered UI in the list is 100% pure without any branding suffix/prefix
    const item1 = optionsPage.locator('[data-chat-id="legacy_001"]');
    const item2 = optionsPage.locator('[data-chat-id="legacy_002"]');
    const item3 = optionsPage.locator('[data-chat-id="legacy_003"]');
    const item4 = optionsPage.locator('[data-chat-id="legacy_004"]');

    await expect(item1).toContainText('量子计算与超导量子比特');
    await expect(item1).not.toContainText('Google Gemini');
    await expect(item1).not.toContainText('Gemini');

    await expect(item2).toContainText('深度学习反向传播算法');
    await expect(item2).not.toContainText('Google Gemini');
    await expect(item2).not.toContainText('Gemini');

    await expect(item3).toContainText('微服务架构设计');
    await expect(item3).not.toContainText('Google Gemini');
    await expect(item3).not.toContainText('Gemini');

    await expect(item4).toContainText('纯净标题无需处理');

    // 3. Assert that storage in chrome.storage.local is self-healed and scrubbed
    const storageData = await optionsPage.evaluate(async () => {
      return await chrome.storage.local.get(['gemini_conversations']);
    }) as Record<string, any>;
    const healedList = (storageData.gemini_conversations || []) as any[];
    expect(healedList.length).toBe(4);

    const healed1 = healedList.find((c: any) => c.id === 'legacy_001');
    const healed2 = healedList.find((c: any) => c.id === 'legacy_002');
    const healed3 = healedList.find((c: any) => c.id === 'legacy_003');

    expect(healed1.title).toBe('量子计算与超导量子比特');
    expect(healed2.title).toBe('深度学习反向传播算法');

    expect(healed3.title).toBe('微服务架构设计');
  });
});
