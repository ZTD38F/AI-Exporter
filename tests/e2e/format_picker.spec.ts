import { test, expect, seedRegistryAccounts } from './fixtures';
import { openOptions, storedSettings } from './uiFixture';
import { mkdir } from 'node:fs/promises';

// Exercise the rendered picker rather than selectOption, which bypasses its UI.
test('format picker is page-rendered and supports pointer, keyboard and dismissal', async ({ context, extensionId }) => {
    await seedRegistryAccounts(context);
    const page = await openOptions(context, extensionId);
    await page.setViewportSize({ width: 1280, height: 800 });
    const select = page.locator('#format');
    await expect(select).toHaveCSS('appearance', 'base-select');
    await select.click();
    const pdf = select.locator('option[value="pdf"]');
    await expect(pdf).toBeVisible();
    const box = await pdf.boundingBox();
    expect(box?.height).toBeGreaterThan(20);
    await mkdir('tests/output/visual_audit', { recursive: true });
    await page.screenshot({ animations: 'disabled', path: 'tests/output/visual_audit/format_picker_dark.png' });
    await pdf.click();
    await expect(select).toHaveValue('pdf');
    await expect.poll(async () => (await storedSettings(page)).defaultFormat).toBe('pdf');
    await expect.poll(() => select.evaluate(node => node.matches(':open'))).toBe(false);

    await select.click();
    await page.keyboard.press('Escape');
    await expect.poll(() => select.evaluate(node => node.matches(':open'))).toBe(false);
    await expect(select).toBeFocused();
    await expect(select).toHaveValue('pdf');

    await select.press('Space');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(select).toHaveValue('json');
    await expect.poll(async () => (await storedSettings(page)).defaultFormat).toBe('json');

    await select.click();
    await page.locator('h1').click();
    await expect.poll(() => select.evaluate(node => node.matches(':open'))).toBe(false);
    await expect(select).toHaveValue('json');
    await page.evaluate(async () => Reflect.get(globalThis, 'uiFixture').updateSettings({ theme: 'light' }));
    await select.click();
    await page.screenshot({ animations: 'disabled', path: 'tests/output/visual_audit/format_picker_light.png' });
    await page.keyboard.press('Escape');
    await page.close();
});
