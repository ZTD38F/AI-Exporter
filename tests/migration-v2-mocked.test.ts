import { beforeEach, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import { IDBFactory } from 'fake-indexeddb';
import type { Account } from '../src/l2/accountRegistry.js';
import type { DomainConversationIndex } from '../src/l2/conversationIndex.js';
import type { ConversationKey } from '../src/l2/conversationKey.js';
import type { ExportRecord } from '../src/application/export/types.js';
import type { GlobalSettings } from '../src/application/settings/index.js';

const A: Account = {
    id: '10000000-0000-4000-8000-000000000001',
    providerId: 'gemini', providerAccountId: 'source',
};
const recorded = {
    accounts: [] as Account[],
    indexes: [] as DomainConversationIndex[][],
    exports: [] as Array<{ key: ConversationKey; record: ExportRecord }>,
    settings: [] as Array<Partial<GlobalSettings>>,
    handles: [] as FileSystemDirectoryHandle[],
};
let local: Record<string, unknown> = {};
let failOn: string | null = null;
const previousChrome = globalThis.chrome;
const previousIndexedDB = globalThis.indexedDB;

const readAccountRegistry: typeof import('../src/l2/accountRegistry.js').readAccountRegistry =
    value => value as Account[];
const restoreConversationIndex: typeof import('../src/l2/conversationIndex.js').restoreConversationIndex =
    value => value as DomainConversationIndex;
const conversationKey: typeof import('../src/l2/conversationKey.js').conversationKey =
    (accountId, conversationId) => ({ accountId, conversationId });

const putAccount: typeof import('../src/l3a/storageService.js').putAccount =
    async account => { if (failOn === 'account') throw new Error('mock v2 account write failed'); recorded.accounts.push(account); };
const putIndexes: typeof import('../src/l3a/storageService.js').putIndexes =
    async values => { if (failOn === 'indexes') throw new Error('mock v2 index write failed'); recorded.indexes.push([...values]); };
const putExportRecord: typeof import('../src/l3a/storageService.js').putExportRecord =
    async (key, record) => { if (failOn === 'record') throw new Error('mock v2 record write failed'); recorded.exports.push({ key, record }); };
const patchStoredSettings: typeof import('../src/l3a/storageService.js').patchStoredSettings =
    async settings => { if (failOn === 'settings') throw new Error('mock v2 settings write failed'); recorded.settings.push(settings); };
const setDirectoryHandle: typeof import('../src/l3a/storageService.js').setDirectoryHandle =
    async handle => { if (failOn === 'handle') throw new Error('mock v2 handle write failed'); recorded.handles.push(handle!); };
const storage = { putAccount, putIndexes, putExportRecord, patchStoredSettings, setDirectoryHandle } satisfies Partial<typeof import('../src/l3a/storageService.js')>;

// Import real Migration once; only its imported L2/L3a public v2 ports are mocked.
type Loader = { _load(request: string, parent?: NodeModule | null, isMain?: boolean): unknown };
const loader = Module as unknown as Loader;
const originalLoad = loader._load;
loader._load = (request, parent, isMain) => {
    const caller = parent?.filename.replace(/\\/g, '/') ?? '';
    if (caller.includes('/src/migration/')) {
        if (request === './sourceVersions.js') return { repairSourceVersions: async () => {} };
        if (request === './releasedV17.js') return { upgradeReleasedV17: async () => { throw new Error('No released-1.7 fixture in this isolated UUID test'); } };
        if (request === '../l2/accountRegistry.js') return { readAccountRegistry };
        if (request === '../l2/conversationIndex.js') return { restoreConversationIndex };
        if (request === '../l2/conversationKey.js') return { conversationKey };
        if (request === '../l3a/storageService.js') return storage;
        if (request.startsWith('../')) throw new Error('Unmocked Migration external v2 port: ' + request);
    }
    return originalLoad.call(loader, request, parent, isMain);
};
let ensureUpgraded!: typeof import('../src/migration/upgradeV1.js').ensureUpgraded;
try {
    ({ ensureUpgraded } = require('../src/migration/upgradeV1.js') as typeof import('../src/migration/upgradeV1.js'));
} finally {
    loader._load = originalLoad;
}

beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
    local = {};
    failOn = null;
    recorded.accounts.length = 0;
    recorded.indexes.length = 0;
    recorded.exports.length = 0;
    recorded.settings.length = 0;
    recorded.handles.length = 0;
    globalThis.chrome = { storage: { local: {
        get: async (keys: string | string[]) =>
            Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, local[key]])),
        set: async (patch: Record<string, unknown>) => { Object.assign(local, structuredClone(patch)); },
    } } } as unknown as typeof chrome;
});
afterEach(() => {
    globalThis.chrome = previousChrome;
    globalThis.indexedDB = previousIndexedDB;
});

