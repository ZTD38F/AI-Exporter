import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mockAccountRegistry, mockConversationKey, assertRuntimeUnitBoundary, v2IndexFixtures } from './helpers/runtimeV2ContractMocks.js';

const Module = require('node:module');
const root = path.resolve(__dirname, '..');
const A = '12345678-1234-4234-8234-123456789abc';
const B = '87654321-4321-4321-8321-cba987654321';
const account = { id: A, providerId: 'gemini', providerAccountId: 'gaia' };
const sender = { id: 'ext', tab: { id: 7 }, frameId: 0, url: 'https://gemini.google.com/app', documentId: 'doc-1' };
const key = { accountId: A, conversationId: 'abcdef123456' };

function load(file: string, stubs: Record<string, unknown> = {}) {
    const original = Module._load;
    const ports = { 'src/l2/accountRegistry.js': mockAccountRegistry([A, B]),
        'src/l1/client/grok/grokSource.js': { hasGrokAccess: async () => true },
        'src/l1/client/claude/claudeSource.js': { hasClaudeAccess: async () => true },
        'src/runtime/capabilities/platformInjection.js': { syncAllPlatformContentScripts: async () => [] },
        'src/l1/client/chatgpt/chatgptAccess.js': { hasChatGPTAccess: async () => true },
        'src/l2/conversationKey.js': mockConversationKey([A, B]), ...stubs };
    Module._load = function(request: string, parent: { filename: string }, ...args: unknown[]) {
        const resolved = request.startsWith('.') ? path.resolve(path.dirname(parent.filename), request).replace(/\.ts$/, '.js') : request;
        const key = Object.keys(ports).find(name => resolved === path.resolve(root, name).replace(/\.ts$/, '.js'));
        if (key) return ports[key as keyof typeof ports];
        if (request.startsWith('.')) assertRuntimeUnitBoundary(resolved, root);
        return original.call(this, request, parent, ...args);
    };
    try {
        const filename = path.resolve(root, file);
        delete require.cache[require.resolve(filename)];
        return require(filename);
    } finally { Module._load = original; }
}

