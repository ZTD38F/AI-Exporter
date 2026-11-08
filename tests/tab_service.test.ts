import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mockAccountRegistry, assertRuntimeUnitBoundary } from './helpers/runtimeV2ContractMocks.js';

const Module = require('node:module');
const root = path.resolve(__dirname, '..');
const A = '12345678-1234-4234-8234-123456789abc';
const B = '87654321-4321-4321-8321-cba987654321';
const accounts: Record<string, unknown> = {
    [A]: { id: A, providerId: 'gemini', providerAccountId: 'gaia-a' },
    [B]: { id: B, providerId: 'gemini', providerAccountId: 'gaia-b' },
};
function load(stubs: Record<string, unknown> = {}) {
    const original = Module._load;
    const ports = { 'src/l2/accountRegistry.js': mockAccountRegistry([A, B]), ...stubs };
    Module._load = function(request: string, parent: { filename: string }, ...args: unknown[]) {
        const resolved = request.startsWith('.') ? path.resolve(path.dirname(parent.filename), request).replace(/\.ts$/, '.js') : request;
        const key = Object.keys(ports).find(name => resolved === path.resolve(root, name).replace(/\.ts$/, '.js'));
        if (key) return ports[key as keyof typeof ports];
        if (request.startsWith('.')) assertRuntimeUnitBoundary(resolved, root);
        return original.call(this, request, parent, ...args);
    };
    try {
        const file = path.resolve(root, 'src/runtime/capabilities/tabService.ts');
        delete require.cache[require.resolve(file)];
        return require(file);
    } finally { Module._load = original; }
}
function router(stubs: Record<string, unknown> = {}) {
    return load({
        'src/l3a/storageService.js': { getAccount: async (id: string) => accounts[id] ?? null },
        'src/runtime/capabilities/chatgptDiscovery.js': { discoverChatGPTAccounts: async () => [] },
        'src/runtime/capabilities/grokDiscovery.js': { discoverGrokAccounts: async () => [] },
        'src/runtime/capabilities/claudeDiscovery.js': { discoverClaudeAccounts: async () => [] },
        'src/runtime/api/runtimeReady.js': { ensureV2Ready: async () => {} },
        'src/runtime/capabilities/platformInjection.js': { preparePlatformTab: async () => {} },
        ...stubs,
    });
}
function withChrome(t: { after: (fn: () => void) => void }, value: unknown) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
    (globalThis as any).chrome = value;
    t.after(() => {
        if (descriptor) Object.defineProperty(globalThis, 'chrome', descriptor);
        else Reflect.deleteProperty(globalThis, 'chrome');
    });
}

test('Tab routing requires a registered real Account UUID, not a Gemini URL slot', async t => {
    withChrome(t, { runtime: {}, tabs: { query: async () => [{ id: 1 }] } });
    const route = router();
    await assert.rejects(route.resolveAccountTab(''), /UUID/);
    await assert.rejects(route.resolveAccountTab('u0'), /UUID/);
    await assert.rejects(route.resolveAccountTab('https://gemini.google.com/u/0/app'), /UUID/);
    await assert.rejects(route.resolveAccountTab(B.replace(/.$/, 'x')), /UUID|supported|matches/);
    await assert.rejects(route.getAITab('chatgpt', A), /Provider\/account mismatch/);
});

test('Verified Provider + Account match wins over first tab or URL slot; active match is preferred', async t => {
    const probes: number[] = [];
    withChrome(t, { runtime: { lastError: null }, tabs: {
        query: async () => [
            { id: 1, active: false, url: 'https://gemini.google.com/u/0/app' },
            { id: 2, active: false, url: 'https://gemini.google.com/u/1/app' },
            { id: 3, active: true, url: 'https://gemini.google.com/u/0/app' }
        ],
        sendMessage: (id: number, message: any, callback: Function) => {
            assert.equal(message.action, 'getAccountContext');
            probes.push(id);
            callback({ ok: true, accountContext: { accountId: id === 1 ? B : A,
                providerId: id === 2 ? 'chatgpt' : 'gemini' } });
        }
    } });
    const route = router();
    assert.equal((await route.resolveAccountTab(A)).id, 3);
    assert.deepEqual(probes, [3]); // matching active tab, no first-tab fallback
    assert.equal((await route.getAITab('gemini', A))?.id, 3);
});

