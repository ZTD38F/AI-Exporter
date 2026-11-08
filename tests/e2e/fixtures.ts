import { platformOrigins } from '../../src/shared/platformHosts';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { domainFixtureBrowser } from './domainFixtureBrowser';
import { test as base, chromium, expect, type BrowserContext } from '@playwright/test';
import * as path from 'path';

const pathToExtension = path.resolve(__dirname, '../../');

let authorizedExtensionPath: string | undefined;

const isHeaded = process.argv.includes('--headed');

export const test = base.extend<{
  context: BrowserContext;
  grantGemini: boolean;
  extensionId: string;
}>({
  // Existing source-flow tests use a Gemini-authorized staging copy. Dedicated
  // permission tests explicitly select the unchanged shipping manifest.
  grantGemini: [true, { option: true }],
  context: async ({ grantGemini }, use) => {
    let extensionPath = pathToExtension;
    if (grantGemini && !authorizedExtensionPath) {
      const staged = fs.mkdtempSync(path.join(os.tmpdir(), 'exporter-authorized-'));
      for (const name of ['src', 'dist', 'icons', 'lib', '_locales'])
        fs.cpSync(path.join(pathToExtension, name), path.join(staged, name), { recursive: true });
      const manifest = JSON.parse(fs.readFileSync(path.join(pathToExtension, 'manifest.json'), 'utf8'));
      const origins = platformOrigins('gemini');
      manifest.host_permissions = origins;
      manifest.optional_host_permissions = manifest.optional_host_permissions.filter((origin: string) => !origins.includes(origin));
      fs.writeFileSync(path.join(staged, 'manifest.json'), JSON.stringify(manifest));
      authorizedExtensionPath = staged;
      process.once('exit', () => fs.rmSync(staged, { recursive: true, force: true }));
    }
    if (grantGemini) extensionPath = authorizedExtensionPath!;
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium', // Use full Chromium binary to support extensions in true headless
      headless: !isHeaded,
      chromiumSandbox: true,
      args: [
        ...(isHeaded ? [] : ['--headless=new']),
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,

      ],
    });
    // Fixture tests do not require outbound traffic; an explicit mock route can override this guard.
    await context.route(/^https?:\/\//, route => route.abort('blockedbyclient'));
    if (grantGemini) {
      const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
      await worker.evaluate(async () => {
        for (let attempt = 0; attempt < 100; attempt++) {
          if ((await chrome.scripting.getRegisteredContentScripts()).some(script => script.id === 'gemini-source-content')) return;
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        throw new Error('Gemini staging content registration timed out');
      });
    }
    await context.addInitScript({ content: domainFixtureBrowser });
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


/** Explicit v2 physical fixtures; ordinary Extension reads use direct APIs, not Content IPC. */
const seedBundle = require('esbuild').buildSync({
  stdin: { contents: `import * as storage from './src/l3a/storageService.ts'; globalThis.fixtureStorage = storage;`,
    resolveDir: path.resolve(__dirname, '../..'), loader: 'ts' }, bundle: true, write: false, format: 'iife',
}).outputFiles[0].text;
export async function seedRegistryAccounts(context: BrowserContext): Promise<void> {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const page = await context.newPage();
  try {
    await page.goto(`chrome-extension://${worker.url().split('/')[2]}/src/ui/options/options.html`);
    const reply = await page.evaluate(() => chrome.runtime.sendMessage({ action: 'ensureV2Ready' }));
    if (!reply?.ok) throw new Error('Fixture readiness failed');
    await page.evaluate(seedBundle);
    await page.evaluate(async () => {
      const storage = Reflect.get(globalThis, 'fixtureStorage');
      await storage.putAccount({id:'10000000-0000-4000-8000-000000000001',providerId:'gemini',providerAccountId:'10000000001',displayName:'Fixture account'});
      await storage.putAccount({id:'10000000-0000-4000-8000-000000000002',providerId:'gemini',providerAccountId:'10000000002',displayName:'Other account'});
      await storage.putAccount({id:'10000000-0000-4000-8000-000000000003',providerId:'gemini',providerAccountId:'default'});
    });
  } finally { await page.close(); }
}
