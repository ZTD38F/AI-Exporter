export {};
const test = require('node:test');
const assert = require('node:assert');

if (typeof globalThis !== 'undefined' && !(globalThis as any).GeminiProtocol) {
    (globalThis as any).GeminiProtocol = require('../src/core/protocol/protocol.js');
}

const DirHandleController = require('../src/ui/controllers/dirHandleController.js');
const ExportController = require('../src/ui/controllers/exportController.js');
const SyncController = require('../src/ui/controllers/syncController.js');
const TakeoutController = require('../src/ui/controllers/takeoutController.js');
const GeminiUtils = require('../src/core/utils/utils.js');

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
