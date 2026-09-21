import { test, expect } from './fixtures';

test.describe('Real-Time Conversation Deletion & Live Storage Pruning', () => {
  test('should prune deleted conversation from storage and update options workbench in real time upon deletion event', async ({ context, extensionId }) => {
    // 1. 打开扩展 Options 工作台页面并预置 3 条会话
    const optionsPage = await context.newPage();
    await optionsPage.goto(`chrome-extension://${extensionId}/src/ui/options/options.html`);
    await optionsPage.waitForLoadState('domcontentloaded');

    const initialConversations = [
      { id: 'del_target_8888', title: '待实时删除的目标会话', timestamp: 1700000000000, source: 'batchexecute' },
      { id: 'keep_chat_1111', title: '保持留存的有效会话 1', timestamp: 1699990000000, source: 'batchexecute' },
      { id: 'keep_chat_2222', title: '保持留存的有效会话 2', timestamp: 1699980000000, source: 'batchexecute' }
    ];

    await optionsPage.evaluate(async (convs) => {
      await chrome.storage.local.set({
        gemini_conversations: convs,
        gemini_conversations_count_u0: convs.length
      });
      if (typeof (window as any).__workbenchLoadStore === 'function') {
        await (window as any).__workbenchLoadStore(true);
      }
    }, initialConversations);

    // 验证初始状态：DOM 列表中有 3 条，且目标待删会话清晰可见
    await expect(optionsPage.locator('#list .item')).toHaveCount(3);
    await expect(optionsPage.locator('#list .item[data-chat-id="del_target_8888"]')).toBeVisible();
    await expect(optionsPage.locator('#list .item[data-chat-id="keep_chat_1111"]')).toBeVisible();

    // 2. 打开模拟的 Gemini 标签页
    const geminiPage = await context.newPage();

    await geminiPage.route('https://gemini.google.com/app/**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: `<!DOCTYPE html>
        <html>
        <head><title>Gemini Live Chat</title></head>
        <body>
          <div id="app">Gemini Mock Chat Window</div>
        </body>
        </html>`
      });
    });

    await geminiPage.route('**/batchexecute*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: `)]}'

[["wrb.fr","GzXR5e","[null, \"del_target_8888\"]"]]`
      });
    });

    await geminiPage.goto('https://gemini.google.com/app/del_target_8888');
    await geminiPage.waitForLoadState('domcontentloaded');

    // 3. 在 Gemini 页面中派发真实的会话删除事件 (GEMINI_CONVERSATION_DELETED)
    await geminiPage.evaluate(() => {
      window.postMessage({
        type: 'GEMINI_CONVERSATION_DELETED',
        payload: { id: 'del_target_8888', slot: 'u0' }
      }, '*');
    });

    // 4. 断言 Options 工作台：无需用户手动刷新，通过 syncUpdate 广播列表自动实时由 3 项变为 2 项
    await expect(optionsPage.locator('#list .item')).toHaveCount(2);
    await expect(optionsPage.locator('#list .item[data-chat-id="del_target_8888"]')).toHaveCount(0);
    await expect(optionsPage.locator('#list .item[data-chat-id="keep_chat_1111"]')).toBeVisible();
    await expect(optionsPage.locator('#list .item[data-chat-id="keep_chat_2222"]')).toBeVisible();

    // 5. 断言 Storage 底层数据：目标会话已被彻底剥离，留存会话完好
    const storageState = await optionsPage.evaluate(async () => {
      return new Promise<{ list: any[]; count: number }>((resolve) => {
        chrome.storage.local.get(['gemini_conversations', 'gemini_conversations_count_u0'], (data: any) => {
          resolve({
            list: (data && data.gemini_conversations) || [],
            count: (data && data.gemini_conversations_count_u0) || 0
          });
        });
      });
    });

    expect(storageState.list.some((c: any) => c.id === 'del_target_8888')).toBe(false);
    expect(storageState.list.length).toBe(2);
    expect(storageState.list.map((c: any) => c.id)).toEqual(
      expect.arrayContaining(['keep_chat_1111', 'keep_chat_2222'])
    );
  });
});
