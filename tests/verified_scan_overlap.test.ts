export {};
const test = require('node:test');
const assert = require('node:assert');
const { __setModuleOverride, __clearModuleOverrides } = require('../src/core/utils/moduleOverrides.js');
const { defaultGeminiProvider } = require('../src/core/provider/gemini/geminiProvider.js');
const { contentContext } = require('../src/content/contentContext.js');
const { tryBatchExecuteFull } = require('../src/content/syncEngine.js');

test('production scan entry admits one pagination call while another scan is pending', async () => {
    const oldDocument = (global as any).document;
    const oldLocation = (global as any).location;
    const oldChrome = (global as any).chrome;
    const originalList = defaultGeminiProvider.listConversations;
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    let calls = 0;
    (global as any).document = { getElementById: () => null };
    (global as any).location = { href: 'https://gemini.google.com/app', pathname: '/app' };
    (global as any).chrome = { runtime: { sendMessage: async () => {} } };
    __setModuleOverride('StorageService', { getScanCheckpoint: async () => null });
    defaultGeminiProvider.listConversations = async () => {
        calls++;
        entered();
        await gate;
        return { conversations: [], total: 0, stoppedEarly: true, diagnostics: null } as any;
    };
    try {
        const first = tryBatchExecuteFull();
        await started;
        const second = await tryBatchExecuteFull();
        assert.strictEqual(second, null);
        assert.strictEqual(calls, 1);
        release();
        await first;
    } finally {
        release();
        defaultGeminiProvider.listConversations = originalList;
        contentContext.setDeepScanPromise(null);
        __clearModuleOverrides();
        (global as any).document = oldDocument;
        (global as any).location = oldLocation;
        (global as any).chrome = oldChrome;
    }
});
