import { test, expect, seedRegistryAccounts } from './fixtures';
import { exposeUIStorage, openOptions, seedConversations, storedSettings } from './uiFixture';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

test('55-conversation browser delivery suggests folder once, then ZIP remains available and suppression survives reload', async ({ context, extensionId }) => {
    await seedRegistryAccounts(context);
    const page = await openOptions(context, extensionId);
    await seedConversations(page, Array.from({ length: 55 }, (_, i) => ({
        id: `bulk_${i}`, title: `Bulk ${i}`, body: `Bulk answer ${i}`,
    })));
    await page.locator('#btnSelectAll').click();
    await page.locator('#btnExport').click();

    const modal = page.locator('#directWriteModal');
    await expect(modal).toBeVisible();
    await expect(page.locator('#directWritePromptText')).toContainText('55 conversations');
    await expect(page.locator('#btnModalSwitchFolder')).toBeVisible();
    await expect(page.locator('#btnModalContinueZip')).toBeVisible();
    await expect.poll(async () => (await storedSettings(page)).directWritePromptCompleted).toBe(true);

    const pending = page.waitForEvent('download');
    await page.locator('#btnModalContinueZip').click();
    await expect(modal).toBeHidden();
    const file = await pending;
    expect(file.suggestedFilename()).toMatch(/\.zip$/);
    const JSZip = require(path.resolve(__dirname, '../../lib/jszip.min.js'));
    const zip = await JSZip.loadAsync(await readFile((await file.path())!));
    const files = Object.keys(zip.files).filter(x => x.endsWith('.md'));
    expect(files).toHaveLength(55);
    expect((await Promise.all(files.map(x => zip.file(x).async('string')))).join('\n')).toContain('Bulk answer 54');

    // Browser download precedes the final export record commits; do not reload until they settle.
    await expect(page.locator('#status')).toContainText('Successfully downloaded: 55', { timeout: 30000 });
    await expect.poll(async () => page.evaluate(async () =>
        Object.keys(await Reflect.get(globalThis, 'uiFixture')
            .listExportRecords('10000000-0000-4000-8000-000000000001')).length),
        { timeout: 30000 }).toBe(55);

    await page.reload();
    await expect(page.locator('#list .item')).toHaveCount(55);
    await page.locator('#btnSelectAll').click();
    await page.locator('#btnExport').click();
    await expect(page.locator('#status')).toContainText('Skipped: 55');
    await expect(modal).toBeHidden();
});

test('closing a displayed batch suggestion permanently dismisses it without starting an export', async ({ context, extensionId }) => {
    await seedRegistryAccounts(context);
    const page = await openOptions(context, extensionId);
    await seedConversations(page, Array.from({ length: 21 }, (_, i) => ({ id: `tip_${i}` })));
    await page.locator('#btnSelectAll').click();
    await page.locator('#btnExport').click();
    await expect(page.locator('#directWriteModal')).toBeVisible();
    await page.locator('#btnDirectWriteClose').click();
    await expect(page.locator('#directWriteModal')).toBeHidden();
    await expect.poll(async () => (await storedSettings(page)).directWritePromptCompleted).toBe(true);

    await page.reload();
    await expect(page.locator('#list .item')).toHaveCount(21);
    await exposeUIStorage(page);
    await page.locator('#btnSelectAll').click();
    const pending = page.waitForEvent('download');
    await page.locator('#btnExport').click();
    await pending;
    await expect(page.locator('#directWriteModal')).toBeHidden();
    // A download starts before the export records commit; await the completed task before teardown.
    await expect(page.locator('#status')).toContainText('Successfully downloaded: 21', { timeout: 30000 });
    await expect.poll(async () => page.evaluate(async () =>
        Object.keys(await Reflect.get(globalThis, 'uiFixture')
            .listExportRecords('10000000-0000-4000-8000-000000000001')).length),
        { timeout: 30000 }).toBe(21);
});
