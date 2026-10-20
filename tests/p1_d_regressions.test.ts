/**
 * D 组 P1 回归测试 —— 2026-09-15 代码审查「存储层：并发、原子性与写放大」
 * P1-045 ~ P1-060，共 20 个测试。
 *
 * 运行：node -r tests/ts_register.js --test tests/p1_d_regressions.test.ts
 */
export {};
const test = require('node:test');
const assert = require('node:assert');

const StorageService = require('../src/core/storage/storageService.js');
const LiveStorageManager = require('../src/core/storage/liveStorageManager.js');
const { __setModuleOverride } = require('../src/core/utils/moduleOverrides.js');
const IdbHandleStore = require('../src/core/storage/idbHandleStore.js');
const FormatStore = require('../src/core/storage/formatStore.js');
const { mergeConversation } = require('../src/core/utils/mergeUtils.js');
const Pagination = require('../src/core/api/client/pagination.js');

// ------------------------------------------------------------------ helpers

function makeChromeStore() {
    const store: Record<string, any> = {};
    let failNextSet = false;
    const chrome = {
        storage: {
            local: {
                get: async (keys: any) => {
                    if (keys == null) return { ...store };
                    const arr = Array.isArray(keys) ? keys : [keys];
                    const r: Record<string, any> = {};
                    for (const k of arr) if (k in store) r[k] = store[k];
                    return r;
                },
                set: async (obj: any) => {
                    if (failNextSet) {
                        failNextSet = false;
                        throw new Error('simulated-quota-failure');
                    }
                    Object.assign(store, obj);
                },
                remove: async (keys: any) => {
                    const arr = Array.isArray(keys) ? keys : [keys];
                    for (const k of arr) delete store[k];
                },
            },
        },
    };
    return { store, chrome, setFailNext: (v: boolean) => { failNextSet = v; } };
}

function withChrome(chrome: any) {
    const prev = (global as any).chrome;
    (global as any).chrome = chrome;
    return () => { (global as any).chrome = prev; };
}

function captureWarn() {
    const warns: string[] = [];
    const prev = console.warn;
    console.warn = (...a: any[]) => { warns.push(a.map(String).join(' ')); };
    return { warns, restore: () => { console.warn = prev; } };
}

// ------------------------------------------------------------------ P1-045

test('P1-045: saveExportRecord stores a single canonical key (no 3-alias fan-out)', async () => {
    const { store, chrome } = makeChromeStore();
    const restore = withChrome(chrome);
    try {
        await StorageService.saveExportRecord('u0', 'c_d45_a', { ok: 1 });
        const map = store['exportedIds'];
        assert.deepStrictEqual(
            Object.keys(map).sort(),
            ['d45_a'],
            `expected single canonical key, got: ${JSON.stringify(Object.keys(map))}`
        );
        assert.deepStrictEqual(map['d45_a'], { ok: 1 });
    } finally { restore(); }
});

test('P1-045: historical alias keys are collapsed to canonical form on save', async () => {
    const { store, chrome } = makeChromeStore();
    const restore = withChrome(chrome);
    try {
        // Map as written by the old code: three alias keys for one conversation.
        store['exportedIds'] = { 'c_d45_b': { v: 1 }, 'd45_b': { v: 1 }, 'other': { v: 2 } };
        await StorageService.saveExportRecord('u0', 'd45_c', { v: 3 });
        const map = store['exportedIds'];
        assert.deepStrictEqual(
            Object.keys(map).sort(),
            ['d45_b', 'd45_c', 'other'],
            `aliases not collapsed: ${JSON.stringify(Object.keys(map))}`
        );
    } finally { restore(); }
});

// ------------------------------------------------------------------ P1-046

test('P1-046: non-u0 saves never pollute the global exportedIds key', async () => {
    const { store, chrome } = makeChromeStore();
    const restore = withChrome(chrome);
    try {
        store['exportedIds'] = { 'u0rec': { v: 1 } };
        await StorageService.saveExportRecord('u1', 'c_d46_a', { v: 1 });
        assert.deepStrictEqual(
            store['exportedIds'],
            { 'u0rec': { v: 1 } },
            'non-u0 record leaked into the global exportedIds key'
        );
        assert.deepStrictEqual(Object.keys(store['gemini_exported_u1']).sort(), ['d46_a']);
        // Read path respects canonical slot isolation: u1 view reads only u1 key without leaking global u0 records.
        const viewU1 = await StorageService.getExportedIds('u1');
        assert.deepStrictEqual(Object.keys(viewU1).sort(), ['d46_a'], 'u1 view should isolate to u1 without leaking global u0rec');
        const viewU0 = await StorageService.getExportedIds('u0');
        assert.ok(viewU0['u0rec'], 'u0 view preserves u0rec');
    } finally { restore(); }
});

