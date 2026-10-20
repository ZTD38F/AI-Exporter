/**
 * 统一数据摄入与 Fail-Closed 完整性防护测试套件
 *
 * 契约：
 *   1. 数据平权：会话数据不携带任何 timestampSource 偏见字段，无论来自嗅探还是扫描，
 *      合并规则 100% 客观一致（依据 timestamp、title 权重、消息长度）。
 *   2. Fail-Closed 完整性门禁：当传入空 ID、c_unknown 等无效或畸形会话时，
 *      upsertConversations 立即拦截并阻断存储事务，绝不污染或覆盖本地老数据。
 *   3. 混杂批次过滤：混杂批次中自动剥离非法 ID，只允许合法会话进入存储。
 *
 * 运行: node -r ./tests/ts_register.js --test tests/unified_ingest_integrity.test.ts
 */
export {};
const test = require('node:test');
const assert = require('node:assert');
const { mergeConversation } = require('../src/core/utils/mergeUtils.js');
const syncEngine = require('../src/content/syncEngine.js');
const { __setModuleOverride } = require('../src/core/utils/moduleOverrides.js');
const { upsertConversations } = syncEngine;

function listItem(id: string, tsMs: number, title: string, messagesLen = 3) {
    return {
        id,
        title,
        titleSource: 'rpc',
        titles: { rpc: title },
        createdAt: tsMs - 86400000,
        updatedAt: tsMs,
        chatTime: tsMs,
        timestamp: tsMs,
        messageCount: messagesLen,
        url: `https://gemini.google.com/app/${id}`,
    };
}

// ---- 1. 数据平权：无 timestampSource 属性 ----

test('数据平权：network-list 与 batchexecute 合并结果均无 timestampSource 字段', () => {
    const sniffed: any = mergeConversation(null, listItem('a', 1000, 'A'), { source: 'network-list' });
    assert.strictEqual(sniffed.merged.timestampSource, undefined, '嗅探输入不产生 timestampSource');
    assert.strictEqual(sniffed.merged.timestamp, 1000);

    const scanned: any = mergeConversation(null, listItem('b', 1000, 'B'), { source: 'batchexecute' });
    assert.strictEqual(scanned.merged.timestampSource, undefined, '扫描输入不产生 timestampSource');
    assert.strictEqual(scanned.merged.timestamp, 1000);
});

test('数据平权：同值或新值合并完全客观，无血统歧视', () => {
    // 嗅探先入库
    const first: any = mergeConversation(null, listItem('c', 1000, 'Old Title', 2), { source: 'network-list' }).merged;
    assert.strictEqual(first.timestamp, 1000);
    assert.strictEqual(first.messageCount, 2);

    // 扫描后拉取到更丰富的内容（更多消息数）
    const second: any = mergeConversation(first, listItem('c', 1000, 'Old Title', 5), { source: 'batchexecute' }).merged;
    assert.strictEqual(second.timestamp, 1000);
    assert.strictEqual(second.messageCount, 5, '消息数客观增长');
    assert.strictEqual(second.timestampSource, undefined);

    // 新时间戳更新
    const third: any = mergeConversation(second, listItem('c', 2000, 'New Title', 5), { source: 'network-list' }).merged;
    assert.strictEqual(third.timestamp, 2000, '时间戳客观前进');
    assert.strictEqual(third.title, 'New Title');
    assert.strictEqual(third.timestampSource, undefined);
});

// ---- 2. Fail-Closed 完整性防护门禁 ----

function mockStorageContext() {
    let transactionInvoked = false;
    let savedList: any[] = [];
    const mockStorage = {
        getConversations: async () => [...savedList],
        transactConversations: async (_slot: string, updater: any) => {
            transactionInvoked = true;
            const res = updater([...savedList]);
            if (res && res.list) savedList = res.list;
            return { list: savedList, changed: res?.changed || 0, written: !!res };
        },
        setLastSync: async () => {},
        updateAccountSlot: async () => {}
    };

    (global as any).chrome = {
        runtime: {
            sendMessage: () => {}
        }
    };
    __setModuleOverride('StorageService', mockStorage);

    return {
        wasTransactionInvoked: () => transactionInvoked,
        getSavedList: () => savedList,
        setInitialList: (l: any[]) => { savedList = [...l]; transactionInvoked = false; }
    };
}

test('Fail-Closed：传入空 ID 或 c_unknown 等非法项目时，严禁触发存储写入', async () => {
    const ctx = mockStorageContext();
    ctx.setInitialList([listItem('c_safe_1', 1000, 'Safe Chat')]);

    // 模拟由于 Google 协议变更导致的 c_unknown 或缺少 ID 载荷
    const badBatch = [
        { id: 'c_unknown', title: 'Unknown' },
        { id: '', title: 'Empty' },
        { title: 'No ID' },
        { id: 'c_' }
    ];

    const count = await upsertConversations(badBatch, 'network-list', true);
    assert.strictEqual(count, 0, '非法批次直接返回 0');
    assert.strictEqual(ctx.wasTransactionInvoked(), false, '绝不发起存储事务，Fail-Closed 保护生效');
    assert.strictEqual(ctx.getSavedList().length, 1, '已有数据毫发无损');
    assert.strictEqual(ctx.getSavedList()[0].id, 'c_safe_1');
});

test('混杂批次：自动剥离 c_unknown，仅允许合法 ID 写入', async () => {
    const ctx = mockStorageContext();
    ctx.setInitialList([]);

    const mixedBatch = [
        { id: 'c_unknown', title: 'Should Be Dropped' },
        listItem('c_valid_1', 2000, 'Valid Chat')
    ];

    const count = await upsertConversations(mixedBatch, 'batchexecute', true);
    assert.strictEqual(count, 1, '仅 1 条合法数据入库');
    assert.strictEqual(ctx.wasTransactionInvoked(), true);
    assert.strictEqual(ctx.getSavedList().length, 1);
    assert.strictEqual(ctx.getSavedList()[0].id, 'valid_1');
});
