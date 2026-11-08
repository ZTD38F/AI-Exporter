import { test, expect, seedRegistryAccounts } from './fixtures';
import { openOptions, openPopup, storedSettings, exposeUIStorage } from './uiFixture';

/**
 * Real extension test: shared Settings persistence and theme CSS must work across
 * actual chrome-extension:// Options and Popup pages, not only isolated UI mocks.
 */
test('Options and Popup theme toggle persists, repaints, and synchronizes across windows', async ({ context, extensionId }) => {
    await seedRegistryAccounts(context);
    const options = await openOptions(context, extensionId);
    const popup = await openPopup(context, extensionId);
    const optionsSwitch = options.locator('#btnThemeToggle');
    const popupSwitch = popup.locator('#btnThemeToggle');

    await expect(optionsSwitch).toBeEnabled();
    await expect(popupSwitch).toBeEnabled();
    await expect(options.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(popup.locator('html')).toHaveAttribute('data-theme', 'light');

    await optionsSwitch.click();
    await expect(options.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(options.locator('body')).toHaveCSS('background-color', 'rgb(16, 16, 17)');
    await expect.poll(async () => (await storedSettings(options)).theme).toBe('dark');
    await expect(popup.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(popup.locator('body')).toHaveCSS('background-color', 'rgb(16, 16, 17)');

    await options.reload();
    await exposeUIStorage(options);
    await expect(options.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(optionsSwitch).toBeEnabled();

    await popupSwitch.click();
    await expect(popup.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(popup.locator('body')).toHaveCSS('background-color', 'rgb(245, 247, 252)');
    await expect.poll(async () => (await storedSettings(options)).theme).toBe('light');
    await expect(options.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(options.locator('body')).toHaveCSS('background-color', 'rgb(245, 247, 252)');

    await popup.reload();
    await expect(popup.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(popupSwitch).toBeEnabled();
});


test('Stored Light theme is ready before either extension page becomes visible', async ({ context, extensionId }) => {
    await seedRegistryAccounts(context);
    const setup = await openOptions(context, extensionId);
    await setup.evaluate(() => Reflect.get(globalThis, 'uiFixture').updateSettings({ theme: 'light' }));
    await expect.poll(async () => (await storedSettings(setup)).theme).toBe('light');
    await setup.close();

    for (const kind of ['options', 'popup']) {
        const page = await context.newPage();
        await page.addInitScript(() => {
            const original = chrome.storage.local.get.bind(chrome.storage.local);
            let release!: () => void;
            const gate = new Promise<void>(resolve => { release = resolve; });
            Reflect.set(window, '__releaseThemeRead', release);
            Object.defineProperty(chrome.storage.local, 'get', {
                configurable: true,
                value: (...args: Parameters<typeof chrome.storage.local.get>) =>
                    args[0] === 'gemini_exporter_v2_settings'
                        ? gate.then(() => original(...args))
                        : original(...args),
            });
        });
        await page.goto(`chrome-extension://${extensionId}/src/ui/${kind}/${kind}.html`);
        await expect(page.locator('html')).toHaveAttribute('data-theme', 'loading');
        await expect(page.locator('html')).toHaveCSS('visibility', 'hidden');
        await page.evaluate(() => Reflect.get(window, '__releaseThemeRead')());
        await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
        await expect(page.locator('html')).toHaveCSS('visibility', 'visible');
        await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(245, 247, 252)');
        await page.close();
    }
});


test('Light first visible frame has no dark cards or initial background transitions', async ({ context, extensionId }) => {
    await seedRegistryAccounts(context);
    const setup = await openOptions(context, extensionId);
    await setup.evaluate(() => Reflect.get(globalThis, 'uiFixture').updateSettings({ theme: 'light' }));
    await expect.poll(async () => (await storedSettings(setup)).theme).toBe('light');
    await setup.close();

    for (const kind of ['options', 'popup'] as const) {
        const page = await context.newPage();
        await page.addInitScript(() => {
            document.addEventListener('DOMContentLoaded', () => {
                const root = document.documentElement;
                const capture = () => {
                    if (root.dataset.theme !== 'light' || root.hasAttribute('data-theme-unready')) return;
                    const ghost = document.querySelector('#btnThemeToggle');
                    const block = document.querySelector('.delivery-card,.tab-group');
                    Reflect.set(window, '__firstVisiblePalette', {
                        theme: root.dataset.theme,
                        ghost: ghost ? getComputedStyle(ghost).backgroundColor : null,
                        block: block ? getComputedStyle(block).backgroundColor : null,
                        visibility: getComputedStyle(root).visibility,
                        bootstrap: root.hasAttribute('data-theme-bootstrap'),
                        ghostTransition: ghost ? getComputedStyle(ghost).transitionDuration : null,
                    });
                };
                const observer = new MutationObserver(() => {
                    capture();
                    if (Reflect.has(window, '__firstVisiblePalette')) observer.disconnect();
                });
                observer.observe(root, { attributes: true, attributeFilter: ['data-theme-unready'] });
                capture();
            }, { once: true });
        });
        await page.goto(`chrome-extension://${extensionId}/src/ui/${kind}/${kind}.html`);
        await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
        await expect(page.locator('html')).toHaveCSS('visibility', 'visible');
        const first = await page.evaluate(() => Reflect.get(window, '__firstVisiblePalette'));
        expect(first, `${kind}: first visible theme snapshot`).toBeTruthy();
        expect(first.visibility).toBe('visible');
        expect(first.bootstrap, 'transitions should still be disabled at first paint').toBe(true);
        expect(first.ghostTransition, 'no dark-to-light animation on first paint').toBe('0s');
        // Light buttons and cards should start light, not animate from their dark CSS defaults.
        for (const [name, color] of Object.entries({ ghost: first.ghost, block: first.block })) {
            const channels = String(color).match(/[0-9]+/g)?.slice(0, 3).map(Number) ?? [];
            expect(channels.length, `${kind}: ${name} background should be RGB`).toBe(3);
            expect(channels.every(channel => channel >= 215),
                `${kind}: ${name} was initially dark: ${color}`).toBe(true);
        }
        await expect.poll(() => page.locator('html').getAttribute('data-theme-bootstrap')).toBeNull();
        // Normal interaction animations are retained once initial appearance settles.
        expect(await page.locator('#btnThemeToggle').evaluate(node => getComputedStyle(node).transitionDuration)).not.toBe('0s');
        await page.close();
    }
});
