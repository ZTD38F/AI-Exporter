import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { buildSync } from 'esbuild';
import type * as Storage from '../src/l3a/storageService.js';
import type * as AccountAdmission from '../src/l2/accountAdmission.js';
import type * as Ingestion from '../src/l2/ingestion.js';

const bundle = buildSync({ stdin: { contents: `
    export * from './src/l3a/storageService.ts';
    export {getOrCreateAccount} from './src/l2/accountAdmission.ts';
    export {ingestIndexes, ingestDetail} from './src/l2/ingestion.ts';
`, resolveDir: process.cwd() }, bundle: true, format: 'iife', globalName: 'admission', write: false }).outputFiles[0].text;
declare global { interface Window { admission: typeof Storage & typeof AccountAdmission & typeof Ingestion } }

test('Chromium contexts serialize L2 fact admission using native IDB readwrite transactions', async () => {
    const browser = await chromium.launch({ chromiumSandbox: true, headless: true });
    try {
        const context = await browser.newContext();
        await context.route('http://localhost/admission', route => route.fulfill({ body: '<html></html>', contentType: 'text/html' }));
        const pages = await Promise.all([context.newPage(), context.newPage()]);
        for (const page of pages) {
            await page.goto('http://localhost/admission');
            await page.addScriptTag({ content: bundle });
            // Browser Runtime broker boundary only: each read reaches the actual same-origin DB.
            await page.evaluate(() => Object.defineProperty(window, 'chrome', { configurable: true, value: { runtime: {
                sendMessage: async (request: { action: string; accountId?: string }) =>
                    request.action === 'ensureV2Ready' ? { ok: true }
                        : { ok: true, value: await window.admission.getAccount(request.accountId!) }
            } } }));
        }
        const accounts = await Promise.all(pages.flatMap((page, i) => Array.from({ length: 6 }, (_, j) => page.evaluate(async ({ i, j }) => {
            return window.admission.getOrCreateAccount('gemini', 'subject', `${i}-${j}@example.test`);
        }, { i, j }))));
        assert.equal(new Set(accounts.map(account => account.id)).size, 1);
        const accountId = accounts[0].id;
        await Promise.all(pages.flatMap((page, i) => Array.from({ length: 6 }, (_, j) => page.evaluate(async ({ accountId, i, j }) => {
            await window.admission.ingestIndexes(accountId, [{ conversationId: `id-${i}-${j}`, fields: { updatedAt: j } }]);
            await window.admission.ingestDetail(accountId, 'shared', { assets: [], messages: [], quality: { status: 'complete' }, savedAt: i * 6 + j });
        }, { accountId, i, j }))));
        const result = await pages[0].evaluate(async accountId => ({ accounts: await window.admission.listAccounts(),
            indexes: await window.admission.listIndexes(accountId), detail: await window.admission.getDetail({ accountId, conversationId: 'shared' }) }), accountId);
        assert.equal(result.accounts.length, 1);
        assert.equal(result.indexes.length, 13);
        assert.equal(result.detail?.savedAt, 11);
    } finally { await browser.close(); }
});
