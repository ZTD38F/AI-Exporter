export {};

// Credential security: session-only persistence, no local-storage leakage, and targeted 401 eviction.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');

const code = require('esbuild').buildSync({ entryPoints: [path.join(__dirname, '..', 'src', 'l1', 'client', 'gemini', 'bootstrap.ts')], bundle: true, write: false, format: 'iife', globalName: 'TestBootstrap', logLevel: 'silent' }).outputFiles[0].text;
const protocolCode = fs.readFileSync(path.join(__dirname, '..', 'src', 'l1', 'protocol', 'gemini', 'protocol.js'), 'utf8');

function makeContext() {
    const ctx: Record<string, any> = {
        console: { log: () => {}, warn: () => {}, debug: () => {} },
        crypto: require('node:crypto').webcrypto,
        setTimeout, clearTimeout, queueMicrotask,
        URL,
        chrome: {
            runtime: { id: 'test-extension', sendMessage: async (message: any) => message.action === 'ensureV2Ready' ? {ok:true} : ({ok:true,value:{id:'10000000-0000-4000-8000-000000000003',providerId:message.providerId,providerAccountId:message.providerAccountId}}) },
            storage: {
                local: {
                    get: async (keys: any) => {
                        const keyList = Array.isArray(keys) ? keys : [keys];
                        const out: Record<string, any> = {};
                        for (const k of keyList) {
                            if (ctx.__localData && Object.prototype.hasOwnProperty.call(ctx.__localData, k)) {
                                out[k] = ctx.__localData[k];
                            }
                        }
                        return out;
                    },
                    set: async (items: any) => {
                        ctx.__localWrites.push(items);
                        ctx.__localData = ctx.__localData || {};
                        Object.assign(ctx.__localData, JSON.parse(JSON.stringify(items)));
                    },
                    remove: async () => {}
                },
                session: {
                    get: async (keys: any) => {
                        const keyList = Array.isArray(keys) ? keys : [keys];
                        const out: Record<string, any> = {};
                        for (const k of keyList) {
                            if (ctx.__sessionData && Object.prototype.hasOwnProperty.call(ctx.__sessionData, k)) {
                                out[k] = ctx.__sessionData[k];
                            }
                        }
                        return out;
                    },
                    set: async (items: any) => {
                        ctx.__sessionWrites.push(items);
                        ctx.__sessionData = ctx.__sessionData || {};
                        Object.assign(ctx.__sessionData, JSON.parse(JSON.stringify(items)));
                    },
                    remove: async (keys: any) => {
                        const keyList = Array.isArray(keys) ? keys : [keys];
                        for (const k of keyList) {
                            if (ctx.__sessionData) delete ctx.__sessionData[k];
                        }
                    }
                }
            }
        },
        addEventListener: () => {},
        removeEventListener: () => {},
        __localWrites: [],
        __sessionWrites: [],
        __sessionData: {}
    };
    ctx.window = ctx;
    ctx.document = {
        querySelectorAll: () => [],
        addEventListener: () => {},
        removeEventListener: () => {},
        documentElement: { innerHTML: '' }
    };
    ctx.location = { origin: 'https://gemini.google.com', href: 'https://gemini.google.com/u/0/app', pathname: '/u/0/app' };
    ctx.localStorage = { getItem: () => null, setItem: () => {} };
    ctx.sessionStorage = { getItem: () => null, setItem: () => {} };
    vm.createContext(ctx);
    // This storage-focused fixture has no Gaia. Model the real MAIN-world
    // response so identity discovery completes before credential assertions.
    vm.runInContext(`
        const accountListeners = new Set();
        window.addEventListener = (type, listener) => { if (type === 'message') accountListeners.add(listener); };
        window.removeEventListener = (type, listener) => { if (type === 'message') accountListeners.delete(listener); };
        window.postMessage = message => {
            if (message.type !== 'GEMINI_ACCOUNT_REQUESTED') return;
            queueMicrotask(() => {
                const event = { source: window, origin: location.origin, data: {
                    type: 'GEMINI_ACCOUNT_OBSERVED', payload: { requestId: message.payload.requestId, slot: 'u0', observation: null }
                } };
                for (const listener of [...accountListeners]) listener(event);
            });
        };
    `, ctx);
    return ctx;
}

test('p1-lock: session tokens live in chrome.storage.session, never in chrome.storage.local', async () => {
    const ctx = makeContext();
    ctx.WIZ_global_data = { SNlM0e: 'ATTEST0123456789abcdef' };

    // Mirror the browser load order: protocol.js loads before bootstrap.js.
    vm.runInContext(protocolCode, ctx, { filename: 'protocol.js' });
    vm.runInContext(code, ctx, { filename: 'bootstrap.js' });
    ctx.TestBootstrap.initBootstrap();
    // bootstrap runs ensureCreds() at load; let its async chain settle.
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));

    const credKeys = (w: any) => 'gemini_credentials' in w || 'gemini_credentials_map' in w;
    const wroteLocal = ctx.__localWrites.some(credKeys);
    const wroteSession = ctx.__sessionWrites.some(credKeys);

    assert.ok(wroteSession, 'credentials must be persisted to chrome.storage.session (memory-scoped)');
    assert.ok(
        !wroteLocal,
        'credentials must NOT be written to chrome.storage.local — plaintext tokens on disk survive logout ' +
        'and are readable by any extension code. Migrate to chrome.storage.session (+401/logout cleanup).'
    );
});

