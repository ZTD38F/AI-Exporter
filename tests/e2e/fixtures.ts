import { test as base, chromium, expect, type BrowserContext } from '@playwright/test';
import * as path from 'path';

const pathToExtension = path.resolve(__dirname, '../../');

const isHeaded = process.argv.includes('--headed');

export const test = base.extend<{
  context: BrowserContext;
  extensionId: string;
}>({
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext('', {
      headless: false, // Don't use legacy headless
      args: [
        ...(isHeaded ? [] : ['--headless=new']), // Use Chrome's new headless architecture for full extension support with zero UI popups
        `--disable-extensions-except=${pathToExtension}`,
        `--load-extension=${pathToExtension}`,
        '--no-sandbox',
        '--disable-setuid-sandbox'
      ],
    });
    await use(context);
    await context.close();
  },
  extensionId: async ({ context }, use) => {
    let [background] = context.serviceWorkers();
    if (!background) {
      background = await context.waitForEvent('serviceworker', { timeout: 10000 });
    }
    const extensionId = background.url().split('/')[2]!;
    await use(extensionId);
  },
});

export { expect };

