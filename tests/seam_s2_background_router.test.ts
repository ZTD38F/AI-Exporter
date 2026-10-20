import test from 'node:test';
import assert from 'node:assert';

// S2: background router fail-closed (unknown action, empty tab response).

const msgListeners: Array<(msg: any, sender: any, sendResponse: any) => any> = [];
const sessionData: Record<string, any> = {};

// Controls what chrome.tabs.sendMessage delivers to the background.
let tabReply: any = { success: true, data: { id: 'c_1', messages: [] } };
let tabResponder: ((_msg: any, cb: any) => void) | null = null;

(global as any).chrome = {
    runtime: {
        onMessage: { addListener: (fn: any) => { msgListeners.push(fn); } },
        onInstalled: { addListener: () => {} },
        setUninstallURL: (_u: string, cb?: any) => { if (cb) cb(); },
        getURL: (p: string) => `chrome-extension://test/${p}`,
        getPlatformInfo: (cb: any) => { if (cb) cb({}); },
        sendMessage: async () => {},
        lastError: null,
    },
    storage: {
        local: {
            get: async (_keys: any) => ({ gemini_schema_version: 1 }),
            set: async (_obj: any) => {},
            remove: async (_keys: any) => {},
        },
        session: {
            get: async (keys: any) => {
                if (keys === null) return { ...sessionData };
                if (typeof keys === 'string') return { [keys]: sessionData[keys] };
                return {};
            },
            set: async (obj: any) => { Object.assign(sessionData, obj); },
            remove: async (keys: any) => {
                const arr = Array.isArray(keys) ? keys : [keys];
                for (const k of arr) delete sessionData[k];
            },
            setAccessLevel: async () => {},
        },
    },
    tabs: {
        onActivated: { addListener: () => {} },
        onUpdated: { addListener: () => {} },
        query: async () => [{ id: 42, url: 'https://gemini.google.com/app', active: true }],
        sendMessage: (_tabId: number, msg: any, cb: any) => { if (tabResponder) tabResponder(msg, cb); else cb(tabReply); },
    },
    action: {
        setIcon: async () => {},
        setTitle: async () => {},
    },
};

// tabService.ts 末尾 `module.exports = TabService` 覆盖了 esbuild 具名导出，
// ts_register 下 `import { TabService }` 会拿到 undefined（生产 bundle 走 ESM
// 不受影响）。沿用 p1_c_regressions.test.ts 的做法：给 require 缓存打补丁，仅用于测试。
const tabServiceMod: any = require('../src/core/utils/tabService.js');
if (tabServiceMod && !tabServiceMod.TabService) tabServiceMod.TabService = tabServiceMod;

require('../src/background/background.ts');

function lastListener() {
    return msgListeners[msgListeners.length - 1];
}

async function dispatch(msg: any, waitMs = 2000): Promise<{ responses: any[]; returned: any }> {
    const responses: any[] = [];
    const returned = lastListener()(msg, {}, (r: any) => { responses.push(r); });
    const deadline = Date.now() + waitMs;
    while (responses.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
    }
    await new Promise((r) => setTimeout(r, 50));
    return { responses, returned };
}

test('S2 - unknown action keeps the intentional "not for me" contract (no response)', async () => {
    // entrypoints.test.ts locks this: background must not reject unknown
    // actions synchronously. Senders only await responses for owned actions.
    const { responses, returned } = await dispatch({ action: 'noSuchAction' }, 300);
    assert.strictEqual(responses.length, 0, 'unknown actions get no response by design');
    assert.ok(!returned, 'listener returns falsy for unowned actions');
});

test('S2 - fetchChat with undefined tab response fails closed', async () => {
    tabReply = undefined;
    try {
        const { responses } = await dispatch({ action: 'fetchChat', id: 'c_1' });
        assert.strictEqual(responses.length, 1, 'sender must get a response');
        const r = responses[0];
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.success, false);
        assert.ok(String(r.error).includes('empty response'));
    } finally {
        tabReply = { success: true, data: { id: 'c_1', messages: [] } };
    }
});

test('S2 - fetchChat passes a real tab response through untouched', async () => {
    const { responses } = await dispatch({ action: 'fetchChat', id: 'c_1' });
    assert.strictEqual(responses.length, 1);
    assert.strictEqual(responses[0].success, true);
    assert.strictEqual(responses[0].data.id, 'c_1');
});

