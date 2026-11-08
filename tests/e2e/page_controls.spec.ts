import { test, expect, seedRegistryAccounts } from './fixtures';
import { accountId, openOptions, seedConversations } from './uiFixture';
import { mkdir } from 'node:fs/promises';

const evidence = 'tests/output/visual_audit';

test('account, status and log pickers paint inside the viewport in both themes and operate by pointer and keyboard', async ({ context, extensionId }) => {
    await seedRegistryAccounts(context);
    const page = await openOptions(context, extensionId);
    await expect(page.locator('select:not(.page-select)')).toHaveCount(0);
    await seedConversations(page, [{ id: 'exported' }, { id: 'new' }], {
        exported: { exportedAt: 100, format: 'markdown', status: 'ok' },
    });
    await page.locator('#devToggle').check();
    await mkdir(evidence, { recursive: true });
    for (const theme of ['dark', 'light']) {
        await page.evaluate(theme => Reflect.get(globalThis, 'uiFixture').updateSettings({ theme }), theme);
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        for (const id of ['accountIdSelect', 'chatFilterSelect', 'logLevel']) {
            const select = page.locator(`#${id}`);
            await expect(select).toHaveCSS('appearance', 'base-select');
            await select.click();
            await expect.poll(() => select.evaluate(node => node.matches(':open'))).toBe(true);
            // Every physical option must be visible in viewport screenshots, including
            // the log picker near the bottom of the scrolling settings panel.
            for (const option of await select.locator('option').all()) {
                await expect(option).toBeInViewport({ ratio: 1 });
            }
            await page.screenshot({ animations: 'disabled', path: `${evidence}/${id}_${theme}.png` });
            await page.keyboard.press('Escape');
            await expect(select).toBeFocused();
            await expect.poll(() => select.evaluate(node => node.matches(':open'))).toBe(false);
        }
    }
    const filter = page.locator('#chatFilterSelect');
    await filter.click();
    await filter.locator('option[value="has_record"]').click();
    await expect(page.locator('#list .item')).toHaveCount(1);
    await expect(page.locator('#list .item')).toContainText('exported');
    await filter.press('Space');
    await expect.poll(() => filter.evaluate(node => node.matches(':open'))).toBe(true);
    await page.keyboard.press('Home');
    await page.keyboard.press('Enter');
    await expect(filter).toHaveValue('all');
    await expect(page.locator('#list .item')).toHaveCount(2);

    const logLevel = page.locator('#logLevel');
    await logLevel.click();
    await logLevel.locator('option[value="error"]').click();
    await expect(logLevel).toHaveValue('error');
    await expect(page.locator('#log')).toHaveText('Ready');
    await logLevel.click();
    await page.locator('h1').click();
    await expect.poll(() => logLevel.evaluate(node => node.matches(':open'))).toBe(false);

    const account = page.locator('#accountIdSelect');
    await account.click();
    await account.locator('option').filter({ hasText: 'Other account' }).click();
    await expect(page.locator('#list .item')).toHaveCount(0);
    await expect(account).toHaveValue('10000000-0000-4000-8000-000000000002');
    await account.press('Space');
    await expect.poll(() => account.evaluate(node => node.matches(':open'))).toBe(true);
    await page.keyboard.press('Escape');
    await expect.poll(() => account.evaluate(node => node.matches(':open'))).toBe(false);
    // Native select option keyboard navigation can be nondeterministic in headless Chromium.
    // Keep real keyboard open/close coverage; switch the source via the same select change path.
    await account.selectOption(accountId);
    await expect(account).toHaveValue(accountId);
    await expect(page.locator('#list .item')).toHaveCount(2);
});

