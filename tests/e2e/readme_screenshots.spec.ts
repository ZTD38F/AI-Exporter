import { test, expect, seedRegistryAccounts } from './fixtures';
import { openOptions, openPopup, exposeUIStorage, accountId } from './uiFixture';
import { mkdir, stat } from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Regenerate README/Chrome Web Store screenshots from the actual built v2 extension.
 * This is intentionally opt-in and uses anonymous fixture conversations, never a real account.
 * Run: CAPTURE_README_SCREENSHOTS=1 npx playwright test tests/e2e/readme_screenshots.spec.ts --workers=1
 */
test.skip(process.env.CAPTURE_README_SCREENSHOTS !== '1', 'Manual docs screenshot capture only');

test('capture v2 product screenshots from the real extension UI', async ({ context, extensionId }) => {
    test.setTimeout(90000);

    await seedRegistryAccounts(context);
    const page = await openOptions(context, extensionId);
    await page.setViewportSize({ width: 1280, height: 800 });

    const chats = [
        { id: 'notes', title: 'Organizing my AI notes' },
        { id: 'kyoto', title: 'Planning a weekend in Kyoto' },
        { id: 'attention', title: 'Understanding transformer attention' },
        { id: 'typescript', title: 'Refactoring a TypeScript parser' },
        { id: 'takeout', title: 'A personal backup checklist' },
        { id: 'research', title: 'Summarizing a research paper' },
        { id: 'food', title: 'Weekly meal planning ideas' },
        { id: 'csv', title: 'Comparing CSV import approaches' },
        { id: 'journal', title: 'Writing better daily reflections' },
        { id: 'japanese', title: 'Learning Japanese vocabulary' },
        { id: 'travel', title: '旅行计划：京都与大阪' },
        { id: 'chinese', title: '中文笔记与知识库整理' },
    ];
    await page.evaluate(async ({ accountId, chats }) => {
        const api = Reflect.get(globalThis, 'uiFixture');
        const now = Date.now();
        for (const [i, chat] of chats.entries()) {
            const updatedAt = now - (i + 1) * 6 * 60 * 60 * 1000;
            await api.ingestDetail(accountId, chat.id, {
                savedAt: updatedAt,
                quality: { status: 'complete' },
                assets: [],
                messages: [
                    { role: 'user', content: [{ type: 'paragraph', children: [{ type: 'text', text: 'Sample question for ' + chat.title }] }] },
                    { role: 'assistant', content: [{ type: 'paragraph', children: [{ type: 'text', text: 'Sample response used only in documentation screenshots.' }] }] },
                ],
            }, { title: chat.title, titleSource: 'provider', updatedAt });
            if (i % 3 === 0) {
                await api.putExportRecord({ accountId, conversationId: chat.id },
                    { format: 'markdown', status: 'ok', exportedAt: now, chatTime: updatedAt });
            }
        }
        await api.putAccount({ id: accountId, providerId: 'gemini',
            providerAccountId: '10000000001', displayName: 'Demo account' });
        await api.updateSettings({
            language: 'en', theme: 'light', lastSeenFeatureVersion: '999.0.0',
            takeoutPromptCompleted: true, directWritePromptCompleted: true,
            defaultFormat: 'markdown', exportDelivery: 'browserDownload', enabledDisk: false,
        });
    }, { accountId, chats });

    const output = path.resolve(__dirname, '../../store_assets');
    await mkdir(output, { recursive: true });
    const assertWorkbench = async (theme: string) => {
        await expect(page.locator('#list .item')).toHaveCount(chats.length);
        await expect(page.locator('.delivery-card')).toHaveCount(2);
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        await expect(page.locator('body')).toHaveAttribute('data-busy', 'false');
    };
    const reloadWorkbench = async (theme: string) => {
        await page.reload(); await exposeUIStorage(page);
        await assertWorkbench(theme);
        await page.locator('#btnSelectAll').click();
        await page.evaluate(() => document.fonts.ready);
    };

    // First image: light English workbench with representative conversations.
    await reloadWorkbench('light');
    await page.screenshot({
        path: path.join(output, 'screenshot_1_1280x800.png'),
        animations: 'disabled',
    });

    // Second image: dark workbench with actual local-folder settings active.
    await page.evaluate(async () => {
        const api = Reflect.get(globalThis, 'uiFixture');
        const root = await navigator.storage.getDirectory();
        const folder = await root.getDirectoryHandle('Gemini Backups', { create: true });
        await api.setDirectoryHandle(folder);
        await api.updateSettings({ language: 'en', theme: 'dark', defaultFormat: 'markdown',
            exportDelivery: 'folderWriter', enabledDisk: true });
    });
    await reloadWorkbench('dark');
    await expect(page.locator('input[name="delivery"][value="folderWriter"]')).toBeChecked();
    await page.screenshot({
        path: path.join(output, 'screenshot_2_1280x800.png'),
        animations: 'disabled',
    });

    // Third image: Chinese UI for the bilingual README/store listing.
    await page.evaluate(async () => {
        const api = Reflect.get(globalThis, 'uiFixture');
        await api.updateSettings({ language: 'zh', theme: 'light', defaultFormat: 'markdown',
            exportDelivery: 'browserDownload', enabledDisk: false });
    });
    await reloadWorkbench('light');
    await expect(page.locator('#btnSyncAll')).toContainText('同步');
    await page.screenshot({
        path: path.join(output, 'screenshot_3_1280x800.png'),
        animations: 'disabled',
    });

    // Fourth image: real extension popup with an explicitly fixture-resolved chat.
    await page.evaluate(async () => {
        await Reflect.get(globalThis, 'uiFixture').updateSettings({ language: 'en', theme: 'light' });
    });
    const popup = await openPopup(context, extensionId, chats[0].id);
    await popup.setViewportSize({ width: 360, height: 370 });
    await expect(popup.locator('#formatTabs .tab-btn')).toHaveCount(4);
    await expect(popup.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(popup.locator('#currentChatTitle')).toContainText('Organizing my AI notes');
    await popup.locator('body').screenshot({
        path: path.join(output, 'screenshot_popup_v2.png'),
        animations: 'disabled',
    });

    for (const file of [
        'screenshot_1_1280x800.png', 'screenshot_2_1280x800.png',
        'screenshot_3_1280x800.png', 'screenshot_popup_v2.png',
    ]) {
        expect((await stat(path.join(output, file))).size).toBeGreaterThan(3000);
    }
    await popup.close();
    await page.close();
});
