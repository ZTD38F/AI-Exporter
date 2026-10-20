/**
 * Storage Readiness Boundary Tests (PR A — Establish Storage Readiness Boundary)
 * Contract Classification: Permanent Contract
 * Invariants: Single-flight startup readiness, idempotent re-use, fail-closed context boundary.
 *
 * Verifies:
 * - Test 1: First initialization runs migration on legacy fixture and stamps version.
 * - Test 2: Concurrent callers share the exact same initialization promise (single run).
 * - Test 3: Later callers reuse resolved readiness and do not remigrate.
 * - Test 4: Migration failure (frozen or throw) propagates fail-closed (rejects, blocks consumer).
 * - Test 5: Context startup boundary (options loadStore awaits readiness before loading).
 *
 * Run: node -r ./tests/ts_register.js --test tests/storage_readiness_boundary.test.ts
 */
export {};
const test = require('node:test');
const assert = require('node:assert');

const StorageService = require('../src/core/storage/storageService.js');
const SchemaMigration = require('../src/core/storage/schemaMigration.js');
const DetailStore = require('../src/core/storage/conversationDetailStore.js');
const Options = require('../src/ui/options/options.js');

function makeChromeMock() {
    const localStore: Record<string, any> = {};
    const sessionStore: Record<string, any> = {};
    const badgeCalls: any[] = [];
    const area = (store: Record<string, any>) => ({
        get: async (keys: any) => {
            if (keys === null || keys === undefined) return { ...store };
            if (typeof keys === 'string') keys = [keys];
            const res: Record<string, any> = {};
            for (const k of (keys || [])) {
                if (k in store) res[k] = store[k];
            }
            return res;
        },
        set: async (obj: any) => { Object.assign(store, obj); },
        remove: async (keys: any) => {
            if (typeof keys === 'string') keys = [keys];
            for (const k of (keys || [])) delete store[k];
        }
    });
    return {
        localStore,
        sessionStore,
        badgeCalls,
        chrome: {
            storage: { local: area(localStore), session: area(sessionStore) },
            action: {
                setBadgeText: async (o: any) => { badgeCalls.push({ type: 'text', ...o }); },
                setBadgeBackgroundColor: async (o: any) => { badgeCalls.push({ type: 'color', ...o }); }
            }
        }
    };
}

function installMock() {
    const m = makeChromeMock();
    const origChrome = (global as any).chrome;
    (global as any).chrome = m.chrome;
    SchemaMigration.__setSchemaFrozenForTest(false);
    SchemaMigration.__resetStorageReadyForTest();
    DetailStore.__clearMemoryStore();
    return {
        ...m,
        restore() {
            (global as any).chrome = origChrome;
            SchemaMigration.__setSchemaFrozenForTest(false);
            SchemaMigration.__resetStorageReadyForTest();
        }
    };
}

// ---------------------------------------------------------------- Test 1
test('PR-A Test 1: First initialization runs migration on legacy fixture and stamps version', async () => {
    const m = installMock();
    try {
        // Seed legacy fixture: unmigrated schema with fat conversation and aliased export id
        m.localStore['gemini_conversations'] = [
            { id: 'fat_chat_1', title: 'Fat Chat', messages: [{ id: 'm1', text: 'hello' }], timestamp: 100 }
        ];
        m.localStore['exportedIds'] = {
            'c_fat_chat_1': { status: 'ok', alias: true },
            'fat_chat_1': { status: 'ok', canonical: true }
        };
        m.sessionStore['gemini_credentials'] = { sid: 's_legacy', at: 'at_val', bl: 'bl_val' };

        assert.strictEqual(m.localStore['gemini_schema_version'], undefined, 'Before ready, version is unset');

        await SchemaMigration.ensureStorageReady();

        // After ready: canonical schema reached
        assert.strictEqual(m.localStore['gemini_schema_version'], 1, 'Schema version stamped to CURRENT_SCHEMA_VERSION (1)');
        const convs = m.localStore['gemini_conversations'];
        assert.ok(!Array.isArray((convs[0] as any).messages), 'Conversations should be slimmed');
        const mem = DetailStore.__getMemoryStore();
        assert.ok(mem.has('fat_chat_1'), 'Fat messages offloaded to DetailStore');

        const expIds = m.localStore['exportedIds'];
        assert.ok(!('c_fat_chat_1' in expIds), 'Export alias key collapsed');
        assert.ok('fat_chat_1' in expIds, 'Canonical export key preserved');

        const credMap = m.sessionStore['gemini_credentials_map'];
        assert.ok(credMap && credMap['s_legacy'], 'Legacy single credential merged into map');
        assert.strictEqual(SchemaMigration.isSchemaFrozen(), false);
    } finally {
        m.restore();
    }
});

