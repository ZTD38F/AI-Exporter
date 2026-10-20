export {};
const test = require('node:test');
const assert = require('node:assert');

const { ExportOrchestrator, AsyncQueue } = require('../src/core/engine/export/exportOrchestrator.js');
const { RateLimitManager, isRateLimited, calculateBackoff } = require('../src/core/engine/export/rateLimiter.js');
const { BatchWorker, formatDebugInfo } = require('../src/core/engine/export/batchWorker.js');
const { ChatFormatter } = require('../src/core/engine/chatFormatter.js');
const { __setModuleOverride, __getModuleOverride } = require('../src/core/utils/moduleOverrides.js');

// ---------------------------------------------------------------------------
// AsyncQueue
// ---------------------------------------------------------------------------
test('AsyncQueue - push, pop, length, FIFO order, and close', async () => {
    const queue = new AsyncQueue();
    assert.strictEqual(queue.length, 0);

    queue.push('task-1');
    queue.push('task-2');
    assert.strictEqual(queue.length, 2);

    const item1 = await queue.pop();
    assert.strictEqual(item1, 'task-1');
    assert.strictEqual(queue.length, 1);

    const item2 = await queue.pop();
    assert.strictEqual(item2, 'task-2');
    assert.strictEqual(queue.length, 0);

    // Test waiting on empty queue
    let popResolved = false;
    const popPromise = queue.pop().then((val: any) => {
        popResolved = true;
        return val;
    });
    assert.strictEqual(popResolved, false);

    queue.push('task-3');
    const item3 = await popPromise;
    assert.strictEqual(item3, 'task-3');

    // Test close
    const closeWaitPromise = queue.pop();
    queue.close();
    const itemAfterClose = await closeWaitPromise;
    assert.strictEqual(itemAfterClose, null);
    assert.strictEqual(await queue.pop(), null);

    // Test pushing to closed queue returns false
    assert.strictEqual(queue.push('task-after-close'), false, 'pushing to closed queue must return false');
});

// ---------------------------------------------------------------------------
// RateLimitManager
// ---------------------------------------------------------------------------
test('RateLimitManager - detect rate limit and exponential backoff', async () => {
    assert.strictEqual(isRateLimited({ success: false, status: 429 }), true);
    assert.strictEqual(isRateLimited({ success: false, error: 'Quota exceeded: too many requests' }), true);
    assert.strictEqual(isRateLimited({ success: true, status: 200 }), false);
    assert.strictEqual(isRateLimited({ success: false, error: '500 internal server error' }), false);

    const delay0 = calculateBackoff(0, { initialDelayMs: 100, maxDelayMs: 1000, jitterMs: 0 });
    assert.strictEqual(delay0, 100);

    const delay1 = calculateBackoff(1, { initialDelayMs: 100, maxDelayMs: 1000, jitterMs: 0 });
    assert.strictEqual(delay1, 200);

    const delayMax = calculateBackoff(10, { initialDelayMs: 100, maxDelayMs: 500, jitterMs: 0 });
    assert.strictEqual(delayMax, 500);

    const manager = new RateLimitManager({ initialDelayMs: 50, maxDelayMs: 200, jitterMs: 0 });
    assert.strictEqual(manager.rateLimitCooldownUntil, 0);

    manager.recordRateLimit(100);
    assert.ok(manager.rateLimitCooldownUntil > Date.now());

    await manager.waitForCooldown();
    assert.ok(Date.now() >= manager.rateLimitCooldownUntil);
    manager.reset();
    assert.strictEqual(manager.rateLimitCooldownUntil, 0);
});

// ---------------------------------------------------------------------------
// ExportOrchestrator: Mock JSZip
// ---------------------------------------------------------------------------
function setupMockJSZip() {
    const instances: any[] = [];
    __setModuleOverride('JSZip', class MockJSZip {
        files: Record<string, any> = {};
        constructor() {
            this.files = {};
            instances.push(this);
        }
        folder(_name: string) {
            return {
                file: (path: string, content: any) => { this.files[path] = content; }
            };
        }
        async generateAsync(_options?: any, cb?: (p: { percent: number }) => void) {
            if (cb) cb({ percent: 100 });
            return new Blob(['mock-zip'], { type: 'application/zip' });
        }
    });
    return instances;
}


