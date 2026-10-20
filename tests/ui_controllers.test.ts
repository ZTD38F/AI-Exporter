export {};
const test = require('node:test');
const assert = require('node:assert');

const { __setModuleOverride, __getModuleOverride, __resolveModule } = require('../src/core/utils/moduleOverrides.js');
if (!__resolveModule('GeminiProtocol', null)) {
    __setModuleOverride('GeminiProtocol', require('../src/core/protocol/protocol.js'));
}
// Mock I18n with Chinese strings for syncController error message tests
__setModuleOverride('I18n', {
    t: (key: string, ...args: any[]) => {
        const zh: Record<string, string> = {
            'syncConnectionFailedRefresh': '未能与 Gemini 建立连接，请刷新 gemini.google.com 页面后重试',
            'syncFailed': `同步失败: ${args[0] || ''}`,
        };
        return zh[key] || key;
    }
});

const DirHandleController = require('../src/ui/controllers/dirHandleController.js');
const ExportController = require('../src/ui/controllers/exportController.js');
const SyncController = require('../src/ui/controllers/syncController.js');
const TakeoutController = require('../src/ui/controllers/takeoutController.js');
const GeminiUtils = require('../src/core/utils/utils.js');

// Headless Node environment test harness: provide lightweight mock document for UI controllers
if (typeof (globalThis as any).document === 'undefined') {
    (globalThis as any).document = {
        getElementById: () => null,
        querySelectorAll: () => [],
        createElement: () => ({})
    };
}

// ---------------------------------------------------------------------------
// DirHandleController
// ---------------------------------------------------------------------------
test('dirHandleController - exports and in-memory handle state', () => {
    assert.ok(DirHandleController);
    assert.strictEqual(typeof DirHandleController.getStoredDirHandle, 'function');
    assert.strictEqual(typeof DirHandleController.saveStoredDirHandle, 'function');
    assert.strictEqual(typeof DirHandleController.verifyDirPermission, 'function');
    assert.strictEqual(typeof DirHandleController.restoreSavedDirHandle, 'function');
    assert.strictEqual(typeof DirHandleController.requestDirHandle, 'function');
    assert.strictEqual(typeof DirHandleController.getDirHandle, 'function');
    assert.strictEqual(typeof DirHandleController.setDirHandle, 'function');

    const mockHandle = { name: 'my_export_folder' };
    DirHandleController.setDirHandle(mockHandle);
    assert.strictEqual(DirHandleController.getDirHandle(), mockHandle);
    DirHandleController.setDirHandle(null);
    assert.strictEqual(DirHandleController.getDirHandle(), null);
});

// ---------------------------------------------------------------------------
// ExportController
// ---------------------------------------------------------------------------
test('exportController - state machine, flags, and exports', () => {
    assert.strictEqual(typeof ExportController.runExport, 'function');
    assert.strictEqual(typeof ExportController.abort, 'function');
    assert.strictEqual(typeof ExportController.setRunning, 'function');
    assert.strictEqual(typeof ExportController.isRunning, 'function');
    assert.strictEqual(typeof ExportController.getActiveEngine, 'function');

    assert.strictEqual(ExportController.isRunning(), false);
    ExportController.setRunning(true);
    assert.strictEqual(ExportController.isRunning(), true);
    ExportController.setRunning(false);
    assert.strictEqual(ExportController.isRunning(), false);
});

test('ExportController / GeminiUtils.formatExportProgress - formats conversation progress and attachment stats', () => {
    assert.strictEqual(typeof GeminiUtils.formatExportProgress, 'function');

    // Case 1: Active export with chats and attachments in Chinese
    const resZh = GeminiUtils.formatExportProgress({
        current: 2,
        total: 5,
        pct: 40,
        title: 'CAS无法夺取制空权机制',
        assetsDownloaded: 3,
        assetsTotal: 8
    }, '', false);

    assert.strictEqual(resZh.pct, 40);
    assert.ok(resZh.text.includes('导出中 (2/5)'), 'Must include progress count (2/5)');
    assert.ok(resZh.text.includes('CAS无法夺取制空权机制'), 'Must include chat title');
    assert.ok(resZh.text.includes('📎 附件 3/8'), 'Must include attachment count 3/8');

    // Case 2: Active export with English locale
    const resEn = GeminiUtils.formatExportProgress({
        current: 4,
        total: 10,
        pct: 40,
        title: 'Quantum Computing',
        assetsDownloaded: 5,
        assetsTotal: 12
    }, '', true);

    assert.ok(resEn.text.includes('Exporting (4/10)'), 'Must include English progress count (4/10)');
    assert.ok(resEn.text.includes('📎 Assets 5/12'), 'Must include English asset count 5/12');

    // Case 3: Packaging ZIP stage
    const resZip = GeminiUtils.formatExportProgress({
        current: 5,
        total: 5,
        pct: 95,
        title: 'Packaging ZIP file...',
        assetsDownloaded: 8,
        assetsTotal: 8
    }, '', false);

    assert.ok(resZip.text.includes('正在打包 ZIP 文件...'), 'Translates system title');
    assert.ok(resZip.text.includes('📎 附件 8/8'), 'Keeps attachment stats');

    // Case 4: No attachments
    const resNoAssets = GeminiUtils.formatExportProgress({
        current: 1,
        total: 3,
        pct: 33,
        title: 'Simple Chat'
    }, '', false);

    assert.ok(resNoAssets.text.includes('导出中 (1/3)'));
    assert.ok(!resNoAssets.text.includes('📎 附件'), 'Omits attachment text when no assets');

    // Case 5: Legacy numeric progress
    const resLegacy = GeminiUtils.formatExportProgress(60, 'Processing Takeout...');
    assert.strictEqual(resLegacy.pct, 60);
    assert.strictEqual(resLegacy.text, 'Processing Takeout...');
});