async function seedLegacyAccount(account: Account): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('gemini_exporter_domain');
        request.onupgradeneeded = () => { request.result.createObjectStore('accounts', { keyPath: 'id' }); };
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            const db = request.result;
            const tx = db.transaction('accounts', 'readwrite');
            tx.objectStore('accounts').put(account);
            tx.oncomplete = () => { db.close(); resolve(); };
            tx.onabort = () => { db.close(); reject(tx.error); };
        };
    });
}

test('Migration with completed marker never calls another module or rewrites the marker', async () => {
    local.gemini_exporter_v2_initialized = true;
    await ensureUpgraded();
    assert.deepEqual(recorded.accounts, []);
    assert.deepEqual(recorded.settings, []);
    assert.equal(local.gemini_exporter_v2_initialized, true);
});

test('Migration on a new install only commits the v2 initialized marker', async () => {
    await ensureUpgraded();
    assert.deepEqual(recorded.accounts, []);
    assert.deepEqual(recorded.indexes, []);
    assert.deepEqual(recorded.settings, []);
    assert.equal(local.gemini_exporter_v2_initialized, true);
});

test('Migration normalizes retained preferences, without executing real Settings or Storage', async () => {
    local.gemini_export_format = 'html';
    local.gemini_exporter_lang = 'zh';
    local.gemini_dev_mode = true;
    local.live_save_config = { enabledDisk: false };
    local.has_imported_takeout = true;
    await ensureUpgraded();
    assert.deepEqual(recorded.settings, [{
        defaultFormat: 'html', developerMode: true, language: 'zh', enabledDisk: false,
        takeoutPromptCompleted: true,
    }]);
    assert.equal(local.gemini_exporter_v2_initialized, true);
});

test('Migration maps legacy Account, Index and ExportRecord facts into frozen v2 write ports', async () => {
    await seedLegacyAccount(A);
    local['conversations_' + A.id] = [{
        key: { accountId: A.id, conversationId: 'abc' },
        title: 'Old chat', titleSource: 'provider', updatedAt: '1700000000000',
    }];
    local['exported_' + A.id] = {
        c_abc: { format: 'markdown', status: 'partial', exportedAt: 1700000000000 },
        abc: { format: 'html', status: 'ok', exportedAt: 1700000000001 },
    };
    await ensureUpgraded();
    assert.deepEqual(recorded.accounts, [A]);
    assert.equal(recorded.indexes.length, 1);
    assert.equal(recorded.indexes[0][0].updatedAt, undefined);
    assert.deepEqual(recorded.exports, [{
        key: { accountId: A.id, conversationId: 'abc' },
        record: { exportedAt: 1700000000001, format: 'html', status: 'ok' },
    }]);
    assert.equal(local.gemini_exporter_v2_initialized, true);
});

test('Migration leaves completion marker unset on failed external v2 write, permitting retry', async () => {
    local.gemini_export_format = 'pdf';
    failOn = 'settings';
    await assert.rejects(ensureUpgraded(), /mock v2 settings write failed/);
    assert.equal(local.gemini_exporter_v2_initialized, undefined);
    failOn = null;
    await ensureUpgraded();
    assert.equal(local.gemini_exporter_v2_initialized, true);
    assert.deepEqual(recorded.settings, [{ defaultFormat: 'pdf' }]);
});
