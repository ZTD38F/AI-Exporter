import test from 'node:test';
import assert from 'node:assert/strict';
import type { GeminiClientCredentialManagerModule, GeminiCredentials } from '../src/l1/client/gemini/api/credentialManager.js';
import { resolveCred, updateCredential } from '../src/l1/client/gemini/api/credentialManager.js';
import RetryPolicy, { handleHttp400 } from '../src/l1/client/gemini/api/retryPolicy.js';
import { withCredMapLock } from '../src/l1/client/gemini/api/credStorage.js';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type CredentialPorts = [
    Assert<Equal<Extract<keyof GeminiClientCredentialManagerModule, 'loadCredMap' | 'getCredStorage'>, never>>,
    Assert<Equal<Awaited<ReturnType<GeminiClientCredentialManagerModule['resolveCred']>>, GeminiCredentials>>,
];
const contracts: CredentialPorts = [true, true];
void contracts;

function storage(t: import('node:test').TestContext, map: unknown) {
    const previous = new Map(['chrome', 'document', 'location'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    t.after(() => {
        for (const [key, descriptor] of previous) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else Reflect.deleteProperty(globalThis, key);
        }
    });
    Reflect.deleteProperty(globalThis, 'document');
    Reflect.deleteProperty(globalThis, 'location');
    const data = { gemini_credentials_map: map };
    let writes = 0, removals = 0;
    const session = {
        get: async () => structuredClone(data),
        set: async (items: object) => { writes++; Object.assign(data, structuredClone(items)); },
    };
    Object.defineProperty(globalThis, 'chrome', { configurable: true, value: { storage: {
        session, local: { remove: async () => { removals++; } },
    } } });
    return { data, writes: () => writes, removals: () => removals };
}

test('credential ingress rejects invalid fields on direct SID and slot selection without erasing raw neighbors', async t => {
    const valid = { sid: 123, at: 'valid', bl: 'build', accountSlot: 'default', lastUsed: '100', extension: { kept: true } };
    const invalid = {
        badSid: { ...valid, sid: {} }, badAt: { ...valid, at: 7 }, badBl: { ...valid, bl: false },
        badSlot: { ...valid, accountSlot: [] }, badTime: { ...valid, lastUsed: {} },
        array: [valid], primitive: 'not-a-credential', empty: null,
    };
    const raw = { ...invalid, valid };
    const env = storage(t, raw);
    for (const sid of Object.keys(invalid)) assert.equal((await resolveCred(sid)).at, 'valid');
    assert.equal((await resolveCred('default')).sid, 123);
    assert.deepEqual(env.data.gemini_credentials_map, raw);
    assert.equal(env.writes(), 0);
    await updateCredential(123, () => ({ patch: { at: 'not-a-stored-key' } }));
    assert.equal(env.writes(), 0, 'SID field is not a substitute for the persisted map key');
    await updateCredential('valid', () => ({ patch: { at: 'fresh' } }));
    assert.deepEqual(env.data.gemini_credentials_map, { ...invalid, valid: { ...valid, at: 'fresh' } });
    assert.equal(env.removals(), 1);
});

test('HTTP refresh ignores inherited credential keys and preserves explicitly stored special keys', async t => {
    const env = storage(t, {});
    const params = { resp: { status: 400 }, cred: { sid: '__proto__', at: 'old' }, getAtFromPage: () => 'fresh', getBlFromPage: () => null };
    assert.equal((await handleHttp400(params)).shouldRetry, true);
    assert.equal(env.writes(), 0, 'inherited Object.prototype is not a stored credential');
    assert.equal(env.removals(), 0);
    env.data.gemini_credentials_map = JSON.parse('{"__proto__":{"at":"old","extension":{"kept":true}},"neighbor":17}');
    await handleHttp400(params);
    assert.deepEqual(env.data.gemini_credentials_map, JSON.parse('{"__proto__":{"at":"fresh","extension":{"kept":true}},"neighbor":17}'));
    assert.equal(env.writes(), 1);
});

test('credential mutation preserves refresh-specific cleanup and deletes only the expired entry', async t => {
    const env = storage(t, { stale: { at: 'old', sid: 'stale', extension: true }, other: false });
    await updateCredential('stale', () => ({ patch: { at: 'fresh' }, clearLocal: false }));
    assert.deepEqual(env.data.gemini_credentials_map, { stale: { at: 'fresh', sid: 'stale', extension: true }, other: false });
    assert.equal(env.removals(), 0, '401 refresh preserves the existing cleanup policy');
    await updateCredential('stale', () => ({ patch: null }));
    assert.deepEqual(env.data.gemini_credentials_map, { other: false });
    assert.equal(env.removals(), 1);
    await updateCredential('missing', () => ({ patch: null }));
    assert.equal(env.writes(), 2);
});


test('queued 401 observes page rotation after acquiring the credential lock', async t => {
    const env = storage(t, { session: { sid: 'session', at: 'old' } });
    let release = () => {};
    let entered = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    const acquired = new Promise<void>(resolve => { entered = resolve; });
    t.after(() => release());
    const held = withCredMapLock(async () => { entered(); await gate; });
    await acquired;
    let pageAt = 'old', reads = 0;
    const queued = RetryPolicy.handleHttp401({ cred: { sid: 'session', at: 'old' },
        refreshAtFromPage: () => { reads++; return pageAt; } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(reads, 0, 'refresh/delete decision must wait for the same read-modify-write lock');
    pageAt = 'rotated-while-queued';
    release();
    await held;
    await queued;
    assert.deepEqual(env.data.gemini_credentials_map, { session: { sid: 'session', at: pageAt } });
    assert.equal(env.removals(), 0);
});


function currentGeminiPage(t: import('node:test').TestContext, pathname: string) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, '__gemExporterExtractAt');
    t.after(() => {
        if (previous) Object.defineProperty(globalThis, '__gemExporterExtractAt', previous);
        else Reflect.deleteProperty(globalThis, '__gemExporterExtractAt');
    });
    Object.defineProperty(globalThis, 'location', { configurable: true, value: { pathname } });
    Object.defineProperty(globalThis, '__gemExporterExtractAt', { configurable: true, value: () => 'PAGE_AT_CURRENT' });
}

test('page AT never initializes another requested slot from an empty credential map', async t => {
    const env = storage(t, {});
    currentGeminiPage(t, '/app');
    const foreign = await resolveCred('u2');
    assert.equal(foreign.accountSlot, 'u2');
    assert.equal(foreign.at, '');
    assert.equal(env.writes(), 0, 'page token must not be persisted under the foreign slot');

    const current = await resolveCred('default');
    assert.equal(current.accountSlot, 'default');
    assert.equal(current.at, 'PAGE_AT_CURRENT');
    assert.equal(env.writes(), 1, 'the same page may initialize its own slot');
});

test('explicit foreign SID with missing token never borrows the current page AT', async t => {
    const raw = {
        foreign: { sid: 'foreign', at: '', bl: 'BL_FOREIGN', accountSlot: 'u2' },
        current: { sid: 'current', at: 'CURRENT_STORED', accountSlot: 'default' },
    };
    const env = storage(t, raw);
    currentGeminiPage(t, '/app');
    const resolved = await resolveCred('foreign');
    assert.equal(resolved.sid, 'foreign');
    assert.equal(resolved.accountSlot, 'u2');
    assert.equal(resolved.at, '');
    assert.equal(env.writes(), 0);
    assert.deepEqual(env.data.gemini_credentials_map, raw);
});

test('matching-slot page AT backfill keeps exact keys, foreign accounts and extra fields', async t => {
    const raw = {
        foreign: { sid: 'foreign', at: '', accountSlot: 'u2', extension: { untouched: true } },
        current: { sid: 'current', at: '', bl: 'BL_CURRENT', accountSlot: 'default',
            extension: { kept: true } },
        other: { sid: 'other', at: 'TOKEN_OTHER', accountSlot: 'u3' },
    };
    const env = storage(t, raw);
    currentGeminiPage(t, '/app');
    const resolved = await resolveCred('default');
    assert.equal(resolved.sid, 'current');
    assert.equal(resolved.at, 'PAGE_AT_CURRENT');
    assert.equal(resolved.bl, 'BL_CURRENT');
    assert.deepEqual(env.data.gemini_credentials_map, {
        ...raw, current: { ...raw.current, at: 'PAGE_AT_CURRENT', lastUsed: resolved.lastUsed },
    });
    assert.equal(env.writes(), 1);
    assert.equal(env.removals(), 1);
});

test('credential selection rejects invalid SID, lastUsed and slot values without erasing raw storage', async t => {
    const healthy = { sid: 'healthy', at: 'HEALTHY_AT', accountSlot: 'default', lastUsed: 300 };
    const invalid = {
        sidNaN: { ...healthy, sid: NaN },
        sidInfinity: { ...healthy, sid: Infinity },
        sidNegative: { ...healthy, sid: -2 },
        sidFraction: { ...healthy, sid: 2.5 },
        timeInfinity: { ...healthy, lastUsed: Infinity },
        timeStringInfinity: { ...healthy, lastUsed: 'Infinity' },
        timeStringOverflow: { ...healthy, lastUsed: '1e309' },
        timeNegative: { ...healthy, lastUsed: -1 },
        timeUnsafe: { ...healthy, lastUsed: Number.MAX_SAFE_INTEGER + 1 },
        slotPath: { ...healthy, accountSlot: 'u2/../../' },
        slotUnknown: { ...healthy, accountSlot: 'foreign-account-uuid' },
    };
    const raw = {
        ...invalid, healthy,
        legacy: { sid: 12345, at: 'LEGACY_AT', accountSlot: '/u/2', lastUsed: '101' },
        largeNumericSid: { sid: 1e19, at: 'LARGE_SID', accountSlot: 'u3' },
    };
    const env = storage(t, raw);
    for (const key of Object.keys(invalid)) {
        const result = await resolveCred(key);
        assert.equal(result.at, 'HEALTHY_AT', key);
        assert.equal(result.sid, 'healthy', key);
    }
    const latest = await resolveCred('default');
    assert.equal(latest.sid, 'healthy');
    const legacy = await resolveCred('u2');
    assert.equal(legacy.at, 'LEGACY_AT');
    assert.equal(legacy.accountSlot, 'u2', 'historical URL-style slots normalize only in the trusted view');
    const largeSid = await resolveCred('largeNumericSid');
    assert.equal(largeSid.sid, 1e19, 'historic large numeric SIDs must remain readable');
    assert.equal(env.writes(), 0);
    assert.deepEqual(env.data.gemini_credentials_map, raw);
});

test('credential mutation retains a captured local storage reference across async browser teardown', async t => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
    t.after(() => {
        if (previous) Object.defineProperty(globalThis, 'chrome', previous);
        else Reflect.deleteProperty(globalThis, 'chrome');
    });
    const data = { gemini_credentials_map: { stored: { sid: 'stored', at: 'old' } } };
    let removed = 0;
    const local = { remove: async () => { removed++; } };
    const session = {
        get: async () => structuredClone(data),
        set: async (items: object) => {
            Object.assign(data, structuredClone(items));
            Reflect.deleteProperty(globalThis, 'chrome');
        },
    };
    Object.defineProperty(globalThis, 'chrome', { configurable: true, value: { storage: { session, local } } });
    await updateCredential('stored', () => ({ patch: { at: 'new' } }));
    assert.equal(data.gemini_credentials_map.stored.at, 'new');
    assert.equal(removed, 1, 'cleanup must use the acquired local reference without re-reading chrome');
});
