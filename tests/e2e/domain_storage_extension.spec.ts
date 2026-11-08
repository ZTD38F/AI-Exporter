import { test, expect, seedRegistryAccounts } from './fixtures';
import { geminiRpcPacket, GEMINI_DETAIL_CAPTURE } from '../fixtures/providers/geminiRpcCapture.js';

test.beforeEach(async ({context, extensionId}) => {
    void extensionId;
    await seedRegistryAccounts(context);
});

test('content-script native detail is committed in extension IndexedDB and remains readable after the source tab closes', async ({ context, extensionId }) => {
    const options = await context.newPage();
    await options.goto(`chrome-extension://${extensionId}/src/ui/options/options.html?notour=1`);
    const source = await context.newPage();
    await source.route('https://gemini.google.com/**', route => route.fulfill({ contentType: 'text/html', body: `
        <title>Cross origin - Gemini</title><script>window._WIZ_global_data = { qDCSke: '10000000001', SNlM0e: 'mock-at', cfb2h: 'mock-bl' };</script>
        <user-query><div class="query-text"><p>Persist this question</p></div></user-query>
        <model-response data-model-name="Cross origin model"><div class="markdown"><p><strong>Persist this answer</strong></p></div></model-response>
    ` }));
    const wire = geminiRpcPacket('detail').responseBody;
    await source.route('**/batchexecute*', route => route.fulfill({ contentType: 'application/json', body: wire }));
    await source.goto('https://gemini.google.com/app/0000000000000001');
    await source.waitForFunction(() => window.__gemExporterHookInstalled === true);
    await source.evaluate(async body => {
        await fetch('/_/BardChatUi/data/batchexecute', { method: 'POST', body: new URLSearchParams(body) });
    }, geminiRpcPacket('detail').requestBody);
    await expect.poll(() => options.evaluate(async () => {
        const request = indexedDB.open('gemini_exporter_v2');
        const db = await new Promise<IDBDatabase>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
        try {
            return await new Promise<number>((resolve, reject) => {
                const get = db.transaction('details').objectStore('details').get(['10000000-0000-4000-8000-000000000001', '0000000000000001']);
                get.onsuccess = () => resolve(get.result?.messages?.length ?? 0); get.onerror = () => reject(get.error);
            });
        } finally { db.close(); }
    })).toBe(GEMINI_DETAIL_CAPTURE.messages);
    await source.close();
    const stored = await options.evaluate(async () => {
        const request = indexedDB.open('gemini_exporter_v2');
        const db = await new Promise<IDBDatabase>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
        try {
            return await new Promise<unknown>((resolve, reject) => {
                const tx = db.transaction('details', 'readonly');
                const get = tx.objectStore('details').get(['10000000-0000-4000-8000-000000000001', '0000000000000001']);
                let value: unknown;
                get.onsuccess = () => { value = get.result; };
                tx.oncomplete = () => resolve(value);
                tx.onerror = () => reject(tx.error);
            });
        } finally { db.close(); }
    }) as { key: { accountId: string }; messages: Array<{ model?: string; content: unknown[] }> };
    expect(stored.key.accountId).toBe('10000000-0000-4000-8000-000000000001');
    expect(stored.messages).toHaveLength(GEMINI_DETAIL_CAPTURE.messages);
    expect(stored.messages[0].content).not.toHaveLength(0);
    expect(stored.messages.every(message => message.content.length > 0)).toBe(true);
    expect(JSON.stringify(stored.messages.at(-1)?.content)).toContain(GEMINI_DETAIL_CAPTURE.lastAnswer);
    expect(stored).not.toHaveProperty('index');
});
