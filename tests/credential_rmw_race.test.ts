export {};
const test = require('node:test');
const assert = require('node:assert');
const { handleHttp400 } = require('../src/l1/client/gemini/api/retryPolicy.js');

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
    const localWrites: unknown[] = [];
    const localRemovals: string[][] = [];
    const sessionStorage = {
        get: async () => ({ gemini_credentials_map: JSON.parse(JSON.stringify(data.gemini_credentials_map)) }),
        set: async (obj: any) => {
            if (++writes === 1) { entered(); await gate; }
            Object.assign(data, JSON.parse(JSON.stringify(obj)));
        }
    };
    (global as any).chrome = { storage: {
        session: sessionStorage,
        local: {
            set: async (obj: unknown) => { localWrites.push(obj); },
            remove: async (keys: string[]) => { localRemovals.push(keys); }
        }
    } };
    const params = (sid: string, at: string) => ({
        resp: { status: 400 }, snippet: 'xsrf', cred: { sid, at: 'old' }, isRetried: false,
        getAtFromPage: () => at, getBlFromPage: () => null
    });
    try {
        const first = handleHttp400(params('sid1', 'new1'));
        await firstSet;
        const second = handleHttp400(params('sid2', 'new2'));
        await new Promise(resolve => setImmediate(resolve));
        release();
        const [firstResult, secondResult] = await Promise.all([first, second]);
        assert.strictEqual(firstResult.shouldRetry, true);
        assert.strictEqual(secondResult.shouldRetry, true);
        assert.strictEqual(firstResult.freshAt, 'new1');
        assert.strictEqual(secondResult.freshAt, 'new2');
        assert.strictEqual(writes, 2, 'each credential refresh must be persisted to session storage');
        assert.deepStrictEqual(data.gemini_credentials_map, {
            sid1: { sid: 'sid1', at: 'new1' },
            sid2: { sid: 'sid2', at: 'new2' }
        }, 'both account tokens must survive serialized read-modify-write');
        assert.deepStrictEqual(localWrites, [], 'refresh must never persist tokens to chrome.storage.local');
        assert.strictEqual(localRemovals.length, 2, 'legacy disk copies must be cleaned after each successful refresh');
    } finally {
        release();
        (global as any).chrome = originalChrome;
    }
});
