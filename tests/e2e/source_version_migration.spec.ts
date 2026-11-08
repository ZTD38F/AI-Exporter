import { test, expect, seedRegistryAccounts } from './fixtures';
import { build } from 'esbuild';
import path from 'node:path';

const accountId = '10000000-0000-4000-8000-000000000001';

test('existing profile repairs mixed versions once and admits an older online timestamp in native IndexedDB', async ({ context, extensionId }) => {
    await seedRegistryAccounts(context);
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/ui/options/options.html`);
    const output = await build({ stdin: { resolveDir: path.resolve(__dirname, '../..'), loader: 'ts', contents: `
        import * as storage from './src/l3a/storageService.ts';
        import { ingestDetail } from './src/l2/ingestion.ts';
        import { repairSourceVersions } from './src/migration/sourceVersions.ts';
        globalThis.versionProbe = {...storage,ingestDetail,repairSourceVersions};
    ` }, bundle: true, write: false, format: 'iife' });
    await page.evaluate(output.outputFiles[0].text);
    const result = await page.evaluate(async accountId => {
        const api = Reflect.get(globalThis, 'versionProbe');
        const key = { accountId, conversationId: 'migration-version' };
        const detail = { savedAt: 9000, quality: { status: 'partial' }, assets: [], messages: [
            { role: 'user', timestamp: 9000, content: [{ type: 'paragraph', children: [{ type: 'text', text: 'Keep this body' }] }] },
        ] };
        await api.ingestDetail(accountId, key.conversationId, detail, { title: 'Migration regression', titleSource: 'provider', updatedAt: 9000 });
        await api.putExportRecord(key, { format: 'markdown', status: 'ok', exportedAt: 10000, chatTime: 9000 });
        await chrome.storage.local.remove('gemini_exporter_source_versions_v1');
        await api.repairSourceVersions();
        const repaired = { index: await api.getIndex(key), detail: await api.getDetail(key), record: await api.getExportRecord(key) };
        const admission = await api.ingestDetail(accountId, key.conversationId, { ...detail, savedAt: 1000 }, { updatedAt: 1000 });
        await api.repairSourceVersions();
        return { repaired, admission, final: { index: await api.getIndex(key), detail: await api.getDetail(key) } };
    }, accountId);
    expect(result.repaired.index.updatedAt).toBeUndefined();
    expect(result.repaired.index.activityAt).toBe(9000);
    expect(result.repaired.detail.savedAt).toBeUndefined();
    expect(result.repaired.detail.messages[0].content[0].children[0].text).toBe('Keep this body');
    expect(result.repaired.record).toEqual({ format: 'markdown', status: 'ok', exportedAt: 10000 });
    expect(result.admission.accepted).toBe(true);
    expect(result.final.index.updatedAt).toBe(1000);
    expect(result.final.detail.savedAt).toBe(1000);
    await page.reload();
    await expect(page.locator('#list .item')).toHaveCount(1);
    await expect(page.locator('#list')).toContainText('Migration regression');
});