// ------------------------------------------------------------------ P1-047

test('P1-047: overlapping setConversations calls are serialized in call order', async () => {
    const { store, chrome } = makeChromeStore();
    const resolvers: Array<() => void> = [];
    chrome.storage.local.set = (obj: any) => new Promise<void>((res) => {
        resolvers.push(() => { Object.assign(store, obj); res(); });
    });
    const restore = withChrome(chrome);
    try {
        const p1 = StorageService.setConversations('u0', [{ id: 'first' }]);
        const p2 = StorageService.setConversations('u0', [{ id: 'second' }]);
        await new Promise((r) => setTimeout(r, 10));
        // The second write must not start before the first one completes.
        assert.strictEqual(resolvers.length, 1, 'second write started before the first finished (no lock)');
        resolvers[0]();
        await new Promise((r) => setTimeout(r, 10));
        assert.strictEqual(resolvers.length, 2);
        resolvers[1]();
        await Promise.all([p1, p2]);
        assert.deepStrictEqual(store['gemini_conversations'], [{ id: 'second' }]);
    } finally { restore(); }
});

// ------------------------------------------------------------------ P1-048

test('P1-048: concurrent updateAccountSlot calls do not lose fields', async () => {
    const { store, chrome } = makeChromeStore();
    const restore = withChrome(chrome);
    try {
        const p1 = StorageService.updateAccountSlot('u0', { a: 1 });
        const p2 = StorageService.updateAccountSlot('u1', { b: 2 });
        await Promise.all([p1, p2]);
        assert.deepStrictEqual(
            store['gemini_account_slots'],
            { u0: { a: 1 }, u1: { b: 2 } },
            'concurrent slot updates lost a field (naked read-modify-write)'
        );
    } finally { restore(); }
});

test('P1-048: removeConversation keeps list, count key and slot count consistent', async () => {
    const { store, chrome } = makeChromeStore();
    const restore = withChrome(chrome);
    try {
        store['gemini_conversations'] = [{ id: 'c_keep' }, { id: 'c_gone' }];
        store['gemini_last_count'] = 2;
        const removed = await StorageService.removeConversation('u0', 'c_gone');
        assert.strictEqual(removed, true);
        assert.deepStrictEqual(
            (store['gemini_conversations'] as any[]).map((c) => c.id),
            ['c_keep']
        );
        assert.strictEqual(store['gemini_last_count'], 1, 'countKey diverged from list');
        assert.strictEqual(
            store['gemini_account_slots'] && store['gemini_account_slots']['u0'] && store['gemini_account_slots']['u0'].count,
            1,
            'account slot count diverged from list'
        );
    } finally { restore(); }
});

// ------------------------------------------------------------------ P1-049

test('P1-049: removeConversation deletes the conversation export records (all alias forms)', async () => {
    const { store, chrome } = makeChromeStore();
    const restore = withChrome(chrome);
    try {
        store['gemini_conversations'] = [{ id: 'c_gone' }, { id: 'c_keep' }];
        store['exportedIds'] = { 'c_gone': { v: 1 }, 'gone': { v: 1 }, 'c_keep': { v: 2 } };
        await StorageService.removeConversation('u0', 'c_gone');
        assert.deepStrictEqual(
            Object.keys(store['exportedIds']).sort(),
            ['c_keep'],
            `stale export records remain: ${JSON.stringify(Object.keys(store['exportedIds']))}`
        );
    } finally { restore(); }
});

test('P1-049: reconcileConversations deletes export records of removed conversations', async () => {
    const { store, chrome } = makeChromeStore();
    const restore = withChrome(chrome);
    try {
        store['gemini_conversations'] = [{ id: 'c_a' }, { id: 'c_b' }];
        store['exportedIds'] = { 'a': { v: 1 }, 'b': { v: 1 } };
        const res = await StorageService.reconcileConversations('u0', [{ id: 'c_a' }]);
        assert.deepStrictEqual(res.removedIds, ['b']);
        assert.deepStrictEqual(
            Object.keys(store['exportedIds']),
            ['a'],
            'reconciled-away conversation kept its export record'
        );
        assert.deepStrictEqual(
            (store['gemini_conversations'] as any[]).map((c) => c.id),
            ['c_a']
        );
    } finally { restore(); }
});

