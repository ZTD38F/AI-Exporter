import { test, expect } from './fixtures';

test.describe('AI Exporter product identity (Gemini upstream UI parity)', () => {
  test('should show AI Exporter in extension manifest, options tab and workbench heading', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/ui/options/options.html`);
    await expect(page).toHaveTitle('AI Exporter');
    await expect(page.locator('h1').first()).toContainText('AI Exporter');
    await expect(page.locator('h1').first()).not.toContainText('Gemini Exporter');
    const manifestName = await page.evaluate(() => chrome.runtime.getManifest().name);
    expect(manifestName).toContain('AI Exporter');
    await page.close();
  });

  test('should show AI Exporter in popup title and header without changing Gemini-specific notices', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/ui/popup/popup.html`);
    await expect(page).toHaveTitle('AI Exporter');
    await expect(page.locator('body > div').first().locator('b').first()).toHaveText('AI Exporter');
    await expect(page.locator('#notGeminiNotice')).toContainText('Gemini');
    await page.close();
  });
});
