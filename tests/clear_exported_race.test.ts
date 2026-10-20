/**
 * P1-3 回归测试：conversationsStore.clearExported 必须走
 * removeExportRecords(slot, allIds) 事务性删除路径，禁止用
 * setExportedIds(s, {}) 整 map 裸写清零 —— 裸写与并发的 saveExportRecord
 * 写入存在"清记录+写记录"竞态丢失窗口。
 *
 * 运行: node -r ./tests/ts_register.js --test tests/clear_exported_race.test.ts
 */
export {};
const test = require('node:test');
const assert = require('node:assert');

const ConversationsStore = require('../src/ui/state/conversationsStore.js');
const { __setModuleOverride } = require('../src/core/utils/moduleOverrides.js');

function makeMockStorage(initial: Record<string, any>) {
    const state: Record<string, any> = { ...initial };
    const calls: any[][] = [];
    const storage: any = {
        calls,
        getExportedIds: async (_slot: string) => ({ ...state }),
        // 模拟生产 removeExportRecords 的关键语义：只删传入名单里的 id，
        // 写链内重读，名单外的并发写入不受影响。
        removeExportRecords: async (slot: string, ids: string[] | null | undefined) => {
            calls.push(['removeExportRecords', slot, ids]);
            let removed = 0;
            for (const id of ids || []) {
                if (id in state) { delete state[id]; removed++; }
            }
            return removed;
        },
        get state() { return state; },
    };
    return storage;
}

test('P1-3: clearExported 走 removeExportRecords(slot, allIds)，不用裸写', async () => {
    ConversationsStore.setCurrentSlot('u0');
    const storage = makeMockStorage({ a: { id: 'a' }, b: { id: 'b' } });
    __setModuleOverride('StorageService', storage);
    try {
        await ConversationsStore.clearExported('u0');

        const dels = storage.calls.filter((c: any[]) => c[0] === 'removeExportRecords');
        assert.strictEqual(dels.length, 1, '应恰好调用一次 removeExportRecords');
        assert.strictEqual(dels[0][1], 'u0');
        assert.deepStrictEqual(new Set(dels[0][2]), new Set(['a', 'b']),
            '应传入当前全部导出 id');

        // 裸写原语在 mock 上根本不存在：若 clearExported 仍走旧路径会直接抛错
        assert.strictEqual(storage.setExportedIds, undefined,
            'storage mock 不应提供 setExportedIds');

        assert.deepStrictEqual(storage.state, {}, 'storage 侧 map 应被清空');
        assert.deepStrictEqual(ConversationsStore.getExportedIds(), {},
            '内存 map 应同步清空');
    } finally {
        __setModuleOverride('StorageService', undefined as any);
    }
});

test('P1-3: 并发 clear + write 不丢失新记录', async () => {
    ConversationsStore.setCurrentSlot('u0');
    const storage = makeMockStorage({ a: { id: 'a' } });
    const origRemove = storage.removeExportRecords;
    storage.removeExportRecords = async (slot: string, ids: string[] | null | undefined) => {
        // 模拟一次在 clear 读名单之后、删执行之前落盘的并发写入
        storage.state['c'] = { id: 'c' };
        return origRemove(slot, ids);
    };
    __setModuleOverride('StorageService', storage);
    try {
        await ConversationsStore.clearExported('u0');
        assert.ok(!('a' in storage.state), '名单内的旧记录应被删除');
        assert.ok('c' in storage.state, '并发写入的新记录不得丢失（旧裸写会整 map 覆盖丢掉它）');
    } finally {
        __setModuleOverride('StorageService', undefined as any);
    }
});

test('StorageService.removeExportRecords: u0 清除时正确从 exportedIds 中移除记录', async () => {
    const StorageService = require('../src/core/storage/storageService.js');
    const store: Record<string, any> = {
        exportedIds: { chat_new: { exportedAt: 100 }, chat_legacy: { exportedAt: 90 } }
    };
    const origChrome = (globalThis as any).chrome;
    (globalThis as any).chrome = {
        storage: {
            local: {
                get: async (keys: string[]) => {
                    const out: Record<string, any> = {};
                    for (const k of keys) {
                        if (k in store) out[k] = store[k];
                    }
                    return out;
                },
                set: async (updates: Record<string, any>) => {
                    Object.assign(store, updates);
                },
                remove: async (keys: string[]) => {
                    for (const k of keys) delete store[k];
                }
            }
        }
    };
    try {
        const before = await StorageService.getExportedIds('u0');
        assert.deepStrictEqual(Object.keys(before).sort(), ['chat_legacy', 'chat_new']);
        await StorageService.removeExportRecords('u0', Object.keys(before));
        const after = await StorageService.getExportedIds('u0');
        assert.deepStrictEqual(after, {}, '清除后 getExportedIds(u0) 必须为空');
        assert.deepStrictEqual(store.exportedIds, {}, 'store.exportedIds 必须为空');
    } finally {
        (globalThis as any).chrome = origChrome;
    }
});

test('ListView.render: 传入 prevSelectedSet=null 时强制重置 canonicalSelectedIds 并自动勾选未导出会话', () => {
    const ListView = require('../src/ui/views/listView.js');
    let innerHTML = '';
    const fakeList: any = {
        addEventListener: () => {}
    };
    Object.defineProperty(fakeList, 'innerHTML', {
        get() { return innerHTML; },
        set(val) { innerHTML = val; }
    });
    const origDoc = (globalThis as any).document;
    try {
        (globalThis as any).document = {
            getElementById: (id: string) => (id === 'list' ? fakeList : null),
            querySelectorAll: () => []
        };
        const convs = [
            { id: 'c_1', title: 'Chat 1', timestamp: 1000 },
            { id: 'c_2', title: 'Chat 2', timestamp: 1000 }
        ];
        // 1. 初始全部已导出，默认 0 勾选（canonicalSelectedIds 为空 Set）
        ListView.setSelectedIds(null);
        ListView.render(convs as any, { '1': { exportedAt: 2000 }, '2': { exportedAt: 2000 } } as any, null);
        assert.strictEqual(ListView.getSelectedIds().size, 0, '全部已导出时初始应 0 勾选');

        // 2. 清除导出记录后传入 expMap={} 与 prevSelectedSet=null，应重新自动全选
        ListView.render(convs as any, {}, null);
        const selectedAfterClear = ListView.getSelectedIds();
        assert.ok(selectedAfterClear.has('1') || selectedAfterClear.has('c_1'), '清除后 Chat 1 应自动勾选');
        assert.ok(selectedAfterClear.has('2') || selectedAfterClear.has('c_2'), '清除后 Chat 2 应自动勾选');
    } finally {
        (globalThis as any).document = origDoc;
    }
});