// ---------------------------------------------------------------------------
// ExportOrchestrator: Mock StorageService
// Phase A (P1-4): orchestrator 不再接受 Storage=null（静态 fallback 保证生产环境
// 永远有真 StorageService）；无 chrome 的 node 测试必须显式注册 mock adapter，
// 且它必须实现 saveExportRecord（finalizeChatExport fail-closed）。
// ---------------------------------------------------------------------------
function setupMockStorage() {
    const mem: Record<string, any> = {};
    __setModuleOverride('StorageService', {
        getExportedIds: async (_slot: string) => ({ ...mem }),
        saveExportRecord: async (_slot: string, id: string, rec: any) => {
            mem[id] = rec;
            return { ...mem };
        },
    });
    return { savedRecords: mem };
}

// ---------------------------------------------------------------------------
// ExportOrchestrator: Batch export success and failure accounting (S-2)
// ---------------------------------------------------------------------------
test('ExportOrchestrator - accurate accounting for successful and failed chats (S-2)', async () => {
    setupMockJSZip();
    setupMockStorage();
    const orchestrator = new ExportOrchestrator();

    const selected = [
        { id: 'chat-1', title: 'Conversation 1' },
        { id: 'chat-2', title: 'Conversation 2' },
        { id: 'chat-3', title: 'Conversation 3' }
    ];

    const mockWorker = {
        fetchChatDetail: async (requestedItem: any) => {
            if (requestedItem.id === 'chat-2') {
                return {
                    success: false,
                    error: '429 Rate Limit Exceeded'
                };
            }
            return {
                success: true,
                chat: {
                    id: requestedItem.id,
                    title: requestedItem.title,
                    messages: [
                        { role: 'user', content: 'Hello' },
                        { role: 'model', content: 'Hi there!' }
                    ]
                },
                listTitle: requestedItem.title
            };
        }
    };

    const logs: string[] = [];
    const result = await orchestrator.run({
        selected,
        format: 'markdown',
        useZip: true,
        includeAssets: false,
        worker: mockWorker
    }, {
        onLog: (msg: string) => logs.push(msg)
    });

    assert.strictEqual(result.landedChats, 2, '2 chats should have succeeded');
    assert.strictEqual(result.exportedCount, 2, 'exportedCount should equal landedChats');
    assert.strictEqual(result.failedChats.length, 1, '1 chat should have failed');
    assert.strictEqual(result.failedChats[0].id, 'chat-2');
    assert.ok(result.failedChats[0].error.includes('429'), 'Error reason should be captured');
    assert.strictEqual(result.aborted, false);
});

