export {};

// known_issue_credentials_session.test.js — INTENTIONALLY RED.
//
// KNOWN ISSUE (audit report P1-2.6, still open after #194):
// Gemini session tokens (at / SNlM0e — functionally CSRF credentials for the
// Google account) are persisted in chrome.storage.local: plaintext on disk,
// never cleared on logout, readable by any code running in the extension.
// Desired behavior: keep credentials in chrome.storage.session (memory-
// scoped, cleared when the browser session ends), plus explicit cleanup on
// 401/logout.
//
// Fix path note: chrome.storage.session is not exposed to content scripts
// by default — background must call
//   chrome.storage.session.setAccessLevel('TRUSTED_AND_UNTRUSTED_CONTEXTS')
// or the content script must proxy credential writes through the service
// worker. This test pins the desired end state.
//
// This file makes `npm test` fail by design until the issue is fixed. Do
// not merge to main while it is red.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');

const code = fs.readFileSync(path.join(__dirname, '..', 'src', 'content', 'bootstrap.js'), 'utf8');
const protocolCode = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'protocol', 'protocol.js'), 'utf8');

function makeContext() {
    const ctx: Record<string, any> = {
        console: { log: () => {}, warn: () => {}, debug: () => {} },
        URL,
        chrome: {
            runtime: { id: 'test-extension' },
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
    return ctx;
}

test('p1-lock: session tokens live in chrome.storage.session, never in chrome.storage.local', async () => {
    const ctx = makeContext();
    ctx.WIZ_global_data = { SNlM0e: 'ATTEST0123456789abcdef' };

    // Mirror the browser load order: protocol.js loads before bootstrap.js.
    vm.runInContext(protocolCode, ctx, { filename: 'protocol.js' });
    vm.runInContext(code, ctx, { filename: 'bootstrap.js' });
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

test('StorageService credentials storage uses chrome.storage.session and cleans local', async () => {
    const StorageService = require('../src/core/storage/storageService.js');
    const localStore: Record<string, any> = { gemini_credentials_map: { old_sid: { at: 'old_at', sid: 'old_sid' } } };
    const sessionStore: Record<string, any> = {};
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

    // 1. getCredentialsMap migrates from local to session and cleans local
    const map = await StorageService.getCredentialsMap();
    assert.strictEqual(map.old_sid?.at, 'old_at');
    assert.strictEqual(sessionStore.gemini_credentials_map?.old_sid?.at, 'old_at');
    assert.strictEqual(localStore.gemini_credentials_map, undefined);

    // 2. setCredentialsMap writes to session and ensures local is clean
    await StorageService.setCredentialsMap({
        new_sid: { at: 'new_at', sid: 'new_sid' }
    });
    assert.strictEqual(sessionStore.gemini_credentials_map.new_sid.at, 'new_at');
    assert.strictEqual(localStore.gemini_credentials_map, undefined);

    // 3. clearCredentials deletes specific sid from session
    await StorageService.clearCredentials('new_sid');
    assert.strictEqual(sessionStore.gemini_credentials_map.new_sid, undefined);
});

test('GeminiAPIClient 401 response purges expired sid from session storage', async () => {
    const { GeminiAPIClient } = require('../src/core/api/geminiClient.js');
    const sessionStore: Record<string, any> = {
        gemini_credentials_map: {
            bad_sid: { at: 'bad_token', sid: 'bad_sid', accountSlot: 'default' }
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

    const client = new GeminiAPIClient();
    const originalFetch = (global as any).fetch;
    (global as any).fetch = async () => ({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        text: async () => 'Unauthorized'
    });

    try {
        await client.getConversationList(null, 'bad_sid');
        assert.fail('should have thrown 401');
    } catch (err: any) {
        assert.ok(err.message.includes('401'));
    } finally {
        (global as any).fetch = originalFetch;
    }

    assert.strictEqual(sessionStore.gemini_credentials_map.bad_sid, undefined, '401 must evict bad_sid from session storage');
});
