import { test, expect } from '@playwright/test';
import { mount, read, A, B } from '../helpers/uiPortHarness';
const chatgpt = { id: A, providerId: 'chatgpt', providerAccountId: '["user-1","workspace-1"]' };
const archive = { name: 'openai-export.zip', mimeType: 'application/zip', buffer: Buffer.from('fixture') };

test('Shared ZIP import follows the selected ChatGPT account', async ({ page }) => {
    await mount(page, 'options');
    await expect(page.locator('#btnImportTakeout')).toBeEnabled();
    await mount(page, 'options', { accounts: [chatgpt] });
    await page.locator('#btnMoreActions').click();
    await expect(page.locator('#btnImportTakeout')).toBeEnabled();
    await expect(page.locator('#btnImportTakeout')).toHaveText('📥 Import ZIP');
    await expect(page.locator('#btnImportOpenAI')).toHaveCount(0);
    const chooser = page.waitForEvent('filechooser');
    await page.locator('#btnImportTakeout').click();
    expect((await chooser).isMultiple()).toBe(false);
    await page.locator('#takeoutFileInput').setInputFiles(archive);
    await expect(page.locator('#status')).toHaveText('Imported 2 conversations; skipped 0; unavailable attachments 0.');
    expect(await read(page, 'imports')).toEqual([A]);
    expect(await read(page, 'patches')).not.toContainEqual({ takeoutPromptCompleted: true });
    await expect(page.locator('#takeoutFileInput')).toHaveValue('');
});

test('empty OpenAI archive has explicit bilingual feedback and can be selected again', async ({ page }) => {
    await mount(page, 'options', { accounts: [chatgpt], openaiResult: { imported: 0, skipped: 0, missingAssets: 0, status: 'empty' } });
    await page.locator('#takeoutFileInput').setInputFiles(archive);
    await expect(page.locator('#status')).toHaveText('This OpenAI ZIP contains no conversation bodies. No conversations were imported.');
    await page.locator('#langToggle').uncheck();
    await expect(page.locator('#status')).toHaveText('此 OpenAI ZIP 没有聊天正文，未导入任何会话。');
    await page.locator('#takeoutFileInput').setInputFiles(archive);
    expect(await read(page, 'imports')).toEqual([A, A]);
});

test('switching accounts routes the same ZIP input to the selected platform', async ({ page }) => {
    await mount(page, 'options', { accounts: [chatgpt,
        { id: B, providerId: 'gemini', providerAccountId: 'default' },
        { id: 'claude-account', providerId: 'claude', providerAccountId: 'claude-user' }] });
    await page.locator('#takeoutFileInput').setInputFiles(archive);
    await expect(page.locator('#status')).toContainText('skipped 0');
    await page.locator('#accountIdSelect').selectOption(B);
    await page.locator('#takeoutFileInput').setInputFiles(archive);
    await expect(page.locator('#status')).toHaveText('Imported 2 conversations (partial)');
    expect(await read(page, 'imports')).toEqual([A, B]);
    await page.locator('#accountIdSelect').selectOption('claude-account');
    await expect(page.locator('#btnImportTakeout')).toBeDisabled();
    await page.locator('#takeoutFileInput').setInputFiles(archive);
    expect(await read(page, 'imports')).toEqual([A, B]);
    await page.locator('#accountIdSelect').selectOption(A);
    await expect(page.locator('#btnImportTakeout')).toBeEnabled();
});
