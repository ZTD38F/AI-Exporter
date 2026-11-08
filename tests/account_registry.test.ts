import { fixtureAccount } from './helpers/domainFixture.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readAccount, readAccountParameters, readAccountRegistry, findAccount } from '../src/l2/accountRegistry.js';
import { geminiAccountObservation } from '../src/l1/client/gemini/accountObservation.js';
import { chatgptAccountObservation } from '../src/l1/client/chatgpt/accountObservation.js';
import { resolveCurrentAccount, resolveRequestAccount, getAccountContext, invalidateAccountContext } from '../src/runtime/content/accountContext.js';
import { accountRuntime, ACCOUNT_UUID, OTHER_ACCOUNT_UUID, ACCOUNT_OBSERVATION } from './helpers/accountRuntime.js';
const alice = { id: ACCOUNT_UUID, providerId: 'gemini', providerAccountId: '101', email: 'alice@example.com' };

test('matching preserves UUID and missing profile fields; mutable email is not identity', () => {
    assert.deepEqual(findAccount([alice], 'gemini', '101'), alice);
    assert.deepEqual(findAccount([alice], 'gemini', '101', 'new@example.com'), { ...alice, email: 'new@example.com' });
    assert.equal(findAccount([alice], 'claude', '101', alice.email), null);
    assert.equal(findAccount([alice], 'gemini', '102', alice.email), null);
    assert.equal(alice.email, 'alice@example.com');
});
test('only Account is durable; UUID, identity, extra fields and duplicates are validated', () => {
    assert.deepEqual(readAccount(alice), alice);
    for (const patch of [{ id: 'u0' }, { id: alice.email }, { slot: 'u0' }, { count: 1 }, { email: null }, { displayName: '' }]) {
        assert.throws(() => readAccount({ ...alice, ...patch }), TypeError);
    }
    assert.throws(() => readAccountRegistry([alice, alice]), /Duplicate/);
    assert.throws(() => readAccountRegistry([alice, { ...alice, id: OTHER_ACCOUNT_UUID }]), /Duplicate/);
    assert.throws(() => readAccountParameters({ providerId: 'gemini', email: alice.email }));
});
test('default is a normal UUID account with a provider-local reserved key and no borrowed profile', () => {
    const fallback = { id: OTHER_ACCOUNT_UUID, providerId: 'gemini', providerAccountId: 'default' };
    assert.deepEqual(readAccount({ ...fallback, email: alice.email, displayName: 'Unverified' }), fallback);
    assert.deepEqual(findAccount([fallback], 'gemini', 'default', alice.email), fallback);
    assert.equal(findAccount([fallback], 'chatgpt', 'default'), null);
    assert.equal(findAccount([fallback], 'gemini', alice.providerAccountId), null);
});
test('Gemini requires Gaia and normalizes only its verified profile', () => {
    assert.equal(geminiAccountObservation({ email: alice.email }), null);
    assert.deepEqual(geminiAccountObservation({ gaiaId: ' 101 ', email: ' ALICE@EXAMPLE.COM ', name: ' Alice ' }), {
        providerId: 'gemini', providerAccountId: '101', email: alice.email, displayName: 'Alice'
    });
});
test('ChatGPT user/workspace tuple isolates subjects and keeps email mutable', () => {
    const session = { user: { id: 'user-a', email: ' ALICE@EXAMPLE.COM ', name: ' Alice ' }, account: { id: 'workspace-a' }, accessToken: 'never-persist' };
    const parameters = chatgptAccountObservation(session)!;
    assert.deepEqual(parameters, { providerId: 'chatgpt', providerAccountId: '["user-a","workspace-a"]', email: alice.email, displayName: 'Alice' });
    const account = { ...parameters, id: ACCOUNT_UUID };
    assert.equal(findAccount([account], 'chatgpt', parameters.providerAccountId, 'new@example.com')?.id, ACCOUNT_UUID);
    for (const other of [{ ...session, account: { id: 'workspace-b' } }, {   ...session, user: { id: 'user-b' } }]) {
        assert.notEqual(chatgptAccountObservation(other)?.providerAccountId, parameters.providerAccountId);
    }
    for (const invalid of [null, {}, { user: session.user }, { user: session.user, account: { id: 'default' } }]) assert.equal(chatgptAccountObservation(invalid), null);
    assert.notEqual(chatgptAccountObservation({ user: { id: 'a:b' }, account: { id: 'c' } })?.providerAccountId,
        chatgptAccountObservation({ user: { id: 'a' }, account: { id: 'b:c' } })?.providerAccountId);
});
test('concurrent Gaia discovery reuses UUID; Gaia loss clears context without allocating a default', async () => {
    const runtime = accountRuntime();
    try {
        const contexts = await Promise.all([resolveCurrentAccount(), resolveCurrentAccount(), resolveCurrentAccount()]);
        assert.deepEqual(contexts.map(context => context?.accountId), [ACCOUNT_UUID, ACCOUNT_UUID, ACCOUNT_UUID]);
        runtime.state.observation = null;
        const fallback = await resolveCurrentAccount();
        assert.equal(fallback, null);
        assert.equal(getAccountContext(), null);
        runtime.state.observation = { ...ACCOUNT_OBSERVATION };
        assert.equal((await resolveCurrentAccount())?.accountId, ACCOUNT_UUID);
    } finally { runtime.restore(); }
});
test('late response keeps the captured account after a same-slot switch; unknown maps to existing first real account', async () => {
    const runtime = accountRuntime();
    try {
        await resolveCurrentAccount();
        runtime.state.observation = { providerId: 'gemini', providerAccountId: 'other-gaia' };
        assert.equal((await resolveCurrentAccount())?.accountId, OTHER_ACCOUNT_UUID);
        assert.equal((await resolveRequestAccount(ACCOUNT_OBSERVATION, 'u0'))?.accountId, ACCOUNT_UUID);
        assert.equal(getAccountContext()?.accountId, OTHER_ACCOUNT_UUID);
        assert.equal((await resolveRequestAccount(null, 'u0'))?.accountId, ACCOUNT_UUID);
        assert.equal(await resolveRequestAccount(undefined, 'u0'), null);
    } finally { runtime.restore(); }
});
test('failed persistence cannot acknowledge a new binding', async () => {
    const runtime = accountRuntime(); const original = chrome.runtime.sendMessage;
    try {
        chrome.runtime.sendMessage = (async () => { throw new Error('disk failed'); }) as typeof original;
        await assert.rejects(resolveCurrentAccount(), /disk failed/);
        assert.equal(getAccountContext(), null);
        invalidateAccountContext();
    } finally { chrome.runtime.sendMessage = original; runtime.restore(); }
});