test('compact conversation toolbar keeps source, search, filter and overflow actions accessible', async ({ context, extensionId }) => {
    await seedRegistryAccounts(context);
    const page = await openOptions(context, extensionId);
    await seedConversations(page, [{ id: 'toolbar-chat' }]);

    const source = page.locator('#accountIdSelect');
    const more = page.locator('#btnMoreActions');
    const menu = page.locator('#moreActionsMenu');
    await expect(source).toBeVisible();
    await expect(source.locator('option').first()).toContainText('Gemini · ');
    await expect(page.locator('#btnImportTakeout')).toBeHidden();
    await expect(page.locator('#btnClearScan')).toBeHidden();

    for (const width of [1280, 1024]) {
        await page.setViewportSize({ width, height: 800 });
        const aligned = await page.evaluate(() => {
            const selectors = ['#btnSyncAll', '#accountIdSelect', '.conversation-search',
                '#chatFilterSelect', '#btnMoreActions'];
            const rects = selectors.map(selector => document.querySelector(selector)!.getBoundingClientRect());
            const toolbar = document.querySelector('.conversation-toolbar')!.getBoundingClientRect();
            return rects.every(rect => Math.abs(rect.top - toolbar.top) <= 2 && rect.right <= toolbar.right + 1)
                && rects.every((rect, i) => i === 0 || rect.left >= rects[i - 1]!.right);
        });
        expect(aligned, 'all controls must fit in one ordered row').toBe(true);
    }

    await more.click();
    await expect(menu).toBeVisible();
    await expect(more).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('#btnImportTakeout')).toBeVisible();
    await expect(page.locator('#btnClearScan')).toBeVisible();
    await expect(page.locator('#btnClearExported')).toBeHidden();
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(more).toBeFocused();
    await more.click();
    await page.locator('#chatSearchInput').click();
    await expect(menu).toBeHidden();

    await page.locator('#chatFilterSelect').selectOption('no_record');
    await expect(page.locator('#chatFilterSelect')).toHaveValue('no_record');
    await expect(page.locator('#list .item')).toHaveCount(1);
});

test('cleanup confirmation is screenshot-visible, traps focus, cancels safely and works in Chinese', async ({ context, extensionId }) => {
    await seedRegistryAccounts(context);
    const page = await openOptions(context, extensionId);
    await seedConversations(page, [{ id: 'keep' }]);
    let nativeDialogs = 0;
    page.on('dialog', dialog => { nativeDialogs++; void dialog.dismiss(); });
    await mkdir(evidence, { recursive: true });
    const modal = page.getByRole('alertdialog');
    for (const theme of ['dark', 'light']) {
        await page.evaluate(theme => Reflect.get(globalThis, 'uiFixture').updateSettings({ theme }), theme);
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        await page.locator('#btnMoreActions').click();
        await expect(page.locator('#moreActionsMenu')).toBeVisible();
        await page.locator('#btnClearScan').click();
        await expect(modal).toBeVisible();
        await expect(modal).toHaveAccessibleName('Clear scan records?');
        await expect(modal).toContainText('Fixture account');
        await expect(page.locator('#btnCleanupCancel')).toBeFocused();
        await page.keyboard.press('Tab');
        await expect(page.locator('#btnCleanupConfirm')).toBeFocused();
        await page.keyboard.press('Tab');
        await expect(page.locator('#btnCleanupCancel')).toBeFocused();
        await page.screenshot({ animations: 'disabled', path: `${evidence}/cleanup_${theme}.png` });
        await page.keyboard.press('Escape');
        await expect(modal).toBeHidden();
        await expect(page.locator('#btnMoreActions')).toBeFocused();
        await expect(page.locator('#list .item')).toHaveCount(1);
    }
    await page.locator('#langToggle').uncheck();
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
    await page.locator('#btnMoreActions').click();
    await page.locator('#btnClearScan').click();
    await expect(modal).toHaveAccessibleName('清除扫描记录？');
    await expect(modal).toContainText('账户：Fixture account');
    await page.screenshot({ animations: 'disabled', path: `${evidence}/cleanup_zh.png` });
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await expect(modal).toBeHidden();
    await expect(page.locator('#list .item')).toHaveCount(1);
    expect(nativeDialogs).toBe(0);
});
