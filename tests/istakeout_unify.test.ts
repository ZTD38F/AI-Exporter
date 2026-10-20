/**
 * isTakeout 四条件判断统一回归测试。
 *
 * 背景："这条记录是 takeout 数据吗"这个 keep 守卫曾在四处各写一份内联判断，
 * 其中两处带 `titles.takeout && !titles.rpc && !titles.dom` 守卫
 * （conversationsStore.reconcileWithCloud、storageService.reconcileConversations），
 * 另两处是宽口径（两处 hasTakeoutData）。"混血"记录（titles 同时携带
 * takeout 与 rpc）在宽口径站点被判为 takeout，却在带守卫的 reconciliation
 * 路径被判为非 takeout —— 同一份数据，一边认为该保留、一边把它删掉。
 *
 * 修复：四处统一调用 src/core/utils/titleUtils.ts 的共享 helper
 * isTakeoutConversation（宽口径语义），删除语义其他部分不动。
 *
 * 运行：node -r tests/ts_register.js --test tests/istakeout_unify.test.ts
 */
export {};
const test = require('node:test');
const assert = require('node:assert');

// Mock chrome.storage.local（storageService 需要）
const mockStorage: Record<string, any> = {};
(global as any).chrome = {
    storage: {
        local: {
            get: async (keys: any) => {
                if (keys === null) return { ...mockStorage };
                if (typeof keys === 'string') keys = [keys];
                const res: Record<string, any> = {};
                for (const k of keys) {
                    if (k in mockStorage) res[k] = mockStorage[k];
                }
                return res;
            },
            set: async (obj: any) => { Object.assign(mockStorage, obj); },
            remove: async (keys: any) => {
                if (typeof keys === 'string') keys = [keys];
                for (const k of keys) delete mockStorage[k];
            }
        }
    }
};

const ConversationsStore = require('../src/ui/state/conversationsStore.js');
const StorageService = require('../src/core/storage/storageService.js');

// "混血"记录：titles 同时携带 takeout 与 rpc（宽口径判 true，旧守卫版判 false）
const hybrid = () => ({ id: 'c_hybrid1', title: 'Hybrid', titles: { takeout: 'Takeout Title', rpc: 'RPC Title' } });
const pureTakeout = () => ({ id: 'c_takeout1', title: 'Pure Takeout', source: 'takeout' });
const pureOnline = () => ({ id: 'c_online1', title: 'Pure Online', titles: { rpc: 'RPC Title' } });

const { __setModuleOverride, __getModuleOverride } = require('../src/core/utils/moduleOverrides.js');

function withStubStorage() {
    const prev = __getModuleOverride('StorageService');
    __setModuleOverride('StorageService', {
        reconcileConversations: async () => ({ kept: 0, removed: 0, removedIds: [] }),
    });
    return () => { __setModuleOverride('StorageService', prev); };
}

test('store: reconcileWithCloud 保留 takeout+rpc 混血记录（与 hasTakeoutData 一致）', async () => {
    const restore = withStubStorage();
    try {
        ConversationsStore.setConversations([hybrid(), pureTakeout(), pureOnline()]);
        await ConversationsStore.reconcileWithCloud([], { keepTakeout: true });
        const ids = ConversationsStore.getConversations().map((c: any) => c.id);
        assert.ok(ids.includes('c_hybrid1'), '混血记录应被保留（宽口径语义）');
        assert.ok(ids.includes('c_takeout1'), '纯 takeout 记录应被保留');
        assert.ok(!ids.includes('c_online1'), '纯在线记录不在云端列表时应被移除（对照组）');
    } finally { restore(); }
});

test('store: hasTakeoutData 对混血记录返回 true', () => {
    ConversationsStore.setConversations([hybrid()]);
    assert.strictEqual(ConversationsStore.hasTakeoutData(), true);
});

test('storage: reconcileConversations 保留 takeout+rpc 混血记录', async () => {
    await StorageService.setConversations('u0', [hybrid(), pureTakeout(), pureOnline()]);
    const res = await StorageService.reconcileConversations('u0', [], { keepTakeout: true });
    assert.ok(!res.removedIds.includes('hybrid1'), '混血记录不应出现在 removedIds（宽口径语义）');
    const list = await StorageService.getConversations('u0');
    const ids = list.map((c: any) => (c.id || '').replace(/^c_/, ''));
    assert.ok(ids.includes('hybrid1'), '混血记录应被保留');
    assert.ok(ids.includes('takeout1'), '纯 takeout 记录应被保留');
    assert.ok(!ids.includes('online1'), '纯在线记录应被移除（对照组）');
});

test('helper: isTakeoutConversation 宽口径语义', () => {
    const { isTakeoutConversation } = require('../src/core/utils/titleUtils.js');
    assert.strictEqual(typeof isTakeoutConversation, 'function', 'titleUtils 应导出 isTakeoutConversation');
    assert.strictEqual(isTakeoutConversation(hybrid()), true, 'takeout+rpc 混血 → true');
    assert.strictEqual(isTakeoutConversation(pureTakeout()), true, 'source=takeout → true');
    assert.strictEqual(isTakeoutConversation({ id: 'x', titleSource: 'takeout' }), true, 'titleSource=takeout → true');
    assert.strictEqual(isTakeoutConversation({ id: 'x', isTakeoutOnly: true }), true, 'isTakeoutOnly → true');
    assert.strictEqual(isTakeoutConversation({ id: 'x', titles: { takeout: 'T' } }), true, 'titles.takeout → true');
    assert.strictEqual(isTakeoutConversation(pureOnline()), false, '纯在线 → false');
    assert.strictEqual(isTakeoutConversation({ id: 'x', title: 'plain' }), false, '普通记录 → false');
    assert.strictEqual(isTakeoutConversation(null), false, 'null → false');
    assert.strictEqual(isTakeoutConversation(undefined), false, 'undefined → false');
});

test('facade: utils CJS 出口 re-export isTakeoutConversation', () => {
    // 注意：utils.ts 底部有 `module.exports = GeminiUtils`，所以 CJS require
    // 拿到的就是 GeminiUtils 对象本身（这正是上一轮踩过的坑：CJS 实际出口）。
    const utils = require('../src/core/utils/utils.js');
    assert.strictEqual(typeof utils.isTakeoutConversation, 'function', 'utils CJS 出口应带 isTakeoutConversation');
    assert.strictEqual(utils.isTakeoutConversation(hybrid()), true);
    assert.strictEqual(utils.isTakeoutConversation(pureOnline()), false);
});
