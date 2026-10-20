// tests/write_failure_semantics.test.ts
// Phase A (P0-1): writeFileDirect 抛错语义回归测试。
// 覆盖四类：
//   1. 主 md 写失败 -> 会话记 failed，不标 success，无成功导出记录（可重试）
//   2. doc-md 写失败 -> 进入 failedAttachments，记录为 partial
//   3. index 写失败 -> fail-closed，run() 外抛
//   4. diagnostics 写失败 -> 用户可见（onLog error），不外抛，不污染资产失败账目
export {};
const test = require('node:test');
const assert = require('node:assert');

const { ExportOrchestrator } = require('../src/core/engine/export/exportOrchestrator.js');
const { __setModuleOverride } = require('../src/core/utils/moduleOverrides.js');

// 按文件名决定是否抛错的 MockJSZip
function setupFailingJSZip(shouldFail: (path: string) => boolean) {
    __setModuleOverride('JSZip', class MockJSZip {
        files: Record<string, any> = {};
        folder(_name: string) {
            const self = this;
            return {
                file: (path: string, content: any) => {
                    if (shouldFail(path)) {
                        throw new Error(`mock disk failure: ${path}`);
                    }
                    self.files[path] = content;
                }
            };
        }
        async generateAsync(_options?: any, cb?: (p: { percent: number }) => void) {
            if (cb) cb({ percent: 100 });
            return new Blob(['mock-zip'], { type: 'application/zip' });
        }
    });
}

// 内存 StorageService：必须实现 saveExportRecord（finalize fail-closed）
function setupMockStorage() {
    const mem: Record<string, any> = {};
    __setModuleOverride('StorageService', {
        getExportedIds: async (_slot: string) => ({}),
        saveExportRecord: async (_slot: string, id: string, rec: any) => {
            mem[id] = rec;
            return { ...mem };
        },
    });
    return mem;
}

function makeWorker(chatOverrides: any = {}) {
    return {
        fetchChatDetail: async (requestedItem: any) => ({
            success: true,
            chat: {
                id: requestedItem.id,
                title: requestedItem.title,
                messages: [{ role: 'user', content: 'Hello' }],
                ...chatOverrides
            },
            listTitle: requestedItem.title
        })
    };
}

function collectLogs() {
    const logs: Array<{ msg: string; level?: string }> = [];
    return {
        logs,
        onLog: (msg: string, level?: string) => logs.push({ msg, level }),
        errorLogs: () => logs.filter(l => l.level === 'error')
    };
}

// 1. 主 md 写失败 -> failed，不标 success，无导出记录（下次可重试）
test('write-failure semantics - main markdown write failure marks chat failed, never success', async () => {
    setupFailingJSZip((p) => /\.md$/.test(p) && !p.includes('00_INDEX'));
    const mem = setupMockStorage();
    const { logs, onLog, errorLogs } = collectLogs();
    const orchestrator = new ExportOrchestrator();

    const result = await orchestrator.run({
        selected: [{ id: 'chat-main-fail', title: 'Main Fail Chat' }],
        format: 'markdown',
        useZip: true,
        includeAssets: false,
        worker: makeWorker()
    }, { onLog });

    assert.strictEqual(result.landedChats, 0, 'failed main-md must not count as landed');
    assert.strictEqual(result.exportedCount, 0);
    assert.strictEqual(result.failedChats.length, 1, 'chat must be recorded as failed');
    assert.strictEqual(result.failedChats[0].id, 'chat-main-fail');
    assert.ok(result.failedChats[0].error && result.failedChats[0].error.length > 0, 'real error must be saved, not swallowed');
    // 无导出记录 -> 增量导出不会跳过它，可重试
    assert.strictEqual(mem['chat-main-fail'], undefined, 'no export record may be persisted for a failed main-md');
    // 用户可见
    assert.ok(errorLogs().length > 0, 'failure must surface as user-visible error log');
    void logs;
});

// 2. doc-md 写失败 -> failedAttachments，记录为 partial（主 md 成功）
test('write-failure semantics - doc-md write failure lands in failedAttachments with partial record', async () => {
    setupFailingJSZip((p) => p.includes('doc_fail.md'));
    const mem = setupMockStorage();
    const { onLog } = collectLogs();
    const orchestrator = new ExportOrchestrator();

    const result = await orchestrator.run({
        selected: [{ id: 'chat-doc-fail', title: 'Doc Fail Chat' }],
        format: 'markdown',
        useZip: true,
        includeAssets: true,
        worker: makeWorker({
            messages: [{
                role: 'user',
                content: 'see attached',
                attachments: [{ type: 'file', localName: 'doc_fail.md', contentMarkdown: '# failing doc' }]
            }]
        })
    }, { onLog });

    assert.strictEqual(result.landedChats, 1, 'main md succeeded, chat lands');
    assert.strictEqual(result.failedChats.length, 0, 'chat itself is not failed');
    assert.strictEqual(result.failedAttachments.length, 1, 'doc-md failure must be tracked');
    assert.strictEqual(result.failedAttachments[0].file, 'doc_fail.md');
    const rec = mem['chat-doc-fail'];
    assert.ok(rec, 'export record must exist');
    assert.strictEqual(rec.status, 'partial', 'record with failed assets must be partial, never ok');
    assert.strictEqual(rec.hasFailedAssets, true);
});

// 3. index 写失败 -> fail-closed，run() 外抛
test('write-failure semantics - index write failure fails closed (run rejects)', async () => {
    setupFailingJSZip((p) => p.includes('00_INDEX.md'));
    setupMockStorage();
    const { onLog, errorLogs } = collectLogs();
    const orchestrator = new ExportOrchestrator();

    await assert.rejects(
        orchestrator.run({
            selected: [{ id: 'chat-index-fail', title: 'Index Fail Chat' }],
            format: 'markdown',
            useZip: true,
            includeAssets: false,
            includeIndex: true,
            worker: makeWorker()
        }, { onLog }),
        /00_INDEX/,
        'index write failure must propagate out of run() (fail-closed)'
    );
    assert.ok(errorLogs().length > 0, 'index failure must be user-visible before rethrow');
});

// 4. diagnostics 写失败 -> 用户可见，不外抛，不污染资产失败账目
test('write-failure semantics - diagnostics write failure is visible but never pollutes asset ledger', async () => {
    // 主 md 失败 -> 触发 diagnostics 写入；同时让 _export_dev.log 也失败
    setupFailingJSZip((p) => (/\.md$/.test(p) && !p.includes('00_INDEX')) || p.includes('_export_dev.log'));
    setupMockStorage();
    const { onLog, errorLogs } = collectLogs();
    const orchestrator = new ExportOrchestrator();

    // 必须 resolve，不能 reject（diagnostics 是 best-effort）
    const result = await orchestrator.run({
        selected: [{ id: 'chat-diag-fail', title: 'Diag Fail Chat' }],
        format: 'markdown',
        useZip: true,
        includeAssets: false,
        worker: makeWorker()
    }, { onLog });

    assert.strictEqual(result.failedChats.length, 1, 'main-md failure still recorded');
    assert.strictEqual(result.failedAttachments.length, 0, 'diagnostics failure must not pollute the asset failure ledger');
    assert.ok(errorLogs().length > 0, 'diagnostics failure must still be user-visible');
});
