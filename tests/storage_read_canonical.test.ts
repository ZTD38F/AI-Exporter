/**
 * Canonical Storage Read Invariant Tests (PR B — Retire Migration-on-Read)
 * Contract Classification: Permanent Contract
 * Invariants: Canonical-only querying, non-mutating reads (0 sets, 0 removes), slot isolation, migration recovery.
 *
 * Verifies:
 * - Current-schema read: Canonical state is read accurately for all slots.
 * - Non-mutating read: Normal storage reads never modify or delete storage.
 * - Legacy fixture migration: Historical data is migrated strictly via migration boundary,
 *   never via normal read path.
 * - Slot isolation: Non-u0 slot reads never bleed or fallback to u0 global keys.
 *
 * Run: node -r ./tests/ts_register.js --test tests/storage_read_canonical.test.ts
 */
export {};
const test = require('node:test');
const assert = require('node:assert');

const StorageService = require('../src/core/storage/storageService.js');
const SchemaMigration = require('../src/core/storage/schemaMigration.js');
const CredentialManager = require('../src/core/api/client/credentialManager.js').default || require('../src/core/api/client/credentialManager.js');
const DetailStore = require('../src/core/storage/conversationDetailStore.js');

function makeMockStorage() {
    const localStore: Record<string, any> = {};
    const sessionStore: Record<string, any> = {};
    let localSets = 0;
    let localRemoves = 0;
    let sessionSets = 0;
    let sessionRemoves = 0;

    const mkArea = (store: Record<string, any>, onSet: () => void, onRemove: () => void) => ({
        get: async (keys: any) => {
            if (keys === null || keys === undefined) return { ...store };
            if (typeof keys === 'string') keys = [keys];
            const out: Record<string, any> = {};
            for (const k of keys) {
                if (k in store) out[k] = store[k];
            }
            return out;
        },
        set: async (items: Record<string, any>) => {
            onSet();
            Object.assign(store, items);
        },
        remove: async (keys: any) => {
            onRemove();
            if (typeof keys === 'string') keys = [keys];
            for (const k of keys) delete store[k];
        }
    });

    const chromeMock = {
        storage: {
            local: mkArea(localStore, () => { localSets++; }, () => { localRemoves++; }),
            session: mkArea(sessionStore, () => { sessionSets++; }, () => { sessionRemoves++; })
        },
        action: {
            setBadgeText: async () => {},
            setBadgeBackgroundColor: async () => {}
        }
    };

    return {
        localStore,
        sessionStore,
        chromeMock,
        stats: () => ({ localSets, localRemoves, sessionSets, sessionRemoves }),
        resetStats: () => {
            localSets = 0;
            localRemoves = 0;
            sessionSets = 0;
            sessionRemoves = 0;
        }
    };
}

function installMock() {
    const s = makeMockStorage();
    const origChrome = (global as any).chrome;
    (global as any).chrome = s.chromeMock;
    SchemaMigration.__setSchemaFrozenForTest(false);
    SchemaMigration.__resetStorageReadyForTest();
    DetailStore.__clearMemoryStore();
    return {
        ...s,
        restore() {
            (global as any).chrome = origChrome;
            SchemaMigration.__setSchemaFrozenForTest(false);
            SchemaMigration.__resetStorageReadyForTest();
        }
    };
}

// ---------------------------------------------------------------- Current-schema read
test('PR-B: Current-schema read paths read only canonical keys', async () => {
    const env = installMock();
    try {
        env.localStore['gemini_conversations'] = [{ id: 'u0_c1', title: 'U0 Conv', timestamp: 100 }];
        env.localStore['gemini_conversations_u1'] = [{ id: 'u1_c1', title: 'U1 Conv', timestamp: 200 }];
        env.localStore['exportedIds'] = { 'u0_c1': { status: 'ok' } };
        env.localStore['gemini_exported_u1'] = { 'u1_c1': { status: 'ok' } };
        env.sessionStore['gemini_credentials_map'] = {
            'sid_main': { at: 'at_val', bl: 'bl_val', sid: 'sid_main', accountSlot: 'default' }
        };

        const u0Convs = await StorageService.getConversations('u0');
        assert.deepStrictEqual(u0Convs.map((c: any) => c.id), ['u0_c1']);

        const u1Convs = await StorageService.getConversations('u1');
        assert.deepStrictEqual(u1Convs.map((c: any) => c.id), ['u1_c1']);

        const u0Exp = await StorageService.getExportedIds('u0');
        assert.deepStrictEqual(Object.keys(u0Exp), ['u0_c1']);

        const u1Exp = await StorageService.getExportedIds('u1');
        assert.deepStrictEqual(Object.keys(u1Exp), ['u1_c1']);

        const creds = await CredentialManager.loadCredMap();
        assert.ok(creds['sid_main']);
        assert.strictEqual(creds['sid_main'].at, 'at_val');
    } finally {
        env.restore();
    }
});