// ------------------------------------------------------------------ P1-050

const liveMock = makeChromeStore();
function withLiveChrome() {
    return withChrome(liveMock.chrome);
}

test('P1-050: concurrent setLiveConfig patches serialize without clobbering', async () => {
    const restore = withLiveChrome();
    try {
        const p1 = LiveStorageManager.setLiveConfig({ dirName: 'dir-one' });
        const p2 = LiveStorageManager.setLiveConfig({ enabledDisk: true });
        await Promise.all([p1, p2]);
        const cfg = await LiveStorageManager.getLiveConfig();
        assert.strictEqual(cfg.dirName, 'dir-one', 'first patch was clobbered by the second');
        assert.strictEqual(cfg.enabledDisk, true, 'second patch was lost');
    } finally { restore(); }
});

test('P1-050: failed disk write does not diverge memory from disk', async () => {
    const restore = withLiveChrome();
    const cap = captureWarn();
    try {
        liveMock.setFailNext(true);
        const ret = await LiveStorageManager.setLiveConfig({ dirName: 'dir-bad' });
        const cfg = await LiveStorageManager.getLiveConfig();
        assert.strictEqual(cfg.dirName, 'dir-one', 'memory diverged from disk after failed write');
        assert.strictEqual(ret.dirName, 'dir-one', 'returned config does not match persisted state');
        assert.ok(cap.warns.length > 0, 'storage failure was not logged');
    } finally { cap.restore(); restore(); }
});

// ------------------------------------------------------------------ P1-051

test('P1-051: getLiveConfig returns a defensive copy, not the live cache', async () => {
    const restore = withLiveChrome();
    try {
        const c1 = await LiveStorageManager.getLiveConfig();
        (c1 as any).__polluted = true;
        const c2 = await LiveStorageManager.getLiveConfig();
        assert.strictEqual(
            (c2 as any).__polluted,
            undefined,
            'caller mutation leaked into the shared config cache'
        );
    } finally { restore(); }
});

// ------------------------------------------------------------------ P1-052

function fakeIDB() {
    const db = {
        close() { /* tracked by caller if needed */ },
        transaction: () => {
            const tx: any = {
                objectStore: () => ({
                    put() { /* noop */ },
                    delete() { /* noop */ },
                    get: (_k: string) => {
                        const r: any = {};
                        setTimeout(() => { if (r.onsuccess) r.onsuccess(); }, 0);
                        return r;
                    },
                }),
            };
            setTimeout(() => { if (tx.oncomplete) tx.oncomplete(); }, 0);
            return tx;
        },
        objectStoreNames: { contains: () => true },
    };
    return {
        open: () => {
            const req: any = { result: db };
            setTimeout(() => { if (req.onsuccess) req.onsuccess(); }, 0);
            return req;
        },
    };
}

test('P1-052: dir handle is published to memory only after the IDB write succeeds', async () => {
    IdbHandleStore.setMemoryDirHandle('sentinel');
    const prevIDB = (globalThis as any).indexedDB;
    try {
        // Failure path: no IndexedDB -> saveStoredDirHandle returns false.
        delete (globalThis as any).indexedDB;
        const okFail = await LiveStorageManager.saveLiveDirHandle({ name: 'nope' });
        assert.strictEqual(okFail, false);
        assert.strictEqual(IdbHandleStore.getMemoryDirHandle(), 'sentinel', 'memory updated although the IDB write failed');

        // Success path.
        (globalThis as any).indexedDB = fakeIDB();
        const ok = await LiveStorageManager.saveLiveDirHandle({ name: 'mydir' });
        assert.strictEqual(ok, true);
        assert.deepStrictEqual(IdbHandleStore.getMemoryDirHandle(), { name: 'mydir' });

        // Clear failure path: memory must not be cleared when the IDB delete fails.
        delete (globalThis as any).indexedDB;
        const okClearFail = await LiveStorageManager.clearLiveDirHandle();
        assert.strictEqual(okClearFail, false);
        assert.deepStrictEqual(IdbHandleStore.getMemoryDirHandle(), { name: 'mydir' }, 'memory cleared although the IDB delete failed');

        // Clear success path.
        (globalThis as any).indexedDB = fakeIDB();
        const okClear = await LiveStorageManager.clearLiveDirHandle();
        assert.strictEqual(okClear, true);
        assert.strictEqual(IdbHandleStore.getMemoryDirHandle(), null);
    } finally {
        IdbHandleStore.setMemoryDirHandle(null);
        if (prevIDB === undefined) delete (globalThis as any).indexedDB;
        else (globalThis as any).indexedDB = prevIDB;
    }
});

