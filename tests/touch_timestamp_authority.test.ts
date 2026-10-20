export {};
const test = require('node:test');
const assert = require('node:assert');
const SyncEngine = require('../src/content/syncEngine.js');
const { __setModuleOverride } = require('../src/core/utils/moduleOverrides.js');

// Timestamp authority:
// On stream-start, touchActiveConversation preserves server timestamps (does not prematurely advance them).
// On stream-complete / live-turn-complete, updatedAt/timestamp advance to current interaction time
// to reflect the new completed turn, enabling real-time bump-to-top and incremental update detection.

function mockStorageContext() {
    let savedList: any[] = [];
    let checkpoint: number | null = null;
    const mockStorage = {
        getConversations: async () => [...savedList],
        transactConversations: async (_slot: string, updater: any) => {
            const res = updater([...savedList]);
            if (res && res.list) savedList = res.list;
            return { list: savedList, changed: res?.changed || 0, written: !!res };
        },
        setLastSync: async () => {},
        updateAccountSlot: async () => {},
        getScanCheckpoint: async () => checkpoint,
        setScanCheckpoint: async (_s: any, ts: number | null) => { checkpoint = ts; }
    };
    (global as any).chrome = { runtime: { sendMessage: () => {} } };
    __setModuleOverride('StorageService', mockStorage);
    return {
        seed: (items: any[]) => { savedList = items.map(c => ({ ...c })); },
        getSavedList: () => savedList,
        find: (id: string) => savedList.find((c: any) => c.id === id),
        getCheckpoint: () => checkpoint,
        setCheckpoint: (ts: number | null) => { checkpoint = ts; }
    };
}

function serverItem(id: string, ts: number) {
    return {
        id,
        title: `Server ${id}`,
        titleSource: 'rpc',
        titles: { rpc: `Server ${id}` },
        timestamp: ts,
        updatedAt: ts,
        createdAt: ts - 3600000,
        url: `https://gemini.google.com/app/${id}`
    };
}

test('touch preserves server timestamp on existing record', async () => {
    const ctx = mockStorageContext();
    const SERVER_TS = 1700000000000;
    ctx.seed([serverItem('srv_chat_1', SERVER_TS)]);

    await SyncEngine.touchActiveConversation('srv_chat_1', 'u0', { source: 'stream-complete' });

    const rec = ctx.find('srv_chat_1');
    assert.ok(rec, 'record still exists');
    assert.strictEqual(rec.timestamp, SERVER_TS, 'server timestamp must not be overwritten by client clock');
    assert.strictEqual(rec.updatedAt, SERVER_TS, 'server updatedAt must not be overwritten by client clock');
    assert.strictEqual(rec.sidebarIndex, 0, 'touch still pins sidebarIndex');
    assert.ok(rec.lastSeen, 'touch still refreshes lastSeen');
});

test('touch on unknown record creates entry without client timestamp', async () => {
    const ctx = mockStorageContext();

    await SyncEngine.touchActiveConversation('brand_new_chat', 'u0', { source: 'stream-start' });

    const rec = ctx.find('brand_new_chat');
    assert.ok(rec, 'record created');
    assert.ok(rec.timestamp == null, 'no client-stamped timestamp on new record');
    assert.ok(rec.updatedAt == null, 'no client-stamped updatedAt on new record');
    assert.strictEqual(rec.sidebarIndex, 0);
    assert.ok(rec.lastSeen, 'lastSeen records the touch');
});

test('touch never moves the scan checkpoint', async () => {
    const ctx = mockStorageContext();
    const CP = 1700000050000;
    ctx.seed([serverItem('srv_chat_3', 1700000000000)]);
    ctx.setCheckpoint(CP);

    await SyncEngine.touchActiveConversation('srv_chat_3', 'u0', { source: 'stream-complete' });

    assert.strictEqual(ctx.getCheckpoint(), CP, 'checkpoint untouched by touch path');
});
