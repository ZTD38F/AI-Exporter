import { test, expect } from './fixtures';

test.use({ grantGemini: false });

test('fixture browser blocks unexpected external requests while allowing explicit mocks', async ({ context }) => {
  const blockedPage = await context.newPage();
  await expect(blockedPage.goto('https://untrusted.invalid/')).rejects.toThrow(/ERR_BLOCKED_BY_CLIENT/);
  await blockedPage.close();

  // Failed Chromium navigations may still asynchronously enter chrome-error://.
  // Start the mock-route assertion on a clean page so that transition cannot race it.
  const page = await context.newPage();
  await page.route('https://fixture.invalid/**', route => route.fulfill({
    contentType: 'text/html',
    body: '<main data-testid="fixture">Local browser fixture</main>',
  }));
  await page.goto('https://fixture.invalid/');
  await expect(page.getByTestId('fixture')).toHaveText('Local browser fixture');
});