// ---------------------------------------------------------------------------
// ExportOrchestrator: Permission revocation immediate abort (S-5)
// ---------------------------------------------------------------------------
test('ExportOrchestrator - stops pipeline immediately on NotAllowedError (S-5)', async () => {
    setupMockStorage();
    const orchestrator = new ExportOrchestrator();

    const selected = [
        { id: 'chat-p1', title: 'Permission 1' },
        { id: 'chat-p2', title: 'Permission 2' },
        { id: 'chat-p3', title: 'Permission 3' }
    ];

    let fetchCount = 0;
    const mockWorker = {
        fetchChatDetail: async (requestedItem: any) => {
            fetchCount++;
            return {
                success: true,
                chat: {
                    id: requestedItem.id,
                    title: requestedItem.title,
                    messages: [{ role: 'user', content: 'test' }]
                },
                listTitle: requestedItem.title
            };
        }
    };

    // Mock dirHandle where getFileHandle throws NotAllowedError
    const mockDirHandle: any = {
        name: 'test_folder',
        getDirectoryHandle: async () => mockDirHandle,
        getFileHandle: async () => {
            const err = new Error('The user revoked directory permission');
            err.name = 'NotAllowedError';
            throw err;
        }
    };

    const logs: string[] = [];
    const result = await orchestrator.run({
        selected,
        format: 'markdown',
        useZip: false,
        includeAssets: false,
        dirHandle: mockDirHandle,
        worker: mockWorker,
        concurrency: 1
    }, {
        onLog: (msg: string) => logs.push(msg)
    });

    // Verify pipeline aborted
    assert.strictEqual(orchestrator.aborted, true, 'Orchestrator should be aborted');
    assert.strictEqual(result.aborted, true, 'Result should flag aborted');
    assert.strictEqual(result.landedChats, 0, 'No chats should have landed');
    assert.strictEqual(fetchCount, 1, 'Only one chat should have been fetched before abort');
    assert.strictEqual(result.failedChats.length, 1, 'Pipeline should record exactly one failed chat on immediate abort');
    assert.ok(
        logs.some(l => l.includes('权限') || l.includes('permission')),
        'Logs should contain permission revocation warning'
    );
});

// ---------------------------------------------------------------------------
// ExportOrchestrator: Fast Upfront Skip Filter
// ---------------------------------------------------------------------------
test('ExportOrchestrator - skip: true skips already exported up-to-date chats upfront and only fetches unexported/updated chats', async () => {
    setupMockJSZip();
    setupMockStorage();
    const orchestrator = new ExportOrchestrator();

    const tExported = 1700000000000;
    const conversations = [
        { id: 'chat-new', title: 'New Conversation', timestamp: tExported },
        { id: 'chat-updated', title: 'Updated Conversation', timestamp: tExported, updatedAt: tExported + 30000 },
        { id: 'chat-synced', title: 'Synced Conversation', timestamp: tExported, updatedAt: tExported },
        { id: 'chat-old', title: 'Old Synced Conversation', timestamp: tExported - 10000 }
    ];

    const exportedIds = {
        'chat-updated': { exportedAt: new Date(tExported).toISOString(), chatTime: tExported, title: 'Updated Conversation' },
        'chat-synced': { exportedAt: new Date(tExported + 5000).toISOString(), chatTime: tExported, title: 'Synced Conversation' },
        'chat-old': { exportedAt: new Date(tExported).toISOString(), chatTime: tExported - 10000, title: 'Old Synced Conversation' }
    };

    const fetchedIds: string[] = [];
    const mockWorker = {
        fetchChatDetail: async (requestedItem: any) => {
            fetchedIds.push(requestedItem.id);
            return {
                success: true,
                chat: {
                    id: requestedItem.id,
                    title: requestedItem.title,
                    messages: [{ role: 'user', content: 'test' }]
                },
                listTitle: requestedItem.title
            };
        }
    };

    const logs: string[] = [];
    const result = await orchestrator.run({
        selected: conversations,
        format: 'markdown',
        useZip: true,
        skip: true,
        conversations,
        exportedIds,
        includeAssets: false,
        worker: mockWorker
    }, {
        onLog: (msg: string) => logs.push(msg)
    });

    assert.strictEqual(result.landedChats, 2, 'Only 2 chats (new and updated) should be exported');
    assert.strictEqual(result.skipped, 2, '2 chats (synced and old) should be skipped upfront');
    assert.deepStrictEqual(fetchedIds.sort(), ['chat-new', 'chat-updated'].sort(), 'Only new and updated chats should be fetched');
    assert.ok(logs.some(l => (l.includes('Synced Conversation') || l.includes('chat-synced')) && (l.includes('跳过') || l.includes('skipped'))), 'Logs should report chat-synced skipped');
    assert.ok(logs.some(l => (l.includes('Old Synced Conversation') || l.includes('chat-old')) && (l.includes('跳过') || l.includes('skipped'))), 'Logs should report chat-old skipped');
});

