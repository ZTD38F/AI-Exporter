/**
 * Phase A (P1-3) 回归测试：嗅探 / 扫描 slice 隔离。
 *
 * 契约：
 *   1. 嗅探是数据面 —— ingestListBatch 默认（participateInWatermark 未传/false）
 *      只写数据，不进 __sessionSlices、不推进 scan checkpoint、不报 reachedWatermark。
 *   2. 扫描是控制面 —— onPageBatch / 完整扫描收尾显式传 participateInWatermark: true
 *      才走水位逻辑。
 *   3. 同一批 upsert 两次，updatedAt 不推进。
 *      假设：mergeUtils.mergeConversation 对权威时间戳取 max（见 mergeUtils.ts:136-140）。
 *      将来该语义变化时，本测试应当变红，而不是被静默绕过。
 *
 * 运行: node -r ./tests/ts_register.js --test tests/sniff_watermark_isolation.test.ts
 */
export {};
const test = require('node:test');
const assert = require('node:assert');
const SyncEngine = require('../src/content/syncEngine.js');
const { __setModuleOverride } = require('../src/core/utils/moduleOverrides.js');

function mockStorageContext() {
    let savedList: any[] = [];
    let checkpoint: number | null = 5000;
    const setCheckpointCalls: number[] = [];
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
        setScanCheckpoint: async (_slot: string, ts: number) => { setCheckpointCalls.push(ts); checkpoint = ts; }
    };
    (global as any).chrome = { runtime: { sendMessage: () => {} } };
    __setModuleOverride('StorageService', mockStorage);
    return {
        seed: (items: any[]) => { savedList = items.map(c => ({ ...c })); },
        find: (id: string) => savedList.find((c: any) => c.id === id),
        getCheckpoint: () => checkpoint,
        setCheckpointCalls,
        resetSlice: () => SyncEngine.resetSessionSlice('u0')
    };
}

const batch = (ts: number) => [
    { id: 'chat-a', title: 'A', timestamp: ts, updatedAt: ts, url: 'https://gemini.google.com/app/chat-a' },
    { id: 'chat-b', title: 'B', timestamp: ts - 100, updatedAt: ts - 100, url: 'https://gemini.google.com/app/chat-b' }
];

test('sniff（默认不参与）：批次 minTimestamp <= checkpoint 也不推进水位', async () => {
    const ctx = mockStorageContext();
    ctx.resetSlice();
    // checkpoint=5000, batch max=4000/min=3900：旧逻辑下 minTimestamp <= checkpoint
    // 会 reachedWatermark=true；隔离后 sniff 不得触发。
    const res = await SyncEngine.ingestListBatch(batch(4000), 'network-list', { slot: 'u0' });

    assert.strictEqual(res.reachedWatermark, false, 'sniff 不应触发 watermark');
    assert.strictEqual(res.establishedBaseline, false, 'sniff 不应建立基线');
    assert.strictEqual(ctx.setCheckpointCalls.length, 0,
        `setScanCheckpoint 不应被调用，实际调用了 ${ctx.setCheckpointCalls.length} 次`);
    assert.strictEqual(ctx.getCheckpoint(), 5000, 'checkpoint 应保持不变');
    assert.ok(ctx.find('chat-a'), '数据面写入不应受隔离影响');
    assert.ok(ctx.find('chat-b'), '数据面写入不应受隔离影响');
});

test('对照：participateInWatermark=true 的扫描批次仍走水位逻辑', async () => {
    const ctx = mockStorageContext();
    ctx.resetSlice();
    const res = await SyncEngine.ingestListBatch(batch(4000), 'batchexecute', {
        slot: 'u0',
        isPage1: true,
        participateInWatermark: true
    });

    // minTimestamp=3900 <= checkpoint=5000 -> 命中水位；newWatermark=max(5000,4000)=5000
    // 未超过旧值故不写存储，但 reachedWatermark 必须为 true（证明控制面路径仍在）
    assert.strictEqual(res.reachedWatermark, true, '扫描控制面应触发 watermark');
    assert.strictEqual(ctx.getCheckpoint(), 5000, '水位未实际升高时 checkpoint 不变');
});

test('同一批 upsert 两次，updatedAt 不推进', async () => {
    // 假设：mergeConversation 对权威时间戳取 max（mergeUtils.ts:136-140）。
    // 若将来该语义变化（例如改成"后来者覆盖"），本测试应当变红。
    const ctx = mockStorageContext();
    ctx.resetSlice();
    const items = [
        { id: 'chat-x', title: 'X', timestamp: 8000, updatedAt: 8000, url: 'https://gemini.google.com/app/chat-x' }
    ];

    await SyncEngine.upsertConversations(items, 'network-list', true, 'u0');
    const afterFirst = ctx.find('chat-x');
    assert.ok(afterFirst, '第一次 upsert 应写入');

    await SyncEngine.upsertConversations(items.map(c => ({ ...c })), 'network-list', true, 'u0');
    const afterSecond = ctx.find('chat-x');

    assert.strictEqual(
        afterSecond.updatedAt, afterFirst.updatedAt,
        `重复 upsert 同一批不应推进 updatedAt：${afterFirst.updatedAt} -> ${afterSecond.updatedAt}`
    );
});
