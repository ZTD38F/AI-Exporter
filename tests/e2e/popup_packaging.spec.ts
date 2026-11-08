import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

test('Popup loads ZIP dependency before packaging a conversation with original files', async ({ page }) => {
    const root = process.cwd();
    const bundle = await build({
        stdin: { contents: `
            import { packageExportFiles } from './src/l4/packaging/index.ts';
            globalThis.packageOriginals = async () => {
                const [file] = await packageExportFiles([[
                    {fileName:'conversation.md',mimeType:'text/markdown',content:'# Conversation'},
                    {fileName:'files/original.py',mimeType:'text/plain',content:'print(42)'}
                ]], 'browserDownload');
                const zip = await globalThis.JSZip.loadAsync(await file.content.arrayBuffer());
                return {mimeType:file.mimeType, text:await zip.file('conversation.md').async('string'),
                    original:await zip.file('files/original.py').async('string')};
            };
        `, resolveDir: root }, bundle: true, write: false, format: 'iife', platform: 'browser',
    });
    await page.route('https://popup.test/**', async route => {
        const resource = new URL(route.request().url()).pathname;
        if (resource === '/dist/ui/popup.js') {
            await route.fulfill({ contentType: 'text/javascript', body: bundle.outputFiles[0].text });
        } else {
            const file = path.join(root, resource === '/' ? 'src/ui/popup/popup.html' : resource);
            if (!fs.existsSync(file)) return route.abort();
            await route.fulfill({ path: file });
        }
    });
    await page.goto('https://popup.test/');
    expect(await page.evaluate(() => (globalThis as any).packageOriginals())).toEqual({
        mimeType: 'application/zip', text: '# Conversation', original: 'print(42)',
    });
});
