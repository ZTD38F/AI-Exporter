export {};
// Regression tests: takeoutController's whole-table write must go through
// StorageService.transactConversations (atomic read-merge-write, #402) instead
// of the legacy Store.getConversations() -> Store.saveConversations() snapshot
// pattern, which loses a concurrent tab's updates (classic lost update).
//
// Scenario: this tab reads a (possibly stale) snapshot [A], the takeout zip
// contributes [B], and another tab's write of [C] lands between our read and
// our write. Correct behavior: final table contains A, B and C.
const test = require('node:test');
const assert = require('node:assert');

const TakeoutController = require('../src/ui/controllers/takeoutController.js');

const mkConv = (id: string, ts: number) => ({
    id,
    title: `Title ${id}`,
    titleSource: 'takeout',
    titles: { takeout: `Title ${id}` },
    messageCount: 1,
    updatedAt: ts,
    timestamp: ts,
});

// `cell.list` is the single shared "chrome.storage" truth; every mock reads
// and writes through it so interleavings are visible to all parties.
function installMocks(opts: {
    stale: any[];
    cell: { list: any[] };
    incoming: any[];
    interleave: (() => void) | null;
}) {
    const { cell } = opts;
    let memCache: any[] | null = null;
    let legacySaves = 0;
    let transactCalls = 0;

    const { __setModuleOverride, __getModuleOverride } = require('../src/core/utils/moduleOverrides.js');
    const origStore = __getModuleOverride('ConversationsStore');
    const origEngine = __getModuleOverride('TakeoutEngine');
    const origStorage = __getModuleOverride('StorageService');

    __setModuleOverride('ConversationsStore', {
        // Deliberately stale: captured before the other tab's write.
        getConversations: () => opts.stale,
        getCurrentSlot: () => 'u0',
        setConversations: (list: any[]) => { memCache = list; },
        saveConversations: async (_slot: string, list: any[]) => {
            // Legacy blind-write path: the other tab's write lands first,
            // then gets clobbered by the stale-snapshot write.
            if (opts.interleave) opts.interleave();
            cell.list = list;
            legacySaves++;
        },
    });
    __setModuleOverride('TakeoutEngine', {
        parseTakeoutZip: async () => ({ conversations: opts.incoming, totalMediaCount: 0 }),
    });
    __setModuleOverride('StorageService', {
        transactConversations: async (_slot: string, updater: (e: any[]) => any) => {
            transactCalls++;
            // The updater runs inside the lock and re-reads fresh storage:
            // the interleaved write is visible to it.
            if (opts.interleave) opts.interleave();
            const fresh = cell.list.map((c: any) => ({ ...c }));
            const res = updater(fresh);
            if (!res || !Array.isArray(res.list)) {
                return { list: fresh, changed: 0, written: false };
            }
            cell.list = res.list;
            return { list: res.list, changed: res.changed || 0, written: true };
        },
    });

    return {
        getBacking: () => cell.list,
        getMemCache: () => memCache,
        getLegacySaves: () => legacySaves,
        getTransactCalls: () => transactCalls,
        restore: () => {
            __setModuleOverride('ConversationsStore', origStore);
            __setModuleOverride('TakeoutEngine', origEngine);
            __setModuleOverride('StorageService', origStorage);
        },
    };
}

test('takeout import via transact: interleaved cross-tab write is not lost', async () => {
    const A = mkConv('chat-a', 1000);
    const B = mkConv('chat-b', 2000);
    const C = mkConv('chat-c', 1500);
    const cell = { list: [{ ...A }] };
    const mocks = installMocks({
        stale: [{ ...A }],
        cell,
        incoming: [{ ...B }],
        // The other tab writes C after we started but before our write lands.
        interleave: () => { cell.list = [...cell.list, { ...C }]; },
    });
    try {
        let result: any = null;
        let finished = false;
        await TakeoutController.handleTakeoutImport({} as any, {
            onFinished: (r: any) => { result = r; finished = true; },
            onError: (e: any) => { throw e; },
        });
        assert.strictEqual(finished, true, 'import must finish');
        assert.strictEqual(result.addedCount, 1, 'B is new relative to fresh storage');
        const ids = mocks.getBacking().map((c: any) => c.id).sort();
        assert.deepStrictEqual(ids, ['chat-a', 'chat-b', 'chat-c'], 'interleaved write C must survive');
        assert.strictEqual(mocks.getTransactCalls(), 1, 'must use the transactional path');
        assert.strictEqual(mocks.getLegacySaves(), 0, 'must not fall back to blind save');
        const mem = mocks.getMemCache();
        assert.ok(Array.isArray(mem), 'in-memory store cache must be refreshed after transact write');
        assert.deepStrictEqual((mem as any[]).map((c: any) => c.id).sort(), ['chat-a', 'chat-b', 'chat-c']);
    } finally {
        mocks.restore();
    }
});

test('takeout zero-change re-import via transact: no write, no cache touch', async () => {
    const A = mkConv('chat-a', 1000);
    const cell = { list: [{ ...A }] };
    const mocks = installMocks({
        stale: [{ ...A }],
        cell,
        incoming: [{ ...A }],
        interleave: null,
    });
    try {
        let result: any = null;
        await TakeoutController.handleTakeoutImport({} as any, {
            onFinished: (r: any) => { result = r; },
            onError: (e: any) => { throw e; },
        });
        assert.strictEqual(result.addedCount, 0);
        assert.strictEqual(mocks.getTransactCalls(), 1);
        assert.strictEqual(mocks.getLegacySaves(), 0);
        assert.strictEqual(mocks.getMemCache(), null, 'zero-change must not touch the in-memory cache');
        assert.deepStrictEqual(mocks.getBacking().map((c: any) => c.id), ['chat-a']);
    } finally {
        mocks.restore();
    }
});

test('planTakeoutMerge - pure planner returns null when no change and valid plan when items added or modified', () => {
    const { planTakeoutMerge } = require('../src/core/utils/mergeUtils.js');
    const existing = [mkConv('chat-1', 1000)];

    // Case 1: Identical item -> returns null (skip write)
    const planNoChange = planTakeoutMerge(existing, [mkConv('chat-1', 1000)]);
    assert.strictEqual(planNoChange, null);

    // Case 2: New item -> returns plan with addedCount = 1
    const planNew = planTakeoutMerge(existing, [mkConv('chat-2', 2000)]);
    assert.ok(planNew !== null);
    assert.strictEqual(planNew?.addedCount, 1);
    assert.strictEqual(planNew?.processed.length, 2);

    // Case 3: Same id but updated timestamp -> returns plan with repeatMods
    const planUpdated = planTakeoutMerge(existing, [mkConv('chat-1', 5000)]);
    assert.ok(planUpdated !== null);
    assert.strictEqual(planUpdated?.addedCount, 0);
    assert.strictEqual(planUpdated?.processed.length, 1);
    assert.strictEqual(planUpdated?.processed[0].timestamp, 5000);
});
