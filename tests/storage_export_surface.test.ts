/**
 * Phase A (P1-4) + P1-3 跟进修复的架构测试：存储出口收口。
 *
 * 契约：
 *   1. setExportedIds / setAccountSlots 彻底退出 storageService 公开 surface ——
 *      不再是命名导出，也不在 StorageServiceModule interface 与默认 StorageService
 *      对象上声明。裸写原语不得成为公开 API，对外只走 saveExportRecord /
 *      saveExportRecordsBatch / removeExportRecords / updateAccountSlot
 *      等事务性入口。函数本体仍保留在模块闭包内，供 saveExportRecordsBatch
 *     （锁内回写）与内部 slot 更新使用。
 *   2. _setConversationsRaw 保持模块私有 —— 它从未被导出，本测试防止将来
 *      有人把它重新加进命名导出（裸写原语外泄）。
 *   3. finalizeChatExport 的 storageAdapter 必须实现 saveExportRecord ——
 *      缺失即抛错，不再静默降级到 set/get 或 chrome.storage 直写。
 *   4. conversationsStore.clearExported 必须走 removeExportRecords(slot, allIds)
 *      事务性删除路径，禁止用 setExportedIds(s, {}) 整 map 裸写清零（并发
 *      清记录+写记录的竞态丢失窗口）。
 *
 * 运行: node -r ./tests/ts_register.js --test tests/storage_export_surface.test.ts
 */
export {};
const test = require('node:test');
const assert = require('node:assert');

test('storageService: 裸写 setter 不再是命名导出', () => {
    // 注意：本仓库测试桩（ts_register.js 的 Smart CJS Interop）会把命名导出合并到
    // default 的 StorageService 对象上，导致 require 层面无法区分"命名导出"与
    // "对象属性"。此处做源码级断言 —— 真正的 esbuild 打包会按命名导出解析，
    // 源码里不在 export 块即不可 import。
    const fs = require('node:fs');
    const path = require('node:path');
    const src = fs.readFileSync(
        path.join(__dirname, '../src/core/storage/storageService.ts'), 'utf8');
    const m = src.match(/export\s*\{([\s\S]*?)\};/);
    assert.ok(m, '应找到 export { ... } 命名导出块');
    const blockWithoutComments = m[1].replace(/\/\/[^\n]*/g, '');
    const specifiers = blockWithoutComments.split(',')
        .map((s: string) => s.trim().split(/\s+as\s+/).pop()!.trim())
        .filter(Boolean);

    assert.ok(!specifiers.includes('setExportedIds'),
        'setExportedIds 不得出现在命名导出中');
    assert.ok(!specifiers.includes('setAccountSlots'),
        'setAccountSlots 不得出现在命名导出中');
    assert.ok(!specifiers.includes('_setConversationsRaw'),
        '_setConversationsRaw 必须保持模块私有，不得导出');

    // 事务性入口仍在
    assert.ok(specifiers.includes('saveExportRecord'),
        'saveExportRecord 命名导出必须保留');
    assert.ok(specifiers.includes('getExportedIds'),
        'getExportedIds 命名导出必须保留');

    // 运行时：_setConversationsRaw 在任何可达对象上都不存在
    const mod = require('../src/core/storage/storageService.js');
    assert.strictEqual(mod._setConversationsRaw, undefined,
        '_setConversationsRaw 不得外泄');

    // 裸写原语彻底退出公开 surface：默认对象上也不再挂载
    assert.strictEqual(mod.StorageService.setExportedIds, undefined,
        'StorageService.setExportedIds 不得再挂载');
    assert.strictEqual(mod.StorageService.setAccountSlots, undefined,
        'StorageService.setAccountSlots 不得再挂载');
});

test('finalizeChatExport: storageAdapter 缺 saveExportRecord 即抛错', async () => {
    const SessionRecovery = require('../src/core/engine/export/sessionRecovery.js');

    const recordsMap = new Map();
    recordsMap.set('abc123', { id: 'abc123', title: 'T' });

    await assert.rejects(
        SessionRecovery.finalizeChatExport('abc123', {
            chatRecordsMap: recordsMap,
            // 只有 set/get 的 mock adapter：旧逻辑会静默走降级分支，新逻辑必须抛错
            storageAdapter: {
                set: async () => {},
                get: async () => ({})
            },
            slot: 'u0'
        } as any),
        /adapter must implement finalizeConversationExport or saveExportRecord/,
        '缺少必要接口的 adapter 必须抛错，不得静默降级'
    );
});

test('finalizeChatExport: 正式路径 saveExportRecord 照常工作', async () => {
    const SessionRecovery = require('../src/core/engine/export/sessionRecovery.js');

    const recordsMap = new Map();
    recordsMap.set('abc123', { id: 'abc123', title: 'T' });
    let saved: any = null;

    const ok = await SessionRecovery.finalizeChatExport('abc123', {
        chatRecordsMap: recordsMap,
        storageAdapter: {
            saveExportRecord: async (slot: string, id: string, rec: any) => {
                saved = { slot, id, rec };
            }
        },
        slot: 'u0'
    } as any);

    assert.strictEqual(ok, true);
    assert.ok(saved, '应经 saveExportRecord 保存');
    assert.strictEqual(saved.slot, 'u0');
    assert.strictEqual(saved.id, 'abc123');
});
