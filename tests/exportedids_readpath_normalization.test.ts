export {};
const test = require('node:test');
const assert = require('node:assert');

// Regression tests for triage #5 read-path fix.
//
// Historical writers stored three alias keys per conversation
// (raw id / normId(id) / 'c_'+normId(id)) in the exportedIds maps. Writes now
// use the single canonical key, and the READ path folds any legacy alias keys
// back to canonical (StorageService.getExportedIds and
// ConversationsStore.setExportedIds), so consumers only need a single
// canonical-key probe — no triple lookup.

function installChromeMock(store: Record<string, any>) {
    const origChrome = (global as any).chrome;
    (global as any).chrome = {
        storage: {
            local: {
                get: async (keys: any) => {
                    if (keys === null) return { ...store };
                    if (typeof keys === 'string') keys = [keys];
                    const res: Record<string, any> = {};
                    for (const k of (keys || [])) if (k in store) res[k] = store[k];
                    return res;
                },
                set: async (obj: any) => { Object.assign(store, obj); },
                remove: async (keys: any) => {
                    if (typeof keys === 'string') keys = [keys];
                    for (const k of (keys || [])) delete store[k];
                }
            }
        }
    };
    return () => { (global as any).chrome = origChrome; };
}

test('read-path normalization - StorageService.getExportedIds folds legacy alias keys to canonical', async () => {
    const StorageService = require('../src/core/storage/storageService.js');
    // Simulates a map persisted by the old triple-alias writers: the same
    // conversation under raw (padded), 'c_'-prefixed, and canonical keys.
    const restore = installChromeMock({
        exportedIds: {
            '  xyz789  ': { exportedAt: '2025-01-01T00:00:00.000Z', title: 'legacy raw' },
            'c_xyz789': { exportedAt: '2025-01-01T00:00:00.000Z', title: 'legacy alias' },
            'xyz789': { exportedAt: '2025-02-01T00:00:00.000Z', title: 'canonical' }
        }
    });
    try {
        const merged = await StorageService.getExportedIds('u0');
        assert.deepStrictEqual(Object.keys(merged).sort(), ['xyz789']);
        // Single canonical probe is all a consumer needs — no triple lookup.
        assert.ok(merged['xyz789']);
        assert.strictEqual(merged['c_xyz789'], undefined);
        assert.strictEqual(merged['  xyz789  '], undefined);
    } finally {
        restore();
    }
});

test('read-path normalization - alias-only legacy storage stays readable via single canonical probe', async () => {
    const StorageService = require('../src/core/storage/storageService.js');
    const rec = { exportedAt: '2025-03-01T00:00:00.000Z', title: 'legacy only' };
    const restore = installChromeMock({ exportedIds: { 'c_abc123': rec } });
    try {
        const merged = await StorageService.getExportedIds('u0');
        assert.deepStrictEqual(Object.keys(merged), ['abc123']);
        assert.strictEqual(merged['abc123'], rec);
    } finally {
        restore();
    }
});

test('read-path normalization - ConversationsStore.setExportedIds normalizes the in-memory map', () => {
    const ConversationsStore = require('../src/ui/state/conversationsStore.js');
    const rec = { exportedAt: 5000 };
    ConversationsStore.setExportedIds({ 'c_123': rec, '  456  ': rec });
    const ids = ConversationsStore.getExportedIds();
    assert.deepStrictEqual(Object.keys(ids).sort(), ['123', '456']);

    // getExportedRecord resolves every id form through the single canonical
    // probe — no triple lookup needed.
    assert.strictEqual(ConversationsStore.getExportedRecord('123'), rec);
    assert.strictEqual(ConversationsStore.getExportedRecord('c_123'), rec);
    assert.strictEqual(ConversationsStore.getExportedRecord('  123  '), rec);
    assert.strictEqual(ConversationsStore.getExportedRecord('456'), rec);
    assert.strictEqual(ConversationsStore.getExportedRecord('nope'), null);

    // Reset the singleton so later tests start clean.
    ConversationsStore.setExportedIds({});
});

test('read-path normalization - normalized map needs no alias keys for listView-style lookup', () => {
    const ConversationsStore = require('../src/ui/state/conversationsStore.js');
    const rec = { exportedAt: 6000 };
    ConversationsStore.setExportedIds({ 'c_789': rec });
    try {
        // This mirrors the production listView/exportOrchestrator read pattern.
        const expMap = ConversationsStore.getExportedIds();
        const nid = ConversationsStore.normId('c_789');
        assert.strictEqual(expMap[nid] || null, rec);
    } finally {
        ConversationsStore.setExportedIds({});
    }
});
