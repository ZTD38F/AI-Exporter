/**
 * Phase A (P1-2) 回归测试：partial 记录可重试。
 *
 * 契约：
 *   1. 坏 base64 附件 -> handleLiveSaveViaHandle 返回 ok:false + failedAssets，
 *      导出记录标 status:'partial' + hasFailedAssets:true（不再静默标成功）。
 *   2. checkIsUpdated 对 partial 记录永远返回 true —— 即使会话时间戳未变化，
 *      下次增量也不得跳过，保证失败附件可重试。
 *
 * 运行: node -r ./tests/ts_register.js --test tests/partial_retry.test.ts
 */
export {};
const test = require('node:test');
const assert = require('node:assert');

function mockChromeStorage() {
    const origChrome = (global as any).chrome;
    (global as any).chrome = {
        storage: {
            local: {
                get: async () => ({ live_save_config: {} }),
                set: async () => {}
            }
        }
    };
    return () => { (global as any).chrome = origChrome; };
}

function mockDirHandle(writtenFiles: Record<string, any>) {
    const mockAssetsDir = {
        name: 'assets',
        getFileHandle: async (name: string) => ({
            createWritable: async () => ({
                write: async (content: any) => { writtenFiles[`assets/${name}`] = content; },
                close: async () => {}
            })
        })
    };
    const mockBatchDir = {
        name: 'gemini_export',
        getFileHandle: async (name: string) => ({
            createWritable: async () => ({
                write: async (content: any) => { writtenFiles[name] = content; },
                close: async () => {}
            })
        }),
        getDirectoryHandle: async () => mockAssetsDir
    };
    return {
        name: 'UserSelectedFolder',
        queryPermission: async () => 'granted',
        getDirectoryHandle: async () => mockBatchDir
    };
}

test('坏 base64 附件 -> ok:false + failedAssets + partial 记录', async () => {
    const { handleLiveSaveViaHandle } = require('../src/background/liveSaveHandler.js');
    const idbStore = require('../src/core/storage/idbHandleStore.js');
    const storageMod = require('../src/core/storage/storageService.js');

    const writtenFiles: Record<string, any> = {};
    const origGetHandle = idbStore.getStoredDirHandle;
    idbStore.getStoredDirHandle = async () => mockDirHandle(writtenFiles);
    const origSave = storageMod.StorageService.saveExportRecord;
    let savedRecord: any = null;
    storageMod.StorageService.saveExportRecord = async (slot: string, nid: string, rec: any) => {
        savedRecord = { slot, nid, rec };
    };
    const restoreChrome = mockChromeStorage();

    try {
        const res = await handleLiveSaveViaHandle({
            chat: {
                title: 'Bad Asset Chat',
                messages: [{ role: 'user', content: 'hi' }]
            },
            safeTitle: 'Bad Asset Chat',
            nid: 'c_abcdef1234567890',
            assets: [
                // 纯非法 base64 字符：Node 的 Buffer.from 会解码出空 buffer，
                // 走 "no valid binary data" 失败路径（浏览器 atob 则直接抛错，
                // 同样进 failedAssets）
                { fileName: 'bad_img.png', subDir: 'assets', base64: '!!!' }
            ]
        }, 'u0');

        assert.strictEqual(res.ok, false, '坏 base64 附件应使 ok=false');
        assert.ok(Array.isArray(res.failedAssets) && res.failedAssets.length === 1,
            'failedAssets 应累积该附件');
        assert.strictEqual(res.failedAssets[0].file, 'bad_img.png');
        assert.ok(res.targetFile && res.targetFile in writtenFiles, '主 md 应照常落盘');
        assert.ok(savedRecord, '应写导出记录');
        assert.strictEqual(savedRecord.rec.status, 'partial');
        assert.strictEqual(savedRecord.rec.hasFailedAssets, true);
    } finally {
        idbStore.getStoredDirHandle = origGetHandle;
        storageMod.StorageService.saveExportRecord = origSave;
        restoreChrome();
    }
});

test('全部附件成功 -> ok:true 且记录不带 partial', async () => {
    const { handleLiveSaveViaHandle } = require('../src/background/liveSaveHandler.js');
    const idbStore = require('../src/core/storage/idbHandleStore.js');
    const storageMod = require('../src/core/storage/storageService.js');

    const writtenFiles: Record<string, any> = {};
    const origGetHandle = idbStore.getStoredDirHandle;
    idbStore.getStoredDirHandle = async () => mockDirHandle(writtenFiles);
    const origSave = storageMod.StorageService.saveExportRecord;
    let savedRecord: any = null;
    storageMod.StorageService.saveExportRecord = async (slot: string, nid: string, rec: any) => {
        savedRecord = { slot, nid, rec };
    };
    const restoreChrome = mockChromeStorage();

    try {
        const res = await handleLiveSaveViaHandle({
            chat: {
                title: 'Good Chat',
                messages: [{ role: 'user', content: 'hi' }]
            },
            safeTitle: 'Good Chat',
            nid: 'c_abcdef1234567890',
            assets: [
                { fileName: 'good_img.png', subDir: 'assets', base64: Buffer.from('img-bytes').toString('base64') }
            ]
        }, 'u0');

        assert.strictEqual(res.ok, true, '附件全成功时 ok 应为 true');
        assert.ok(savedRecord, '应写导出记录');
        assert.strictEqual(savedRecord.rec.status, 'ok', '成功记录应清除旧 partial 状态');
        assert.strictEqual(savedRecord.rec.hasFailedAssets, false);

        const partial = await handleLiveSaveViaHandle({
            chat: { title: 'Good Chat', messages: [{ role: 'user', content: 'hi' }] },
            safeTitle: 'Good Chat', nid: 'c_abcdef1234567890', assets: [],
            failedAssets: [{ file: 'missing.png', error: 'image download returned no bytes' }]
        }, 'u0');
        assert.strictEqual(partial.ok, false, '后台必须保留内容脚本下载失败');
        assert.strictEqual(savedRecord.rec.status, 'partial');
        assert.strictEqual(savedRecord.rec.hasFailedAssets, true);

    } finally {
        idbStore.getStoredDirHandle = origGetHandle;
        storageMod.StorageService.saveExportRecord = origSave;
        restoreChrome();
    }
});

test('checkIsUpdated: partial 记录即使时间戳未变化也判 true', async () => {
    const { checkIsUpdated } = require('../src/core/utils/titleUtils.js');
    // 会话时间戳 1000，记录 exportedAt=5000：无 partial 守卫时会因"导出新鲜锁"判 false（跳过）
    const c = { id: 'chat-p', timestamp: 1000, updatedAt: 1000 };
    const partialRec = {
        exportedAt: new Date(5000).toISOString(),
        status: 'partial',
        hasFailedAssets: true
    };
    assert.strictEqual(checkIsUpdated(c, partialRec), true,
        'partial 记录必须判 true，否则失败附件永远得不到重试');

    // 仅 hasFailedAssets（无 status）同样判 true
    assert.strictEqual(
        checkIsUpdated(c, { exportedAt: new Date(5000).toISOString(), hasFailedAssets: true }),
        true, 'hasFailedAssets 单独也应判 true');

    // 对照：干净记录在同样时间戳下判 false（增量可跳过）
    assert.strictEqual(
        checkIsUpdated(c, { exportedAt: new Date(5000).toISOString(), status: 'success' }),
        false, '干净记录在时间戳未变化时应判 false');
});
