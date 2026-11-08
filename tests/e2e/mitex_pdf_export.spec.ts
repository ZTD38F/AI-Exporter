/**
 * Full MV3 v2 MiTeX/PDF integration: native L2 Detail -> L3a -> Application
 * -> L3b -> L4 MiTeX + Typst sandbox -> browser download + ExportRecord.
 * No v1 chrome.storage.local conversation arrays or __mitex UI debug hooks.
 */
import { test, expect, seedRegistryAccounts } from './fixtures';
import { openOptions, accountId, exposeUIStorage } from './uiFixture';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';

let mitexBundle: string;
test.beforeAll(async () => {
    const built = await build({
        stdin: {
            resolveDir: path.resolve(__dirname, '../..'), loader: 'ts',
            contents: "import { initMitexWasm, isMitexReady, convertMathWithMitex } from './src/l4/format/typst/mathConverter.ts';" +
                'globalThis.mitexV2Probe = { initMitexWasm, isMitexReady, convertMathWithMitex };',
        },
        bundle: true, write: false, format: 'iife', platform: 'browser',
    });
    mitexBundle = built.outputFiles[0].text;
});
test.beforeEach(async ({ context }) => { await seedRegistryAccounts(context); });

const formulas = [
    '\\int_0^\\infty e^{-x} dx = 1',
    '\\frac{\\sqrt{x^2 + 1}}{2}',
    '\\begin{cases} 1 & x > 0 \\\\ 0 & x \\le 0 \\end{cases}',
];

for (const denied of [false, true]) {
    test(denied ? 'v2 PDF exports math offline when local fonts are denied'
        : 'v2 PDF uses real MiTeX and Typst sandbox with no external HTTP requests',
    async ({ context, extensionId }) => {
        test.setTimeout(120000);
        const remoteRequests: string[] = [];
        await context.route(/^https?:\/\//, async route => {
            remoteRequests.push(route.request().url());
            await route.abort();
        });
        const page = await openOptions(context, extensionId);
        await page.evaluate(mitexBundle);

        // The actual L4 module owns MiTeX initialization; UI exposes no math debug global.
        const math = await page.evaluate(async expressions => {
            const api = Reflect.get(globalThis, 'mitexV2Probe');
            await api.initMitexWasm();
            return {
                ready: api.isMitexReady(),
                converted: expressions.map((source: string) => api.convertMathWithMitex(source, 'latex', true)),
            };
        }, formulas);
        expect(math.ready).toBe(true);
        for (const converted of math.converted) {
            expect(converted.typst).toBeTruthy();
            expect(converted.diagnostic).toBeUndefined();
        }

        const conversationId = denied ? 'mitex_denied' : 'mitex_allowed';
        await page.evaluate(async ({ accountId, conversationId, expressions, denied }) => {
            const api = Reflect.get(globalThis, 'uiFixture');
            await api.ingestDetail(accountId, conversationId, {
                savedAt: 1700000000000, quality: { status: 'complete' }, assets: [],
                messages: [
                    { role: 'user', content: [{ type: 'paragraph', children: [
                        { type: 'text', text: denied ? 'Calculate the integral' : 'Show me the Gaussian integral' },
                    ] }] },
                    { role: 'assistant', content: [
                        { type: 'paragraph', children: [{ type: 'text', text: 'MiTeX math in the production PDF:' }] },
                        ...expressions.map((source: string) => ({ type: 'math', source })),
                    ] },
                ],
            }, {
                title: denied ? 'Math without local fonts' : 'MiTeX PDF integration',
                titleSource: 'provider', updatedAt: 1700000000000,
            });
        }, { accountId, conversationId, expressions: formulas, denied });
        await page.reload();
        await exposeUIStorage(page);
        await expect(page.locator('#list .item')).toHaveCount(1);

        if (denied) {
            await page.evaluate(() => {
                (window as any).__deniedFontQueries = 0;
                const originalQuery = navigator.permissions.query.bind(navigator.permissions);
                navigator.permissions.query = (async descriptor => descriptor.name === ('local-fonts' as PermissionName)
                    ? { state: 'denied' } : originalQuery(descriptor)) as typeof navigator.permissions.query;
                (window as any).queryLocalFonts = async () => {
                    (window as any).__deniedFontQueries++;
                    throw new DOMException('User denied Local Font Access', 'NotAllowedError');
                };
            });
        }

        await page.locator('#format').selectOption('pdf');
        await page.locator('#btnSelectAll').click();
        const downloadPromise = page.waitForEvent('download', { timeout: 90000 });
        await page.locator('#btnExport').click();
        const download = await downloadPromise;
        expect(download.suggestedFilename()).toMatch(/\.pdf$/);
        const bytes = await readFile((await download.path())!);
        expect(bytes.length).toBeGreaterThan(1000);
        expect(bytes.subarray(0, 5).toString('ascii')).toBe('%PDF-');
        await expect.poll(async () => page.evaluate(async ({ accountId, conversationId }) =>
            Reflect.get(globalThis, 'uiFixture').getExportRecord({ accountId, conversationId }),
        { accountId, conversationId })).toMatchObject({ format: 'pdf', status: 'ok' });

        if (denied) {
            expect(await page.evaluate(() => (window as any).__deniedFontQueries)).toBe(0); // Denied fonts must never be queried or block export.
            await readFile((await download.path())!); // Final artifact remains readable without permission.
        }
        expect(remoteRequests).toEqual([]);
    });
}
