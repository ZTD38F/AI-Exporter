export {};
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const activation = require('../src/core/provider/chatgpt/activation.js');

function makeChrome(options: {
    contains?: boolean;
    request?: boolean;
    registered?: boolean;
    tabs?: Array<{ id?: number; url?: string }>;
    failExecuteTabIds?: number[];
} = {}) {
    const calls: any = {
        contains: [],
        request: [],
        remove: [],
        getRegistered: [],
        register: [],
        unregister: [],
        query: [],
        execute: []
    };

    let registered = !!options.registered;
    const fail = new Set(options.failExecuteTabIds || []);

    const chromeMock = {
        permissions: {
            contains: async (value: any) => {
                calls.contains.push(value);
                return !!options.contains;
            },
            request: async (value: any) => {
                calls.request.push(value);
                return !!options.request;
            },
            remove: async (value: any) => {
                calls.remove.push(value);
                return true;
            }
        },
        scripting: {
            getRegisteredContentScripts: async (filter: any) => {
                calls.getRegistered.push(filter);
                return registered
                    ? [{ id: activation.CHATGPT_BRIDGE_SCRIPT_ID }]
                    : [];
            },
            registerContentScripts: async (scripts: any[]) => {
                calls.register.push(scripts);
                registered = true;
            },
            unregisterContentScripts: async (filter: any) => {
                calls.unregister.push(filter);
                registered = false;
            },
            executeScript: async (details: any) => {
                calls.execute.push(details);
                if (fail.has(details.target.tabId)) throw new Error('tab disappeared');
                return [];
            }
        },
        tabs: {
            query: async (query: any) => {
                calls.query.push(query);
                return options.tabs || [];
            }
        }
    };

    return { chromeMock, calls };
}

test('ChatGPT activation - denied permission does not register or inject anything', async () => {
    const oldChrome = (global as any).chrome;
    const { chromeMock, calls } = makeChrome({ request: false });
    try {
        (global as any).chrome = chromeMock;
        const result = await activation.enableChatGPTAccessFromUserGesture();

        assert.deepStrictEqual(result, {
            granted: false,
            registered: false,
            injectedTabIds: [],
            failedTabIds: []
        });
        assert.strictEqual(calls.request.length, 1);
        assert.strictEqual(calls.register.length, 0);
        assert.strictEqual(calls.query.length, 0);
        assert.strictEqual(calls.execute.length, 0);
    } finally {
        (global as any).chrome = oldChrome;
    }
});

test('ChatGPT activation - granted permission registers narrow bridge and injects existing tabs with per-tab failure evidence', async () => {
    const oldChrome = (global as any).chrome;
    const { chromeMock, calls } = makeChrome({
        contains: true,
        request: true,
        registered: false,
        tabs: [{ id: 101 }, { id: 202 }, {}],
        failExecuteTabIds: [202]
    });

    try {
        (global as any).chrome = chromeMock;
        const result = await activation.enableChatGPTAccessFromUserGesture();

        assert.strictEqual(result.granted, true);
        assert.strictEqual(result.registered, true);
        assert.deepStrictEqual(result.injectedTabIds, [101]);
        assert.deepStrictEqual(result.failedTabIds, [202]);

        assert.deepStrictEqual(calls.request[0], {
            permissions: ['scripting'],
            origins: ['https://chatgpt.com/*']
        });

        assert.strictEqual(calls.register.length, 1);
        const script = calls.register[0][0];
        assert.strictEqual(script.id, 'ai-exporter-chatgpt-bridge-v1');
        assert.deepStrictEqual(script.matches, ['https://chatgpt.com/*']);
        assert.deepStrictEqual(script.js, ['dist/content/chatgpt.js']);
        assert.strictEqual(script.runAt, 'document_start');
        assert.strictEqual(script.allFrames, false);
        assert.strictEqual(script.persistAcrossSessions, true);

        assert.deepStrictEqual(calls.query, [{ url: 'https://chatgpt.com/*' }]);
        assert.deepStrictEqual(
            calls.execute.map((x: any) => [x.target.tabId, x.files]),
            [
                [101, ['dist/content/chatgpt.js']],
                [202, ['dist/content/chatgpt.js']]
            ]
        );
    } finally {
        (global as any).chrome = oldChrome;
    }
});

test('ChatGPT activation - reconcile never requests permission and does not inject current tabs', async () => {
    const oldChrome = (global as any).chrome;
    const { chromeMock, calls } = makeChrome({
        contains: true,
        registered: true,
        tabs: [{ id: 1 }]
    });

    try {
        (global as any).chrome = chromeMock;
        const result = await activation.reconcileChatGPTAccess();

        assert.strictEqual(result.granted, true);
        assert.strictEqual(result.registered, true);
        assert.strictEqual(calls.request.length, 0, 'startup reconciliation must never prompt');
        assert.strictEqual(calls.register.length, 0, 'already-registered bridge stays idempotent');
        assert.strictEqual(calls.query.length, 0);
        assert.strictEqual(calls.execute.length, 0);
    } finally {
        (global as any).chrome = oldChrome;
    }
});

test('ChatGPT activation - reconcile without permission stays dormant', async () => {
    const oldChrome = (global as any).chrome;
    const { chromeMock, calls } = makeChrome({
        contains: false,
        registered: false
    });

    try {
        (global as any).chrome = chromeMock;
        const result = await activation.reconcileChatGPTAccess();

        assert.deepStrictEqual(result, {
            granted: false,
            registered: false,
            injectedTabIds: [],
            failedTabIds: []
        });
        assert.strictEqual(calls.request.length, 0);
        assert.strictEqual(calls.register.length, 0);
    } finally {
        (global as any).chrome = oldChrome;
    }
});

test('ChatGPT activation - disable unregisters bridge and optionally removes permission', async () => {
    const oldChrome = (global as any).chrome;
    const { chromeMock, calls } = makeChrome({
        contains: true,
        registered: true
    });

    try {
        (global as any).chrome = chromeMock;
        const removed = await activation.disableChatGPTAccess({ removePermission: true });

        assert.strictEqual(removed, true);
        assert.deepStrictEqual(calls.unregister, [{
            ids: ['ai-exporter-chatgpt-bridge-v1']
        }]);
        assert.deepStrictEqual(calls.remove, [{
            permissions: ['scripting'],
            origins: ['https://chatgpt.com/*']
        }]);
    } finally {
        (global as any).chrome = oldChrome;
    }
});

test('ChatGPT activation - content bridge contains a global idempotency sentinel', () => {
    const source = fs.readFileSync(
        path.join(process.cwd(), 'src/content/chatgpt.ts'),
        'utf8'
    );
    assert.ok(source.includes('__AI_EXPORTER_CHATGPT_BRIDGE_V1__'));
    assert.ok(source.includes('if (!bridgeGlobal[BRIDGE_SENTINEL]'));
});