test('Routing skips ID-less tabs and retains the valid zero ID through execution', async t => {
    const sent: Array<{ id: number; action: string }> = [];
    withChrome(t, { runtime: { lastError: null }, tabs: {
        query: async () => [{ active: true }, { id: 0, active: false }],
        sendMessage: (id: number, message: { action: string }, callback: (value: unknown) => void) => {
            sent.push({ id, action: message.action });
            callback({ ok: true, accountContext: { accountId: A, providerId: 'gemini' } });
        },
    } });
    await router().sendToGeminiTab({ action: 'export' }, A);
    assert.deepEqual(sent, [{ id: 0, action: 'getAccountContext' }, { id: 0, action: 'export' }]);
});

test('Ambiguous Scan target fails without guessing; explicit preference and a unique live UUID work', async t => {
    let accepted: Record<number, string | null> = { 1: A, 2: B, 3: A };
    withChrome(t, { runtime: { lastError: null }, tabs: {
        query: async () => [{ id: 1 }, { id: 2 }, { id: 3 }],
        sendMessage: (id: number, _: unknown, callback: Function) =>
            callback({ ok: true, accountContext: accepted[id] ? { accountId: accepted[id], providerId: 'gemini' } : null }),
    } });
    const route = router();
    await assert.rejects(route.resolveScanTarget(), /Multiple provider accounts/);
    assert.equal(await route.resolveScanTarget(A), A);
    assert.equal(await route.resolveScanTarget(B), B);
    accepted = { 1: A, 2: null, 3: A };
    assert.equal(await route.resolveScanTarget(), A);
    accepted = { 1: null, 2: null, 3: null };
    await assert.rejects(route.resolveScanTarget(), /Open Gemini/);
});

test('An open Gemini document predating installation is prepared before retrying identity discovery', async t => {
    let prepared = false;
    let probes = 0;
    withChrome(t, { runtime: { lastError: null }, tabs: {
        query: async () => [{ id: 7 }],
        sendMessage: (_id: number, message: { action: string }, callback: (value: unknown) => void) => {
            assert.equal(message.action, 'getAccountContext');
            probes++;
            callback(prepared ? { ok: true, accountContext: { accountId: A, providerId: 'gemini' } } : undefined);
        },
    } });
    const route = router({ 'src/runtime/capabilities/platformInjection.js': {
        preparePlatformTab: async (platform: string, tabId: number) => {
            assert.equal(platform, 'gemini'); assert.equal(tabId, 7); prepared = true;
        },
    } });
    assert.equal(await route.resolveScanTarget(A), A);
    assert.equal(prepared, true);
    assert.equal(probes, 2);
});

test('Unknown/default source identity is not a Scan target even if Content replies ok', async t => {
    accounts[B] = { id: B, providerId: 'gemini', providerAccountId: 'default' };
    try {
        withChrome(t, { runtime: { lastError: null }, tabs: {
            query: async () => [{ id: 5 }],
            sendMessage: (_: number, __: unknown, cb: Function) => cb({ ok: true, accountContext: { accountId: B, providerId: 'gemini' } })
        } });
        await assert.rejects(router().resolveScanTarget(B), /Open Gemini/);
    } finally { accounts[B] = { id: B, providerId: 'gemini', providerAccountId: 'gaia-b' }; }
});

test('ChatGPT discovery resolves the selected provider and never falls back to Gemini after logout', async t => {
    const gpt = { id: B, providerId: 'chatgpt', providerAccountId: '["user","workspace"]' };
    const previous = accounts[B]; accounts[B] = gpt;
    t.after(() => { accounts[B] = previous; });
    let available = true;
    let discoveryCalls = 0;
    withChrome(t, { runtime: { lastError: null }, tabs: {
        query: async () => [{ id: 1 }],
        sendMessage: (_: number, __: unknown, cb: Function) => cb({ ok: true, accountContext: { accountId: A, providerId: 'gemini' } }),
    } });
    const route = router({ 'src/runtime/capabilities/chatgptDiscovery.js': {
        discoverChatGPTAccounts: async () => { discoveryCalls++; return available ? [gpt] : []; },
    } });
    assert.equal(await route.resolveScanTarget(A), A);
    assert.equal(discoveryCalls, 0, 'Gemini preference does not contact ChatGPT');
    await assert.rejects(route.resolveScanTarget(), /Multiple provider accounts/);
    assert.equal(await route.resolveScanTarget(B), B);
    available = false;
    await assert.rejects(route.resolveScanTarget(B), { name: 'ScanConnectionError', platform: 'chatgpt',
        message: 'Open ChatGPT, log in and connect the selected account before scanning.' });
});

