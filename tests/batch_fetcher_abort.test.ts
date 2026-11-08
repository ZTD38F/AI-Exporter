/**
 * V2 Runtime routing regressions replacing removed batchFetcher/abortManager.
 * The trusted execution target is an Account UUID verified by Content IPC,
 * never a caller-provided slot. Cancellation is tested on L1's AbortSignal.
 * Real Runtime TabService and L3a Account store; only Chrome tabs are mocked.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { useIndexStorage } from './helpers/indexStorage.js';
import { fixtureAccount } from './helpers/domainFixture.js';
import { putAccount } from '../src/l3a/storageService.js';
import { resolveAccountTab, sendToGeminiTab, sendTabMessage, sendToAITab } from '../src/runtime/capabilities/tabService.js';

useIndexStorage();
const selected = fixtureAccount('gemini');
const foreign = '10000000-0000-4000-8000-000000000002';

function installTabs(t: { after(fn: () => void): void }, tabs: Array<{ id: number; active?: boolean }>,
    onMessage: (tabId: number, message: Record<string, unknown>, reply: (value: unknown) => void) => void) {
    const chromeHost = globalThis.chrome;
    const previous = Object.getOwnPropertyDescriptor(globalThis.chrome, 'tabs');
    const observations: Array<{ tabId: number; message: Record<string, unknown> }> = [];
    Object.defineProperty(chromeHost, 'tabs', { configurable: true, value: {
        query: async () => tabs.map(tab => ({ ...tab, url: 'https://gemini.google.com/app' })),
        sendMessage: (tabId: number, message: Record<string, unknown>, reply: (value: unknown) => void) => {
            observations.push({ tabId, message });
            onMessage(tabId, message, reply);
        },
    } });
    t.after(() => {
        if (previous) Object.defineProperty(chromeHost, 'tabs', previous);
        else Reflect.deleteProperty(chromeHost, 'tabs');
    });
    return observations;
}

test('v2 Runtime bypasses an active foreign Gemini tab and sends to the verified Account only', async t => {
    await putAccount(selected);
    const messages = installTabs(t, [{ id: 11, active: true }, { id: 22, active: false }],
        (tabId, message, reply) => {
            if (message.action === 'getAccountContext') return reply({
                ok: true, accountContext: { providerId: 'gemini',
                    accountId: tabId === 11 ? foreign : selected.id, slot: 'u0' },
            });
            return reply({ ok: true, received: message });
        });
    const result = await sendToGeminiTab({ action: 'fetchDetail', conversationId: 'source-only' }, selected.id);
    assert.deepEqual(result, {
        ok: true, received: { action: 'fetchDetail', conversationId: 'source-only', accountId: selected.id },
    });
    assert.deepEqual(messages.map(({ tabId, message }) => [tabId, message.action]), [
        [11, 'getAccountContext'], [22, 'getAccountContext'], [22, 'fetchDetail'],
    ]);
    const resolved = await resolveAccountTab(selected.id);
    assert.equal(resolved.id, 22);
});

test('v2 Runtime fails closed when no tab has the requested Account UUID', async t => {
    await putAccount(selected);
    const calls = installTabs(t, [{ id: 30, active: true }, { id: 40, active: false }],
        (_id, message, reply) => {
            assert.equal(message.action, 'getAccountContext', 'no unverified business message is sent');
            reply({ ok: true, accountContext: { accountId: foreign, providerId: 'gemini', slot: 'u0' } });
        });
    await assert.rejects(resolveAccountTab(selected.id), /No open Provider Tab matches this Account/);
    await assert.rejects(sendToGeminiTab({ action: 'fetchDetail' }, selected.id), /No open Provider Tab matches this Account/);
    assert.ok(calls.length >= 2);
    assert.ok(calls.every(call => call.message.action === 'getAccountContext'));
});

test('v2 Runtime tab IPC timeout settles once and ignores a late browser callback', async t => {
    let delayedReply: ((value: unknown) => void) | undefined;
    installTabs(t, [{ id: 55 }], (_id, _message, reply) => { delayedReply = reply; });
    await assert.rejects(sendTabMessage(55, { action: 'getAccountContext' }, 10), /timed out/);
    assert.equal(typeof delayedReply, 'function');
    delayedReply!({ ok: true, accountContext: { accountId: selected.id } });
});

test('v2 Runtime rejects non-UUID targets and unsupported Content providers without falling back to a slot', async t => {
    await putAccount(selected);
    const observations = installTabs(t, [{ id: 1 }], () => { throw new Error('Must not be called'); });
    await assert.rejects(sendToGeminiTab({ action: 'fetchDetail' }, 'u0'), /Account UUID/);
    await assert.rejects(sendToAITab('chatgpt', { action: 'fetchDetail' }, selected.id),
        /Provider\/account mismatch/);
    assert.deepEqual(observations, []);
});
