// Cross-module integration coverage intentionally separate from Runtime unit tests.
// Runtime unit suites replace Migration/L3a/Settings with their frozen v2 ports;
// this suite verifies the full upgrade across the actual owners.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

const Module = require('node:module');
const root = path.resolve(__dirname, '..');
const uuid = '12345678-1234-4234-8234-123456789abc';
const account = { id: uuid, providerId: 'gemini', providerAccountId: 'gaia' };
const sender = { id: 'ext', tab: { id: 7 }, frameId: 0, url: 'https://gemini.google.com/app' };
function load(file: string, stubs: Record<string, unknown>) {
    const original = Module._load;
    Module._load = function(request: string, parent: { filename: string }, ...args: unknown[]) {
        const resolved = request.startsWith('.') ? path.resolve(path.dirname(parent.filename), request).replace(/\.ts$/, '.js') : request;
        const key = Object.keys(stubs).find(key => resolved === path.resolve(root, key).replace(/\.ts$/, '.js'));
        if (key) return stubs[key];
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


function contentWindow() {
    const target = new EventTarget();
    return Object.assign(target, { __gemExporterCleanups: [] as Function[] });
}

const settleHook = async () => { await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)); };

// Real Migration + Settings + Storage behind the production Runtime handlers.
// Only the Chrome/IndexedDB browser surfaces are replaced, not ensureUpgraded().
function migratedRuntime(initial: Record<string, unknown>, beforeWrite: (patch: Record<string, unknown>) => Promise<void> = async () => {}) {
    const { IDBFactory, IDBKeyRange } = require('fake-indexeddb');
    global.IDBKeyRange = IDBKeyRange;
    const pendingLocks = new Map<string, Promise<void>>();
    if (typeof globalThis.navigator === 'undefined') (globalThis as any).navigator = {};
    Object.defineProperty(globalThis.navigator, 'locks', { configurable: true, value: {
        async request<T>(name: string, callback: () => Promise<T>): Promise<T> {
            const previous = pendingLocks.get(name) ?? Promise.resolve();
            let release!: () => void;
            const next = new Promise<void>(resolve => { release = resolve; });
            pendingLocks.set(name, next); await previous;
            try { return await callback(); }
            finally { release(); if (pendingLocks.get(name) === next) pendingLocks.delete(name); }
        }
    } });
    global.indexedDB = new IDBFactory();
    delete (global as any).window;
    global.location = { protocol: 'chrome-extension:' } as any;
    const data = structuredClone(initial);
    const writes: Record<string, unknown>[] = [];
    let listener!: Function, installed!: Function;
    let opened = 0;
    global.chrome = { ...chromeBase(), tabs: { ...chromeBase().tabs, create: async () => { opened++; } }, storage: { local: {
        get: async (keys: string | string[]) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, structuredClone(data[key])])),
        set: async (patch: Record<string, unknown>) => { await beforeWrite(patch); writes.push(structuredClone(patch)); Object.assign(data, structuredClone(patch)); },
    } }, runtime: { id: 'ext', getURL: (path: string) => 'chrome-extension://ext/' + path, getManifest: () => ({ version: '2.0.0' }), openOptionsPage: async () => { opened++; },
        onInstalled: { addListener: (fn: Function) => { installed = fn; } },
        onMessage: { addListener: (fn: Function) => { listener = fn; } },
        sendMessage: async (message: unknown) => invoke(listener, message),
    } } as any;
    delete require.cache[require.resolve('../src/migration/upgradeV1.ts')];
    const readiness = load('src/runtime/background/readiness.ts', {});
    const settings = load('src/application/settings/index.ts', {});
    const lifecycle = load('src/runtime/background/lifecycle.ts', { 'src/runtime/background/readiness.js': readiness,
        'src/application/settings/index.js': settings });
    const guards = load('src/runtime/background/contentSender.ts', {});
    const registryHandler = load('src/runtime/background/accountRegistryHandler.ts', {
        'src/runtime/background/readiness.js': readiness, 'src/runtime/background/contentSender.js': guards,
    });
    load('src/runtime/background/background.ts', {
        'src/runtime/background/readiness.js': readiness, 'src/runtime/background/lifecycle.js': lifecycle,
        'src/runtime/background/contentSender.js': guards, 'src/runtime/background/accountRegistryHandler.js': registryHandler,
        'src/runtime/background/domainStorageHandler.js': { handleDomainIngestionMessage: () => false },
        'src/runtime/background/tabAction.js': { initTabActionListeners() {} },
        'src/runtime/background/liveSaveHandler.js': { runLiveSave: () => assert.fail('No export requested') },
    });
    const readyApi = load('src/runtime/api/runtimeReady.ts', { 'src/runtime/background/readiness.js': readiness });
    const accounts = load('src/runtime/api/accountRegistry.ts', { 'src/runtime/api/runtimeReady.js': readyApi });
    return { data, writes, readiness, readyApi, accounts, settings, opened: () => opened,
        install: (reason: string, previousVersion?: string) => installed({ reason, previousVersion }),
        message: (message: unknown) => invoke(listener, message),
        store: load('src/l3a/storageService.ts', {}),
    };
}
async function seedRuntimeLegacyAccount() {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('gemini_exporter_domain');
        request.onupgradeneeded = () => request.result.createObjectStore('accounts');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
    try {
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction('accounts', 'readwrite');
            tx.objectStore('accounts').put(account, uuid);
            tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
        });
    } finally { db.close(); }
}
const migrationMarker = 'gemini_exporter_v2_initialized';
const migratedSettingsKey = 'gemini_exporter_v2_settings';

