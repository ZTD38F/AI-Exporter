import { test, expect } from './fixtures';
import { openOptions } from './uiFixture';

test('scan connection guidance follows the workbench language', async ({ context, extensionId }) => {
    const page = await openOptions(context, extensionId);
    for (const language of ['zh', 'en']) {
        await page.evaluate(async language => Reflect.get(globalThis, 'uiFixture').updateSettings({ language }), language);
        await expect(page.locator('html')).toHaveAttribute('lang', language === 'zh' ? 'zh-CN' : 'en');
        await page.locator('#btnSyncAll').click();
        await expect(page.locator('#scanStatus')).toHaveText(language === 'zh'
            ? '请打开 Gemini、ChatGPT、Claude 或 Grok 并登录，再通过“新手引导”连接后同步会话。'
            : 'Open Gemini, ChatGPT, Claude or Grok and connect an account before scanning.');
        await expect(page.locator('#btnSyncAll')).toBeEnabled();
        await page.screenshot({ path: `tests/output/visual_audit/tier3_fixed_scan_guidance_${language}.png` });
    }
    await page.close();
});

test('cancelled folder picker unlocks the workbench and allows a later successful selection', async ({ context, extensionId }) => {
    const page = await openOptions(context, extensionId);
    await page.locator('input[name="delivery"][value="folderWriter"]').check();
    await expect(page.locator('#btnSetDir')).toBeEnabled();
    // Model the browser API's unresolved modal and genuine AbortError result.
    // This checks application recovery, not native-dialog screenshot coverage.
    await page.evaluate(() => {
        Reflect.set(window, 'showDirectoryPicker', () => new Promise((_resolve, reject) => {
            Reflect.set(window, 'cancelFolderPicker', () => reject(new DOMException('User cancelled', 'AbortError')));
        }));
    });
    await page.locator('#btnSetDir').click();
    await expect(page.locator('#format')).toBeDisabled();
    await page.evaluate(() => Reflect.get(window, 'cancelFolderPicker')());
    await expect(page.locator('#format')).toBeEnabled();
    await expect(page.locator('#btnSetDir')).toBeEnabled();
    await expect(page.locator('#dirPermissionLabel')).toHaveText('Not authorized');
    await page.evaluate(() => Reflect.set(window, 'showDirectoryPicker', () => navigator.storage.getDirectory()));
    await page.locator('#btnSetDir').click();
    await expect(page.locator('#dirPermissionLabel')).toHaveText('Authorized');
    await expect(page.locator('#format')).toBeEnabled();
    await page.close();
});
