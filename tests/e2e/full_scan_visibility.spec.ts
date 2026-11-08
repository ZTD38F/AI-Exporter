import { test, expect, seedRegistryAccounts } from './fixtures';
import { openOptions } from './uiFixture';

test('Full history scanning is visible to non-developer Gemini users', async ({ context, extensionId }) => {
    await seedRegistryAccounts(context);
    const page = await openOptions(context, extensionId);
    const fullScan = page.locator('#btnForceFullScan');
    await page.locator('#btnMoreActions').click();
    await expect(fullScan).toBeVisible();
    await expect(fullScan).toContainText('Scan full history');
    await expect(fullScan).toBeEnabled();
});
