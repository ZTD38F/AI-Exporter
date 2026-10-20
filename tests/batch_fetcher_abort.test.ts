// tests/batch_fetcher_abort.test.ts
// B2: sendToGeminiTabCancellable 的 AbortSignal race —— mock slot abort，断言在途请求即时被取消，
// 不再依赖 50ms 轮询；settled 后 controller 被清理，且重建的 signal 与 boolean 旗标保持同步。
export {};
const test = require('node:test');
const assert = require('node:assert');

test('batchFetcher - slot abort wins the race while sendToGeminiTab is in-flight', async () => {
    const origChrome = (global as any).chrome;
    (global as any).chrome = {
        runtime: {
            sendMessage: (_msg: any) => Promise.resolve()
        },
        storage: {
            session: {
                get: async (_keys: any) => ({}),
                set: async (_obj: any) => {},
                remove: async (_keys: any) => {}
            }
        }
    };

    const { TabService } = require('../src/core/utils/tabService.js');
    const {
        setSlotAborted,
        clearAllAborts,
        getSlotAbortSignal,
        __bgControllers
    } = require('../src/background/abortManager.js');
    const { fetchBatch } = require('../src/background/batchFetcher.js');

    clearAllAborts();
    const origGet = TabService.getGeminiTab;
    const origSend = TabService.sendToGeminiTab;
    // tab 存在；send 永不 resolve（模拟在途请求）
    TabService.getGeminiTab = async () => ({ id: 123 });
    let sendCalls = 0;
    TabService.sendToGeminiTab = (..._args: any[]) => {
        sendCalls++;
        return new Promise(() => {});
    };

    try {
        const slot = 'u0';
        let response: any = null;
        const done = fetchBatch(
            [{ id: 'chat1', title: 't1' }],
            'markdown',
            false,
            (r: any) => { response = r; },
            0,
            1,
            slot
        );
        // 让 sendToGeminiTabCancellable 进入 race
        await new Promise(r => setTimeout(r, 60));
        // 触发取消
        await setSlotAborted(slot, true);
        // race 必须即时生效 —— 远小于旧 50ms 轮询的累积延迟，更绝不拖到 24h
        const timeout = new Promise((_resolve, rej) =>
            setTimeout(() => rej(new Error('race did not settle promptly after abort')), 3000));
        await Promise.race([done, timeout]);

        assert.ok(response, 'portSendResponse must be called');
        assert.strictEqual(response.aborted, true, 'response must carry aborted:true');
        assert.strictEqual(response.success, false, 'aborted batch must not report success');
        assert.strictEqual(sendCalls, 1, 'exactly one in-flight send was raced');
        assert.strictEqual(
            __bgControllers.has(slot), false,
            'controller must be cleaned up after the race settles'
        );
        // 旗标同步：清理后重建的 signal 仍为 aborted（boolean 旗标未清）
        assert.strictEqual(
            getSlotAbortSignal(slot).aborted, true,
            'recreated signal must follow the still-set boolean flag'
        );
    } finally {
        TabService.getGeminiTab = origGet;
        TabService.sendToGeminiTab = origSend;
        clearAllAborts();
        (global as any).chrome = origChrome;
    }
});

test('batchFetcher - no abort: sendToGeminiTab result passes through, timer released', async () => {
    const origChrome = (global as any).chrome;
    (global as any).chrome = {
        runtime: {
            sendMessage: (_msg: any) => Promise.resolve()
        },
        storage: {
            session: {
                get: async (_keys: any) => ({}),
                set: async (_obj: any) => {},
                remove: async (_keys: any) => {}
            }
        }
    };

    const { TabService } = require('../src/core/utils/tabService.js');
    const { clearAllAborts, __bgControllers } = require('../src/background/abortManager.js');
    const { fetchBatch } = require('../src/background/batchFetcher.js');

    clearAllAborts();
    const origGet = TabService.getGeminiTab;
    const origSend = TabService.sendToGeminiTab;
    TabService.getGeminiTab = async () => ({ id: 123 });
    TabService.sendToGeminiTab = async (msg: any, _slot?: string) => ({
        success: true,
        data: { id: msg.conversationId, title: 'ok-chat', messages: [] }
    });

    try {
        const slot = 'u0';
        let response: any = null;
        await fetchBatch(
            [{ id: 'chat1', title: 't1' }],
            'markdown',
            false,
            (r: any) => { response = r; },
            0,
            1,
            slot
        );
        assert.ok(response, 'portSendResponse must be called');
        assert.strictEqual(response.success, true, 'non-aborted batch reports success');
        assert.strictEqual(response.aborted, false);
        assert.strictEqual(response.results.length, 1);
        assert.strictEqual(response.results[0].id, 'chat1');
        assert.strictEqual(
            __bgControllers.has(slot), false,
            'controller must be cleaned up after settle even without abort'
        );
    } finally {
        TabService.getGeminiTab = origGet;
        TabService.sendToGeminiTab = origSend;
        clearAllAborts();
        (global as any).chrome = origChrome;
    }
});