// ------------------------------------------------------------------ P1-053

test('P1-053: IDB connections are closed after use and onblocked is observed', async () => {
    let closed = 0;
    let capturedReq: any = null;
    const db: any = {
        close() { closed++; },
        transaction: () => { throw new Error('boom-tx'); },
        objectStoreNames: { contains: () => true },
    };
    const prevIDB = (globalThis as any).indexedDB;
    (globalThis as any).indexedDB = {
        open: () => {
            const req: any = { result: db };
            capturedReq = req;
            setTimeout(() => { if (req.onsuccess) req.onsuccess(); }, 0);
            return req;
        },
    };
    const cap = captureWarn();
    try {
        const got = await IdbHandleStore.getStoredDirHandle();
        assert.strictEqual(got, null);
        assert.strictEqual(closed, 1, 'IDB connection was not closed after the operation');
        assert.strictEqual(typeof capturedReq.onblocked, 'function', 'onblocked handler not registered');
        capturedReq.onblocked();
        assert.ok(
            cap.warns.some((w) => /blocked/i.test(w)),
            `blocked upgrade produced no warning: ${JSON.stringify(cap.warns)}`
        );
    } finally {
        cap.restore();
        if (prevIDB === undefined) delete (globalThis as any).indexedDB;
        else (globalThis as any).indexedDB = prevIDB;
    }
});

// ------------------------------------------------------------------ P1-054

test('P1-054: loadFormat warns instead of silently swallowing storage errors', async () => {
    const cap = captureWarn();
    const prev = (global as any).chrome;
    (global as any).chrome = {
        storage: { local: { get: async () => { throw new Error('boom'); }, set: async () => { /* noop */ } } },
    };
    try {
        const res = await FormatStore.loadFormat();
        assert.strictEqual(res.format, 'markdown');
        assert.ok(
            cap.warns.some((w) => /format/i.test(w)),
            `storage error produced no warning: ${JSON.stringify(cap.warns)}`
        );
    } finally {
        cap.restore();
        (global as any).chrome = prev;
    }
});

// ------------------------------------------------------------------ P1-056

test('P1-056: merge keeps the fuller message body when the incoming body is empty/shorter', async () => {
    const mkMsgs = (n: number) => Array.from({ length: n }, (_, i) => ({ id: 'm' + i, text: 't' + i }));
    const full = { id: 'c_x', title: 'T', titles: { rpc: 'T' }, titleSource: 'rpc', messages: mkMsgs(5), messageCount: 5, timestamp: 100, updatedAt: 100 };

    // Empty incoming body must not clobber the full body.
    const r1 = mergeConversation(full, { ...full, messages: [], messageCount: 0 }, { source: 'network-list' });
    assert.strictEqual(r1.merged.messages.length, 5, 'empty incoming body clobbered the full body');
    assert.strictEqual(r1.merged.messageCount, 5, 'stale smaller messageCount regressed');

    // Shorter (not just empty) incoming body must not clobber either.
    const r3 = mergeConversation(full, { ...full, messages: mkMsgs(2), messageCount: 2 }, { source: 'network-list' });
    assert.strictEqual(r3.merged.messages.length, 5, 'shorter incoming body clobbered the full body');

    // Reverse order: incoming brings the full body — it must be kept (same outcome).
    const r2 = mergeConversation(
        { ...full, messages: [], messageCount: 0 },
        { ...full },
        { source: 'network-list' }
    );
    assert.strictEqual(r2.merged.messages.length, 5);
    assert.strictEqual(r2.merged.messageCount, 5);
});