// ---------------------------------------------------------------- Non-mutating read
test('PR-B: Current-schema read paths are strictly non-mutating (0 writes, 0 deletes)', async () => {
    const env = installMock();
    try {
        env.localStore['gemini_conversations'] = [{ id: 'c1', title: 'C1' }];
        env.localStore['gemini_conversations_u1'] = [{ id: 'c2', title: 'C2' }];
        env.localStore['exportedIds'] = { 'c1': { status: 'ok' } };
        env.localStore['gemini_exported_u1'] = { 'c2': { status: 'ok' } };
        env.sessionStore['gemini_credentials_map'] = { 's1': { sid: 's1' } };

        env.resetStats();

        await StorageService.getConversations('u0');
        await StorageService.getConversations('u1');
        await StorageService.getExportedIds('u0');
        await StorageService.getExportedIds('u1');
        await CredentialManager.loadCredMap();

        const stats = env.stats();
        assert.strictEqual(stats.localSets, 0, 'Normal reads must never call chrome.storage.local.set');
        assert.strictEqual(stats.localRemoves, 0, 'Normal reads must never call chrome.storage.local.remove');
        assert.strictEqual(stats.sessionSets, 0, 'Normal reads must never call chrome.storage.session.set');
        assert.strictEqual(stats.sessionRemoves, 0, 'Normal reads must never call chrome.storage.session.remove');
    } finally {
        env.restore();
    }
});

// ---------------------------------------------------------------- Slot isolation
test('PR-B: getExportedIds enforces slot isolation without fallback leakage', async () => {
    const env = installMock();
    try {
        env.localStore['exportedIds'] = { 'u0_only': { status: 'u0' } };
        env.localStore['gemini_exported_u1'] = { 'u1_only': { status: 'u1' } };

        const u1Exp = await StorageService.getExportedIds('u1');
        assert.deepStrictEqual(Object.keys(u1Exp), ['u1_only'], 'u1 must NOT read u0 records from exportedIds');

        const u0Exp = await StorageService.getExportedIds('u0');
        assert.deepStrictEqual(Object.keys(u0Exp), ['u0_only'], 'u0 must NOT read u1 records');
    } finally {
        env.restore();
    }
});

// ---------------------------------------------------------------- Legacy migration fixture
test('PR-B: Legacy storage is upgraded strictly through migration boundary, then read canonically', async () => {
    const env = installMock();
    try {
        // Seed legacy storage shapes:
        // - legacy u0 key: gemini_conversations_u0
        // - legacy export key: gemini_exported_u0
        // - legacy single cred: gemini_credentials
        env.localStore['gemini_conversations_u0'] = [
            { id: 'leg_conv', title: 'Legacy Conv', messages: [{ id: 'm1', text: 'msg' }], timestamp: 10 }
        ];
        env.localStore['gemini_exported_u0'] = {
            'c_leg_exp': { status: 'ok', alias: true }
        };
        env.sessionStore['gemini_credentials'] = { sid: 'leg_sid', at: 'token_123', bl: 'boq_123' };

        // Before migration: normal canonical reads do not see unmigrated legacy keys
        const beforeConvs = await StorageService.getConversations('u0');
        assert.deepStrictEqual(beforeConvs, [], 'Unmigrated key is not read by canonical getConversations');

        const beforeExp = await StorageService.getExportedIds('u0');
        assert.deepStrictEqual(beforeExp, {}, 'Unmigrated key is not read by canonical getExportedIds');

        const beforeCreds = await CredentialManager.loadCredMap();
        assert.deepStrictEqual(beforeCreds, {}, 'Unmigrated cred is not read by canonical loadCredMap');

        // Execute migration via readiness boundary
        await SchemaMigration.ensureStorageReady();

        // Migration must have populated canonical keys and removed legacy keys
        assert.strictEqual(env.localStore['gemini_schema_version'], 1);
        assert.strictEqual(env.localStore['gemini_conversations_u0'], undefined, 'Legacy u0 conv key removed');
        assert.strictEqual(env.localStore['gemini_exported_u0'], undefined, 'Legacy u0 export key removed');
        assert.strictEqual(env.sessionStore['gemini_credentials'], undefined, 'Legacy single cred key removed');

        // Now normal canonical reads succeed
        const afterConvs = await StorageService.getConversations('u0');
        assert.strictEqual(afterConvs.length, 1);
        assert.strictEqual(afterConvs[0].id, 'leg_conv');
        assert.ok(!Array.isArray((afterConvs[0] as any).messages), 'Conversations slimmed');

        const afterExp = await StorageService.getExportedIds('u0');
        assert.deepStrictEqual(Object.keys(afterExp), ['leg_exp'], 'Export alias normalized to canonical key');

        const afterCreds = await CredentialManager.loadCredMap();
        assert.ok(afterCreds['leg_sid']);
        assert.strictEqual(afterCreds['leg_sid'].at, 'token_123');

        // And reads remain strictly non-mutating
        env.resetStats();
        await StorageService.getConversations('u0');
        await StorageService.getExportedIds('u0');
        await CredentialManager.loadCredMap();
        assert.strictEqual(env.stats().localSets, 0);
        assert.strictEqual(env.stats().localRemoves, 0);
    } finally {
        env.restore();
    }
});