test('queued fetchBatch submitted before cancel must not restart after the in-flight batch drains', async () => {
    const { clearAllAborts, setSlotAborted } = require('../src/background/abortManager.js');
    clearAllAborts();
    let detailCalls = 0;
    let releaseFirstDetail: any = null;
    tabResponder = (msg: any, cb: any) => {
        if (msg.action === 'getConversationDetail') {
            detailCalls++;
            if (detailCalls === 1) releaseFirstDetail = () => cb({ success: false, error: 'cancelled' });
            else cb({ success: true, data: { id: msg.conversationId, messages: [] } });
        } else cb(tabReply);
    };
    const listener = lastListener();
    const responses: any[] = [];
    try {
        listener({ action: 'fetchBatch', accountSlot: 'u0', ids: ['first'] }, {}, (r: any) => responses.push(r));
        while (detailCalls === 0) await new Promise(r => setTimeout(r, 5));
        listener({ action: 'fetchBatch', accountSlot: 'u0', ids: ['queued'] }, {}, (r: any) => responses.push(r));
        listener({ action: 'cancelExport', accountSlot: 'u0' }, {}, () => {});
        const deadline = Date.now() + 1000;
        while (responses.length < 2 && Date.now() < deadline) await new Promise(r => setTimeout(r, 5));
        assert.strictEqual(detailCalls, 1, 'queued pre-cancel batch must never contact the tab');
        assert.strictEqual(responses.length, 2);
        assert.ok(responses.every(r => r.aborted), 'both responses should report cancellation');
    } finally {
        if (releaseFirstDetail) releaseFirstDetail();
        tabResponder = null;
        await setSlotAborted('u0', false);
        clearAllAborts();
    }
});

test('same-slot batches do not overlap the shared abort controller in production routing', async () => {
    const { clearAllAborts } = require('../src/background/abortManager.js');
    clearAllAborts();
    let detailCalls = 0;
    let releaseFirst: any = null;
    tabResponder = (msg: any, cb: any) => {
        if (msg.action === 'getConversationDetail') {
            detailCalls++;
            if (detailCalls === 1) releaseFirst = () => cb({ success: true, data: { id: 'first', messages: [] } });
            else cb({ success: true, data: { id: 'second', messages: [] } });
        } else cb(tabReply);
    };
    const listener = lastListener();
    const responses: any[] = [];
    try {
        listener({ action: 'fetchBatch', accountSlot: 'u0', ids: ['first'] }, {}, (r: any) => responses.push(r));
        while (detailCalls === 0) await new Promise(r => setTimeout(r, 5));
        listener({ action: 'fetchBatch', accountSlot: 'u0', ids: ['second'] }, {}, (r: any) => responses.push(r));
        await new Promise(resolve => setImmediate(resolve));
        assert.strictEqual(detailCalls, 1);
        releaseFirst();
        const deadline = Date.now() + 1000;
        while (responses.length < 2 && Date.now() < deadline) await new Promise(r => setTimeout(r, 5));
        assert.strictEqual(detailCalls, 2);
        assert.strictEqual(responses.length, 2);
        assert.ok(responses.every(r => r.success));
    } finally {
        if (releaseFirst) releaseFirst();
        tabResponder = null;
        clearAllAborts();
    }
});

test('back-to-back batches submitted before the first starts both run without cancellation', async () => {
    const { clearAllAborts } = require('../src/background/abortManager.js');
    clearAllAborts();
    const sent: string[] = [];
    tabResponder = (msg: any, cb: any) => {
        if (msg.action === 'getConversationDetail') {
            sent.push(msg.conversationId);
            cb({ success: true, data: { id: msg.conversationId, messages: [] } });
        } else cb(tabReply);
    };
    const listener = lastListener();
    const responses: any[] = [];
    try {
        listener({ action: 'fetchBatch', accountSlot: 'u0', ids: ['first'] }, {}, (r: any) => responses.push(r));
        listener({ action: 'fetchBatch', accountSlot: 'u0', ids: ['second'] }, {}, (r: any) => responses.push(r));
        const deadline = Date.now() + 1000;
        while (responses.length < 2 && Date.now() < deadline) await new Promise(r => setTimeout(r, 5));
        assert.deepStrictEqual(sent, ['first', 'second']);
        assert.ok(responses.every(r => r.success));
    } finally {
        tabResponder = null;
        clearAllAborts();
    }
});

test('S2 - scanProgress broadcast stays fire-and-forget (no response)', async () => {
    const { responses, returned } = await dispatch({ action: 'scanProgress', percent: 50 }, 300);
    assert.strictEqual(responses.length, 0, 'broadcasts must not produce a response');
    assert.ok(!returned, 'no async response expected');
});