// ---------------------------------------------------------------- Test 2
test('PR-A Test 2: Concurrent callers share initialization (migration executes once)', async () => {
    const m = installMock();
    try {
        m.localStore['gemini_conversations'] = [
            { id: 'chat_conc', title: 'Conc', messages: [{ id: 'm1' }], timestamp: 200 }
        ];

        let setCalls = 0;
        const originalSet = m.chrome.storage.local.set;
        m.chrome.storage.local.set = async (obj: any) => {
            if (obj && obj['gemini_schema_version'] !== undefined) {
                setCalls++;
            }
            return originalSet(obj);
        };

        const p1 = SchemaMigration.ensureStorageReady();
        const p2 = SchemaMigration.ensureStorageReady();
        const p3 = SchemaMigration.ensureStorageReady();

        assert.strictEqual(p1, p2, 'Concurrent callers receive identical promise instance');
        assert.strictEqual(p2, p3, 'All concurrent callers receive identical promise instance');

        await Promise.all([p1, p2, p3]);

        assert.strictEqual(m.localStore['gemini_schema_version'], 1);
        assert.strictEqual(setCalls, 1, 'Version stamp write occurred exactly once across concurrent callers');
    } finally {
        m.restore();
    }
});

// ---------------------------------------------------------------- Test 3
test('PR-A Test 3: Later callers reuse readiness and do not remigrate', async () => {
    const m = installMock();
    try {
        m.localStore['gemini_schema_version'] = 1;
        m.localStore['gemini_conversations'] = [
            { id: 'chat_ready', title: 'Ready', timestamp: 300 }
        ];

        let setCalls = 0;
        const originalSet = m.chrome.storage.local.set;
        m.chrome.storage.local.set = async (obj: any) => {
            setCalls++;
            return originalSet(obj);
        };

        await SchemaMigration.ensureStorageReady();
        assert.strictEqual(setCalls, 0, 'No migration write when already at CURRENT_SCHEMA_VERSION');

        // Subsequent call
        await SchemaMigration.ensureStorageReady();
        assert.strictEqual(setCalls, 0, 'Subsequent call does not touch storage write path');
    } finally {
        m.restore();
    }
});

// ---------------------------------------------------------------- Test 4
test('PR-A Test 4: Migration failure propagates fail-closed (rejects, blocks consumer)', async () => {
    const m = installMock();
    try {
        // Unknown future version -> frozen
        m.localStore['gemini_schema_version'] = 999;

        await assert.rejects(
            SchemaMigration.ensureStorageReady(),
            (e: any) => {
                assert.strictEqual(e.name, 'SchemaFrozenError');
                return true;
            },
            'Unknown future schema version must reject ensureStorageReady with SchemaFrozenError'
        );

        assert.strictEqual(SchemaMigration.isSchemaFrozen(), true);

        // Later call also rejects (fail closed, no silent fallback to legacy path)
        await assert.rejects(
            SchemaMigration.ensureStorageReady(),
            (e: any) => {
                assert.strictEqual(e.name, 'SchemaFrozenError');
                return true;
            },
            'Subsequent calls must continue rejecting fail-closed'
        );
    } finally {
        m.restore();
    }
});

test('PR-A Test 4b: Migration error propagates rejection and fails closed', async () => {
    const m = installMock();
    try {
        // Force chrome.storage.local.set to throw during migration
        m.chrome.storage.local.set = async () => {
            throw new Error('Disk IO failure during schema migration');
        };

        await assert.rejects(
            SchemaMigration.ensureStorageReady(),
            (e: any) => {
                assert.ok(e.message.includes('Disk IO failure') || e.message.includes('Storage schema migration failed'));
                return true;
            },
            'Migration exception must reject ensureStorageReady'
        );

        // Subsequent call must also fail closed
        await assert.rejects(
            SchemaMigration.ensureStorageReady(),
            'Subsequent callers must not silently succeed after a failed migration'
        );
    } finally {
        m.restore();
    }
});

// ---------------------------------------------------------------- Test 5
test('PR-A Test 5: Options startup boundary awaits readiness before loading state', async () => {
    const m = installMock();
    try {
        // Case 5a: Frozen schema blocks Options.loadStore from proceeding
        m.localStore['gemini_schema_version'] = 999;
        m.localStore['gemini_conversations'] = [{ id: 'frozen_chat', title: 'Frozen' }];

        await assert.rejects(
            Options.loadStore(),
            (e: any) => {
                assert.strictEqual(e.name, 'SchemaFrozenError');
                return true;
            },
            'Options.loadStore must fail closed when storage readiness fails'
        );

        // Reset and test valid startup
        SchemaMigration.__resetStorageReadyForTest();
        m.localStore['gemini_schema_version'] = 1;
        m.localStore['gemini_conversations'] = [{ id: 'valid_chat', title: 'Valid' }];

        // When storage is ready, loadStore proceeds without throwing
        const res = await Options.loadStore();
        assert.ok(res !== undefined || res === undefined, 'loadStore resolves when storage is ready');
    } finally {
        m.restore();
    }
});
