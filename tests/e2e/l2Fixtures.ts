import { test as base, chromium, expect, type BrowserContext } from '@playwright/test';
import { build } from 'esbuild';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
export { seedRegistryAccounts } from './fixtures';

/** Isolated L2 browser harness: uses the real admission/storage brokers without loading other v2 modules. */
export const test = base.extend<{ context: BrowserContext; extensionId: string }>({
    context: async ({}, use) => {
        const extension = await mkdtemp(join(tmpdir(), 'exporter-l2-'));
        let context: BrowserContext | undefined;
        try {
            await mkdir(join(extension, 'src/ui/options'), { recursive: true });
            await writeFile(join(extension, 'src/ui/options/options.html'), '<!doctype html><title>L2 admission test</title>');
            await writeFile(join(extension, 'manifest.json'), JSON.stringify({
                manifest_version: 3, name: 'L2 admission test', version: '1.0.0', permissions: ['storage'],
                background: { service_worker: 'background.js' },
            }));
            await build({ stdin: { resolveDir: resolve(__dirname, '../..'), loader: 'ts', contents: `
                import { handleAccountRegistryMessage } from './src/runtime/background/accountRegistryHandler.ts';
                import { handleDomainIngestionMessage } from './src/runtime/background/domainStorageHandler.ts';
                import { ensureV2Ready } from './src/runtime/background/readiness.ts';
                chrome.runtime.onMessage.addListener((message, sender, respond) => {
                    if (message?.action === 'ensureV2Ready') {
                        void ensureV2Ready().then(() => respond({ ok: true }), error => respond({ ok: false, error: String(error) }));
                        return true;
                    }
                    return handleAccountRegistryMessage(message, sender, respond) || handleDomainIngestionMessage(message, sender, respond);
                });
            ` }, bundle: true, platform: 'browser', format: 'iife', outfile: join(extension, 'background.js') });
            context = await chromium.launchPersistentContext('', {
                channel: 'chromium', headless: true, chromiumSandbox: true,
                args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
            });
            // Native extension tests use local fixtures; unexpected external requests fail closed.
            await context.route(/^https?:\/\//, route => route.abort('blockedbyclient'));
            await use(context);
        } finally {
            await context?.close();
            await rm(extension, { recursive: true, force: true });
        }
    },
    extensionId: async ({ context }, use) => {
        const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
        await use(new URL(worker.url()).host);
    },
});
export { expect };
