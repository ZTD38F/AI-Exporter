import { test, expect, seedRegistryAccounts } from './fixtures';
import { openOptions, seedConversations } from './uiFixture';
import { readFile } from 'node:fs/promises';
import { extractPdfText } from '../helpers/pdfTextExtract';
import path from 'node:path';
const JSZip = require(path.resolve(__dirname, '../../lib/jszip.min.js'));

test('one PDF batch survives sandbox rotation with all physical documents and text intact', async ({ context, extensionId }) => {
    test.setTimeout(120000);
    await seedRegistryAccounts(context);
    const remoteRequests: string[] = [];
    await context.route(/^https?:\/\//, async route => { remoteRequests.push(route.request().url()); await route.abort(); });
    const page = await openOptions(context, extensionId);
    await seedConversations(page, Array.from({ length: 33 }, (_, index) => ({
        id: `batch_${index}`, title: `Batch lifecycle ${index}`,
        body: `Retained answer marker ${index}.`, question: `Retained question marker ${index}.`,
    })));
    await page.evaluate(() => {
        Object.defineProperty(window, 'queryLocalFonts', { configurable: true,
            value: async () => { throw new DOMException('Denied for test', 'NotAllowedError'); } });
    });
    let sandboxes = 0;
    page.on('framenavigated', frame => { if (frame.url().includes('/sandbox/typst-compile.html')) sandboxes++; });
    await page.locator('#format').selectOption('pdf');
    await expect(page.locator('body')).toHaveAttribute('data-busy', 'false');
    await page.locator('#skipExported').uncheck();
    await expect(page.locator('body')).toHaveAttribute('data-busy', 'false');
    await page.locator('#btnSelectAll').click();
    const downloaded = page.waitForEvent('download', { timeout: 90000 });
    await page.locator('#btnExport').click();
    await expect(page.locator('#directWriteModal')).toBeVisible();
    await expect(page.locator('#directWritePromptText')).toContainText('33 conversations');
    await page.locator('#btnModalContinueZip').click();
    const download = await downloaded;
    const zip = await JSZip.loadAsync(await readFile((await download.path())!));
    const documents = Object.values(zip.files).filter((file: unknown) => {
        const entry = file as { dir: boolean; name: string };
        return !entry.dir && entry.name.endsWith('.pdf');
    }) as Array<{ async(type: string): Promise<Uint8Array> }>;
    expect(documents).toHaveLength(33);
    const text: string[] = [];
    for (const document of documents) {
        const bytes = await document.async('uint8array');
        expect(Buffer.from(bytes.subarray(0, 5)).toString()).toBe('%PDF-');
        text.push(extractPdfText(bytes).text);
    }
    for (let index = 0; index < 33; index++) {
        expect(text.filter(value => value.includes(`Retained answer marker ${index}.`))).toHaveLength(1);
        expect(text.filter(value => value.includes(`Retained question marker ${index}.`))).toHaveLength(1);
    }
    await expect(page.locator('body')).toHaveAttribute('data-busy', 'false');
    expect(sandboxes).toBe(2);
    expect(remoteRequests).toEqual([]);
});