test('P1-056b: slimmed existing conversation (messages in IDB) must NOT have shorter incoming messages attached', () => {
    const mkMsgs = (n: number) => Array.from({ length: n }, (_, i) => ({ id: 'm' + i, text: 't' + i }));
    // 模拟从 storage.local 读出的 slim 会话（无 messages 数组，由 messageCount 记录正文长度）
    const slimOld = {
        id: 'c_slim',
        title: 'Slim Conversation',
        titles: { rpc: 'Slim Conversation' },
        titleSource: 'rpc',
        messageCount: 15,
        timestamp: 1000,
        updatedAt: 1000
    };

    // 较短的 incoming (例如网络列表或局部流式片段仅带前 2 条消息)
    const incomingShort = {
        id: 'c_slim',
        title: 'Slim Conversation',
        titles: { rpc: 'Slim Conversation' },
        titleSource: 'rpc',
        messages: mkMsgs(2),
        messageCount: 2,
        timestamp: 1000,
        updatedAt: 1000
    };

    const res = mergeConversation(slimOld, incomingShort, { source: 'network-list' });
    assert.strictEqual(res.merged.messages, undefined, '较短的 incoming 消息数组绝不可附着到 slim 会话上');
    assert.strictEqual(res.merged.messageCount, 15, '应保持原有 15 条消息计数');
    assert.strictEqual(res.isChanged, false, '更短的残缺正文不应触发变更标记');

    // 较长的 incoming (例如全量追加或离线导入带来 20 条消息)
    const incomingLong = {
        id: 'c_slim',
        title: 'Slim Conversation',
        titles: { rpc: 'Slim Conversation' },
        titleSource: 'rpc',
        messages: mkMsgs(20),
        messageCount: 20,
        timestamp: 1000,
        updatedAt: 1000
    };

    const res2 = mergeConversation(slimOld, incomingLong, { source: 'network-list' });
    assert.strictEqual(res2.merged.messages?.length, 20, '更长完整的消息数组应正常并入');
    assert.strictEqual(res2.merged.messageCount, 20);
    assert.strictEqual(res2.isChanged, true);
});

// ------------------------------------------------------------------ P1-057

test('P1-057: isChanged detects message-count growth when timestamps are unchanged', async () => {
    const base: any = { id: 'c_y', title: 'Same title', titles: { rpc: 'Same title' }, titleSource: 'rpc', timestamp: 1000, updatedAt: 1000 };
    const old = { ...base, messageCount: 5, messages: [{ id: 'a' }] };
    const incoming = { ...base, messageCount: 8, messages: [{ id: 'a' }] };
    const r = mergeConversation(old, incoming, { source: 'network-list' });
    assert.strictEqual(
        r.isChanged, true,
        'messageCount 5 -> 8 with identical title/timestamps must count as changed'
    );
});

// ------------------------------------------------------------------ P1-058

test('P1-058: an older RPC timestamp never regresses updatedAt (newer-wins)', async () => {
    const old: any = { id: 'c_z', title: 'T', titles: { rpc: 'T' }, titleSource: 'rpc', timestamp: 2000, updatedAt: 2000 };
    const incoming: any = { id: 'c_z', title: 'T', titles: { rpc: 'T' }, titleSource: 'rpc', timestamp: 1000, updatedAt: 1000 };
    const r = mergeConversation(old, incoming);
    assert.strictEqual(r.merged.updatedAt, 2000, 'older RPC timestamp regressed updatedAt');
    const r2 = mergeConversation(old, { ...incoming, timestamp: 3000, updatedAt: 3000 });
    assert.strictEqual(r2.merged.updatedAt, 3000, 'newer RPC timestamp did not win');
});

// ------------------------------------------------------------------ P1-059

test('P1-059: partial list pagination interrupted by an exception is marked stoppedEarly', async () => {
    let calls = 0;
    const client: any = {
        aborted: false,
        getConversationList: async () => {
            calls++;
            if (calls === 1) return { conversations: [{ id: 'a' }], nextPageToken: 't1' };
            throw new Error('simulated 429 boom');
        },
    };
    const res = await Pagination.getAllConversations(client, 10);
    assert.strictEqual(res.conversations.length, 1);
    assert.strictEqual(
        res.stoppedEarly, true,
        'partial result from an exception must carry stoppedEarly so UI cannot mistake it for a complete sync'
    );
    assert.match(res.diagnostics.stopReason, /网络或服务异常/);
});

// ------------------------------------------------------------------ P1-060

test('P1-060: detail pagination stops on token loops and dedupes messages by id', async () => {
    let calls = 0;
    const client: any = {
        fetchConversationPage: async (_cid: string, token: string | null) => {
            calls++;
            if (!token) return { messages: [{ id: 'm1' }, { id: 'm2' }], nextPageToken: 't1', title: 'T' };
            // Misbehaving server: repeats the same cursor and re-sends m2.
            return { messages: [{ id: 'm2' }, { id: 'm3' }], nextPageToken: 't1', title: 'T' };
        },
    };
    const res = await Pagination.getConversationDetail(client, 'c_det');
    assert.strictEqual(calls, 2, `token loop was not stopped (fetch calls: ${calls})`);
    const ids = (res.messages as any[]).map((m) => m.id);
    assert.deepStrictEqual(ids, ['m3', 'm1', 'm2'], `duplicate/looped messages leaked: ${JSON.stringify(ids)}`);
});
