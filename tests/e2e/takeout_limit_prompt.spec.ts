import { test, expect } from './fixtures';

test.describe('E2E: Google 600-Chat Limit Takeout Suggestion Prompt', () => {
  test('should display takeout suggestion modal with accurate count and close on dismiss', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/ui/options/options.html`);
    await page.waitForLoadState('domcontentloaded');

    const modal = page.locator('#takeoutLimitModal');
    await expect(modal).toBeHidden();

    // Trigger takeout limit prompt with count 620
    await page.evaluate(() => {
      if (window.DialogView && window.DialogView.showTakeoutLimitPrompt) {
        window.DialogView.showTakeoutLimitPrompt({ count: 620 });
      }
    });

    await expect(modal).toBeVisible();
    await expect(page.locator('#takeoutLimitPromptText')).toContainText('620');
    await expect(page.locator('#btnModalImportTakeout')).toBeVisible();
    await expect(page.locator('#btnModalDismissTakeout')).toBeVisible();

    // Click "我知道了，不再提示" to dismiss
    await page.click('#btnModalDismissTakeout');
    await expect(modal).toBeHidden();

    // Verify storage recorded has_completed_takeout_prompt = true
    const isPromptCompleted = await page.evaluate(async () => {
      const data = await chrome.storage.local.get('has_completed_takeout_prompt');
      return !!data.has_completed_takeout_prompt;
    });
    expect(isPromptCompleted).toBe(true);

    // Verify subsequent showTakeoutLimitPrompt call without force is suppressed
    await page.evaluate(() => {
      if (window.DialogView && window.DialogView.showTakeoutLimitPrompt) {
        window.DialogView.showTakeoutLimitPrompt({ count: 630 });
      }
    });
    await expect(modal).toBeHidden();
  });

  test('should trigger takeout file input click when clicking import button', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/ui/options/options.html`);
    await page.waitForLoadState('domcontentloaded');

    const modal = page.locator('#takeoutLimitModal');

    // Monitor takeoutFileInput clicks
    await page.evaluate(() => {
      window.__takeoutClicked = false;
      const fileInput = document.getElementById('takeoutFileInput');
      if (fileInput) {
        fileInput.addEventListener('click', (e) => {
          e.preventDefault(); // Prevent opening system dialog during automated test
          window.__takeoutClicked = true;
        });
      }
      window.DialogView.showTakeoutLimitPrompt({ count: 650 });
    });

    await expect(modal).toBeVisible();

    // Click "📥 选择 Takeout ZIP 导入全部历史"
    await page.click('#btnModalImportTakeout');
    await expect(modal).toBeHidden();

    const clicked = await page.evaluate(() => window.__takeoutClicked);
    expect(clicked).toBe(true);
  });

  test('should automatically show modal when deep scan completes with hitGoogleLimit', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/ui/options/options.html`);
    await page.waitForLoadState('domcontentloaded');

    const modal = page.locator('#takeoutLimitModal');
    await page.evaluate(async () => {
      await chrome.storage.local.remove(['has_completed_takeout_prompt']);
    });
    await expect(modal).toBeHidden();

    // Mock chrome.runtime.sendMessage to simulate deepScan returning hitGoogleLimit = true
    await page.evaluate(() => {
      const origSendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
      (chrome.runtime as any).sendMessage = function(msg: any, callback: any) {
        if (msg && msg.action === 'deepScan') {
          setTimeout(() => {
            if (callback) {
              callback({
                success: true,
                count: 615,
                hitGoogleLimit: true,
                diagnostics: {
                  stopReason: 'Google 服务端翻页到达极限 (BardErrorInfo: 游标链已达服务端上限)',
                  hitGoogleLimit: true
                }
              });
            }
          }, 50);
          return true;
        }
        return origSendMessage(msg, callback);
      };
    });


    // Click full deep scan button
    await page.click('#btnDeepScan');

    // Verify modal automatically appears with 615 count
    await expect(modal).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#takeoutLimitPromptText')).toContainText('615');

    // Close via close button ✕
    await page.click('#btnTakeoutLimitClose');
    await expect(modal).toBeHidden();
  });

  test('should verify Google Takeout button links to custom Gemini deep link', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/ui/options/options.html`);
    await page.waitForLoadState('domcontentloaded');

    const link = page.locator('#btnModalOpenTakeoutWeb');
    await expect(link).toHaveAttribute('href', 'https://takeout.google.com/settings/takeout/custom/gemini');
  });

  test('should suppress takeout limit prompt if takeout conversations already exist', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/ui/options/options.html`);
    await page.waitForLoadState('domcontentloaded');

    const modal = page.locator('#takeoutLimitModal');
    await expect(modal).toBeHidden();

    // Inject a takeout conversation into storage & ConversationsStore and await the prompt check
    await page.evaluate(async () => {
      await chrome.storage.local.set({
        gemini_conversations_u0: [
          { id: 'takeout_chat_1', title: 'Takeout Recovered Chat', source: 'takeout', timestamp: 1700000000000 }
        ]
      });
      if (window.ConversationsStore) {
        window.ConversationsStore.setConversations([
          { id: 'takeout_chat_1', title: 'Takeout Recovered Chat', source: 'takeout', timestamp: 1700000000000 }
        ]);
      }
      if (window.DialogView && window.DialogView.showTakeoutLimitPrompt) {
        await window.DialogView.showTakeoutLimitPrompt({ count: 620 });
      }
    });


    // Modal should NOT be shown because Takeout data is already present
    await expect(modal).toBeHidden();
  });
});
