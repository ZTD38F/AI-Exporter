// Full browser v2 UI -> Application -> Composer -> HTML -> physical download.
import { test, expect, seedRegistryAccounts } from './fixtures';
import { openOptions, seedConversations, accountId } from './uiFixture';
import { readFile } from 'node:fs/promises';

test.beforeEach(async ({ context }) => { await seedRegistryAccounts(context); });

test('v2 HTML file retains long prompts, collapsible content and print-safe styling', async ({ context, extensionId }) => {
    const page = await openOptions(context, extensionId);
    const question = '请解释一下热膨胀系数突变引发的瞬态热激波。'.repeat(20);
    const answer = '热膨胀系数突变会引发局部应力波与瞬态热激波，在极高加热速率下尤为显著。';
    await seedConversations(page, [{ id: 'html_exp_001', title: '瞬态热激波与热膨胀物理机制', question, body: answer }]);
    await page.locator('#format').selectOption('html');
    await page.locator('#btnSelectAll').click();
    const downloadPromise = page.waitForEvent('download');
    await page.locator('#btnExport').click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.html$/);
    const html = await readFile((await download.path())!, 'utf8');
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('瞬态热激波与热膨胀物理机制');
    expect(html).toContain(answer);
    expect(html).toContain('@media print');
    expect(html).toContain('gem-user-bubble');
    expect(html).toContain('gem-model-content');
    expect(html).toContain('prefers-color-scheme');
    expect(html).not.toContain('gem-top-bar');

    const rendered = await context.newPage();
    await rendered.setContent(html);
    await expect(rendered.locator('.gem-model-content')).toHaveCount(1);
    await expect(rendered.locator('.gem-prompt-content')).toHaveCount(1);
    const toggle = rendered.locator('.gem-prompt-toggle');
    await expect(toggle).toHaveCount(1);
    await expect(rendered.locator('.gem-prompt-content')).toHaveClass(/collapsed/);
    await toggle.click();
    await expect(rendered.locator('.gem-prompt-content')).not.toHaveClass(/collapsed/);
    await toggle.click();
    await expect(rendered.locator('.gem-prompt-content')).toHaveClass(/collapsed/);
    await expect.poll(() => page.evaluate(async id =>
        (await Reflect.get(globalThis, 'uiFixture').getExportRecord({ accountId: id, conversationId: 'html_exp_001' }))?.format,
    accountId)).toBe('html');
    await rendered.close();
    await page.close();
});