test('ExportOrchestrator - skip: true when all selected chats are up-to-date completes instantly without network calls or empty zip', async () => {
    setupMockStorage();
    let zipGenerated = false;
    __setModuleOverride('JSZip', class MockJSZipAllSkip {
        files: Record<string, any> = {};
        folder() { return { file: () => {} }; }
        async generateAsync() {
            zipGenerated = true;
            return new Blob(['mock-zip'], { type: 'application/zip' });
        }
    });

    const orchestrator = new ExportOrchestrator();

    const tExported = 1700000000000;
    const conversations = [
        { id: 'chat-1', title: 'Conversation 1', timestamp: tExported, updatedAt: tExported },
        { id: 'chat-2', title: 'Conversation 2', timestamp: tExported, updatedAt: tExported }
    ];

    const exportedIds = {
        'chat-1': { exportedAt: new Date(tExported + 10000).toISOString(), chatTime: tExported, title: 'Conversation 1' },
        'chat-2': { exportedAt: new Date(tExported + 10000).toISOString(), chatTime: tExported, title: 'Conversation 2' }
    };

    let fetchCalls = 0;
    const mockWorker = {
        fetchChatDetail: async () => {
            fetchCalls++;
            return { success: true };
        }
    };

    const logs: string[] = [];
    const result = await orchestrator.run({
        selected: conversations,
        format: 'markdown',
        useZip: true,
        skip: true,
        conversations,
        exportedIds,
        includeAssets: false,
        worker: mockWorker
    }, {
        onLog: (msg: string) => logs.push(msg)
    });

    assert.strictEqual(fetchCalls, 0, 'Zero network calls should be made when all chats are skipped upfront');
    assert.strictEqual(result.landedChats, 0, 'Zero chats landed');
    assert.strictEqual(result.skipped, 2, 'All 2 chats should be skipped');
    assert.strictEqual(result.failedChats.length, 0, 'Zero failures');
    assert.strictEqual(zipGenerated, false, 'No empty zip should be generated when all chats are skipped');
    assert.ok(logs.some(l => l.includes('无需生成 ZIP') || l.includes('No ZIP generated')), 'Logs should confirm no zip generated');
});

test('ExportOrchestrator - skip: false exports all selected chats regardless of export records', async () => {
    setupMockJSZip();
    setupMockStorage();
    const orchestrator = new ExportOrchestrator();

    const tExported = 1700000000000;
    const conversations = [
        { id: 'chat-1', title: 'Conversation 1', timestamp: tExported, updatedAt: tExported },
        { id: 'chat-2', title: 'Conversation 2', timestamp: tExported, updatedAt: tExported }
    ];

    const exportedIds = {
        'chat-1': { exportedAt: new Date(tExported + 10000).toISOString(), chatTime: tExported, title: 'Conversation 1' },
        'chat-2': { exportedAt: new Date(tExported + 10000).toISOString(), chatTime: tExported, title: 'Conversation 2' }
    };

    let fetchCalls = 0;
    const mockWorker = {
        fetchChatDetail: async (item: any) => {
            fetchCalls++;
            return {
                success: true,
                chat: { id: item.id, title: item.title, messages: [] },
                listTitle: item.title
            };
        }
    };

    const result = await orchestrator.run({
        selected: conversations,
        format: 'markdown',
        useZip: true,
        skip: false,
        conversations,
        exportedIds,
        includeAssets: false,
        worker: mockWorker
    });

    assert.strictEqual(fetchCalls, 2, 'All chats should be fetched when skip is false');
    assert.strictEqual(result.landedChats, 2, 'All chats should land');
    assert.strictEqual(result.skipped, 0, 'Zero chats skipped');
});