test('CredentialManager credentials storage uses chrome.storage.session and does not leak to local', async () => {
    const CredentialManager = require('../src/l1/client/gemini/api/credentialManager.js').default || require('../src/l1/client/gemini/api/credentialManager.js');
    const localStore: Record<string, any> = {};
    const sessionStore: Record<string, any> = { gemini_credentials_map: { test_sid: { at: 'test_at', sid: 'test_sid' } } };
    const originalChromeDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
    (global as any).chrome = {
        storage: {
            local: {
                get: async (keys: any) => {
                    const out: Record<string, any> = {};
                    for (const k of (Array.isArray(keys) ? keys : [keys])) {
                        if (localStore[k]) out[k] = JSON.parse(JSON.stringify(localStore[k]));
                    }
                    return out;
                },
                set: async (items: any) => {
                    Object.assign(localStore, JSON.parse(JSON.stringify(items)));
                },
                remove: async (keys: any) => {
                    for (const k of (Array.isArray(keys) ? keys : [keys])) delete localStore[k];
                }
            },
            session: {
                get: async (keys: any) => {
                    const out: Record<string, any> = {};
                    for (const k of (Array.isArray(keys) ? keys : [keys])) {
                        if (sessionStore[k]) out[k] = JSON.parse(JSON.stringify(sessionStore[k]));
                    }
                    return out;
                },
                set: async (items: any) => {
                    Object.assign(sessionStore, JSON.parse(JSON.stringify(items)));
                },
                remove: async (keys: any) => {
                    for (const k of (Array.isArray(keys) ? keys : [keys])) delete sessionStore[k];
                }
            }
        }
    };
    try {
        const resolved = await CredentialManager.resolveCred('test_sid');
        assert.strictEqual(resolved.at, 'test_at');
        assert.strictEqual(sessionStore.gemini_credentials_map?.test_sid?.at, 'test_at');
        assert.strictEqual(localStore.gemini_credentials_map, undefined, 'credentials must never be written to local store on read');
    } finally {
        if (originalChromeDescriptor) Object.defineProperty(globalThis, 'chrome', originalChromeDescriptor);
        else Reflect.deleteProperty(globalThis, 'chrome');
    }
});

test('GeminiAPIClient 401 evicts only the expired SID from session storage', async () => {
    const { GeminiAPIClient } = require('../src/l1/client/gemini/geminiClient.js');
    const originalChromeDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
    const originalFetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
    const sessionStore: Record<string, any> = {
        gemini_credentials_map: {
            bad_sid: { at: 'bad_token', sid: 'bad_sid', accountSlot: 'default' },
            healthy_sid: { at: 'healthy_token', sid: 'healthy_sid', accountSlot: 'u2' }
        }
    };
    const localStore: Record<string, any> = {};
    (global as any).chrome = {
        storage: {
            local: {
                get: async () => ({ ...localStore }),
                set: async (items: any) => Object.assign(localStore, items),
                remove: async (keys: any) => { for (const k of [keys].flat()) delete localStore[k]; }
            },
            session: {
                get: async (keys: any) => {
                    const out: Record<string, any> = {};
                    for (const k of [keys].flat()) {
                        if (sessionStore[k]) out[k] = JSON.parse(JSON.stringify(sessionStore[k]));
                    }
                    return out;
                },
                set: async (items: any) => Object.assign(sessionStore, JSON.parse(JSON.stringify(items))),
                remove: async (keys: any) => { for (const k of [keys].flat()) delete sessionStore[k]; }
            }
        }
    };

    try {
        const client = new GeminiAPIClient();
        (global as any).fetch = async () => ({
            ok: false,
            status: 401,
            statusText: 'Unauthorized',
            text: async () => 'Unauthorized'
        });

        await assert.rejects(
            () => client.getConversationList(null, 'bad_sid'),
            (error: unknown) => error instanceof Error && error.message.includes('401'),
            'expired credentials must surface an HTTP 401 to the caller'
        );
        assert.strictEqual(sessionStore.gemini_credentials_map.bad_sid, undefined, '401 must evict the expired SID');
        assert.deepStrictEqual(sessionStore.gemini_credentials_map.healthy_sid,
            { at: 'healthy_token', sid: 'healthy_sid', accountSlot: 'u2' },
            'evicting one account must retain another account credential');
        assert.strictEqual(localStore.gemini_credentials_map, undefined, '401 handling must not copy secrets into local storage');
    } finally {
        if (originalFetchDescriptor) Object.defineProperty(globalThis, 'fetch', originalFetchDescriptor);
        else Reflect.deleteProperty(globalThis, 'fetch');
        if (originalChromeDescriptor) Object.defineProperty(globalThis, 'chrome', originalChromeDescriptor);
        else Reflect.deleteProperty(globalThis, 'chrome');
    }
});


test('bootstrap stores a new special-key SID as an own entry and ignores inherited credentials', async () => {
    const ctx = makeContext();
    ctx.__sessionData.gemini_credentials_map = { neighbor: { sid: 'neighbor', at: 'kept' } };
    vm.runInContext(code, ctx, { filename: 'bootstrap.js' });
    ctx.TestBootstrap.initBootstrap();
    await new Promise(resolve => setImmediate(resolve));
    for (const sid of ['__proto__', 'constructor']) {
        ctx.__testSid = sid;
        vm.runInContext(`
            for (const listener of [...accountListeners]) listener({source: window, origin: location.origin,
                data: {type: 'GEMINI_CREDENTIALS', payload: {sid: __testSid, at: 'fresh', accountSlot: 'u0'}}});
        `, ctx);
        await new Promise(resolve => setImmediate(resolve));
        const stored = ctx.__sessionData.gemini_credentials_map;
        assert.ok(Object.hasOwn(stored, sid), 'new SID must survive object serialization');
        assert.equal(stored[sid].at, 'fresh');
        assert.equal(stored[sid].name, undefined, 'an inherited constructor must not become prior credential metadata');
        assert.equal(stored.neighbor.at, 'kept');
    }
});
