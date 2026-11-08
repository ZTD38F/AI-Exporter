// Full browser v2 UI -> L2 Domain -> L4 JSON archive -> direct download.
import { test, expect, seedRegistryAccounts } from './fixtures';
import { openOptions, seedConversations, accountId } from './uiFixture';
import { readFile } from 'node:fs/promises';

test.beforeEach(async ({ context }) => { await seedRegistryAccounts(context); });

test('v2 JSON download preserves Account, canonical keys, source version and native message roles', async ({ context, extensionId }) => {
    const page = await openOptions(context, extensionId);
    const question = '请解释一下分布式系统中的一致性哈希算法。';
    const answer = '一致性哈希（Consistent Hashing）能够在节点增删时最小化数据迁移。';
    await seedConversations(page, [{ id: 'json_exp_001', title: '分布式一致性哈希算法详解', question, body: answer }]);
    await page.locator('#format').selectOption('json');
    await page.locator('#btnSelectAll').click();
    const downloadPromise = page.waitForEvent('download');
    await page.locator('#btnExport').click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.json$/);
    const archive = JSON.parse(await readFile((await download.path())!, 'utf8'));
    expect(archive.format).toBe('gemini-exporter-domain');
    expect(archive.version).toBe(1);
    expect(archive.account.providerId).toBe('gemini');
    expect(archive.account.id).toBe(accountId);
    const key = { accountId, conversationId: 'json_exp_001' };
    expect(archive.conversation.index.key).toEqual(key);
    expect(archive.conversation.detail.key).toEqual(key);
    expect(archive.conversation.detail.savedAt).toBe(100);
    expect(archive.conversation.detail.quality.status).toBe('complete');
    expect(archive.conversation.detail.messages.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant']);
    expect(JSON.stringify(archive.conversation.detail.messages)).toContain(question);
    expect(JSON.stringify(archive.conversation.detail.messages)).toContain(answer);
    expect(archive.resources).toEqual({});
    await expect.poll(() => page.evaluate(async id =>
        (await Reflect.get(globalThis, 'uiFixture').getExportRecord({ accountId: id, conversationId: 'json_exp_001' }))?.format,
    accountId)).toBe('json');
    await page.close();
});