// ---------------------------------------------------------------------------
// formatDebugInfo tests
// ---------------------------------------------------------------------------
test('formatDebugInfo - formats debug info cleanly without [object Object]', () => {
    assert.strictEqual(formatDebugInfo(null), '');
    assert.strictEqual(formatDebugInfo(undefined), '');
    assert.strictEqual(formatDebugInfo('plain error message'), ' plain error message');

    const rpcDebug = { batchexecuteEmptyDebug: { error: 'BardErrorInfo: 1167' } };
    assert.strictEqual(formatDebugInfo(rpcDebug), ' (RPC: BardErrorInfo: 1167)');

    const domDebug = { domDebug: { error: 'DOM not ready' } };
    assert.strictEqual(formatDebugInfo(domDebug), ' (DOM: DOM not ready)');

    const errDebug = { error: 'Explicit error' };
    assert.strictEqual(formatDebugInfo(errDebug), ' (Explicit error)');

    const objDebug = { isNotFound: true, statusCode: 404, rawPreview: 'huge string to ignore' };
    const formatted = formatDebugInfo(objDebug);
    assert.ok(!formatted.includes('[object Object]'), 'Must never format to [object Object]');
    assert.ok(formatted.includes('"isNotFound":true'), 'Must serialize key fields');
    assert.ok(!formatted.includes('huge string to ignore'), 'Must strip out rawPreview bloat');
});

// ---------------------------------------------------------------------------
// BatchWorker.resolveChat - Empty Chat and Deleted Chat handling
// ---------------------------------------------------------------------------
test('BatchWorker.resolveChat - resolves empty chat as valid exportable conversation instead of error', async () => {
    const logs: string[] = [];
    const chat = {
        id: 'empty-chat-123',
        title: 'Used an Assistant feature',
        messages: [],
        error: 'DOM 返回内容为空',
        _empty: true,
        _debug: { domHtmlLen: 0 }
    };
    const reqItem = { id: 'empty-chat-123', title: 'Used an Assistant feature' };

    const res = await BatchWorker.resolveChat(
        chat,
        reqItem,
        null,
        null,
        'u0',
        () => {},
        (msg: string) => logs.push(msg)
    );

    assert.strictEqual(res.isError, false, 'Empty chat should not be treated as fatal error');
    assert.strictEqual(res.isConfirmedDeleted, false, 'Empty chat is not confirmed deleted');
    assert.strictEqual(res.chat.isEmpty, true, 'Chat should be marked as isEmpty');
    assert.strictEqual(res.chat.error, undefined, 'Error property should be removed');
    assert.strictEqual(res.chat._empty, undefined, '_empty property should be removed');
    assert.ok(Array.isArray(res.chat.messages) && res.chat.messages.length === 0, 'Messages should be empty array');
    assert.ok(logs.some(l => l.includes('会话内容为空') || l.includes('empty')), 'Should log empty chat notice');
});

test('BatchWorker.resolveChat - detects cloud-deleted chat with BardErrorInfo: 1167', async () => {
    const logs: string[] = [];
    const chat = {
        id: 'del-chat-456',
        title: 'Deleted Chat',
        messages: [],
        error: '会话已在服务端删除或不可访问 (BardErrorInfo: 1167)',
        _empty: true
    };
    const reqItem = { id: 'del-chat-456', title: 'Deleted Chat' };

    const res = await BatchWorker.resolveChat(
        chat,
        reqItem,
        null,
        null,
        'u0',
        () => {},
        (msg: string) => logs.push(msg)
    );

    assert.strictEqual(res.isError, true, 'Deleted chat should be marked as error/pruned');
    assert.strictEqual(res.isConfirmedDeleted, true, 'Must identify as confirmed deleted');
});

