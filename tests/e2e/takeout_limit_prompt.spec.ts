import { test, expect } from './fixtures';

test.describe('E2E: Google 600-Chat Limit Takeout Suggestion Prompt', () => {
  test('should display takeout suggestion modal with accurate count and close on dismiss', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/ui/options/options.html?notour=1`);
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
    await page.goto(`chrome-extension://${extensionId}/src/ui/options/options.html?notour=1`);
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
    // 1. Open mock Gemini page in background with credentials and network routing for MaZiqc
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
              SNlM0e: 'mock_at_token_limit',
              cfb2h: 'boq_assistant-bard-web-server_20260802.09_p1'
            };
          </script>
        </head>
        <body>Gemini Mock Active Tab</body>
        </html>`
      });
    });

    let requestCount = 0;
    await geminiPage.route('**/batchexecute*', async (route) => {
      requestCount++;
      if (requestCount === 1) {
        // Page 1: returns items with nextPageToken (must start with tC per Gemini protocol)
        const page1Items = [
          ["c_limit_001", "会话 1", [1700000000, 0], [1700000000, 0], 2],
          ["c_limit_002", "会话 2", [1700000100, 0], [1700000100, 0], 2]
        ];
        const page1Inner = JSON.stringify([null, page1Items, "tC_token_page_2"]);
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: `)]}'\n\n[["wrb.fr","MaZiqc",${JSON.stringify(page1Inner)}]]`
        });
      } else {
        // Page 2: Google sliding-window limit reached with BardErrorInfo
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: `)]}'\n\n[["wrb.fr","MaZiqc",null,null,null,["BardErrorInfo", 1096]]]`
        });
      }
    });

    await geminiPage.goto('https://gemini.google.com/app');
    await geminiPage.waitForLoadState('domcontentloaded');

    // 2. Open Workbench Options page with tour disabled
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/ui/options/options.html?notour=1`);
    await page.waitForLoadState('domcontentloaded');

    const modal = page.locator('#takeoutLimitModal');
    await page.evaluate(async () => {
      await chrome.storage.local.clear();
      await chrome.storage.local.set({
        has_completed_tour: true,
        last_seen_feature_version: '99.9.9'
      });
    });
    await expect(modal).toBeHidden();

    // 3. Click full deep scan button (#btnDeepScan)
    await page.click('#btnDeepScan');

    // 4. Verify modal automatically appears with hitGoogleLimit title and count
    await expect(modal).toBeVisible({ timeout: 15000 });
    await expect(page.locator('#takeoutLimitPromptTitle')).toContainText(/已达网页端上限|Reached Google Cloud History Limit/i);
    await expect(page.locator('#takeoutLimitPromptText')).toContainText('2');

    // Close via close button ✕
    await page.click('#btnTakeoutLimitClose');
    await expect(modal).toBeHidden();
  });

  test('should verify Google Takeout button links to custom Gemini deep link', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/ui/options/options.html?notour=1`);
    await page.waitForLoadState('domcontentloaded');

    const link = page.locator('#btnModalOpenTakeoutWeb');
    await expect(link).toHaveAttribute('href', 'https://takeout.google.com/settings/takeout/custom/gemini');
  });

  test('should suppress takeout limit prompt if takeout conversations already exist', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/ui/options/options.html?notour=1`);
    await page.waitForLoadState('domcontentloaded');

    const modal = page.locator('#takeoutLimitModal');
    await expect(modal).toBeHidden();

    // Inject a takeout conversation into storage & ConversationsStore and await the prompt check
    await page.evaluate(async () => {
      await chrome.storage.local.set({
        gemini_conversations: [
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
