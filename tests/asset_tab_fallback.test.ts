/**
 * V2 tab transport is Account-verified Runtime IPC, not AssetPipeline tab
 * iteration. Only a Tab that responds with the requested Account UUID may
 * receive a resource request. A business-request failure does not start a
 * speculative retry to another tab.
 */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { useIndexStorage } from './helpers/indexStorage.js';
import { fixtureAccount } from './helpers/domainFixture.js';
import { putAccount } from '../src/l3a/storageService.js';
import { sendToGeminiTab } from '../src/runtime/capabilities/tabService.js';

useIndexStorage();
const account = fixtureAccount('gemini');
type TabMessage = { action: string; accountId?: string; url?: string };
type Reply = (value: unknown) => void;
function tabs(t: TestContext,
    handler: (id: number, message: TabMessage, reply: Reply) => void,
    list: Array<{ id: number; active?: boolean }> = [{ id: 11 }, { id: 22 }]) {
    const chromeHost = globalThis.chrome;
    const previous = Object.getOwnPropertyDescriptor(globalThis.chrome, 'tabs');
    const runtime = globalThis.chrome.runtime;
    const previousError = Object.getOwnPropertyDescriptor(runtime, 'lastError');
    const calls: Array<{ id: number; message: TabMessage }> = [];
    Object.defineProperty(chromeHost, 'tabs', { configurable: true, value: {
        query: async () => list.map(tab => ({ ...tab, url: 'https://gemini.google.com/app' })),
        sendMessage: (id: number, message: TabMessage, reply: Reply) => {
            calls.push({ id, message });
            handler(id, message, reply);
        },
    } });
    t.after(() => {
        if (previous) Object.defineProperty(chromeHost, 'tabs', previous);
        else Reflect.deleteProperty(chromeHost, 'tabs');
        if (previousError) Object.defineProperty(runtime, 'lastError', previousError);
        else Reflect.deleteProperty(runtime, 'lastError');
    });
    return { calls, failReceiver(reply: Reply) {
        Reflect.set(runtime, 'lastError', { message: 'Receiving end does not exist' });
        try { reply(undefined); }
        finally { Reflect.deleteProperty(runtime, 'lastError'); }
    } };
}

test('resource IPC skips an unavailable Content receiver and reaches the next verified Account tab', async t => {
    await putAccount(account);
    let failFirst!: (reply: Reply) => void;
    const host = tabs(t, (id, message, reply) => {
        assert.equal(message.action === 'getAccountContext' || message.accountId === account.id, true);
        if (id === 11) return failFirst(reply);
        if (message.action === 'getAccountContext') return reply({
            ok: true, accountContext: { accountId: account.id, providerId: 'gemini', slot: 'u0' },
        });
        reply({ success: true, dataBase64: 'AQID', mimeType: 'image/png' });
    });
    failFirst = host.failReceiver;
    const result: unknown = await sendToGeminiTab({
        action: 'getImageBlob', url: 'https://lh3.googleusercontent.com/source.png',
    }, account.id);
    assert.deepEqual(result, { success: true, dataBase64: 'AQID', mimeType: 'image/png' });
    assert.deepEqual(host.calls.map(({ id, message }) => [id, message.action]), [
        [11, 'getAccountContext'], [22, 'getAccountContext'], [22, 'getImageBlob'],
    ]);
    assert.equal(host.calls[2].message.accountId, account.id);
});

test('a verified tab that fails during a resource request cannot trigger speculative cross-tab resend', async t => {
    await putAccount(account);
    let fail!: (reply: Reply) => void;
    const host = tabs(t, (id, message, reply) => {
        if (message.action === 'getAccountContext') return reply({
            ok: true, accountContext: { accountId: account.id, providerId: 'gemini', slot: 'u0' },
        });
        assert.equal(id, 11);
        fail(reply);
    });
    fail = host.failReceiver;
    await assert.rejects(sendToGeminiTab({ action: 'getImageBlob', url: 'https://example.test/image.png' },
        account.id), /Receiving end does not exist/);
    assert.deepEqual(host.calls.map(({ id, message }) => [id, message.action]), [
        [11, 'getAccountContext'], [11, 'getImageBlob'],
    ], 'a failed bound request never forwards bytes/credentials to tab 22');
});

test('a foreign active tab cannot become the resource target even when its Content responder is healthy', async t => {
    await putAccount(account);
    const foreignAccount = '10000000-0000-4000-8000-000000000002';
    const host = tabs(t, (id, message, reply) => {
        if (message.action === 'getAccountContext') return reply({
            ok: true, accountContext: { accountId: id === 11 ? foreignAccount : account.id,
                providerId: 'gemini', slot: 'u0' },
        });
        assert.equal(id, 22);
        reply({ success: true, dataBase64: 'BAUG' });
    }, [{ id: 11, active: true }, { id: 22 }]);
    const result = await sendToGeminiTab({ action: 'getImageBlob', url: 'https://example.test/p.png' }, account.id);
    assert.deepEqual(result, { success: true, dataBase64: 'BAUG' });
    assert.deepEqual(host.calls.map(({ id, message }) => [id, message.action]), [
        [11, 'getAccountContext'], [22, 'getAccountContext'], [22, 'getImageBlob'],
    ]);
});
