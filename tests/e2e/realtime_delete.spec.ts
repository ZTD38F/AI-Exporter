import { test, expect, seedRegistryAccounts } from './fixtures';
import { openOptions, seedConversations, accountId } from './uiFixture';
import { deleteGen as geminiDeleteGen } from '../fixtures/providers/geminiDelete.js';
import { deleteRequestGen as geminiDeleteRequestGen } from '../fixtures/providers/geminiDeleteRequest.js';

// Actual v2 deletion semantics: a confirmed provider deletion removes the
// conversation's Index, Detail and ExportRecord together. No archive shadow.
test.beforeEach(async ({ context }) => { await seedRegistryAccounts(context); });

const targetId = '8888abcd1234ef01';
const key = { accountId, conversationId: targetId };

async function read(page: import('@playwright/test').Page) {
    return page.evaluate(async ({ accountId, conversationId }) => {
        const api = Reflect.get(globalThis, 'uiFixture');
        const key = { accountId, conversationId };
        return {
            targetIndex: await api.getIndex(key),
            targetDetail: await api.getDetail(key),
            targetRecord: await api.getExportRecord(key),
            indexes: await api.listIndexes(accountId),
            records: await api.listExportRecords(accountId),
            other: await api.readConversation({ accountId, conversationId: 'keep_chat_1111' }),
        };
    }, key);
}
async function geminiSource(context: import('@playwright/test').BrowserContext) {
    const source = await context.newPage();
    await source.route('https://gemini.google.com/**', route => route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><title>Google Gemini</title><script>window.WIZ_global_data={qDCSke:"10000000001",SNlM0e:"token",cfb2h:"build"}</script><main>Source</main>',
    }));
    await source.goto('https://gemini.google.com/app/c_' + targetId);
    await source.waitForFunction(() => Boolean(Reflect.get(window, '__gemExporterHookInstalled')));
    return source;
}
async function remoteDelete(source: import('@playwright/test').Page, responseKey: Parameters<typeof geminiDeleteGen>[0]) {
    await source.route('**/batchexecute*', route => route.fulfill({
        status: 200, contentType: 'application/json',
        body: geminiDeleteGen(responseKey),
    }));
    await source.evaluate(async body => {
        await fetch('/_/BardChatUi/data/batchexecute?rpcids=GzXR5e', {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
            body: new URLSearchParams(body),
        });
    }, geminiDeleteRequestGen('G_E2E_REALTIME_DELETE_REQUEST_01'));
}

for (const nativeVoid of [false, true]) test(`real MAIN ${nativeVoid ? 'native void' : 'echoed'} deletion RPC -> isolated L1 -> Background L2 atomically removes only confirmed v2 conversation facts`, async ({ context, extensionId }) => {
    const options = await openOptions(context, extensionId);
    await seedConversations(options, [
        { id: targetId, title: 'Delete target', body: 'Durable target body' },
        { id: 'keep_chat_1111', title: 'Keep original', body: 'Keep body unchanged' },
        { id: 'keep_chat_2222', title: 'Keep second' },
    ], { [targetId]: { format: 'markdown', status: 'ok', exportedAt: 1700000000000 } });
    await expect(options.locator('#list .item')).toHaveCount(3);
    const before = await read(options);
    expect(before.targetIndex?.title).toBe('Delete target');
    expect(JSON.stringify(before.targetDetail)).toContain('Durable target body');
    expect(before.targetRecord?.status).toBe('ok');

    const source = await geminiSource(context);
    await remoteDelete(source, nativeVoid ? 'G_DYNAMIC_DELETE_VOID_01' : 'G_DYNAMIC_DELETE_ECHO_01');
    await expect.poll(async () => (await read(options)).targetIndex).toBeNull();
    const after = await read(options);
    expect(after.targetDetail).toBeNull();
    expect(after.targetRecord).toBeNull();
    expect(after.records[targetId]).toBeUndefined();
    expect(after.indexes).toHaveLength(2);
    expect(JSON.stringify(after.other)).toContain('Keep body unchanged');

    // The UI is a projection of the same v2 L3a Index store, not chrome.storage.local.
    // The open Options view updates from the committed Runtime notification, without reload or focus.
    await expect(options.locator('#list .item')).toHaveCount(2);
    await expect(options.locator('[data-chat-id="' + targetId + '"]')).toHaveCount(0);
    await expect(options.locator('[data-chat-id="keep_chat_1111"]')).toBeVisible();
    await expect(options.locator('[data-chat-id="keep_chat_2222"]')).toBeVisible();
});

test('an unmatched Gemini deletion reply cannot remove a different v2 Domain', async ({ context, extensionId }) => {
    const options = await openOptions(context, extensionId);
    await seedConversations(options, [{ id: targetId, title: 'Must stay' }],
        { [targetId]: { format: 'markdown', status: 'ok', exportedAt: 100 } });
    const source = await geminiSource(context);
    await remoteDelete(source, 'G_DYNAMIC_DELETE_UNMATCHED_01');
    await expect.poll(async () => (await read(options)).targetIndex?.title).toBe('Must stay');
    const after = await read(options);
    expect(after.targetDetail).not.toBeNull();
    expect(after.targetRecord?.status).toBe('ok');
    await options.reload();
    await expect(options.locator('[data-chat-id="' + targetId + '"]')).toBeVisible();
});
