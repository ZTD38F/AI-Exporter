import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveCurrentAccount, getAccountContext, invalidateAccountContext } from '../src/runtime/content/accountContext.js';
import { sessionGen as chatgptSessionGen } from './fixtures/providers/chatgptSession.js';

test('ChatGPT badge binds session subject and workspace, rejects other providers and clears logout', async t => {
    const names = ['window', 'location', 'chrome', 'fetch'];
    const prior = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
    t.after(() => {
        invalidateAccountContext();
        for (const name of names) {
            const descriptor = prior.get(name);
            if (descriptor) Object.defineProperty(globalThis, name, descriptor);
            else Reflect.deleteProperty(globalThis, name);
        }
    });
    let workspace = 'workspace-1';
    let loggedIn = true;
    let requests = 0;
    const id1 = '11111111-1111-4111-8111-111111111111';
    const id2 = '22222222-2222-4222-8222-222222222222';
    Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
    Object.defineProperty(globalThis, 'location', { configurable: true, value: {
        protocol: 'https:', hostname: 'chatgpt.com', origin: 'https://chatgpt.com', href: 'https://chatgpt.com/c/test',
    } });
    Object.defineProperty(globalThis, 'fetch', { configurable: true, value: async (url: string) => {
        assert.equal(url, '/api/auth/session');
        requests++;
        return Response.json(loggedIn
            ? chatgptSessionGen(workspace === 'workspace-1' ? 'C_ACCOUNT_CONTEXT_WORKSPACE_01' : 'C_ACCOUNT_CONTEXT_WORKSPACE_02')
            : chatgptSessionGen('C_ACCOUNT_CONTEXT_LOGOUT_01'));
    } });
    Object.defineProperty(globalThis, 'chrome', { configurable: true, value: { runtime: {
        sendMessage: async (message: Record<string, unknown>) => {
            if (message.action === 'ensureV2Ready') return { ok: true };
            assert.equal(message.command, 'getOrCreate');
            assert.equal(message.providerId, 'chatgpt');
            assert.equal(message.providerAccountId, JSON.stringify(['subject', workspace]));
            assert.equal(JSON.stringify(message).includes('private-token'), false);
            return { ok: true, value: { id: workspace === 'workspace-1' ? id1 : id2,
                providerId: 'chatgpt', providerAccountId: message.providerAccountId } };
        },
    } } });
    invalidateAccountContext();
    assert.equal((await resolveCurrentAccount())?.accountId, id1);
    workspace = 'workspace-2';
    assert.equal((await resolveCurrentAccount())?.accountId, id2);
    assert.equal(getAccountContext()?.providerId, 'chatgpt');
    await assert.rejects(resolveCurrentAccount({ providerId: 'gemini', providerAccountId: 'wrong-provider' }), /Wrong account observation provider/);
    loggedIn = false;
    assert.equal(await resolveCurrentAccount(), null);
    assert.equal(getAccountContext(), null);
    assert.equal(requests, 3);
});