function setup(t: { after: (fn: () => void) => void }, overrides: {
    ready?: () => Promise<void>;
    indexes?: (accountId: string) => Promise<unknown[]>;
    export?: (key: unknown) => Promise<unknown>;
    settings?: (patch: unknown) => Promise<void>;
} = {}) {
    const originalChrome = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
    const listeners: Function[] = [];
    const effects: string[] = [];
    let currentAccountId = A;
    let receivedAccount: unknown;
    const indexQueries: string[] = [];
    (globalThis as any).chrome = {
        runtime: {
            id: 'ext',
            onMessage: { addListener: (listener: Function) => { listeners.push(listener); } },
            openOptionsPage: async () => { effects.push('openOptions'); },
        },
        storage: { session: { set: async (value: { openOptionsAccountId: string | null }) => {
            effects.push('handoff:' + (value.openOptionsAccountId ?? 'none'));
        } } },
        tabs: {
            create: async ({ url }: { url: string }) => {
                assert.equal(url, 'https://gemini.google.com/app');
                effects.push('openGemini');
                return { id: 80 };
            },
            get: async (tabId: number) => ({ id: tabId, url: tabId === 80 ? 'https://gemini.google.com/app' : 'https://other.example/app' }),
            reload: async (tabId: number) => { effects.push('reload:' + tabId); },
            sendMessage: (tabId: number, message: unknown, options: unknown, callback: Function) => {
                assert.equal(tabId, 7);
                assert.deepEqual(message, { action: 'getAccountContext' });
                assert.deepEqual(options, { frameId: 0, documentId: 'doc-1' });
                callback({ ok: true, accountContext: { accountId: currentAccountId, providerId: 'gemini' } });
            },
        },
    };
    const security = load('src/runtime/background/contentSender.ts', {
        'src/l3a/storageService.js': { getAccount: async (id: string) => id === A ? account : null },
    });
    const domainCalls: unknown[] = [], registryCalls: unknown[] = [];
    const handlers = {
        'src/runtime/background/domainStorageHandler.js': {
            handleDomainIngestionMessage: (message: any, from: unknown, reply: Function) => {
                if (message?.action !== 'domainIngest') return false;
                domainCalls.push(message);
                reply({ ok: true });
                return true;
            },
        },
        'src/runtime/background/accountRegistryHandler.js': {
            handleAccountRegistryMessage: (message: any, from: unknown, reply: Function) => {
                if (message?.action !== 'accountRegistry') return false;
                registryCalls.push(message);
                reply({ ok: true, value: account });
                return true;
            },
        },
        'src/runtime/background/lifecycle.js': {
            initSessionAccessLevel: () => effects.push('initAccess'),
            initLifecycleListeners: () => effects.push('initLifecycle'),
            initUninstallUrl: () => effects.push('initUninstall'),
        },
        'src/runtime/background/tabAction.js': { initTabActionListeners: () => effects.push('initTabAction') },
        'src/runtime/background/readiness.js': { ensureV2Ready: overrides.ready || (async () => {}) },
        'src/runtime/background/contentSender.js': security,
        'src/l3a/storageService.js': { getAccount: async (id: string) => id === A ? account : null,
            listIndexes: async (id: string) => {
            indexQueries.push(id);
            return overrides.indexes ? overrides.indexes(id) : v2IndexFixtures(id);
        } },
        'src/application/settings/index.js': { updateSettings: overrides.settings || (async patch => {
            receivedAccount = patch;
        }) },
        'src/runtime/background/liveSaveHandler.js': { runLiveSave: overrides.export || (async () => null) },
    };
    load('src/runtime/background/background.ts', handlers);
    assert.equal(listeners.length, 1);
    assert.deepEqual(effects.slice(0, 4), ['initAccess', 'initLifecycle', 'initUninstall', 'initTabAction']);
    t.after(() => {
        if (originalChrome) Object.defineProperty(globalThis, 'chrome', originalChrome);
        else Reflect.deleteProperty(globalThis, 'chrome');
    });
    async function dispatch(message: unknown, origin: unknown = sender) {
        let replied = 0;
        let finish!: (value: any) => void;
        const response = new Promise<any>(resolve => { finish = resolve; });
        const handled = listeners[0](message, origin, (value: unknown) => { replied++; finish(value); });
        if (handled !== true) return { handled, count: replied, result: undefined };
        const result = await response;
        await Promise.resolve();
        assert.equal(replied, 1, 'one response for each owned action');
        return { handled, count: replied, result };
    }
    return { dispatch, listeners, effects, indexQueries, domainCalls, registryCalls,
        getPatch: () => receivedAccount, changeAccount: (id: string) => { currentAccountId = id; } };
}

test('Background does not register a second v1 Batch/Abort/Scan execution path', t => {
    const { dispatch, listeners } = setup(t);
    for (const action of ['fetchChat', 'fetchBatch', 'cancelExport', 'abortSync', 'scanProgress', 'liveSaveViaHandle', 'domainStorage', 'unknown']) {
        let replies = 0;
        assert.equal(listeners[0]({ action }, sender, () => { replies++; }), false);
        assert.equal(replies, 0);
    }
});

test('Background delegates Domain ingestion and Registry requests to exactly one owning handler', async t => {
    const { dispatch, domainCalls, registryCalls } = setup(t);
    const domain = { action: 'domainIngest', operation: 'indexes', accountId: A, items: [] };
    const registry = { action: 'accountRegistry', command: 'get', accountId: A };
    assert.deepEqual((await dispatch(domain)).result, { ok: true });
    assert.deepEqual((await dispatch(registry)).result, { ok: true, value: account });
    assert.deepEqual(domainCalls, [domain]);
    assert.deepEqual(registryCalls, [registry]);
});