// ---------------------------------------------------------------------------
// SyncController
// ---------------------------------------------------------------------------
test('syncController - exports and isScanning state management', () => {
    assert.ok(SyncController);
    assert.strictEqual(typeof SyncController.startIncrementalScan, 'function');
    assert.strictEqual(typeof SyncController.startDeepScan, 'function');
    assert.strictEqual(typeof SyncController.stopScan, 'function');
    assert.strictEqual(typeof SyncController.setScanRunning, 'function');

    SyncController.setScanRunning(true);
    assert.strictEqual(SyncController.isScanning(), true);
    SyncController.setScanRunning(false);
    assert.strictEqual(SyncController.isScanning(), false);
});

test('syncController - formats Receiving end does not exist with friendly refresh hint', () => {
    const fn = (SyncController as any).formatSyncErrorMessage;
    assert.strictEqual(typeof fn, 'function');

    const rawErr = 'Could not establish connection. Receiving end does not exist.';
    const formatted = fn(rawErr);
    assert.ok(
        formatted.includes('刷新') && formatted.includes('未能与 Gemini 建立连接'),
        `Formatted error should hint user to refresh gemini, got: ${formatted}`
    );

    const normalErr = 'HTTP 503 Service Unavailable';
    const formattedNormal = fn(normalErr);
    assert.ok(
        formattedNormal.includes('503'),
        `Normal error should preserve original error info, got: ${formattedNormal}`
    );
});

test('syncController - startIncrementalScan dispatches friendly message on connection error', async () => {
    const origChrome = (globalThis as any).chrome;
    try {
        let loggedMsg = '';
        let loggedLevel = '';
        let errorMsg = '';

        (globalThis as any).chrome = {
            runtime: {
                lastError: null,
                sendMessage: (_msg: any, cb: any) => {
                    cb({
                        success: false,
                        error: 'Could not establish connection. Receiving end does not exist.'
                    });
                }
            }
        };

        await new Promise<void>((resolve) => {
            SyncController.startIncrementalScan('u0', {
                onLog: (msg: string, lvl: string) => {
                    loggedMsg = msg;
                    loggedLevel = lvl;
                },
                onError: (_err: any, errMsg: string) => {
                    errorMsg = errMsg;
                    resolve();
                }
            });
        });

        assert.strictEqual(loggedLevel, 'error');
        assert.ok(
            loggedMsg.includes('刷新') && loggedMsg.includes('未能与 Gemini 建立连接'),
            `Log should contain friendly refresh prompt, got: ${loggedMsg}`
        );
        assert.strictEqual(errorMsg, loggedMsg);
    } finally {
        (globalThis as any).chrome = origChrome;
    }
});

// ---------------------------------------------------------------------------
// TakeoutController
// ---------------------------------------------------------------------------
test('takeoutController - exports and gracefully handles null file', async () => {
    assert.ok(TakeoutController);
    assert.strictEqual(typeof TakeoutController.handleTakeoutImport, 'function');

    let called = false;
    await TakeoutController.handleTakeoutImport(null as any, {
        onFinished: () => { called = true; }
    });
    assert.strictEqual(called, false);
});

