export {};
const test = require('node:test');
const assert = require('node:assert');
const { handleHttp400 } = require('../src/core/api/client/retryPolicy.js');

test('concurrent credential refreshes preserve updates to both SIDs', async () => {
    const originalChrome = (global as any).chrome;
    const data: Record<string, any> = { gemini_credentials_map: {
        sid1: { sid: 'sid1', at: 'old1' }, sid2: { sid: 'sid2', at: 'old2' }
    } };
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const firstSet = new Promise<void>(resolve => { entered = resolve; });
    let writes = 0;
    const storage = {
        get: async () => ({ gemini_credentials_map: JSON.parse(JSON.stringify(data.gemini_credentials_map)) }),
        set: async (obj: any) => {
            if (++writes === 1) { entered(); await gate; }
            Object.assign(data, JSON.parse(JSON.stringify(obj)));
        }
    };
    (global as any).chrome = { storage: { local: storage } };
    const params = (sid: string, at: string) => ({
        resp: { status: 400 }, snippet: 'xsrf', cred: { sid, at: 'old' }, isRetried: false,
        getAtFromPage: () => at, getBlFromPage: () => null,
        loadCredMap: async () => (await storage.get()).gemini_credentials_map,
        getCredStorage: () => storage
    });
    try {
        const first = handleHttp400(params('sid1', 'new1'));
        await firstSet;
        const second = handleHttp400(params('sid2', 'new2'));
        await new Promise(resolve => setImmediate(resolve));
        release();
        await Promise.all([first, second]);
        assert.strictEqual(data.gemini_credentials_map.sid1.at, 'new1');
        assert.strictEqual(data.gemini_credentials_map.sid2.at, 'new2');
    } finally {
        release();
        (global as any).chrome = originalChrome;
    }
});
