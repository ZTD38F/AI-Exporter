export {};
const test = require('node:test');
const assert = require('node:assert');
const { __setModuleOverride, __clearModuleOverrides } = require('../src/core/utils/moduleOverrides.js');

// ---------------------------------------------------------------------------
// Regression: optionsExport's onTitleUpdated used to be a pure in-memory dirty
// write — it mutated the object returned by Store.getConversations() but never
// wrote the new title back to storage, so the title was lost on page reload.
// The handler logic now lives in the exported `persistTitleUpdate`, which must
// update the in-memory item AND persist via storageService.updateConversation
// (the same atomic read-modify-write path the export chain uses).
// ---------------------------------------------------------------------------

test.afterEach(() => {
    __clearModuleOverrides();
});

function seedConversation() {
    return { id: 'c_aaa111', title: '旧标题', titleSource: 'dom', titles: { dom: '旧标题' } };
}

let memConvs: any[];
let storedConvs: any[];
let updateCalls: Array<{ slot: string; id: string }>;

function installMocks() {
    memConvs = [seedConversation()];
    // stored copy is a separate object, like the real chrome.storage.local copy
    storedConvs = [JSON.parse(JSON.stringify(seedConversation()))];
    updateCalls = [];
    __setModuleOverride('ConversationsStore', {
        getConversations: () => memConvs,
        getCurrentSlot: () => 'u0',
    });
    __setModuleOverride('StorageService', {
        updateConversation: async (slot: string, id: string, updater: (c: any) => void) => {
            updateCalls.push({ slot, id });
            const target = storedConvs.find((c) => c && c.id === id);
            if (!target) return false;
            updater(target);
            return true;
        },
    });
}

function loadPersistTitleUpdate(): (chatId: string, newTitle: string, source: string, exportSlot?: string) => Promise<void> {
    const mod = require('../src/ui/options/modules/optionsExport.js');
    // NOTE: requiring the module transitively loads conversationsStore.ts and
    // storageService.ts, but their self-registration only touches the legacy
    // globalThis entry — the explicit overrides installed above keep priority,
    // so the mocks stay effective without re-installing (this re-install hack
    // was the old globalThis clobbering this seam was built to eliminate).
    assert.strictEqual(
        typeof mod.persistTitleUpdate,
        'function',
        'persistTitleUpdate is not exported: title updates are still in-memory only'
    );
    return mod.persistTitleUpdate;
}

test('persistTitleUpdate updates in-memory item AND persists title to storage', async () => {
    installMocks();
    const persistTitleUpdate = loadPersistTitleUpdate();

    await persistTitleUpdate('c_aaa111', '从RPC解析到的新标题', 'rpc');

    // existing behavior: in-memory item reflects the arbitrated title
    assert.strictEqual(memConvs[0].title, '从RPC解析到的新标题');
    assert.strictEqual(memConvs[0].titles.rpc, '从RPC解析到的新标题');

    // the fix: the stored copy must carry the new title too (survives reload)
    assert.strictEqual(updateCalls.length, 1, 'expected exactly one atomic storage write');
    assert.strictEqual(updateCalls[0].slot, 'u0');
    assert.strictEqual(updateCalls[0].id, 'c_aaa111');
    assert.strictEqual(storedConvs[0].title, '从RPC解析到的新标题');
    assert.strictEqual(storedConvs[0].titles.rpc, '从RPC解析到的新标题');
});

test('persistTitleUpdate ignores non-real titles (no storage write)', async () => {
    installMocks();
    const persistTitleUpdate = loadPersistTitleUpdate();

    await persistTitleUpdate('c_aaa111', 'Gemini', 'rpc');

    assert.strictEqual(memConvs[0].title, '旧标题');
    assert.strictEqual(updateCalls.length, 0, 'brand placeholder must not trigger a storage write');
    assert.strictEqual(storedConvs[0].title, '旧标题');
});

test('persistTitleUpdate ignores unknown ids (no storage write)', async () => {
    installMocks();
    const persistTitleUpdate = loadPersistTitleUpdate();

    await persistTitleUpdate('c_nope999', '某个新标题', 'rpc');

    assert.strictEqual(updateCalls.length, 0);
    assert.strictEqual(storedConvs[0].title, '旧标题');
});

test('persistTitleUpdate still updates memory when storage write is unavailable', async () => {
    installMocks();
    const persistTitleUpdate = loadPersistTitleUpdate();
    // break storage AFTER the mocks are installed above: no updateConversation
    __setModuleOverride('StorageService', {});

    await persistTitleUpdate('c_aaa111', '从RPC解析到的新标题', 'rpc');

    assert.strictEqual(memConvs[0].title, '从RPC解析到的新标题');
    assert.strictEqual(storedConvs[0].title, '旧标题');
});

test('late export title callback persists to its original slot without touching the selected slot', async () => {
    installMocks();
    const visible = { id: 'c_aaa111', title: 'Other account title' };
    __setModuleOverride('ConversationsStore', {
        getConversations: () => [visible],
        getCurrentSlot: () => 'u1',
    });
    const persistTitleUpdate = loadPersistTitleUpdate();
    await persistTitleUpdate('c_aaa111', 'Original account title', 'rpc', 'u0');
    assert.strictEqual(visible.title, 'Other account title');
    assert.deepStrictEqual(updateCalls, [{ slot: 'u0', id: 'c_aaa111' }]);
});
