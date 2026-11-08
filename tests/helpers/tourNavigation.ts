import type { Page } from 'playwright';

/** Onboarding starts with the real authorization menu. */
export async function waitForAuthorization(page: Page): Promise<void> {
    await page.getByRole('heading', { name: 'Authorize AI platforms', exact: true }).waitFor();
}

export async function continueToScan(page: Page): Promise<void> {
    await page.locator('#tourNextBtn').click();
    await page.locator('#btnDetectAccount:enabled').click();
    await page.getByRole('heading', { name: 'Switch platforms and accounts', exact: true }).waitFor();
    await page.locator('#tourNextBtn').click();
}