test('Content operation fixes target Account once and never fails over after send failure', async t => {
    const sends: Array<{ id: number; action: string; accountId?: string }> = [];
    withChrome(t, { runtime: { lastError: null }, tabs: {
        query: async () => [{ id: 9, active: true }, { id: 10 }],
        sendMessage: (id: number, message: any, cb: Function) => {
            sends.push({ id, action: message.action, accountId: message.accountId });
            if (message.action === 'getAccountContext') cb({ ok: true, accountContext: { accountId: A, providerId: 'gemini' } });
            else {
                (globalThis as any).chrome.runtime.lastError = { message: 'Tab navigated' };
                cb(undefined);
                (globalThis as any).chrome.runtime.lastError = null;
            }
        },
    } });
    await assert.rejects(router().sendToGeminiTab({ action: 'getImageBlob', url: 'https://lh3.googleusercontent.com/x' }, A), /Tab navigated/);
    assert.deepEqual(sends.filter(value => value.action === 'getImageBlob'), [{ id: 9, action: 'getImageBlob', accountId: A }]);
    await assert.rejects(router().sendToGeminiTab({ action: 'getImageBlob' }), /UUID/);
    await assert.rejects(router().sendToAITab('chatgpt', { action: 'ping' }, A), /Provider\/account mismatch/);
});

test('Uninjected/closed tab errors are never successful delivery acknowledgements', async t => {
    withChrome(t, { runtime: { lastError: null }, tabs: {
        query: async () => [{ id: 12 }],
        sendMessage: (_id: number, _msg: unknown, callback: Function) => callback(undefined),
    } });
    const route = router();
    await assert.rejects(route.sendTabMessage(12, { action: 'ping' }, 15), /no response/);
    await assert.rejects(route.resolveAccountTab(A), /No open Provider Tab/);
});

test('An unavailable selected Gemini account cannot fall back to another Gemini or Grok account', async t => {
    const grok = { id: B, providerId: 'grok', providerAccountId: 'grok-user' };
    let otherGemini = false;
    let discoveries = 0;
    withChrome(t, { runtime: { lastError: null }, tabs: {
        query: async () => [{ id: 1 }],
        sendMessage: (_: number, __: unknown, callback: (reply: unknown) => void) => callback({
            ok: true, accountContext: otherGemini ? { accountId: B, providerId: 'gemini' } : null,
        }),
    } });
    const route = router({ 'src/runtime/capabilities/grokDiscovery.js': {
        discoverGrokAccounts: async () => { discoveries++; return [grok]; },
    } });
    await assert.rejects(route.resolveScanTarget(A), /Open Gemini/);
    assert.equal(discoveries, 0, 'a selected Gemini scan must not discover or switch to another platform');
    otherGemini = true;
    await assert.rejects(route.resolveScanTarget(A), /Open Gemini/);
    assert.equal(discoveries, 0);
});

test('Unselected scan discovers independent providers concurrently', async t => {
    withChrome(t, { runtime: { lastError: null }, tabs: { query: async () => [] } });
    const started: string[] = [];
    const discover = (platform: string) => async () => {
        started.push(platform);
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.deepEqual(started, ['chatgpt', 'claude', 'grok'], 'provider probes should already be in flight');
        return [];
    };
    const route = router({
        'src/runtime/capabilities/chatgptDiscovery.js': { discoverChatGPTAccounts: discover('chatgpt') },
        'src/runtime/capabilities/claudeDiscovery.js': { discoverClaudeAccounts: discover('claude') },
        'src/runtime/capabilities/grokDiscovery.js': { discoverGrokAccounts: discover('grok') },
    });
    await assert.rejects(route.resolveScanTarget(), /Open Gemini/);
});

test('Selected ChatGPT scan does not probe unrelated platforms', async t => {
    const chatgpt = { id: B, providerId: 'chatgpt', providerAccountId: '["user","workspace"]' };
    const previous = accounts[B];
    accounts[B] = chatgpt;
    t.after(() => { accounts[B] = previous; });
    withChrome(t, { runtime: { lastError: null }, tabs: { query: async () => [] } });
    const calls: string[] = [];
    const route = router({
        'src/runtime/capabilities/chatgptDiscovery.js': {
            discoverChatGPTAccounts: async () => { calls.push('chatgpt'); return [chatgpt]; },
        },
        'src/runtime/capabilities/claudeDiscovery.js': {
            discoverClaudeAccounts: async () => { calls.push('claude'); throw new Error('Unrelated Claude probe'); },
        },
        'src/runtime/capabilities/grokDiscovery.js': {
            discoverGrokAccounts: async () => { calls.push('grok'); throw new Error('Unrelated Grok probe'); },
        },
    });
    assert.equal(await route.resolveScanTarget(B), B);
    assert.deepEqual(calls, ['chatgpt']);
});
