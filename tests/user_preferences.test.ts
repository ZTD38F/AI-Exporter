/**
 * Unit test suite for src/core/storage/userPreferences.ts
 */
export {};
const test = require('node:test');
const assert = require('node:assert');

const UserPreferences = require('../src/core/storage/userPreferences.js');
const StorageService = require('../src/core/storage/storageService.js');

function installStorageMock() {
    const store: Record<string, any> = {};
    const origChrome = (global as any).chrome;
    (global as any).chrome = {
        storage: {
            local: {
                get: async (keys: any) => {
                    if (keys === null || keys === undefined) return { ...store };
                    if (typeof keys === 'string') keys = [keys];
                    const res: Record<string, any> = {};
                    for (const k of (keys || [])) {
                        if (k in store) res[k] = store[k];
                    }
                    return res;
                },
                set: async (obj: any) => {
                    Object.assign(store, obj);
                },
                remove: async (keys: any) => {
                    if (typeof keys === 'string') keys = [keys];
                    for (const k of (keys || [])) delete store[k];
                }
            }
        }
    };
    return {
        store,
        restore: () => { (global as any).chrome = origChrome; }
    };
}

test('userPreferences - devMode getters and setters', async () => {
    const m = installStorageMock();
    try {
        assert.strictEqual(await UserPreferences.getDevMode(), false);
        await UserPreferences.setDevMode(true);
        assert.strictEqual(await UserPreferences.getDevMode(), true);
        assert.strictEqual(m.store['gemini_dev_mode'], true);
        // Also accessible via StorageService re-export
        assert.strictEqual(await StorageService.getDevMode(), true);
    } finally {
        m.restore();
    }
});

test('userPreferences - tour completion status', async () => {
    const m = installStorageMock();
    try {
        assert.strictEqual(await UserPreferences.isTourCompleted(), false);
        await UserPreferences.setTourCompleted(true);
        assert.strictEqual(await UserPreferences.isTourCompleted(), true);
        assert.strictEqual(await StorageService.isTourCompleted(), true);
    } finally {
        m.restore();
    }
});

test('userPreferences - feature version and isVersionGreater', async () => {
    const m = installStorageMock();
    try {
        assert.strictEqual(await UserPreferences.getLastSeenFeatureVersion(), '0.0.0');
        await UserPreferences.setLastSeenFeatureVersion('1.6.0');
        assert.strictEqual(await UserPreferences.getLastSeenFeatureVersion(), '1.6.0');

        assert.strictEqual(UserPreferences.isVersionGreater('1.6.1', '1.6.0'), true);
        assert.strictEqual(UserPreferences.isVersionGreater('1.6.0', '1.6.1'), false);
        assert.strictEqual(StorageService.isVersionGreater('2.0.0', '1.9.9'), true);
    } finally {
        m.restore();
    }
});

test('userPreferences - takeout prompt & direct write suppression', async () => {
    const m = installStorageMock();
    try {
        assert.strictEqual(await UserPreferences.isTakeoutPromptCompleted(), false);
        await UserPreferences.setTakeoutPromptCompleted(true);
        assert.strictEqual(await UserPreferences.isTakeoutPromptCompleted(), true);

        assert.strictEqual(await UserPreferences.isDirectWritePromptSuppressed(), false);
        await UserPreferences.setDirectWritePromptSuppressed(true);
        assert.strictEqual(await UserPreferences.isDirectWritePromptSuppressed(), true);
    } finally {
        m.restore();
    }
});

const { STORAGE_KEYS } = require('../src/core/utils/constants.js');

test('userPreferences - zip preference, badge pos, diagnostics, language', async () => {
    const m = installStorageMock();
    try {
        // Zip preference (defaults to true)
        assert.strictEqual(await UserPreferences.getZipPreference(), true);
        await UserPreferences.setZipPreference(false);
        assert.strictEqual(await UserPreferences.getZipPreference(), false);

        // Badge position
        assert.strictEqual(await UserPreferences.getBadgePosition(), null);
        await UserPreferences.setBadgePosition({ left: 100, top: 200 });
        assert.deepStrictEqual(m.store[STORAGE_KEYS.BADGE_POS], { left: 100, top: 200 });
        assert.deepStrictEqual(await UserPreferences.getBadgePosition(), { left: 100, top: 200 });
        assert.deepStrictEqual(await StorageService.getBadgePosition(), { left: 100, top: 200 });

        // Diagnostics
        await UserPreferences.setLastSyncDiagnostics({ errors: 0 });
        assert.deepStrictEqual(m.store[STORAGE_KEYS.LAST_SYNC_DIAGNOSTICS], { errors: 0 });

        // Pending takeout prompt
        await UserPreferences.setPendingTakeoutPrompt({ pending: true });
        assert.deepStrictEqual(m.store[STORAGE_KEYS.PENDING_TAKEOUT_PROMPT], { pending: true });

        // Language
        await UserPreferences.setLanguagePreference('zh-CN');
        assert.strictEqual(m.store[STORAGE_KEYS.LANG], 'zh-CN');
    } finally {
        m.restore();
    }
});
