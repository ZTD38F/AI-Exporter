export {};
// Cross-tab write-queue regression tests.
//
// Each Gemini tab runs its own content-script JS context, so every tab gets an
// independent copy of storageService's in-memory promise chains while sharing
// one chrome.storage.local. These tests simulate that by loading two fresh
// module instances ("tabs") against one shared storage mock, plus a fake
// navigator.locks that behaves like Chrome's real cross-tab Web Locks.
//
// The core scenario (T1): tab A and tab B concurrently read-modify-write the
// conversation list. Without cross-tab serialization the later write is built
// on a stale snapshot and silently discards the other tab's update.
const test = require('node:test');
const assert = require('node:assert');

const SERVICE_PATH = '../src/core/storage/storageService.js';

function setupMockChromeStorage() {
    const mockStorage: Record<string, any> = {};
    let setCalls = 0;
    const origChrome = (global as any).chrome;
    const origNavDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    (global as any).chrome = {
        storage: {
            local: {
                // Macrotask delays make read/write interleaving deterministic,
                // like two real tabs racing on shared storage.
                get: async (keys: any) => {
                    await new Promise(r => setImmediate(r));
                    if (keys === null) return { ...mockStorage };
                    if (typeof keys === 'string') keys = [keys];
                    const res: Record<string, any> = {};
                    for (const k of (keys || [])) {
                        if (k in mockStorage) res[k] = mockStorage[k];
                    }
                    return res;
                },
                set: async (obj: any) => {
                    await new Promise(r => setImmediate(r));
                    setCalls++;
                    Object.assign(mockStorage, obj);
                },
                remove: async (keys: any) => {
                    await new Promise(r => setImmediate(r));
                    if (typeof keys === 'string') keys = [keys];
                    for (const k of (keys || [])) delete mockStorage[k];
                }
            }
        }
    };
    return {
        mockStorage,
        getSetCalls: () => setCalls,
        restore: () => {
            (global as any).chrome = origChrome;
            if (origNavDesc) {
                Object.defineProperty(globalThis, 'navigator', origNavDesc);
            }
        }
    };
}

// Fake Web Locks: one FIFO queue per lock name, shared across "tabs" —
// mirrors navigator.locks.request(name, callback) semantics in Chrome.
//
// NOTE: plain `(globalThis as any).navigator = ...` assignment does NOT work:
// recent Node ships a native global `navigator` (with its own `locks`) behind
// a getter, so the assignment silently fails. defineProperty is required.
function installFakeWebLocks() {
    const chains = new Map<string, Promise<any>>();
    Object.defineProperty(globalThis, 'navigator', {
        value: {
            locks: {
                request: (name: string, fn: () => Promise<any>) => {
                    const prev = chains.get(name) || Promise.resolve();
                    const p = prev.then(fn, fn);
                    chains.set(name, p.then(() => {}, () => {}));
                    return p;
                }
            }
        },
        configurable: true,
        writable: true,
        enumerable: true
    });
}

function removeWebLocks() {
    Object.defineProperty(globalThis, 'navigator', {
        value: {},
        configurable: true,
        writable: true,
        enumerable: true
    });
}

// Fresh module instance = one tab's independent in-memory chains.
function freshService() {
    const resolved = require.resolve(SERVICE_PATH);
    delete require.cache[resolved];
    return require(SERVICE_PATH);
}

test('T1: concurrent transactConversations from two tabs must not lose updates', async () => {
    const env = setupMockChromeStorage();
    installFakeWebLocks();
    try {
        const tabA = freshService();
        const tabB = freshService();
        await tabA.setConversations('u0', [{ id: 'seed', title: 'Seed' }]);

        const pA = tabA.transactConversations('u0', (existing: any[]) => ({
            list: [...existing, { id: 'fromA', title: 'A' }],
            changed: 1
        }));
        const pB = tabB.transactConversations('u0', (existing: any[]) => ({
            list: [...existing, { id: 'fromB', title: 'B' }],
            changed: 1
        }));
        const [rA, rB] = await Promise.all([pA, pB]);
        assert.strictEqual(rA.written, true);
        assert.strictEqual(rB.written, true);

        const finalList = await tabA.getConversations('u0');
        const ids = finalList.map((c: any) => c.id);
        assert.ok(ids.includes('seed'), 'seed must survive');
        assert.ok(ids.includes('fromA'), "tab A's write must not be lost");
        assert.ok(ids.includes('fromB'), "tab B's write must not be lost");
        assert.strictEqual(finalList.length, 3);
    } finally {
        env.restore();
    }
});

