export {};
const test = require('node:test');
const assert = require('node:assert');

const { ExportOrchestrator, AsyncQueue } = require('../src/core/engine/export/exportOrchestrator.js');
const { RateLimitManager, isRateLimited, calculateBackoff } = require('../src/core/engine/export/rateLimiter.js');

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
    (global as any).JSZip = class MockJSZip {
        files: Record<string, any> = {};
        constructor() { this.files = {}; }
        folder(_name: string) {
            return {
                file: (path: string, content: any) => { this.files[path] = content; }
            };
        }
        async generateAsync(_options?: any, cb?: (p: { percent: number }) => void) {
            if (cb) cb({ percent: 100 });
            return new Blob(['mock-zip'], { type: 'application/zip' });
        }
    };
}

// ---------------------------------------------------------------------------
// ExportOrchestrator: Batch export success and failure accounting (S-2)
// ---------------------------------------------------------------------------
test('ExportOrchestrator - accurate accounting for successful and failed chats (S-2)', async () => {
    setupMockJSZip();
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
        worker: mockWorker
    }, {
        onLog: (msg: string) => logs.push(msg)
    });

    // Verify pipeline aborted
    assert.strictEqual(orchestrator.aborted, true, 'Orchestrator should be aborted');
    assert.strictEqual(result.aborted, true, 'Result should flag aborted');
    assert.strictEqual(result.landedChats, 0, 'No chats should have landed');
    assert.ok(result.failedChats.length >= 1, 'Failed chats should record error');
    assert.ok(
        logs.some(l => l.includes('权限') || l.includes('permission')),
        'Logs should contain permission revocation warning'
    );
});