test('real Migration: fresh-install lifecycle and concurrent readiness IPC wait for initialized marker', async () => {
    let commit!: () => void, reached!: () => void;
    const gate = new Promise<void>(resolve => { commit = resolve; });
    const writing = new Promise<void>(resolve => { reached = resolve; });
    const runtime = migratedRuntime({}, async patch => {
        if (patch[migrationMarker]) { reached(); await gate; }
    });
    runtime.install('install');
    let responses = 0;
    const ipc = Promise.all([runtime.message({ action: 'ensureV2Ready' }), runtime.message({ action: 'ensureV2Ready' })])
        .then(values => { responses++; return values; });
    await writing;
    assert.equal(responses, 0); assert.equal(runtime.opened(), 0);
    assert.equal(runtime.data[migratedSettingsKey], undefined);
    commit(); assert.deepEqual(await ipc, [{ ok: true }, { ok: true }]); await settleHook();
    assert.equal(runtime.data[migrationMarker], true);
    assert.deepEqual(runtime.data[migratedSettingsKey], { lastSeenFeatureVersion: '2.0.0', theme: 'light' });
    assert.equal(runtime.opened(), 1);
    assert.equal(runtime.writes.filter(patch => patch[migrationMarker]).length, 1);
    assert.deepEqual(await indexedDB.databases(), []);
});

for (const baseline of ['1.6.0', undefined]) test(`real Migration: Account/count IPC and update lifecycle await commit; feature baseline ${baseline || 'falls back to previousVersion'}`, async () => {
    let commit!: () => void, reached!: () => void;
    const gate = new Promise<void>(resolve => { commit = resolve; });
    const writing = new Promise<void>(resolve => { reached = resolve; });
    const legacyIndex = { key: { accountId: uuid, conversationId: 'legacy' }, title: 'Migrated', titleSource: 'provider', updatedAt: 100 };
    const runtime = migratedRuntime({ gemini_export_format: 'html', gemini_export_zip: false,
        ...(baseline ? { last_seen_feature_version: baseline } : {}), [`conversations_${uuid}`]: [legacyIndex] }, async patch => {
        if (patch[migrationMarker]) { reached(); await gate; }
    });
    await seedRuntimeLegacyAccount();
    runtime.install('update', '1.8.1');
    const worker = runtime.readyApi.ensureV2Ready(); // Worker takes the direct path.
    global.window = contentWindow() as any;
    global.location = { protocol: 'https:' } as any;
    let resolved = 0;
    const registry = runtime.accounts.getAccount(uuid).then((value: unknown) => { resolved++; return value; });
    const count = runtime.message({ action: 'getLocalIndexCount', accountId: uuid }).then(value => { resolved++; return value; });
    await writing; assert.equal(resolved, 0); assert.equal(runtime.opened(), 0);
    commit(); await worker;
    assert.deepEqual(await registry, account);
    assert.deepEqual(await count, { ok: true, count: 1 }); await settleHook();
    const { updatedAt: _untrustedVersion, ...retainedIndex } = legacyIndex;
    assert.deepEqual(await runtime.store.listIndexes(uuid), [retainedIndex]);
    assert.deepEqual(await runtime.settings.getSettings(), {
        defaultFormat: 'html', skipExported: true, includeAssets: false,
        enabledDisk: false, developerMode: false, exportDelivery: 'browserDownload', lastSeenFeatureVersion: baseline || '1.8.1',
    });
    assert.equal(runtime.writes.filter(patch => patch[migrationMarker]).length, 1);
    assert.deepEqual(runtime.data[`conversations_${uuid}`], [legacyIndex]);
});

test('real Migration: failed completion marker fails Runtime IPC and retries before allowing Account reads', async () => {
    let fail = true;
    const runtime = migratedRuntime({ gemini_export_zip: false }, async patch => {
        if (patch[migrationMarker] && fail) throw new Error('migration marker write failed');
    });
    await seedRuntimeLegacyAccount();
    const failed = await runtime.message({ action: 'ensureV2Ready' });
    assert.deepEqual(failed, { ok: false, error: 'migration marker write failed' });
    assert.equal(runtime.data[migrationMarker], undefined);
    global.window = contentWindow() as any;
    global.location = { protocol: 'https:' } as any;
    await assert.rejects(runtime.accounts.getAccount(uuid), /migration marker write failed/);
    fail = false;
    assert.deepEqual(await runtime.accounts.getAccount(uuid), account);
    assert.equal(runtime.data[migrationMarker], true);
    assert.equal(runtime.writes.filter(patch => patch[migrationMarker]).length, 1);
    // Once ready, neither the worker nor Content asks Migration to reopen legacy DBs.
    indexedDB.databases = () => assert.fail('Ready Runtime must not rerun Migration');
    assert.deepEqual(await runtime.message({ action: 'ensureV2Ready' }), { ok: true });
    assert.deepEqual(await runtime.accounts.getAccount(uuid), account);
});