test('Readiness blocks business actions until completed migration and fails explicitly', async t => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const { dispatch, indexQueries } = setup(t, { ready: () => gate });
    let replied = false;
    const pending = dispatch({ action: 'getLocalIndexCount', accountId: A }).then(value => { replied = true; return value; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(replied, false);
    assert.deepEqual(indexQueries, []);
    release();
    assert.deepEqual((await pending).result, { ok: true, count: 2 });
});

test('Background Count reads only verified current Account after readiness', async t => {
    const { dispatch, changeAccount, indexQueries } = setup(t);
    assert.deepEqual((await dispatch({ action: 'getLocalIndexCount', accountId: A })).result, { ok: true, count: 2 });
    assert.deepEqual(indexQueries, [A]);
    changeAccount(B);
    assert.match((await dispatch({ action: 'getLocalIndexCount', accountId: A })).result.error, /sending Tab/);
    assert.deepEqual(indexQueries, [A]);
});

test('Live Save sends the trusted ConversationKey to the unified Application layer only once', async t => {
    const received: unknown[] = [];
    const exportResult = { exported: 1, skipped: 0, partial: 0, failed: [], aborted: false };
    const { dispatch, changeAccount } = setup(t, { export: async value => { received.push(value); return exportResult; } });
    assert.deepEqual((await dispatch({ action: 'runLiveSave', key })).result, { ok: true, result: exportResult });
    assert.deepEqual(received, [key]);
    changeAccount(B);
    assert.match((await dispatch({ action: 'runLiveSave', key })).result.error, /sending Tab/);
    assert.deepEqual(received, [key]);
    const malformed = await dispatch({ action: 'runLiveSave', key: { accountId: 'u0', conversationId: 'abc' } });
    assert.equal(malformed.result.ok, false);
    assert.deepEqual(received, [key]);
});

test('Badge location IPC accepts only finite left/top and commits through Application Settings', async t => {
    const patch: unknown[] = [];
    const { dispatch } = setup(t, { settings: async value => { patch.push(value); } });
    const update = { action: 'updateBadgePosition', position: { left: 14, top: 28 } };
    assert.deepEqual((await dispatch(update)).result, { ok: true });
    assert.deepEqual(patch, [{ badgePosition: { left: 14, top: 28 } }]);
    for (const position of [{ left: '14', top: 28 }, { left: 1, top: Infinity }, { left: NaN, top: 2 },
        { left: 1, top: 2, enabledDisk: true }, null]) {
        assert.equal((await dispatch({ action: 'updateBadgePosition', position })).result.ok, false);
    }
    assert.equal((await dispatch(update, { ...sender, url: 'https://evil.example/' })).result.ok, false);
    assert.equal(patch.length, 1);
});

test('Explicit user navigation never starts Sync/Export or reloads unrelated pages', async t => {
    const { dispatch, effects } = setup(t);
    assert.deepEqual((await dispatch({ action: 'openOptions' })).result, { ok: true });
    assert.deepEqual((await dispatch({ action: 'openGeminiPage' })).result, { ok: true, tabId: 80 });
    assert.match((await dispatch({ action: 'reloadGeminiTab', tabId: 7 })).result.error, /Not a Gemini Tab/);
    assert.deepEqual((await dispatch({ action: 'reloadGeminiTab', tabId: 80 })).result, { ok: true });
    assert.deepEqual(effects.slice(4), ['handoff:none', 'openOptions', 'openGemini', 'reload:80']);
});

test('Options navigation hands off only a verified current source account', async t => {
    const { dispatch, changeAccount, effects } = setup(t);
    assert.deepEqual((await dispatch({ action: 'openOptions', accountId: A })).result, { ok: true });
    assert.deepEqual(effects.slice(-2), ['handoff:' + A, 'openOptions']);
    changeAccount(B);
    // A changed source opens Options normally, without selecting the stale account.
    assert.deepEqual((await dispatch({ action: 'openOptions', accountId: A })).result, { ok: true });
    assert.deepEqual(effects.slice(-2), ['handoff:none', 'openOptions']);
    const popup = { id: 'ext', url: 'chrome-extension://ext/src/ui/popup/popup.html' };
    assert.deepEqual((await dispatch({ action: 'openOptions', accountId: A }, popup)).result, { ok: true });
    assert.deepEqual(effects.slice(-2), ['handoff:' + A, 'openOptions']);
    assert.deepEqual((await dispatch({ action: 'openOptions', accountId: B }, popup)).result, { ok: true });
    assert.deepEqual(effects.slice(-2), ['handoff:none', 'openOptions']);
    assert.equal((await dispatch({ action: 'openOptions', accountId: 'not-a-uuid' }, popup)).result.ok, false);
});

test('Unexpected/foreign callers fail closed without touching data', async t => {
    const { dispatch, indexQueries } = setup(t);
    assert.equal((await dispatch({ action: 'getLocalIndexCount', accountId: A }, { ...sender, id: 'foreign' })).result.ok, false);
    assert.equal((await dispatch({ action: 'getLocalIndexCount', accountId: A }, { ...sender, tab: undefined })).result.ok, false);
    assert.deepEqual(indexQueries, []);
});
