/**
 * upsert lastSeen 单调性回归测试。
 *
 * 契约（与 mergeUtils.mergeConversation 的 bestLastSeen 一致）：
 *   1. incoming 携带陈旧 lastSeen（takeoutHtmlParser 会从活动时间 seed）时，
 *      不得把已有记录的 lastSeen 往回调；
 *   2. incoming 更 新时应推进；
 *   3. 双方都缺失时 seed 当前时间（保留现有"新记录"行为）。
 *
 * 运行: node -r ./tests/ts_register.js --test tests/upsert_lastseen_max.test.ts
 */
export {};
const test = require('node:test');
const assert = require('node:assert');
const SyncEngine = require('../src/content/syncEngine.js');
const { __setModuleOverride, __getModuleOverride } = require('../src/core/utils/moduleOverrides.js');

function mockStorageContext() {
    let savedList: any[] = [];
    const mockStorage = {
        getConversations: async () => [...savedList],
        transactConversations: async (_slot: string, updater: any) => {
            const res = updater([...savedList]);
            if (res && res.list) savedList = res.list;
            return { list: savedList, changed: res?.changed || 0, written: !!res };
        },
        setLastSync: async () => {},
        updateAccountSlot: async () => {},
        getScanCheckpoint: async () => null,
        setScanCheckpoint: async () => {}
    };
    (global as any).chrome = { runtime: { sendMessage: () => {} } };
    __setModuleOverride('StorageService', mockStorage);
    return {
        seed: (items: any[]) => { savedList = items.map(c => ({ ...c })); },
        find: (id: string) => savedList.find((c: any) => c.id === id),
    };
}

test('陈旧的 incoming lastSeen 不得回退已有的 lastSeen', async () => {
    const ctx = mockStorageContext();
    ctx.seed([
        { id: 'chat1', title: 'T', timestamp: 1000, updatedAt: 1000, lastSeen: '2026-09-10T00:00:00.000Z', url: 'https://gemini.google.com/app/chat1' },
    ]);

    // takeout 导入：incoming 的 lastSeen 比已有记录旧 9 天
    await SyncEngine.upsertConversations(
        [{ id: 'chat1', title: 'T', timestamp: 1000, updatedAt: 1000, lastSeen: '2026-09-01T00:00:00.000Z' }],
        'takeout', true, 'u0'
    );

    const c = ctx.find('chat1');
    assert.strictEqual(
        c.lastSeen, '2026-09-10T00:00:00.000Z',
        `lastSeen 被陈旧的 incoming 回退了，得到 ${c.lastSeen}`
    );
});

test('incoming lastSeen 更新时应推进', async () => {
    const ctx = mockStorageContext();
    ctx.seed([
        { id: 'chat1', title: 'T', timestamp: 1000, updatedAt: 1000, lastSeen: '2026-09-01T00:00:00.000Z', url: 'https://gemini.google.com/app/chat1' },
    ]);

    await SyncEngine.upsertConversations(
        [{ id: 'chat1', title: 'T', timestamp: 1000, updatedAt: 1000, lastSeen: '2026-09-12T00:00:00.000Z' }],
        'takeout', true, 'u0'
    );

    const c = ctx.find('chat1');
    assert.strictEqual(c.lastSeen, '2026-09-12T00:00:00.000Z', `更新的 incoming lastSeen 应推进，得到 ${c.lastSeen}`);
});

test('只有 incoming 携带 lastSeen 时应采用', async () => {
    const ctx = mockStorageContext();
    ctx.seed([
        { id: 'chat1', title: 'T', timestamp: 1000, updatedAt: 1000, url: 'https://gemini.google.com/app/chat1' },
    ]);

    await SyncEngine.upsertConversations(
        [{ id: 'chat1', title: 'T', timestamp: 1000, updatedAt: 1000, lastSeen: '2026-09-05T00:00:00.000Z' }],
        'takeout', true, 'u0'
    );

    const c = ctx.find('chat1');
    assert.strictEqual(c.lastSeen, '2026-09-05T00:00:00.000Z', `应采用 incoming 的 lastSeen，得到 ${c.lastSeen}`);
});

test('双方都缺失 lastSeen 时 seed 当前时间', async () => {
    const ctx = mockStorageContext();
    ctx.seed([]);

    const before = Date.now();
    await SyncEngine.upsertConversations(
        [{ id: 'newchat', title: 'New', timestamp: 1000, updatedAt: 1000 }],
        'page-sync', true, 'u0'
    );
    const after = Date.now();

    const c = ctx.find('newchat');
    const ms = new Date(c.lastSeen).getTime();
    assert.ok(
        Number.isFinite(ms) && ms >= before && ms <= after,
        `新记录应 seed 当前时间，得到 ${c.lastSeen}`
    );
});
