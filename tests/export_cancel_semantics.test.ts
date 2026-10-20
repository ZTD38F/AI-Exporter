// tests/export_cancel_semantics.test.ts
// B3: 取消语义 —— 取消是用户意图，不记失败、不写 _export_errors.json、无下载回调。
// 覆盖三类：
//   1. 用户取消（AbortError）：failedChats 为空、无下载回调、不写错误文件
//   2. 权限被收回（ExportPipelineError + isPermissionRevoked）：记一条真实失败，仍无下载
//   3. B2: 限流退避可被取消打断 —— abortableSleep 让 30s 退避在取消后即时结束
export {};
const test = require('node:test');
const assert = require('node:assert');

const { ExportOrchestrator } = require('../src/core/engine/export/exportOrchestrator.js');
const { __setModuleOverride } = require('../src/core/utils/moduleOverrides.js');

// 不失败的 MockJSZip（记录写入文件，用于断言 _export_errors.json 未产生）
function setupMockJSZip() {
    const seen: string[] = [];
    __setModuleOverride('JSZip', class MockJSZip {
        files: Record<string, any> = {};
        folder(_name: string) {
            const self = this;
            return {
                file: (path: string, content: any) => {
                    seen.push(path);
                    self.files[path] = content;
                }
            };
        }
        async generateAsync(_options?: any, cb?: (p: { percent: number }) => void) {
            if (cb) cb({ percent: 100 });
            return new Blob(['mock-zip'], { type: 'application/zip' });
        }
    });
    return seen;
}

// 抛 NotAllowedError 的 MockJSZip（模拟目录句柄权限被收回）
function setupPermissionRevokedJSZip() {
    __setModuleOverride('JSZip', class MockJSZip {
        files: Record<string, any> = {};
        folder(_name: string) {
            const self = this;
            return {
                file: (path: string, content: any) => {
                    if (/\.md$/.test(path)) {
                        throw new DOMException('Permission denied', 'NotAllowedError');
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

function collectLogs() {
    const logs: Array<{ msg: string; level?: string }> = [];
    return {
        logs,
        onLog: (msg: string, level?: string) => logs.push({ msg, level }),
    };
}

function baseOptions(overrides: any = {}) {
    return {
        selected: [
            { id: 'chat-cancel-1', title: 'Cancel Chat 1' },
            { id: 'chat-cancel-2', title: 'Cancel Chat 2' }
        ],
        format: 'markdown',
        useZip: true,
        includeAssets: false,
        concurrency: 1,
        ...overrides
    };
}

// 1. 用户取消：第二个会话在 resolveChat 阶段（抓取完、写入前）被取消 ——
// writeFileDirect 入口抛原生 AbortError，取消不记失败、无下载、不写错误文件
test('cancel semantics - user cancel mid-export: no failedChats, no download, no error file', async () => {
    const seenFiles = setupMockJSZip();
    setupMockStorage();
    const { onLog } = collectLogs();
    const orchestrator = new ExportOrchestrator();
    let downloadCalls = 0;

    const worker = {
        fetchChatDetail: async (requestedItem: any) => ({
            success: true,
            chat: {
                id: requestedItem.id,
                title: requestedItem.title,
                messages: [{ role: 'user', content: 'Hello' }]
            }
        }),
        // 注入点：抓取完成、主 md 写入前 —— 用户点了取消
        resolveChat: async (chat: any, _requestedItem: any) => {
            if (chat.id === 'chat-cancel-2') {
                orchestrator.abort();
            }
            return {
                chat,
                listTitle: chat.title,
                displayTitle: chat.title,
                isError: false,
                errMsg: null,
                isConfirmedDeleted: false,
                convsNeedSave: false
            };
        }
    };

    const result = await orchestrator.run(baseOptions({
        worker,
        downloadHandler: async (_blob: Blob, _name: string) => { downloadCalls++; }
    }), { onLog });

    assert.strictEqual(result.aborted, true, 'result must carry aborted:true');
    assert.strictEqual(result.landedChats, 1, 'chat 1 landed before cancel');
    assert.strictEqual(result.failedChats.length, 0, 'cancel must not be recorded as failure');
    assert.strictEqual(result.failedAttachments.length, 0, 'cancel must not pollute attachment failures');
    assert.strictEqual(downloadCalls, 0, 'cancel must not trigger the download callback');
    assert.ok(
        !seenFiles.some(p => /_export_errors\.json$/.test(p)),
        'cancel must not write _export_errors.json'
    );
});

// 2. 权限被收回：ExportPipelineError(isPermissionRevoked) —— 真实失败，记一条；仍无下载
test('cancel semantics - permission revoked: one real failure recorded, still no download', async () => {
    setupPermissionRevokedJSZip();
    setupMockStorage();
    const { onLog } = collectLogs();
    const orchestrator = new ExportOrchestrator();
    let downloadCalls = 0;

    const worker = {
        fetchChatDetail: async (requestedItem: any) => ({
            success: true,
            chat: {
                id: requestedItem.id,
                title: requestedItem.title,
                messages: [{ role: 'user', content: 'Hello' }]
            }
        })
    };

    const result = await orchestrator.run(baseOptions({
        selected: [{ id: 'chat-revoked-1', title: 'Revoked Chat' }],
        worker,
        downloadHandler: async (_blob: Blob, _name: string) => { downloadCalls++; }
    }), { onLog });

    assert.strictEqual(result.aborted, true);
    assert.strictEqual(result.failedChats.length, 1, 'permission revocation is a real failure');
    assert.strictEqual(
        result.failedChats[0].error, 'Aborted due to permission revocation',
        'must distinguish permission-revoked from user-cancel'
    );
    assert.strictEqual(downloadCalls, 0, 'revoked run must not trigger the download callback');
});

// 3. B2: 限流退避可被取消打断 —— 30s 退避在取消后即时结束，不傻等
test('cancel semantics - rate-limit backoff is abortable (no 30s stall on cancel)', async () => {
    setupMockJSZip();
    setupMockStorage();
    const { onLog } = collectLogs();
    const orchestrator = new ExportOrchestrator();
    let downloadCalls = 0;

    // 始终判限流、退避 30s：若 abortableSleep 未接 signal，这里会卡 30s
    orchestrator.rateLimiter = {
        rateLimitCooldownUntil: 0,
        isRateLimited: () => true,
        calculateBackoff: () => 30000,
        recordRateLimit: () => {}
    };

    let fetchCalls = 0;
    const worker = {
        fetchChatDetail: async (requestedItem: any) => {
            fetchCalls++;
            if (fetchCalls === 1) {
                setTimeout(() => orchestrator.abort(), 50);
            }
            return { success: false, error: 'rate limited' };
        }
    };

    const startedAt = Date.now();
    const result = await orchestrator.run(baseOptions({
        selected: [{ id: 'chat-backoff-1', title: 'Backoff Chat' }],
        worker,
        downloadHandler: async (_blob: Blob, _name: string) => { downloadCalls++; }
    }), { onLog });
    const elapsed = Date.now() - startedAt;

    assert.ok(elapsed < 15000, `backoff must be interrupted by cancel (took ${elapsed}ms)`);
    assert.strictEqual(result.aborted, true);
    assert.strictEqual(result.failedChats.length, 0, 'cancel during backoff must not be recorded as failure');
    assert.strictEqual(downloadCalls, 0);
});