// ---------------------------------------------------------------------------
// ChatFormatter - Empty Chat Markdown Notice
// ---------------------------------------------------------------------------
test('Canonical Markdown preserves the header for empty chats', async () => {
    const emptyChat = {
        id: 'cca63136d0630930',
        title: 'Used an Assistant feature',
        messages: [],
        isEmpty: true
    };

    const { content: mdZh } = await ChatFormatter.formatMarkdownCanonical(emptyChat, { lang: 'zh' });
    assert.ok(mdZh.includes('title: "Used an Assistant feature"'), 'Frontmatter title');
    assert.ok(!mdZh.includes('## 👤'), 'empty chat has no fabricated messages');

    const { content: mdEn } = await ChatFormatter.formatMarkdownCanonical(emptyChat, { lang: 'en' });
    assert.ok(mdEn.includes('# Used an Assistant feature'), 'empty chat retains title');
});

// ---------------------------------------------------------------------------
// ExportOrchestrator - Empty Chat end-to-end export without deadlock
// ---------------------------------------------------------------------------
test('ExportOrchestrator - empty chat exports successfully into archive with status empty and zero failures', async () => {
    setupMockJSZip();
    setupMockStorage();
    const orchestrator = new ExportOrchestrator();

    const conversations = [
        { id: 'cca63136d0630930', title: 'Used an Assistant feature', timestamp: 1710000000000 }
    ];

    const mockWorker = {
        fetchChatDetail: async () => ({
            success: true,
            chat: {
                id: 'cca63136d0630930',
                title: 'Used an Assistant feature',
                messages: [],
                error: 'DOM 返回内容为空',
                _empty: true
            }
        }),
        resolveChat: BatchWorker.resolveChat
    };

    const exportedIds: Record<string, any> = {};
    const logs: string[] = [];

    const result = await orchestrator.run({
        selected: conversations,
        format: 'markdown',
        useZip: true,
        skip: true,
        conversations,
        exportedIds,
        includeAssets: false,
        worker: mockWorker,
        onExportFinalized: async (id: string) => {
            exportedIds[id] = { exportedAt: new Date().toISOString(), status: 'empty' };
        }
    }, {
        onLog: (msg: string) => logs.push(msg)
    });

    assert.strictEqual(result.landedChats, 1, 'Empty chat should land successfully');
    assert.strictEqual(result.failedChats.length, 0, 'No failed chats');
    assert.ok(exportedIds['cca63136d0630930'], 'Empty chat must be finalized in exportedIds to prevent deadlock');
});

test('ExportOrchestrator - records effective timestamp (updatedAt) in chatTime and fires onItemPendingAssets for queued assets', async () => {
    setupMockJSZip();
    const { savedRecords } = setupMockStorage();
    const orchestrator = new ExportOrchestrator();

    const tCreate = 1700000000000;
    const tUpdate = 1700086400000; // 24h newer than creation timestamp
    const conversations = [
        { id: 'chat_with_img', title: 'Image Chat', timestamp: tCreate, updatedAt: tUpdate }
    ];

    const mockWorker = {
        fetchChatDetail: async () => ({
            success: true,
            chat: {
                id: 'chat_with_img',
                title: 'Image Chat',
                timestamp: tCreate,
                updatedAt: tUpdate,
                messages: [
                    {
                        role: 'model',
                        content: 'Here is an image',
                        images: [{ url: 'https://lh3.googleusercontent.com/fake_img', localName: 'assets/img.png', fileName: 'img.png' }]
                    }
                ]
            }
        }),
        resolveChat: BatchWorker.resolveChat
    };

    const origPipeline = __getModuleOverride('AssetPipeline');
    __setModuleOverride('AssetPipeline', class {
        async processAsset(item: any) {
            return { saved: true, localName: item.localName || 'assets/img.png' };
        }
    });

    const pendingEvents: Array<{ id: string; count: number }> = [];
    const finalizedEvents: Array<{ id: string; rec: any }> = [];

    try {
        const result = await orchestrator.run({
            selected: conversations,
            format: 'markdown',
            useZip: true,
            skip: false,
            conversations,
            exportedIds: {},
            includeAssets: true,
            worker: mockWorker
        }, {
            onItemPendingAssets: (id: string, count: number) => pendingEvents.push({ id, count }),
            onItemExported: (id: string, rec: any) => finalizedEvents.push({ id, rec })
        });

        assert.strictEqual(result.landedChats, 1);
        assert.strictEqual(pendingEvents.length, 1, 'onItemPendingAssets must fire when chat has queued assets');
        assert.strictEqual(pendingEvents[0].id, 'chat_with_img');
        assert.strictEqual(pendingEvents[0].count, 1);
        assert.strictEqual(finalizedEvents.length, 1, 'onItemExported must fire after asset queue completes');
        assert.strictEqual(finalizedEvents[0].rec.chatTime, tUpdate, 'record.chatTime must use effective timestamp (updatedAt), not stale creation timestamp');
        assert.strictEqual(savedRecords['chat_with_img']?.chatTime, tUpdate);

        const { checkIsUpdated } = require('../src/core/utils/titleUtils.js');
        assert.strictEqual(
            checkIsUpdated(conversations[0], finalizedEvents[0].rec),
            false,
            'Freshly exported conversation with updatedAt > timestamp must not be flagged as updated'
        );
    } finally {
        __setModuleOverride('AssetPipeline', origPipeline);
    }
});