test('takeoutController - merges via SSoT dedupe: same-id seeds takeout slot, new ids sorted', async () => {
    const onlineMessages = ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8'];
    const existing = [
        { id: 'chat-online-1', title: 'Online Title', titleSource: 'rpc', titles: { rpc: 'Online Title' }, messages: onlineMessages, messageCount: 8, updatedAt: 2000, timestamp: 2000, lastSeen: '2026-09-10T12:00:00.000Z' },
    ];
    let saved: any = null;
    let saveCalls = 0;
    const origStore = __getModuleOverride('ConversationsStore');
    const origEngine = __getModuleOverride('TakeoutEngine');
    const origStorage = __getModuleOverride('StorageService');
    __setModuleOverride('ConversationsStore', {
        getConversations: () => existing,
        getCurrentSlot: () => 'u0',
        setConversations: (list: any) => { saved = list; },
    });
    __setModuleOverride('StorageService', {
        transactConversations: async (_slot: string, updater: any) => {
            const plan = updater(existing);
            if (!plan) return { list: existing, changed: 0, written: false };
            saved = plan.list;
            saveCalls++;
            return { list: plan.list, changed: plan.changed, written: true };
        },
        setTakeoutPromptCompleted: async () => {},
        setHasImportedTakeout: async () => {}
    });
    __setModuleOverride('TakeoutEngine', {
        parseTakeoutZip: async () => ({
            conversations: [
                { id: 'chat-online-1', title: 'Takeout Prefix Question', titleSource: 'takeout', titles: { takeout: 'Takeout Prefix' }, messageCount: 2, updatedAt: 1000, timestamp: 1000, lastSeen: '2026-09-01T12:00:00.000Z' },
                { id: 'chat-takeout-old', title: 'Old Takeout', titleSource: 'takeout', titles: { takeout: 'Old Takeout' }, updatedAt: 500, timestamp: 500 },
                { id: 'chat-takeout-fresh', title: 'Fresh Takeout', titleSource: 'takeout', titles: { takeout: 'Fresh Takeout' }, updatedAt: 3000, timestamp: 3000 },
            ],
            totalMediaCount: 0,
        }),
    });
    try {
        let result: any = null;
        await TakeoutController.handleTakeoutImport({} as any, {
            onFinished: (r: any) => { result = r; }
        });
        assert.strictEqual(result.addedCount, 2);
        assert.strictEqual(saveCalls, 1, 'changed import must persist once');
        assert.ok(Array.isArray(saved));
        assert.strictEqual(saved.length, 3);
        const sameId = saved.find((c: any) => c.id === 'chat-online-1');
        assert.ok(sameId, 'same-id conversation must be merged, not dropped');
        assert.strictEqual(sameId.title, 'Online Title');
        assert.strictEqual(sameId.titleSource, 'rpc');
        assert.strictEqual(sameId.titles && sameId.titles.takeout, 'Takeout Prefix Question');
        assert.strictEqual(sameId.messageCount, 8, 'stale takeout snapshot must not shrink messageCount');
        assert.deepStrictEqual(sameId.messages, onlineMessages, 'stale takeout snapshot must not replace messages');
        assert.strictEqual(sameId.lastSeen, '2026-09-10T12:00:00.000Z', 'stale takeout snapshot must not rewind lastSeen');
        assert.deepStrictEqual(
            saved.map((c: any) => c.id),
            ['chat-takeout-fresh', 'chat-online-1', 'chat-takeout-old']
        );
    } finally {
        __setModuleOverride('ConversationsStore', origStore);
        __setModuleOverride('TakeoutEngine', origEngine);
        __setModuleOverride('StorageService', origStorage);
    }
});

test('takeoutController - zero-change re-import does not rewrite the store', async () => {
    const existing = [
        { id: 'chat-1', title: 'Same Title', titleSource: 'takeout', titles: { takeout: 'Same Title' }, messageCount: 2, updatedAt: 1000, timestamp: 1000 },
    ];
    let saveCalls = 0;
    const origStore = __getModuleOverride('ConversationsStore');
    const origEngine = __getModuleOverride('TakeoutEngine');
    const origStorage = __getModuleOverride('StorageService');
    __setModuleOverride('ConversationsStore', {
        getConversations: () => existing,
        getCurrentSlot: () => 'u0',
    });
    __setModuleOverride('StorageService', {
        transactConversations: async (_slot: string, updater: any) => {
            const plan = updater(existing);
            if (!plan) return { list: existing, changed: 0, written: false };
            saveCalls++;
            return { list: plan.list, changed: plan.changed, written: true };
        },
        setTakeoutPromptCompleted: async () => {},
        setHasImportedTakeout: async () => {}
    });
    __setModuleOverride('TakeoutEngine', {
        parseTakeoutZip: async () => ({
            conversations: [
                { id: 'chat-1', title: 'Same Title', titleSource: 'takeout', titles: { takeout: 'Same Title' }, messageCount: 2, updatedAt: 1000, timestamp: 1000 },
            ],
            totalMediaCount: 0,
        }),
    });
    try {
        let result: any = null;
        await TakeoutController.handleTakeoutImport({} as any, {
            onFinished: (r: any) => { result = r; }
        });
        assert.strictEqual(result.addedCount, 0);
        assert.strictEqual(saveCalls, 0, 'zero-change import must not rewrite the store');
    } finally {
        __setModuleOverride('ConversationsStore', origStore);
        __setModuleOverride('TakeoutEngine', origEngine);
        __setModuleOverride('StorageService', origStorage);
    }
});
