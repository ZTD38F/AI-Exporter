import { test, expect } from './fixtures';

test.describe('Popup UI & Action Center Localization', () => {
  test('should render properly localized UI, format tabs, and handle language toggle across controls and storage sync', async ({ context, extensionId }) => {
    const page = await context.newPage();

    // 1. Navigate to popup page
    await page.goto(`chrome-extension://${extensionId}/src/ui/popup/popup.html`);
    await page.waitForLoadState('domcontentloaded');

    // Wait for async initLanguage
    await expect(page.locator('#btnCurrent')).toHaveText(/(Export|导出)/);

    // 2. Ensure zero raw i18n keys are exposed on the page and unwanted debug elements are absent
    const rawKeyCheck = await page.evaluate(() => {
      const elements = Array.from(document.querySelectorAll('[data-i18n]'));
      const violations: { id: string; key: string; text: string }[] = [];
      for (const el of elements) {
        const key = el.getAttribute('data-i18n');
        const text = el.textContent?.trim() || '';
        if (key && text === key) {
          violations.push({ id: el.id, key, text });
        }
      }
      return violations;
    });
    expect(rawKeyCheck).toEqual([]);
    expect(await page.locator('#chatSlotBadge').count()).toBe(0);
    expect(await page.locator('#historyTotalSynced').count()).toBe(0);
    expect(await page.locator('#historyCountBadge').count()).toBe(0);
    expect(await page.locator('#btnCopyMarkdown').count()).toBe(0);
    expect(await page.locator('#btnScreenshot').count()).toBe(0);
    expect(await page.locator('#previewModal').count()).toBe(0);

    // 3. Test explicit switch to English by clicking labelLangEn
    await page.click('#labelLangEn');
    await expect(page.locator('#btnCurrent')).toHaveText('📥 Export Current Page');
    await expect(page.locator('#btnOptions')).toHaveText('Batch Export in Console ↗');
    await expect(page.locator('#currentChatLabel')).toHaveText('Current Conversation');
    await expect(page.locator('#formatTabs .tab-btn[data-value="markdown"]')).toHaveText('Markdown');
    await expect(page.locator('#formatTabs .tab-btn[data-value="json_openai"]')).toHaveText('JSON (OpenAI)');
    await expect(page.locator('#formatTabs .tab-btn[data-value="json"]')).toHaveText('JSON (Std)');
    expect(await page.locator('#langToggle').isChecked()).toBe(true);

    const enStorageLang = await page.evaluate(async () => {
      const data = await chrome.storage.local.get('gemini_exporter_lang');
      return data.gemini_exporter_lang;
    });
    expect(enStorageLang).toBe('en');

    // 4. Test explicit switch to Chinese by clicking labelLangZh
    await page.click('#labelLangZh');
    await expect(page.locator('#btnCurrent')).toHaveText('📥 导出当前页面');
    await expect(page.locator('#btnOptions')).toHaveText('去控制台批量导出 ↗');
    await expect(page.locator('#currentChatLabel')).toHaveText('当前会话');
    await expect(page.locator('#formatTabs .tab-btn[data-value="markdown"]')).toHaveText('Markdown');
    await expect(page.locator('#formatTabs .tab-btn[data-value="json_openai"]')).toHaveText('JSON (OpenAI)');
    await expect(page.locator('#formatTabs .tab-btn[data-value="json"]')).toHaveText('JSON (标准)');
    expect(await page.locator('#langToggle').isChecked()).toBe(false);

    const zhStorageLang = await page.evaluate(async () => {
      const data = await chrome.storage.local.get('gemini_exporter_lang');
      return data.gemini_exporter_lang;
    });
    expect(zhStorageLang).toBe('zh');

    // 5. Test clicking the outer capsule pill container (#langTogglePill)
    await page.locator('#langTogglePill').click({ position: { x: 2, y: 2 } });
    await expect(page.locator('#btnCurrent')).toHaveText('📥 Export Current Page');
    expect(await page.locator('#langToggle').isChecked()).toBe(true);

    await page.locator('#langTogglePill').click({ position: { x: 2, y: 2 } });
    await expect(page.locator('#btnCurrent')).toHaveText('📥 导出当前页面');
    expect(await page.locator('#langToggle').isChecked()).toBe(false);

    // 6. Test Format Tabs click selection and storage persistence
    await page.click('#formatTabs .tab-btn[data-value="json_openai"]');
    await expect(page.locator('#formatTabs .tab-btn[data-value="json_openai"]')).toHaveClass(/active/);
    await expect(page.locator('#formatTabs .tab-btn[data-value="markdown"]')).not.toHaveClass(/active/);
    await expect(page.locator('#activeFormatLabel')).toHaveText('JSON (OpenAI)');

    const savedFmt = await page.evaluate(async () => {
      const d = await chrome.storage.local.get('gemini_export_format');
      return d.gemini_export_format;
    });
    expect(savedFmt).toBe('json_openai');

    // 7. Test dev-mode raw json tab visibility
    const rawTabBefore = page.locator('#formatTabs .tab-btn[data-value="json_raw"]');
    await expect(rawTabBefore).toBeHidden();

    await page.evaluate(async () => {
      await chrome.storage.local.set({ gemini_dev_mode: true });
    });
    await expect(rawTabBefore).toBeVisible();

    await page.evaluate(async () => {
      await chrome.storage.local.set({ gemini_dev_mode: false });
    });
    await expect(rawTabBefore).toBeHidden();
  });

  test('should synchronize format and language bidirectionally between options workbench and popup', async ({ context, extensionId }) => {
    const popupPage = await context.newPage();
    const optionsPage = await context.newPage();

    await popupPage.goto(`chrome-extension://${extensionId}/src/ui/popup/popup.html`);
    await popupPage.evaluate(async () => {
      await chrome.storage.local.set({
        has_completed_tour: true,
        last_seen_feature_version: '999.0.0'
      });
    });
    await optionsPage.goto(`chrome-extension://${extensionId}/src/ui/options/options.html?notour=1`);

    await popupPage.waitForLoadState('domcontentloaded');
    await optionsPage.waitForLoadState('domcontentloaded');
    await expect(popupPage.locator('#btnCurrent')).toBeVisible();
    await expect(optionsPage.locator('#btnSelectAll')).toBeVisible();

    // 1. Language: Switch in popup to English -> options workbench updates
    await popupPage.click('#labelLangEn');
    await expect(popupPage.locator('#btnCurrent')).toHaveText('📥 Export Current Page');
    await expect(optionsPage.locator('#btnSelectAll')).toHaveText('All');

    // 2. Language: Switch in options to Chinese -> popup updates
    await optionsPage.click('#labelLangZh');
    await expect(optionsPage.locator('#btnSelectAll')).toHaveText('全选');
    await expect(popupPage.locator('#btnCurrent')).toHaveText('📥 导出当前页面');

    // 3. Format: Switch in popup to json_openai -> options workbench format select updates
    await popupPage.click('#formatTabs .tab-btn[data-value="json_openai"]');
    await expect(optionsPage.locator('#format')).toHaveValue('json_openai');

    // 4. Format: Switch in options to json -> popup format tabs active state updates
    await optionsPage.selectOption('#format', 'json');
    await expect(popupPage.locator('#formatTabs .tab-btn[data-value="json"]')).toHaveClass(/active/);
    await expect(popupPage.locator('#activeFormatLabel')).toHaveText('JSON (标准)');
  });
});