test('T2: concurrent saveExportRecordsBatch from two tabs must not lose records', async () => {
    const env = setupMockChromeStorage();
    installFakeWebLocks();
    try {
        const tabA = freshService();
        const tabB = freshService();

        const pA = tabA.saveExportRecordsBatch('u0', { chat_a: { ok: true } });
        const pB = tabB.saveExportRecordsBatch('u0', { chat_b: { ok: true } });
        await Promise.all([pA, pB]);

        const ids = await tabA.getExportedIds('u0');
        assert.ok(ids['chat_a'], "tab A's record must survive");
        assert.ok(ids['chat_b'], "tab B's record must survive");
    } finally {
        env.restore();
    }
});

test('T3: concurrent updateAccountSlot from two tabs must merge fields', async () => {
    const env = setupMockChromeStorage();
    installFakeWebLocks();
    try {
        const tabA = freshService();
        const tabB = freshService();

        const pA = tabA.updateAccountSlot('u0', { count: 10 });
        const pB = tabB.updateAccountSlot('u1', { count: 20 });
        await Promise.all([pA, pB]);

        const slots = await tabA.getAccountSlots();
        assert.strictEqual(slots['u0'] && slots['u0'].count, 10);
        assert.strictEqual(slots['u1'] && slots['u1'].count, 20);
    } finally {
        env.restore();
    }
});

test('T4: same-tab chains still serialize when Web Locks is unavailable (fallback)', async () => {
    const env = setupMockChromeStorage();
    removeWebLocks();
    try {
        const tab = freshService();
        await tab.setConversations('u0', [{ id: 'seed', title: 'Seed' }]);

        const pA = tab.transactConversations('u0', (existing: any[]) => ({
            list: [...existing, { id: 'first', title: '1' }],
            changed: 1
        }));
        const pB = tab.transactConversations('u0', (existing: any[]) => ({
            list: [...existing, { id: 'second', title: '2' }],
            changed: 1
        }));
        await Promise.all([pA, pB]);

        const ids = (await tab.getConversations('u0')).map((c: any) => c.id);
        assert.deepStrictEqual(ids, ['seed', 'first', 'second']);
    } finally {
        env.restore();
    }
});

test('T5: transactConversations updater returning null must not write', async () => {
    const env = setupMockChromeStorage();
    installFakeWebLocks();
    try {
        const tab = freshService();
        const seed = [{ id: 'seed', title: 'Seed' }];
        await tab.setConversations('u0', seed);
        const setsBefore = env.getSetCalls();

        const res = await tab.transactConversations('u0', () => null);
        assert.strictEqual(res.written, false);
        assert.deepStrictEqual(res.list, seed);
        assert.strictEqual(env.getSetCalls(), setsBefore, 'no storage write should happen');

        const after = await tab.getConversations('u0');
        assert.deepStrictEqual(after, seed);
    } finally {
        env.restore();
    }
});

test('T6: removeConversation inside the lock still drops export records atomically', async () => {
    const env = setupMockChromeStorage();
    installFakeWebLocks();
    try {
        const tabA = freshService();
        const tabB = freshService();
        await tabA.setConversations('u0', [
            { id: 'keep', title: 'Keep' },
            { id: 'drop', title: 'Drop' }
        ]);
        await tabA.saveExportRecord('u0', 'drop', { ok: true });

        // Tab B adds a conversation while tab A removes one.
        const pRemove = tabA.removeConversation('u0', 'drop');
        const pAdd = tabB.transactConversations('u0', (existing: any[]) => ({
            list: [...existing, { id: 'added', title: 'Added' }],
            changed: 1
        }));
        const [removed] = await Promise.all([pRemove, pAdd]);
        assert.strictEqual(removed, true);

        const ids = (await tabA.getConversations('u0')).map((c: any) => c.id);
        assert.ok(ids.includes('keep'));
        assert.ok(ids.includes('added'), "concurrent add must survive the removal");
        assert.ok(!ids.includes('drop'), 'removed conversation must stay removed');

        const exported = await tabA.getExportedIds('u0');
        assert.ok(!exported['drop'], 'export record of removed conversation must be dropped');
    } finally {
        env.restore();
    }
});
