export {};
const test = require('node:test');
const assert = require('node:assert');

// cred_storage_unify.test.ts — regression test for the getCredStorage drift.
//
// Three copies of getCredStorage existed:
//   - src/content/bootstrap.ts            (tracked sessionAccessFailed + "not allowed" downgrade)
//   - src/core/api/client/credentialManager.ts  (naive copy, no downgrade)
//   - src/core/storage/storageService.ts        (naive copy, no downgrade)
//
// After unification all surfaces share one module-level flag in
// src/core/api/client/credStorage.ts, so a "not allowed" session failure
// observed on ANY path downgrades ALL paths to chrome.storage.local.

function bustRequireCache(p: string) {
    try {
        delete require.cache[require.resolve(p)];
    } catch { /* never required */ }
}

function freshModules() {
    bustRequireCache('../src/core/api/client/credStorage.js');
    bustRequireCache('../src/core/api/client/credentialManager.js');
    bustRequireCache('../src/content/bootstrap.js');
    // Pre-fix the shared module does not exist yet — the drift repro below
    // only needs the two pre-existing surfaces.
    let credStorage: any = null;
    try {
        credStorage = require('../src/core/api/client/credStorage.js');
    } catch { /* pre-fix: shared module not yet created */ }
    const credManager = require('../src/core/api/client/credentialManager.js').default;
    const bootstrap = require('../src/content/bootstrap.js');
    return { credStorage, credManager, bootstrap };
}

function makeChromeMock(sessionThrows: boolean) {
    const sessionCalls: string[] = [];
    const denied = new Error('not allowed to access chrome.storage.session');
    const stores: Record<string, Record<string, any>> = { local: {}, session: {} };
    const area = (name: 'local' | 'session') => ({
        get: async (keys: any) => {
            if (name === 'session') sessionCalls.push('get');
            if (name === 'session' && sessionThrows) throw denied;
            const out: Record<string, any> = {};
            for (const k of (Array.isArray(keys) ? keys : [keys])) {
                if (Object.prototype.hasOwnProperty.call(stores[name], k)) out[k] = stores[name][k];
            }
            return out;
        },
        set: async (items: any) => {
            if (name === 'session') sessionCalls.push('set');
            if (name === 'session' && sessionThrows) throw denied;
            Object.assign(stores[name], JSON.parse(JSON.stringify(items)));
        },
        remove: async (keys: any) => {
            if (name === 'session') sessionCalls.push('remove');
            for (const k of (Array.isArray(keys) ? keys : [keys])) delete stores[name][k];
        },
    });
    return { mock: { storage: { local: area('local'), session: area('session') } }, sessionCalls };
}

test('unified: healthy session is preferred by every surface', () => {
    const { mock } = makeChromeMock(false);
    (globalThis as any).chrome = mock;
    const { credStorage, credManager, bootstrap } = freshModules();

    assert.strictEqual(credManager.getCredStorage(), mock.storage.session, 'credentialManager prefers session');
    assert.strictEqual(bootstrap.getCredStorage(), mock.storage.session, 'bootstrap prefers session');
    if (credStorage) {
        assert.strictEqual(credStorage.getCredStorage(), mock.storage.session, 'shared module prefers session');
    }

    delete (globalThis as any).chrome;
});

test('unified: "not allowed" on session downgrades ALL surfaces to local', async () => {
    const { mock, sessionCalls } = makeChromeMock(true);
    (globalThis as any).chrome = mock;
    const { credManager, bootstrap } = freshModules();

    // Trip the failure through the bootstrap path (this is where the flag lived).
    const map = await bootstrap.loadCredentialsMap();
    assert.deepStrictEqual(map, {}, 'loadCredentialsMap falls back to local on "not allowed"');

    // Every surface must now resolve to local — pre-fix the credentialManager
    // copy kept returning the broken session area.
    assert.strictEqual(bootstrap.getCredStorage(), mock.storage.local, 'bootstrap downgraded');
    assert.strictEqual(
        credManager.getCredStorage(),
        mock.storage.local,
        'credentialManager must share the downgrade flag (drift: returned session)'
    );

    // Subsequent calls must not touch session at all.
    sessionCalls.length = 0;
    bootstrap.getCredStorage();
    credManager.getCredStorage();
    assert.deepStrictEqual(sessionCalls, [], 'no session access after downgrade');

    delete (globalThis as any).chrome;
});

test('unified: shared module unit behavior', () => {
    const { mock, sessionCalls } = makeChromeMock(false);
    (globalThis as any).chrome = mock;
    const { credStorage } = freshModules();
    if (!credStorage) {
        // Pre-fix: the shared module does not exist yet; the fix must create it.
        assert.fail('shared module src/core/api/client/credStorage.ts does not exist (expected pre-fix)');
    }

    assert.strictEqual(credStorage.getCredStorage(), mock.storage.session, 'prefers session when healthy');

    credStorage.markCredSessionAccessFailed();
    sessionCalls.length = 0;
    assert.strictEqual(credStorage.getCredStorage(), mock.storage.local, 'downgrades after flag');
    assert.deepStrictEqual(sessionCalls, [], 'downgraded resolver never touches session');

    // No session area at all -> local.
    (globalThis as any).chrome = { storage: { local: mock.storage.local } };
    const fresh2 = (() => {
        bustRequireCache('../src/core/api/client/credStorage.js');
        return require('../src/core/api/client/credStorage.js');
    })();
    assert.strictEqual(fresh2.getCredStorage(), mock.storage.local, 'falls back to local without session area');

    // No chrome at all -> null.
    delete (globalThis as any).chrome;
    const fresh3 = (() => {
        bustRequireCache('../src/core/api/client/credStorage.js');
        return require('../src/core/api/client/credStorage.js');
    })();
    assert.strictEqual(fresh3.getCredStorage(), null, 'null without chrome');
});