test('same-account profile updates retain the committed binding and coalesce identical writes', async () => {
    const runtime = accountRuntime(); const original = chrome.runtime.sendMessage;
    try {
        await resolveCurrentAccount(ACCOUNT_OBSERVATION);
        let release!: () => void, calls = 0;
        const gate = new Promise<void>(resolve => { release = resolve; });
        chrome.runtime.sendMessage = (async message => {
            calls++;
            await gate;
            return Reflect.apply(original, chrome.runtime, [message]);
        }) as typeof original;
        const changed = {...ACCOUNT_OBSERVATION, email:'changed@example.com'};
        const first = resolveCurrentAccount(changed);
        const second = resolveCurrentAccount(changed);
        assert.equal(getAccountContext()?.accountId, ACCOUNT_UUID);
        assert.equal(calls, 1);
        release();
        assert.deepEqual((await Promise.all([first,second])).map(value => value?.accountId), [ACCOUNT_UUID,ACCOUNT_UUID]);
    } finally {chrome.runtime.sendMessage = original; runtime.restore();}
});
test('a failed profile update leaves the committed UUID usable and the new profile retryable', async () => {
    const runtime = accountRuntime(); const original = chrome.runtime.sendMessage;
    try {
        await resolveCurrentAccount(ACCOUNT_OBSERVATION);
        const changed = {...ACCOUNT_OBSERVATION, email:'retry@example.com'};
        chrome.runtime.sendMessage = (async () => { throw new Error('quota'); }) as typeof original;
        await assert.rejects(resolveCurrentAccount(changed), /quota/);
        assert.equal(getAccountContext()?.accountId, ACCOUNT_UUID);
        chrome.runtime.sendMessage = original;
        assert.equal((await resolveCurrentAccount(changed))?.accountId, ACCOUNT_UUID);
    } finally {chrome.runtime.sendMessage = original; runtime.restore();}
});
test('a delayed registration cannot restore a superseded current-tab binding', async () => {
    const runtime = accountRuntime(); const original = chrome.runtime.sendMessage;
    let release!: () => void;
    try {
        const gate = new Promise<void>(resolve => {release = resolve;});
        chrome.runtime.sendMessage = (async (message: {providerAccountId?: string}) => {
            if(message.providerAccountId === ACCOUNT_OBSERVATION.providerAccountId) await gate;
            return Reflect.apply(original, chrome.runtime, [message]);
        }) as typeof original;
        const old = resolveCurrentAccount(ACCOUNT_OBSERVATION);
        assert.equal((await resolveCurrentAccount({providerId:'gemini',providerAccountId:'other-gaia'}))?.accountId, OTHER_ACCOUNT_UUID);
        release();
        assert.equal(await old, null);
        assert.equal(getAccountContext()?.accountId, OTHER_ACCOUNT_UUID);
    } finally {release?.(); chrome.runtime.sendMessage = original; runtime.restore();}
});
test('mismatched committed identities never bind a UUID to the current tab', async () => {
    const runtime = accountRuntime(); const original = chrome.runtime.sendMessage;
    try {
        chrome.runtime.sendMessage = (async () => ({ok:true,value:{...alice,providerAccountId:'unexpected'}})) as typeof original;
        await assert.rejects(resolveCurrentAccount(ACCOUNT_OBSERVATION), /identity mismatch/);
        assert.equal(getAccountContext(), null);
    } finally {chrome.runtime.sendMessage = original; runtime.restore();}
});