test('ExportOrchestrator - exports document attachments containing immersive_entry_chip by writing cleaned markdown without dropping file', async () => {
    const mockZips = setupMockJSZip();
    setupMockStorage();
    const orchestrator = new ExportOrchestrator();

    const conversations = [
        { id: 'chat_doc_1', title: 'Doc Analysis', timestamp: 1700000000000 }
    ];

    const mockWorker = {
        fetchChatDetail: async () => ({
            success: true,
            chat: {
                id: 'chat_doc_1',
                title: 'Doc Analysis',
                timestamp: 1700000000000,
                messages: [
                    {
                        role: 'user',
                        content: 'Please analyze this system.'
                    },
                    {
                        role: 'model',
                        content: 'Analysis generated: [供水管网报告](files/chat_doc_1_pipe_analysis.md)',
                        attachments: [
                            {
                                type: 'file',
                                title: '供水管网报告',
                                localName: 'files/chat_doc_1_pipe_analysis.md',
                                contentMarkdown: 'http://googleusercontent.com/immersive_entry_chip/0\n# 城市供水管网水力建模分析\n\n## 1. 建模方程\n连续性方程与水头损失计算。'
                            },
                            {
                                type: 'file',
                                title: '仅包含Chip的无用文档',
                                localName: 'files/chat_doc_1_empty_chip.md',
                                contentMarkdown: 'http://googleusercontent.com/immersive_entry_chip/0\n'
                            }
                        ]
                    }
                ]
            }
        }),
        resolveChat: BatchWorker.resolveChat
    };

    const result = await orchestrator.run({
        selected: conversations,
        format: 'markdown',
        useZip: true,
        skip: false,
        conversations,
        exportedIds: {},
        includeAssets: true,
        worker: mockWorker
    });

    assert.strictEqual(result.landedChats, 1);
    assert.strictEqual(result.failedChats.length, 0);

    // Verify mock zip files
    const zipInstance = mockZips[0];
    assert.ok(zipInstance, 'Mock JSZip instance must be created');

    // 1. Cleaned document must be written
    assert.ok(zipInstance.files['files/chat_doc_1_pipe_analysis.md'], 'Document file must be written to archive');
    const writtenContent = zipInstance.files['files/chat_doc_1_pipe_analysis.md'];
    assert.strictEqual(writtenContent.includes('immersive_entry_chip'), false, 'Written document must not contain telemetry chip URL');
    assert.ok(writtenContent.includes('# 城市供水管网水力建模分析'), 'Written document must contain document title and content');
    assert.ok(writtenContent.includes('连续性方程与水头损失计算'), 'Written document must contain document body');

    // 2. Pure chip telemetry document (empty after cleaning) must NOT be written
    assert.strictEqual(zipInstance.files['files/chat_doc_1_empty_chip.md'], undefined, 'Empty-after-cleaning chip document must not be written');
});

