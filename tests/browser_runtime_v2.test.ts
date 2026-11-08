import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mockAccountRegistry, mockConversationKey, assertRuntimeUnitBoundary, v2Settings, v2IndexFixtures, mockLiveSaveEffective } from './helpers/runtimeV2ContractMocks.js';

const Module = require('node:module');
const root = path.resolve(__dirname, '..');
const uuid = '12345678-1234-4234-8234-123456789abc';
const otherUuid = '87654321-4321-4321-8321-cba987654321';
const account = { id: uuid, providerId: 'gemini', providerAccountId: 'gaia' };
const detailFact = { messages: [], assets: [], quality: { status: 'unknown' as const } };
const sender = { id: 'ext', tab: { id: 7 }, frameId: 0, url: 'https://gemini.google.com/app' };
function load(file: string, stubs: Record<string, unknown>) {
    const original = Module._load;
    const ports = { 'src/application/conversations/refreshConversation.js': { refreshConversation: () => assert.fail('Unexpected source refresh') }, 'src/l2/accountRegistry.js': mockAccountRegistry([uuid, otherUuid]),
        'src/l1/client/grok/grokSource.js': { hasGrokAccess: async () => true },
        'src/l1/client/claude/claudeSource.js': { hasClaudeAccess: async () => true },
        'src/l1/client/grok/accountObservation.js': { observeGrokAccount: async () => null },
        'src/l1/client/claude/accountObservation.js': { observeClaudeAccount: async () => null },
        'src/runtime/capabilities/platformInjection.js': { syncAllPlatformContentScripts: async () => [] },
        'src/l1/client/chatgpt/chatgptAccess.js': { hasChatGPTAccess: async () => true },
        'src/runtime/capabilities/chatgptDiscovery.js': { discoverChatGPTAccounts: async () => [] },
        'src/runtime/capabilities/grokDiscovery.js': { discoverGrokAccounts: async () => [] },
        'src/runtime/capabilities/claudeDiscovery.js': { discoverClaudeAccounts: async () => [] },
        'src/l2/conversationKey.js': mockConversationKey([uuid, otherUuid]),
        // Runtime unit mocks L2 decoders; real schema/closure validation is covered by L2 and integration suites.
        'src/l2/runtimeValidation.js': { restoreDomainDetail: (value: unknown) => value },
        'src/l2/conversationIndex.js': { restoreConversationIndex: (value: unknown) => {
            if (!value || typeof value !== 'object' || Array.isArray(value) || !('key' in value)) throw new TypeError('Invalid Index');
            const key = mockConversationKey([uuid, otherUuid]).readConversationKey(value.key);
            const title = 'title' in value ? value.title : undefined;
            const titleSource = 'titleSource' in value ? value.titleSource : undefined;
            const updatedAt = 'updatedAt' in value ? value.updatedAt : undefined;
            if (title !== undefined && (typeof title !== 'string' || typeof titleSource !== 'string')) throw new TypeError('Invalid Index title');
            if (updatedAt !== undefined && (typeof updatedAt !== 'number' || !Number.isSafeInteger(updatedAt))) throw new TypeError('Invalid Index timestamp');
            const { key: _rawKey, ...fields } = value;
            return { key, ...fields };
        } }, ...stubs };
    Module._load = function(request: string, parent: { filename: string }, ...args: unknown[]) {
        const resolved = request.startsWith('.') ? path.resolve(path.dirname(parent.filename), request).replace(/\.ts$/, '.js') : request;
        const key = Object.keys(ports).find(key => resolved === path.resolve(root, key).replace(/\.ts$/, '.js'));
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
const chromeBase = () => ({ runtime: { id: 'ext' }, tabs: { sendMessage: (_id: unknown, _message: unknown, _options: unknown, callback: Function) => callback({ ok: true, accountContext: { accountId: uuid, providerId: 'gemini' } }) } });
const ready = { ensureV2Ready: async () => {} };
const storage = { getAccount: async () => account };
const security = () => load('src/runtime/background/contentSender.ts', { 'src/l3a/storageService.js': storage });
async function invoke(handler: Function, message: unknown, origin: unknown = sender) {
    let count = 0;
    let finish: (value: any) => void = () => {};
    const response = new Promise<any>(resolve => { finish = resolve; });
    assert.equal(handler(message, origin, (value: unknown) => { count++; finish(value); }), true);
    const result = await response;
    await Promise.resolve();
    assert.equal(count, 1);
    return result;
}

test('ingestion awaits L2 commit, forwards empty terminal page and never writes Storage directly', async () => {
    global.chrome = chromeBase() as any;
    const notifications: unknown[] = [];
    Reflect.set(chrome.runtime, 'sendMessage', async (message: unknown) => { notifications.push(message); });
    let commit!: () => void;
    let args: unknown[] = [];
    const gate = new Promise<void>(resolve => { commit = resolve; });
    const { handleDomainIngestionMessage: handle } = load('src/runtime/background/domainStorageHandler.ts', {
        'src/runtime/background/readiness.js': ready, 'src/runtime/background/contentSender.js': security(),
        'src/l2/ingestion.js': { ingestIndexes: async (...values: unknown[]) => { args = values; await gate; return { added: 0, updated: 0 }; } },
    });
    const page = { streamId: 'recent', requestCursor: 'last', nextCursor: null,
        requestedAt: 1700000000000, requestKnown: true, valid: true, ordered: true, keys: [] };
    let answered = false;
    const result = invoke(handle, { action: 'domainIngest', operation: 'indexes', accountId: uuid, items: [], page }).then(value => { answered = true; return value; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(answered, false);
    assert.deepEqual(notifications, [], 'uncommitted facts cannot invalidate an open view');
    assert.deepEqual(args, [uuid, [], page]);
    commit();
    assert.deepEqual(await result, { ok: true, result: { added: 0, updated: 0 } });
    assert.deepEqual(notifications, [{ action: 'domainChanged', accountId: uuid }]);
});

test('ingestion preserves Detail and Index facts; reports L2 errors', async () => {
    global.chrome = chromeBase() as any;
    let seen: unknown[] = [];
    const handle = load('src/runtime/background/domainStorageHandler.ts', {
        'src/runtime/background/readiness.js': ready, 'src/runtime/background/contentSender.js': security(),
        'src/l2/ingestion.js': { ingestDetail: async (...args: unknown[]) => { seen = args; throw new Error('commit failed'); } },
    }).handleDomainIngestionMessage;
    const detail = { ...detailFact, quality: { status: 'partial' as const } };
    const indexFields = { title: 'a', titleSource: 'provider' as const };
    assert.deepEqual(await invoke(handle, { action: 'domainIngest', operation: 'detail', accountId: uuid, conversationId: 'abc', detail, indexFields }), { ok: false, error: 'commit failed' });
    const key = { accountId: uuid, conversationId: 'abc' };
    assert.deepEqual(seen, [uuid, 'abc', { ...detail, key }, { ...indexFields, key }]);
    assert.equal(handle({ action: 'domainStorage' }, sender, () => assert.fail()), false);
});

test('Detail IPC validates Index fields before invoking L2', async () => {
    global.chrome = chromeBase() as any;
    let calls = 0;
    const handle = load('src/runtime/background/domainStorageHandler.ts', {
        'src/runtime/background/readiness.js': ready, 'src/runtime/background/contentSender.js': security(),
        'src/l2/ingestion.js': { ingestDetail: async () => { calls++; return { accepted: true, changed: true }; } },
    }).handleDomainIngestionMessage;
    const invalidIndex = await invoke(handle, { action: 'domainIngest', operation: 'detail',
        accountId: uuid, conversationId: 'abc', detail: detailFact, indexFields: { title: 'needs authority' } });
    assert.equal(invalidIndex.ok, false);
    assert.match(invalidIndex.error, /Invalid Index title|Invalid conversation index schema/);
    assert.equal(calls, 0, 'invalid Index IPC fields cannot reach L2 ingestion');
});

test('Background returns the full Detail admission result only after L2 commits', async () => {
    global.chrome = chromeBase() as any;
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const handle = load('src/runtime/background/domainStorageHandler.ts', {
        'src/runtime/background/readiness.js': ready, 'src/runtime/background/contentSender.js': security(),
        'src/l2/ingestion.js': { ingestDetail: async () => { await gate; return { accepted: true, changed: false }; } },
    }).handleDomainIngestionMessage;
    let returned = false;
    const response = invoke(handle, { action: 'domainIngest', operation: 'detail',
        accountId: uuid, conversationId: 'abc', detail: detailFact }).then((value: unknown) => { returned = true; return value; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(returned, false);
    finish();
    assert.deepEqual(await response, { ok: true, result: { accepted: true, changed: false } });
});

test('Background deletion awaits L2 commit, rejects default identity and propagates failure', async () => {
    global.chrome = chromeBase() as any;
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    let calls = 0;
    const handle = load('src/runtime/background/domainStorageHandler.ts', {
        'src/runtime/background/readiness.js': ready, 'src/runtime/background/contentSender.js': security(),
        'src/l2/ingestion.js': { ingestDeletedConversation: async (accountId: string, id: string) => {
            calls++; assert.equal(accountId, uuid); assert.equal(id, 'abcdef123456'); await gate;
        } },
    }).handleDomainIngestionMessage;
    let responded = false;
    const result = invoke(handle, { action: 'domainIngest', operation: 'deleted', accountId: uuid, conversationId: 'abcdef123456' })
        .then(value => { responded = true; return value; });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(responded, false);
    finish(); assert.deepEqual(await result, { ok: true }); assert.equal(calls, 1);
    const denied = load('src/runtime/background/domainStorageHandler.ts', {
        'src/runtime/background/readiness.js': ready,
        'src/runtime/background/contentSender.js': { assertContentSender() {}, object: (value: unknown) => value,
            requireContentContext: async () => ({ account: { ...account, providerAccountId: 'default' }, tabId: 7 }) },
        'src/l2/ingestion.js': { ingestDeletedConversation: () => assert.fail('default cannot delete') },
    }).handleDomainIngestionMessage;
    assert.equal((await invoke(denied, { action: 'domainIngest', operation: 'deleted', accountId: uuid, conversationId: 'abcdef123456' })).ok, false);
});

test('ingestion rejects foreign, unsupported, subframe and malformed requests', async () => {
    global.chrome = chromeBase() as any;
    let calls = 0;
    const handle = load('src/runtime/background/domainStorageHandler.ts', {
        'src/runtime/background/readiness.js': ready, 'src/runtime/background/contentSender.js': security(),
        'src/l2/ingestion.js': { ingestIndexes: async () => { calls++; } },
    }).handleDomainIngestionMessage;
    const message = { action: 'domainIngest', operation: 'indexes', accountId: uuid, items: [] };
    for (const origin of [{ ...sender, id: 'other' }, { ...sender, tab: undefined }, { ...sender, url: 'https://chatgpt.com/' }, { ...sender, frameId: 1 }]) {
        assert.equal((await invoke(handle, message, origin)).ok, false);
    }
    const page = { streamId: 'recent', requestCursor: null, nextCursor: null,
        requestedAt: 1, requestKnown: true, valid: true, ordered: true, keys: [] };
    for (const patch of [
        { accountId: 'u0' }, { items: {} }, { items: [{ conversationId: '', fields: {} }] },
        { items: [{ conversationId: ' a ', fields: {} }] },
        { items: [null] }, { items: [{ conversationId: 'abc', fields: null }] },
        { items: [{ conversationId: 'abc', fields: { title: 'Incomplete title' } }] },
        { items: [{ conversationId: 'abc', fields: { updatedAt: 1.5 } }] },
        { items: new Array(1) },
        { page: { ...page, requestKnown: 'true' } },
        { page: { ...page, valid: 'true' } },
        { page: { ...page, requestedAt: 'not-a-time' } },
        { page: { ...page, keys: [{ id: 'abc', time: 'not-a-time' }] } },
        { page: { ...page, keys: new Array(1) } },
        { operation: 'write' },
    ]) {
        assert.equal((await invoke(handle, { ...message, ...patch })).ok, false);
    }
    assert.equal(calls, 0);
});

test('Index IPC decodes canonical facts before sending them to L2', async () => {
    global.chrome = chromeBase() as any;
    let admitted: unknown[] | null = null;
    const handle = load('src/runtime/background/domainStorageHandler.ts', {
        'src/runtime/background/readiness.js': ready, 'src/runtime/background/contentSender.js': security(),
        'src/l2/ingestion.js': { ingestIndexes: async (...args: unknown[]) => { admitted = args; return { added: 1, updated: 0 }; } },
    }).handleDomainIngestionMessage;
    const items = [{ conversationId: 'abc', fields: { title: 'A', titleSource: 'provider', updatedAt: 10 } }];
    const page = { streamId: 'recent', requestCursor: null, nextCursor: null,
        requestedAt: 20, requestKnown: true, valid: true, ordered: true, keys: [{ id: 'abc', time: 10 }] };
    assert.deepEqual(await invoke(handle, { action: 'domainIngest', operation: 'indexes', accountId: uuid, items, page }), { ok: true, result: { added: 1, updated: 0 } });
    assert.deepEqual(admitted, [uuid, items, page]);
});

test('provider mismatch is rejected before L2 admission', async () => {
    global.chrome = chromeBase() as any;
    const guard = load('src/runtime/background/contentSender.ts', { 'src/l3a/storageService.js': { getAccount: async () => ({ ...account, providerId: 'chatgpt' }) } });
    await assert.rejects(guard.requireContentContext(sender, uuid), /mismatch/);
});

test('ChatGPT Content is isolated from Gemini, requires a current site grant and matches its document Account', async () => {
    global.chrome = chromeBase() as any;
    let granted = true;
    const gpt = { ...account, providerId: 'chatgpt', providerAccountId: '["subject","workspace"]' };
    const guard = load('src/runtime/background/contentSender.ts', {
        'src/l3a/storageService.js': { getAccount: async () => gpt },
        'src/l1/client/chatgpt/chatgptAccess.js': { hasChatGPTAccess: async () => granted },
    });
    const from = { ...sender, url: 'https://chatgpt.com/c/6acffdc5-c4d0-83e8-8e1b-ba60979a618a' };
    assert.deepEqual(await guard.requireContentContext(from, uuid), { account: gpt, tabId: 7 });
    await assert.rejects(guard.requireContentContext(sender, uuid), /mismatch/);
    granted = false;
    await assert.rejects(guard.requireContentContext(from, uuid), /revoked/);
    granted = true;
    Reflect.set(chrome.tabs, 'sendMessage', (_id: number, _request: unknown, _options: unknown, reply: Function) => reply({ ok: true, accountContext: { accountId: otherUuid, providerId: 'chatgpt' } }));
    await assert.rejects(guard.requireCurrentContentAccount(from, uuid), /sending Tab/);
});

test('Claude Content is isolated from Gemini, requires a current site grant and matches its document Account', async () => {
    global.chrome = chromeBase() as any;
    let granted = true;
    const gpt = { ...account, providerId: 'claude', providerAccountId: otherUuid };
    const guard = load('src/runtime/background/contentSender.ts', {
        'src/l3a/storageService.js': { getAccount: async () => gpt },
        'src/l1/client/grok/grokSource.js': { hasGrokAccess: async () => true },
        'src/l1/client/claude/claudeSource.js': { hasClaudeAccess: async () => granted },
    });
    const from = { ...sender, url: 'https://claude.ai/chat/6acffdc5-c4d0-83e8-8e1b-ba60979a618a' };
    assert.deepEqual(await guard.requireContentContext(from, uuid), { account: gpt, tabId: 7 });
    await assert.rejects(guard.requireContentContext(sender, uuid), /mismatch/);
    granted = false;
    await assert.rejects(guard.requireContentContext(from, uuid), /revoked/);
    granted = true;
    Reflect.set(chrome.tabs, 'sendMessage', (_id: number, _request: unknown, _options: unknown, reply: Function) => reply({ ok: true, accountContext: { accountId: otherUuid, providerId: 'claude' } }));
    await assert.rejects(guard.requireCurrentContentAccount(from, uuid), /sending Tab/);
});

test('Content ingestion sends only JSON facts and propagates worker failure', async () => {
    global.location = { protocol: 'https:' } as any;
    let sent: unknown;
    global.chrome = { runtime: { sendMessage: async (message: unknown) => { sent = message; return { ok: false, error: 'L2 rejected' }; } } } as any;
    const api = load('src/runtime/api/domainIngestion.ts', { 'src/l2/ingestion.js': {}, 'src/runtime/api/runtimeReady.js': ready });
    await assert.rejects(api.ingestIndexes(uuid, []), /L2 rejected/);
    assert.deepEqual(JSON.parse(JSON.stringify(sent)), { action: 'domainIngest', operation: 'indexes', accountId: uuid, items: [] });
});

test('Content Index ingestion accepts only valid committed metadata change counts', async () => {
    global.location = { protocol: 'https:' } as any;
    const api = load('src/runtime/api/domainIngestion.ts', { 'src/l2/ingestion.js': {}, 'src/runtime/api/runtimeReady.js': ready });
    global.chrome = { runtime: { sendMessage: async () => ({ ok: true, result: { added: 1, updated: 0 } }) } } as any;
    assert.deepEqual(await api.ingestIndexes(uuid, [{ conversationId: 'new', fields: {} }]), { added: 1, updated: 0 });
    for (const invalid of [{ added: 2, updated: 0 }, { added: -1, updated: 0 }, { added: 1.5, updated: 0 },
        { added: 0, updated: '1' }, { added: 0 }, null]) {
        global.chrome = { runtime: { sendMessage: async () => ({ ok: true, result: invalid }) } } as any;
        await assert.rejects(api.ingestIndexes(uuid, [{ conversationId: 'new', fields: {} }]), /Invalid committed Index/);
    }
});
test('Content ingestion preserves the full accepted/changed result from the worker', async () => {
    global.location = { protocol: 'https:' } as any;
    global.chrome = { runtime: { sendMessage: async () => ({ ok: true, result: { accepted: true, changed: true } }) } } as any;
    const api = load('src/runtime/api/domainIngestion.ts', { 'src/l2/ingestion.js': {},
        'src/runtime/api/runtimeReady.js': ready });
    assert.deepEqual(await api.ingestDetail(uuid, 'abc', detailFact), { accepted: true, changed: true });
    global.chrome = { runtime: { sendMessage: async () => ({ ok: true, result: { accepted: false, changed: false } }) } } as any;
    assert.deepEqual(await api.ingestDetail(uuid, 'abc', detailFact), { accepted: false, changed: false });
    global.chrome = { runtime: { sendMessage: async () => ({ ok: true, changed: true }) } } as any;
    await assert.rejects(api.ingestDetail(uuid, 'abc', detailFact), /Invalid committed/);
    global.chrome = { runtime: { sendMessage: async () => ({ ok: true, result: { accepted: false, changed: true } }) } } as any;
    await assert.rejects(api.ingestDetail(uuid, 'abc', detailFact), /Invalid committed/);
});

test('Extension ingestion calls the same L2 function after readiness', async () => {
    global.location = { protocol: 'chrome-extension:' } as any;
    const order: string[] = [];
    const api = load('src/runtime/api/domainIngestion.ts', {
        'src/l2/ingestion.js': { ingestDetail: async () => { order.push('L2'); return { accepted: true, changed: true }; } },
        'src/runtime/api/runtimeReady.js': { ensureV2Ready: async () => { order.push('ready'); } },
    });
    assert.deepEqual(await api.ingestDetail(uuid, 'abc', detailFact), { accepted: true, changed: true });
    assert.deepEqual(order, ['ready', 'L2']);
});

function live(settings: object, permission = 'granted', handleExists = true, exporter?: Function) {
    return load('src/runtime/background/liveSaveHandler.ts', {
        'src/application/settings/index.js': { getSettings: async () => ({ ...v2Settings, ...settings }), isLiveSaveEffective: mockLiveSaveEffective },
        'src/l3a/storageService.js': { getDirectoryHandle: async () => handleExists ? { queryPermission: async (options: unknown) => { assert.deepEqual(options, { mode: 'readwrite' }); return permission; }, requestPermission: () => assert.fail('Worker must not request permission') } : null },
        'src/application/export/runExport.js': { runExport: exporter || (() => assert.fail('Unexpected Export')) },
    }).runLiveSave;
}
test('disabled and non-Markdown Live Save return null without exporting', async () => {
    const key = { accountId: uuid, conversationId: 'abc' };
    assert.equal(await live({ enabledDisk: false })(key), null);
    assert.equal(await live({ enabledDisk: true, defaultFormat: 'pdf' })(key), null);
    assert.equal(await live({ enabledDisk: true, defaultFormat: 'markdown', exportDelivery: 'browserDownload' })(key), null);
});
test('missing directory or lost permission fails without requesting permission or changing Settings', async () => {
    const settings = { enabledDisk: true, defaultFormat: 'markdown' };
    const key = { accountId: uuid, conversationId: 'abc' };
    await assert.rejects(live(settings, 'granted', false)(key), /directory/);
    for (const permission of ['prompt', 'denied']) await assert.rejects(live(settings, permission)(key), /Reauthorize/);
    assert.deepEqual(settings, { enabledDisk: true, defaultFormat: 'markdown' });
});
test('Live Save returns the exact unified result and request, including skip/partial/abort', async () => {
    const key = { accountId: uuid, conversationId: 'abc' };
    const result = { exported: 0, skipped: 1, partial: 1, failed: [key], aborted: true };
    const save = live({ enabledDisk: true, defaultFormat: 'markdown', includeAssets: false }, 'granted', true, async (request: unknown) => {
        assert.deepEqual(request, { keys: [key], format: 'markdown', delivery: 'folderWriter', includeAssets: false, skipUnchanged: false });
        return result;
    });
    assert.equal(await save(key), result);
});

test('Worker Live Save scopes KeepAlive to the active export and releases it on failure', async () => {
    const trace: string[] = [];
    const save = load('src/runtime/background/liveSaveHandler.ts', {
        'src/application/settings/index.js': { getSettings: async () => ({ ...v2Settings, enabledDisk: true }), isLiveSaveEffective: mockLiveSaveEffective },
        'src/l3a/storageService.js': { getDirectoryHandle: async () => ({ queryPermission: async () => 'granted', requestPermission: () => assert.fail('Worker must not request permission') }) },
        'src/application/export/runExport.js': { runExport: async () => { trace.push('export'); throw new Error('Delivery failed'); } },
        'src/runtime/background/keepAlive.js': { startKeepAlive: () => { trace.push('start'); return () => trace.push('stop'); } },
    }).runLiveSave;
    await assert.rejects(save({ accountId: uuid, conversationId: 'abc' }), /Delivery failed/);
    assert.deepEqual(trace, ['start', 'export', 'stop']);
});

test('routing matches Provider and UUID, prefers matching active Tab, and never retries a different Tab after dispatch', async () => {
    const sent: any[] = [];
    global.chrome = { runtime: { id: 'ext' }, tabs: {
        query: async () => [{ id: 1, active: true }, { id: 2 }, { id: 3, active: true }],
        sendMessage: (id: number, message: any, callback: Function) => {
            sent.push({ id, message });
            if (message.action === 'getAccountContext') callback({ ok: true, accountContext: { accountId: id === 1 ? 'other' : uuid, providerId: 'gemini' } });
            else { Reflect.set(chrome.runtime, 'lastError', { message: 'Tab navigated' }); callback(); Reflect.deleteProperty(global.chrome.runtime, 'lastError'); }
        },
    } } as any;
    const routing = load('src/runtime/capabilities/tabService.ts', { 'src/l3a/storageService.js': storage, 'src/runtime/api/runtimeReady.js': ready });
    assert.equal((await routing.resolveAccountTab(uuid)).id, 3);
    await assert.rejects(routing.sendToGeminiTab({ action: 'getFileBlob' }, uuid), /Tab navigated/);
    assert.equal(sent.filter(value => value.message.action === 'getFileBlob').length, 1);
    assert.equal(sent.at(-1).message.accountId, uuid);
    await assert.rejects(routing.resolveAccountTab('u0'), /UUID/);
    await assert.rejects(routing.getAITab('chatgpt', uuid), /Provider\/account mismatch/);
});
test('routing rejects matching UUID from wrong Provider and uninjected Tabs', async () => {
    global.chrome = { runtime: {}, tabs: { query: async () => [{ id: 1 }], sendMessage: (_: unknown, __: unknown, cb: Function) => cb({ ok: true, accountContext: { accountId: uuid, providerId: 'chatgpt' } }) } } as any;
    const routing = load('src/runtime/capabilities/tabService.ts', { 'src/l3a/storageService.js': storage, 'src/runtime/api/runtimeReady.js': ready });
    await assert.rejects(routing.resolveAccountTab(uuid), /No open/);
    for (const accountContext of [null, 'invalid', { accountId: uuid }, { accountId: uuid, providerId: 'chatgpt' }]) {
        Reflect.set(chrome.tabs, 'sendMessage', (_id: number, _request: unknown, reply: (value: unknown) => void) =>
            reply({ ok: true, accountContext }));
        await assert.rejects(routing.resolveAccountTab(uuid), /No open/);
    }
});

test('readiness shares one pending upgrade and retries failures', async () => {
    let calls = 0;
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const runtime = load('src/runtime/background/readiness.ts', { 'src/migration/upgradeV1.js': { ensureUpgraded: () => { calls++; return gate; } } });
    const first = runtime.ensureV2Ready();
    assert.equal(first, runtime.ensureV2Ready());
    assert.equal(calls, 1); finish(); await first;
    let attempts = 0;
    const retry = load('src/runtime/background/readiness.ts', { 'src/migration/upgradeV1.js': { ensureUpgraded: async () => { if (++attempts === 1) throw new Error('upgrade failed'); } } });
    await assert.rejects(retry.ensureV2Ready(), /upgrade failed/);
    await retry.ensureV2Ready();
    assert.equal(attempts, 2);
});

function contentWindow() {
    const target = new EventTarget();
    return Object.assign(target, { __gemExporterCleanups: [] as Function[] });
}
test('Content router pairs Account and conversation in one read and rejects account changes', async () => {
    global.location = { href: 'https://gemini.google.com/app/abcdef123456' } as any;
    global.window = contentWindow() as any;
    let listener!: Function;
    global.chrome = { runtime: { id: 'ext', onMessage: { addListener: (fn: Function) => { listener = fn; }, removeListener: () => {} } } } as any;
    const context = { accountId: uuid, providerId: 'gemini', slot: 'u0' };
    const router = load('src/runtime/content/messageRouter.ts', {
        'src/runtime/content/accountContext.js': { resolveCurrentAccount: async () => context, isCurrentAccount: () => true },
        'src/runtime/capabilities/assetFetcher.js': { AssetFetcher: {} },
    });
    router.init();
    assert.deepEqual(await invoke(listener, { action: 'getAccountContext' }), { ok: true, accountContext: context, conversationId: 'abcdef123456' });
    assert.equal((await invoke(listener, { action: 'getFileBlob', accountId: 'other', url: 'https://lh3.googleusercontent.com/a' })).ok, false);
    assert.equal((await invoke(listener, { action: 'getFileBlob', accountId: uuid, url: 'https://evil.test/a' })).ok, false);
    assert.equal(listener({ action: 'deepScan' }, sender, () => assert.fail()), false);
    assert.equal((await invoke(listener, { action: 'getAccountContext' }, { id: 'foreign' })).ok, false);
    const changed = load('src/runtime/content/messageRouter.ts', {
        'src/runtime/content/accountContext.js': { resolveCurrentAccount: async () => { global.location.href = 'https://gemini.google.com/app/other'; return context; }, isCurrentAccount: () => true },
        'src/runtime/capabilities/assetFetcher.js': { AssetFetcher: {} },
    });
    changed.init();
    assert.equal((await invoke(listener, { action: 'getAccountContext' })).ok, false);
});

test('resource router checks Account after completion and answers exactly once', async () => {
    global.location = { href: 'https://gemini.google.com/app/abcdef123456' } as any;
    global.window = contentWindow() as any;
    let listener!: Function;
    global.chrome = { runtime: { id: 'ext', onMessage: { addListener: (fn: Function) => { listener = fn; }, removeListener: () => {} } } } as any;
    const context = { accountId: uuid, providerId: 'gemini', slot: 'u0' };
    let changed = false;
    load('src/runtime/content/messageRouter.ts', {
        'src/runtime/content/accountContext.js': { resolveCurrentAccount: async () => changed ? null : context, isCurrentAccount: () => !changed },
        'src/runtime/capabilities/assetFetcher.js': { AssetFetcher: { handleGetFileBlob: async (_: unknown, cb: Function) => { changed = true; cb({ success: true, base64: 'AA==' }); } } },
    }).init();
    assert.equal((await invoke(listener, { action: 'getFileBlob', accountId: uuid, url: 'https://lh3.googleusercontent.com/a' })).ok, false);
});

test('Live Save Content sends only the changed key and suppresses stale reinjection feedback', async () => {
    const context = { accountId: uuid, providerId: 'gemini', slot: 'u0' };
    let sent: unknown;
    let reply!: (value: unknown) => void;
    global.chrome = { runtime: { sendMessage: (message: unknown) => { sent = message; return new Promise(resolve => { reply = resolve; }); } } } as any;
    const coordinator = load('src/runtime/content/liveSaveCoordinator.ts', {
        'src/runtime/content/accountContext.js': { getAccountContext: () => context },
    });
    let feedback = 0;
    const badge = { showLiveSaveResult: () => { feedback++; } };
    coordinator.init({ badge });
    const pending = coordinator.executeLiveSave({ accountId: uuid, conversationId: 'abc' });
    await Promise.resolve();
    assert.deepEqual(sent, { action: 'runLiveSave', key: { accountId: uuid, conversationId: 'abc' } });
    coordinator.cleanup(); coordinator.init({ badge });
    reply({ ok: true, result: { exported: 1, skipped: 0, partial: 0, failed: [], aborted: false } });
    await pending;
    assert.equal(feedback, 0);
    const committed = { exported: 1, skipped: 0, partial: 0, failed: [], aborted: false };
    global.chrome.runtime.sendMessage = (async () => ({ ok: true, result: committed })) as any;
    assert.deepEqual(await coordinator.executeLiveSave({ accountId: uuid, conversationId: 'abc' }), committed);
    assert.equal(feedback, 1, 'the live v2 Badge callback receives committed ExportResult');
    coordinator.cleanup();
});

test('lifecycle initializes Settings after readiness and opens Options only on installation', async () => {
    let install!: Function;
    const order: unknown[] = [];
    let existingTheme: 'dark' | 'light' | undefined;
    global.chrome = { runtime: { onInstalled: { addListener: (fn: Function) => { install = fn; } },
        getManifest: () => ({ version: '2.0.0' }), getURL: (path: string) => 'chrome-extension://ext/' + path }, tabs: { create: async ({url}: {url: string}) => { assert.match(url, /options.html\?startTour=1$/); order.push('open'); } } } as any;
    const lifecycle = load('src/runtime/background/lifecycle.ts', {
        'src/runtime/background/readiness.js': { ensureV2Ready: async () => { order.push('ready'); } },
        'src/application/settings/index.js': { getSettings: async () => ({ ...v2Settings, theme: existingTheme }), updateSettings: async (patch: unknown) => { order.push(patch); } },
    });
    lifecycle.initLifecycleListeners();
    install({ reason: 'install' }); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(order, ['ready', { lastSeenFeatureVersion: '2.0.0' }, { theme: 'light' }, 'open']);
    order.length = 0;
    install({ reason: 'update', previousVersion: '1.8.1' }); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(order, ['ready', { lastSeenFeatureVersion: '1.8.1' }]);
    order.length = 0;
    install({ reason: 'update', previousVersion: 'untrusted' }); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(order, ['ready', { lastSeenFeatureVersion: '2.0.0' }]);
    assert.equal(Object.hasOwn(order[1] as object, 'tour' + 'AutoHandled'), false);
    for (const theme of ['dark', 'light'] as const) {
        existingTheme = theme;
        order.length = 0;
        install({ reason: 'install' }); await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(order, ['ready', { lastSeenFeatureVersion: '2.0.0' }, 'open']);
        order.length = 0;
        install({ reason: 'update', previousVersion: '2.0.0' }); await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(order, ['ready', { lastSeenFeatureVersion: '2.0.0' }]);
    }

});

test('Background count, Badge position and Live Save follow their public IPC contracts', async () => {
    let listener!: Function;
    let badgePatch: unknown;
    let badgeWrites = 0;
    global.chrome = { ...chromeBase(), runtime: { id: 'ext', onMessage: { addListener: (fn: Function) => { listener = fn; } } } } as any;
    load('src/runtime/background/background.ts', {
        'src/runtime/background/domainStorageHandler.js': { handleDomainIngestionMessage: () => false },
        'src/runtime/background/accountRegistryHandler.js': { handleAccountRegistryMessage: () => false },
        'src/runtime/background/lifecycle.js': { initSessionAccessLevel: () => {}, initLifecycleListeners: () => {}, initUninstallUrl: () => {} },
        'src/runtime/background/tabAction.js': { initTabActionListeners: () => {} },
        'src/runtime/background/readiness.js': ready, 'src/runtime/background/contentSender.js': security(),
        'src/l3a/storageService.js': { listIndexes: async (id: string) => { assert.equal(id, uuid); return v2IndexFixtures(id); } },
        'src/application/settings/index.js': { updateSettings: async (patch: unknown) => { badgePatch = patch; badgeWrites++; } },
        'src/runtime/background/liveSaveHandler.js': { runLiveSave: async () => null },
    });
    assert.deepEqual(await invoke(listener, { action: 'getLocalIndexCount', accountId: uuid }), { ok: true, count: 2 });
    assert.deepEqual(await invoke(listener, { action: 'updateBadgePosition', position: { left: 12, top: 34 } }), { ok: true });
    assert.deepEqual(badgePatch, { badgePosition: { left: 12, top: 34 } });
    for (const position of [{ left: Infinity, top: 0 }, { left: 10, top: NaN }, { left: '1', top: 2 }, { left: 1, top: 2, enabledDisk: true }]) {
        assert.equal((await invoke(listener, { action: 'updateBadgePosition', position })).ok, false);
    }
    assert.equal((await invoke(listener, { action: 'updateBadgePosition', position: { left: 1, top: 2 } }, { ...sender, url: 'https://evil.test/' })).ok, false);
    assert.equal(badgeWrites, 1);
    assert.deepEqual(await invoke(listener, { action: 'runLiveSave', key: { accountId: uuid, conversationId: 'abc' } }), { ok: true, result: null });
    assert.equal((await invoke(listener, { action: 'getLocalIndexCount', accountId: uuid }, { ...sender, url: 'https://evil.test/' })).ok, false);
    for (const action of ['fetchBatch', 'cancelExport', 'deepScan', 'stopDeepScan', 'abortSync', 'liveSaveViaHandle', 'domainStorage']) assert.equal(listener({ action }, sender, () => assert.fail()), false);
});

test('directory picker and reauthorization preserve click gesture; restoration only queries permission', async () => {
    const order: string[] = [];
    const handle = { queryPermission: async () => { order.push('query'); return 'prompt'; }, requestPermission: async () => { order.push('request'); return 'granted'; } };
    global.window = { showDirectoryPicker: () => { order.push('picker'); return Promise.resolve({ ...handle, queryPermission: async () => 'granted' }); } } as any;
    const directory = load('src/runtime/capabilities/dirHandleController.ts', {
        'src/runtime/api/runtimeReady.js': { ensureV2Ready: async () => { order.push('ready'); } },
        'src/l3a/storageService.js': { getDirectoryHandle: async () => handle, setDirectoryHandle: async () => { order.push('store'); } },
    });
    assert.equal(await directory.restoreSavedDirHandle(), null);
    assert.deepEqual(order, ['ready', 'query']);
    order.length = 0;
    await directory.reauthorizeDirHandle();
    assert.deepEqual(order, ['request', 'ready', 'store']);
    order.length = 0;
    await directory.requestDirHandle();
    assert.deepEqual(order, ['picker', 'ready', 'store']);
});

test('Content cleanup unregisters individual completed requests and drains listeners once on reinjection', () => {
    global.window = contentWindow() as any;
    const cleanup = load('src/runtime/content/cleanupRegistry.ts', {});
    let calls = 0;
    const unregister = cleanup.registerCleanup(() => { calls++; });
    unregister();
    cleanup.registerCleanup(() => { calls++; });
    assert.equal(global.window.__gemExporterCleanups?.length, 1);
    cleanup.runCleanups(); cleanup.runCleanups();
    assert.equal(calls, 1);
    assert.equal(global.window.__gemExporterCleanups?.length, 0);
});

test('Worker API readiness shares the background upgrade promise and never messages itself', async () => {
    delete (global as any).window;
    global.location = { protocol: 'chrome-extension:' } as any;
    global.chrome = { runtime: { sendMessage: () => assert.fail('Worker must not message itself') } } as any;
    let upgrades = 0;
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const worker = load('src/runtime/background/readiness.ts', {
        'src/migration/upgradeV1.js': { ensureUpgraded: () => { upgrades++; return pending; } },
    });
    const api = load('src/runtime/api/runtimeReady.ts', { 'src/runtime/background/readiness.js': worker });
    let done = false;
    const calls = Promise.all([worker.ensureV2Ready(), api.ensureV2Ready(), api.ensureV2Ready()]).then(() => { done = true; });
    await Promise.resolve();
    assert.equal(upgrades, 1);
    assert.equal(done, false);
    finish(); await calls;
    assert.equal(done, true);
});

test('Content readiness uses IPC and propagates Background upgrade failure', async () => {
    global.window = contentWindow() as any;
    global.location = { protocol: 'https:' } as any;
    let messages = 0;
    global.chrome = { runtime: { sendMessage: async (message: unknown) => {
        messages++; assert.deepEqual(message, { action: 'ensureV2Ready' });
        return { ok: false, error: 'upgrade failed' };
    } } } as any;
    const api = load('src/runtime/api/runtimeReady.ts', { 'src/runtime/background/readiness.js': { ensureV2Ready: () => assert.fail('Content must not execute upgrade') } });
    await assert.rejects(api.ensureV2Ready(), /upgrade failed/);
    assert.equal(messages, 1);
});

test('Content registers capture, account and message listeners while readiness is pending', async () => {
    global.window = contentWindow() as any;
    global.document = { readyState: 'complete' } as any;
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const initialized: string[] = [];
    load('src/runtime/content/content.ts', {
        'src/runtime/api/runtimeReady.js': { ensureV2Ready: () => pending },
        'src/l1/client/gemini/bootstrap.js': { initBootstrap: () => initialized.push('credentials') },
        'src/runtime/content/messageRouter.js': { MessageRouter: { init: () => initialized.push('router') } },
        'src/l1/sniffer/gemini/messageBridge.js': { MessageBridge: { init: (deps: { onIndexesCommitted?: unknown; onDetailChanged?: unknown }) => {
            assert.equal(deps.onIndexesCommitted, undefined);
            assert.equal(typeof deps.onDetailChanged, 'function'); initialized.push('bridge');
        } } },
        'src/runtime/content/pageObserver.js': { hookHistoryEvents: (callback: unknown) => { assert.equal(typeof callback, 'function'); initialized.push('routes'); } },
        'src/ui/badge/badgeView.js': { BadgeView: { ensureBadge: (...args: unknown[]) => {
            assert.deepEqual(args, []); initialized.push('badge');
        } } },
        'src/runtime/content/liveSaveCoordinator.js': { LiveSaveCoordinator: { init: () => {}, cleanup: () => {} } },
        'src/runtime/content/accountContext.js': { setAccountChangedHandler() {}, invalidateAccountContext: () => {} },
        'src/runtime/content/cleanupRegistry.js': { runCleanups: () => {}, registerCleanup: () => {} },
    });
    assert.deepEqual(initialized, ['credentials', 'router', 'routes', 'bridge']);
    finish(); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(initialized, ['credentials', 'router', 'routes', 'bridge', 'badge']);
});

test('passive L2 Index admission preserves the source Account while the visible Tab changes', async () => {
    global.chrome = chromeBase() as any;
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const accountAtRequest = uuid;
    const admitted: unknown[] = [];
    const handler = load('src/runtime/background/domainStorageHandler.ts', {
        'src/runtime/background/readiness.js': ready,
        'src/runtime/background/contentSender.js': security(),
        'src/l2/ingestion.js': { ingestIndexes: async (...args: unknown[]) => {
            admitted.push(args);
            await pending;
            return { added: 0, updated: 0 };
        } },
    }).handleDomainIngestionMessage;
    const page = { streamId: 'recent', requestCursor: null, nextCursor: null,
        requestedAt: 1700000000000, requestKnown: true, valid: true, ordered: true, keys: [] };
    let completed = false;
    const operation = invoke(handler, { action: 'domainIngest', operation: 'indexes',
        accountId: accountAtRequest, items: [], page }).then(value => { completed = true; return value; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(completed, false);
    // Passive source identity is frozen by L1; unlike active export, Runtime
    // must not re-query the sender Tab or attribute evidence to a new Account.
    global.chrome.tabs.sendMessage = (() => assert.fail('No current-tab read during passive admission')) as any;
    release();
    assert.deepEqual(await operation, { ok: true, result: { added: 0, updated: 0 } });
    assert.deepEqual(admitted, [[accountAtRequest, [], page]]);
});

test('active Content Account validation targets the sending document and rejects a different current Account', async () => {
    const guard = security();
    global.chrome = chromeBase() as any;
    let checks = 0;
    global.chrome.tabs.sendMessage = ((id: number, message: unknown, options: unknown, callback: Function) => {
        checks++; assert.equal(id, 7);
        assert.deepEqual(message, { action: 'getAccountContext' });
        assert.deepEqual(options, { frameId: 0, documentId: 'source-document' });
        callback({ ok: true, accountContext: { accountId: '87654321-4321-4321-8321-cba987654321', providerId: 'gemini' } });
    }) as any;
    // Historical passive evidence keeps request-time ownership and does not consult the current Tab.
    assert.equal((await guard.requireContentContext(sender, uuid)).account.id, uuid);
    assert.equal(checks, 0);
    await assert.rejects(guard.requireCurrentContentAccount({ ...sender, documentId: 'source-document' }, uuid), /sending Tab/);
    assert.equal(checks, 1);
    global.chrome.tabs.sendMessage = ((_id: unknown, _message: unknown, _options: unknown, callback: Function) => {
        Reflect.set(chrome.runtime, 'lastError', { message: 'Document closed' }); callback(); Reflect.deleteProperty(global.chrome.runtime, 'lastError');
    }) as any;
    await assert.rejects(guard.requireCurrentContentAccount(sender, uuid), /Document closed/);
});

test('Content sender validation retains a concrete zero Tab ID and rejects missing IDs before storage', async () => {
    global.chrome = chromeBase() as any;
    let reads = 0;
    const guard = load('src/runtime/background/contentSender.ts', {
        'src/l3a/storageService.js': { getAccount: async () => { reads++; return account; } },
    });
    Reflect.set(chrome.tabs, 'sendMessage', (id: number, _message: unknown, options: unknown, reply: (value: unknown) => void) => {
        assert.equal(id, 0);
        assert.deepEqual(options, { frameId: 0, documentId: 'zero-document' });
        reply({ ok: true, accountContext: { accountId: uuid, providerId: 'gemini' } });
    });
    const zeroSender = { ...sender, tab: { id: 0 }, documentId: 'zero-document' };
    assert.deepEqual(guard.assertContentSender(zeroSender), { tabId: 0, providerId: 'gemini' });
    assert.equal((await guard.requireCurrentContentAccount(zeroSender, uuid)).id, uuid);
    await assert.rejects(guard.requireCurrentContentAccount({ ...sender, tab: {} }, uuid), /Unsupported/);
    assert.equal(reads, 1);
});

test('both active Background ports reject a different current Account before Export or Index query', async () => {
    let listener!: Function;
    global.chrome = { ...chromeBase(), runtime: { id: 'ext', onMessage: { addListener: (fn: Function) => { listener = fn; } } } } as any;
    global.chrome.tabs.sendMessage = ((_id: unknown, _message: unknown, _options: unknown, callback: Function) => callback({ ok: true, accountContext: { accountId: 'other', providerId: 'gemini' } })) as any;
    load('src/runtime/background/background.ts', {
        'src/runtime/background/domainStorageHandler.js': { handleDomainIngestionMessage: () => false },
        'src/runtime/background/accountRegistryHandler.js': { handleAccountRegistryMessage: () => false },
        'src/runtime/background/lifecycle.js': { initSessionAccessLevel: () => {}, initLifecycleListeners: () => {}, initUninstallUrl: () => {} },
        'src/runtime/background/tabAction.js': { initTabActionListeners: () => {} },
        'src/runtime/background/readiness.js': ready, 'src/runtime/background/contentSender.js': security(),
        'src/l3a/storageService.js': { listIndexes: () => assert.fail('Must reject before reading Index') },
        'src/runtime/background/liveSaveHandler.js': { runLiveSave: () => assert.fail('Must reject before writing files') },
        // Background also imports Application Settings. Keep the v2 port mocked and
        // assert a foreign-Account request never reaches this write operation.
        'src/application/settings/index.js': {
            updateSettings: async () => assert.fail('Must reject before writing Settings'),
        } satisfies Pick<typeof import('../src/application/settings/index.js'), 'updateSettings'>,
    });
    for (const request of [{ action: 'getLocalIndexCount', accountId: uuid }, { action: 'runLiveSave', key: { accountId: uuid, conversationId: 'abc' } }]) {
        const result = await invoke(listener, request);
        assert.equal(result.ok, false); assert.match(result.error, /sending Tab/);
    }
});

test('CI scripts no longer reference Runtime modules removed by this PR', () => {
    const fs = require('node:fs');
    const files = JSON.parse(fs.readFileSync(path.join(root, 'scripts/zero-any-files.json'), 'utf8'));
    for (const deleted of ['src/runtime/background/batchFetcher.ts', 'src/runtime/background/abortManager.ts',
        'src/runtime/content/geminiIndexCapture.ts', 'src/runtime/content/domScraper.ts', 'src/runtime/content/syncEngine.ts']) {
        assert.equal(files.includes(deleted), false);
        assert.equal(fs.existsSync(path.join(root, deleted)), false);
    }
    const entries = fs.readdirSync(path.join(root, 'scripts'), { recursive: true });
    for (const entry of entries) {
        const file = path.join(root, 'scripts', entry);
        if (fs.statSync(file).isFile() && /\.(?:cjs|mjs|js|ts|json|py|sh)$/.test(entry)) {
            assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /(?:batchFetcher|abortManager|geminiIndexCapture|domScraper|syncEngine)\.(?:js|ts)/, entry);
        }
    }
});

// The Runtime test double assumes L1 emits onDetailChanged only after a
// successful, changed Detail admission. Whether a particular Provider payload
// changes Domain belongs to L1/L2 tests, not this Chrome wiring suite.
test('Content wires passive Detail and completed replies to unified Live Save', async () => {
    global.window = contentWindow() as any;
    global.document = { readyState: 'complete' } as any;
    const key = { accountId: uuid, conversationId: 'abcdef123456' };
    const triggered: unknown[] = [];
    let capture: { onDetailChanged?: (key: unknown) => void; onIndexesCommitted?: unknown;
        onStreamStart?: unknown; onStreamComplete?: (key: unknown) => void } | undefined;
    load('src/runtime/content/content.ts', {
        'src/runtime/api/runtimeReady.js': { ensureV2Ready: async () => {} },
        'src/l1/client/gemini/bootstrap.js': { initBootstrap() {} },
        'src/runtime/content/messageRouter.js': { MessageRouter: { init() {} } },
        'src/l1/sniffer/gemini/messageBridge.js': { MessageBridge: { init: (deps: typeof capture) => { capture = deps; } } },
        'src/ui/badge/badgeView.js': { BadgeView: { ensureBadge() {}, refreshAccount: async () => {} } },
        'src/runtime/content/liveSaveCoordinator.js': { LiveSaveCoordinator: {
            init() {}, cleanup() {}, executeLiveSave: async (observed: unknown, refresh = false) => { triggered.push({ key: observed, refresh }); }
        } },
        'src/runtime/content/accountContext.js': { setAccountChangedHandler() {}, invalidateAccountContext() {} },
        'src/runtime/content/pageObserver.js': { hookHistoryEvents() {} },
        'src/runtime/content/cleanupRegistry.js': { runCleanups() {}, registerCleanup() {} },
    });
    assert.equal(typeof capture?.onDetailChanged, 'function');
    assert.equal(capture?.onIndexesCommitted, undefined);
    assert.equal(capture?.onStreamStart, undefined);
    assert.equal(typeof capture?.onStreamComplete, 'function');
    assert.deepEqual(triggered, []);
    capture!.onDetailChanged!(key);
    await new Promise(resolve => setImmediate(resolve));
    capture!.onStreamComplete!(key);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(triggered, [{ key, refresh: false }, { key, refresh: true }]);
});

test('resource IPC rejects aggregate duplicate Base64 fields before sending, while preserving small responses', async () => {
    global.location = { href: 'https://gemini.google.com/app/abcdef123456' } as any;
    global.window = contentWindow() as any;
    let listener!: Function;
    global.chrome = { runtime: { id: 'ext', onMessage: { addListener: (fn: Function) => { listener = fn; }, removeListener() {} } } } as any;
    const context = { accountId: uuid, providerId: 'gemini', slot: 'u0' };
    let result: unknown = { success: true, dataUrl: 'data:image/png;base64,AA==', size: 1 };
    load('src/runtime/content/messageRouter.ts', {
        'src/runtime/content/accountContext.js': { resolveCurrentAccount: async () => context, isCurrentAccount: () => true },
        'src/runtime/capabilities/assetFetcher.js': { AssetFetcher: { handleGetImageBlob: async (_: unknown, cb: Function) => cb(result) } },
    }).init();
    const request = { action: 'getImageBlob', accountId: uuid, url: 'https://lh3.googleusercontent.com/a' };
    assert.deepEqual(await invoke(listener, request), result);
    const base64 = 'A'.repeat(21 * 1024 * 1024);
    result = { success: true, dataUrl: 'data:image/png;base64,' + base64, dataBase64: base64, blobBase64: base64, size: 16 * 1024 * 1024 };
    assert.match((await invoke(listener, request)).error, /IPC size limit/);
    result = { success: true, buffer: new ArrayBuffer(8) };
    assert.match((await invoke(listener, request)).error, /flat JSON/);
});


test('Content Live Save ignores a late result after switching away from the captured Account', async () => {
    let messages = 0;
    global.chrome = { runtime: { sendMessage: async () => { messages++; return { ok: true, result: null }; } } } as any;
    const live = load('src/runtime/content/liveSaveCoordinator.ts', {
        'src/runtime/content/accountContext.js': { getAccountContext: () => ({ providerId: 'gemini', accountId: 'another-account', slot: 'u0' }) },
    });
    live.init();
    assert.equal(await live.executeLiveSave({ accountId: uuid, conversationId: 'abc' }), null);
    assert.equal(messages, 0);
    live.cleanup();
});

test('Content Registry cannot enumerate unrelated accounts', async () => {
    global.chrome = chromeBase() as any;
    let listed = false;
    const handler = load('src/runtime/background/accountRegistryHandler.ts', {
        'src/runtime/background/readiness.js': ready,
        'src/runtime/background/contentSender.js': security(),
        'src/l3a/accountRegistryStore.js': { listAccounts: async () => { listed = true; return [account]; } },
        'src/l2/accountAdmission.js': { getOrCreateAccount: async () => account },
    }).handleAccountRegistryMessage;
    const response = await invoke(handler, { action: 'accountRegistry', command: 'list', providerId: 'gemini' });
    assert.equal(response.ok, false);
    assert.match(response.error, /Extension page/);
    assert.equal(listed, false);
    assert.deepEqual(await invoke(handler, { action: 'accountRegistry', command: 'get', accountId: uuid }), { ok: true, value: account });
});

test('Tab IPC rejects missing responses without treating ACK as success', async () => {
    global.chrome = { runtime: {},
        tabs: { sendMessage: (_id: unknown, _message: unknown, callback: Function) => callback(undefined) } } as any;
    const route = load('src/runtime/capabilities/tabService.ts', {
        'src/l3a/storageService.js': storage, 'src/runtime/api/runtimeReady.js': ready,
    });
    await assert.rejects(route.sendTabMessage(7, { action: 'getAccountContext' }, 20), /no response/);
});

test('Runtime navigation observer refreshes on SPA changes, then removes all listeners and timer on reinjection', () => {
    global.window = contentWindow() as any;
    global.location = { href: 'https://gemini.google.com/app/a' } as any;
    const historyMock = { pushState() {}, replaceState() {} };
    global.history = historyMock as any;
    let dispose!: () => void;
    let navigations = 0;
    const observer = load('src/runtime/content/pageObserver.ts', {
        'src/runtime/content/cleanupRegistry.js': { registerCleanup: (fn: () => void) => { dispose = fn; return () => {}; } },
    });
    observer.hookHistoryEvents(() => navigations++);
    global.location.href = 'https://gemini.google.com/app/b';
    global.history.pushState({}, '', '/app/b');
    assert.equal(navigations, 1);
    dispose();
    global.location.href = 'https://gemini.google.com/app/c';
    global.window.dispatchEvent(new Event('popstate'));
    assert.equal(navigations, 1);
});

test('Resource IPC fetches only L1-specified locators and enforces blob caps before base64 encoding', async () => {
    const originalFetch = global.fetch;
    const originalDocument = global.document;
    let requests = 0, domReads = 0;
    global.document = { querySelectorAll: () => { domReads++; return []; },
        documentElement: { innerHTML: 'https://lh3.googleusercontent.com/unrelated' } } as any;
    const fetcher = load('src/runtime/capabilities/assetFetcher.ts', {
        'src/runtime/content/contentContext.js': { contentContext: { isDevMode: () => false } },
    }).AssetFetcher;
    let reply: any;
    try {
        global.fetch = (async () => { requests++; return { ok: false, status: 404 }; }) as any;
        await fetcher.handleGetFileBlob({ url: 'https://lh3.googleusercontent.com/requested' }, (value: unknown) => { reply = value; });
        assert.equal(reply.success, false);
        assert.equal(requests, 1);
        assert.equal(domReads, 0);
        global.fetch = (async () => { requests++; return { ok: true, status: 200,
            headers: { get: () => 'image/png' },
            blob: async () => ({ size: 45 * 1024 * 1024, type: 'image/png' }) }; }) as any;
        await fetcher.handleGetFileBlob({ url: 'https://lh3.googleusercontent.com/oversize' }, (value: unknown) => { reply = value; });
        assert.equal(reply.success, false);
        assert.match(reply.error, /Chrome IPC/);
        await fetcher.handleGetImageBlob({ url: 'https://lh3.googleusercontent.com/oversize' }, (value: unknown) => { reply = value; });
        assert.equal(reply.success, false);
        assert.match(reply.error, /Chrome IPC cap/);
    } finally {
        global.fetch = originalFetch;
        global.document = originalDocument;
    }
});




test('completed replies request source refresh only through unified Export', async () => {
    const key = { accountId: uuid, conversationId: 'newreply' };
    let options: unknown;
    const save = live({ enabledDisk: true, defaultFormat: 'markdown' }, 'granted', true,
        async (_request: unknown, received: unknown) => { options = received; return null; });
    await save(key, true);
    assert.deepEqual(options, { refreshDetail: true });
});
test('Live Save serializes same-Key writes and coalesces trailing events without losing refresh', async () => {
    const key = { accountId: uuid, conversationId: 'queued' };
    const calls: boolean[] = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const save = live({ enabledDisk: true, defaultFormat: 'markdown' }, 'granted', true,
        async (_request: unknown, options: { refreshDetail: boolean }) => {
            calls.push(options.refreshDetail);
            if (calls.length === 1) await gate;
            return null;
        });
    const first = save(key);
    await new Promise(resolve => setImmediate(resolve));
    const second = save(key, true);
    const third = save(key);
    assert.deepEqual(calls, [false]);
    release();
    await Promise.all([first, second, third]);
    assert.deepEqual(calls, [false, true]);
    await save(key);
    assert.deepEqual(calls, [false, true, false], 'settled task is removed');
});

test('Claude discovery admits normalized organizations, not raw remote JSON records', async () => {
    const first = '11111111-1111-4111-8111-111111111111';
    const second = '22222222-2222-4222-8222-222222222222';
    let raw: unknown = [
        null, 'invalid', { uuid: 'bad', name: 'foreign', capabilities: ['chat'] },
        { uuid: first, name: '  First team  ', capabilities: ['chat'] },
        { uuid: second, name: 42, capabilities: ['files'] },
    ];
    const registered: Array<{ id: string; name: unknown }> = [];
    const { discoverClaudeAccounts } = load('src/runtime/capabilities/claudeDiscovery.ts', {
        'src/l1/sniffer/claude/observation.js': {
            claudeUuid: (value: string | null | undefined): value is string => value === first || value === second,
        } satisfies Pick<typeof import('../src/l1/sniffer/claude/observation.js'), 'claudeUuid'>,
        'src/l1/client/claude/claudeAccess.js': {
            hasClaudeAccess: async () => true,
            readClaudeSource: async (path: string) => { assert.equal(path, '/api/organizations'); return raw; },
            ensureClaudeRegistered: async () => undefined,
        },
        'src/runtime/capabilities/platformInjection.js': { syncPlatformContentScripts: async () => undefined },
        'src/runtime/api/accountRegistry.js': {
            getOrCreateAccount: async (_provider: string, id: string, _email: unknown, name: unknown) => {
                registered.push({ id, name });
                return { id, providerId: 'claude', providerAccountId: id };
            },
        },
    });
    const found = await discoverClaudeAccounts();
    assert.deepEqual(found.map((a: { id: string }) => a.id), [first]);
    assert.deepEqual(registered, [{ id: first, name: 'First team' }]);

    raw = [{ uuid: second, name: 42, capabilities: { chat: true } }];
    await discoverClaudeAccounts();
    assert.deepEqual(registered.at(-1), { id: second, name: undefined },
        'the single-org fallback must not pass unvalidated names');

    for (const malformed of ['invalid', '-'.repeat(36), '111111111-111-4111-8111-111111111111']) {
        raw = [{ uuid: malformed, name: 'wrong', capabilities: ['chat'] }];
        assert.deepEqual(await discoverClaudeAccounts(), [], 'invalid UUID must not become an Account');
        assert.equal(registered.length, 2, 'invalid UUID must never reach the Registry');
    }
});


test('Detail IPC decoder rejection prevents L2 admission and view invalidation', async () => {
    global.chrome = chromeBase() as any;
    let calls = 0;
    const notifications: unknown[] = [];
    Reflect.set(chrome.runtime, 'sendMessage', async (message: unknown) => { notifications.push(message); });
    const handle = load('src/runtime/background/domainStorageHandler.ts', {
        'src/runtime/background/readiness.js': ready, 'src/runtime/background/contentSender.js': security(),
        'src/l2/runtimeValidation.js': { restoreDomainDetail: () => { throw new TypeError('schema rejected'); } },
        'src/l2/ingestion.js': { ingestDetail: async () => { calls++; return { accepted: true, changed: true }; } },
    }).handleDomainIngestionMessage;
    assert.deepEqual(await invoke(handle, { action: 'domainIngest', operation: 'detail',
        accountId: uuid, conversationId: 'abc', detail: detailFact }), { ok: false, error: 'schema rejected' });
    assert.equal(calls, 0);
    assert.deepEqual(notifications, []);
});
