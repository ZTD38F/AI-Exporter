import test from 'node:test';
import assert from 'node:assert/strict';
import { indexStorage } from './helpers/indexStorage.js';
import { discoverChatGPTAccounts } from '../src/runtime/capabilities/chatgptDiscovery.js';
import { ProviderRegistry } from '../src/l1/client/providerRegistry.js';
import { scanAll } from '../src/application/sync/scanController.js';
import { listAccounts, listIndexes } from '../src/l3a/storageService.js';
import { listGen as chatgptListGen } from './fixtures/providers/chatgpt.js';
import { sessionGen as chatgptSessionGen } from './fixtures/providers/chatgptSession.js';

async function environment() {
    const storage = indexStorage({}, { seedAccounts: false });
    await storage.ready;
    const fetchFn = globalThis.fetch;
    let granted = true, open = true;
    const calls: string[] = [];
    Object.assign(chrome, {
        permissions: { contains: async () => granted },
        tabs: { query: async () => open ? [{ id: 1, url: 'https://chatgpt.com/' }] : [] },
    });
    return { calls, grant: (value: boolean) => { granted = value; }, open: (value: boolean) => { open = value; },
        restore() { globalThis.fetch = fetchFn; ProviderRegistry.unregister('chatgpt'); storage.restore(); } };
}

test('ChatGPT discovery is inert without optional access or an open ChatGPT tab', async () => {
    const env = await environment();
    try {
        globalThis.fetch = async () => { throw new Error('Unexpected network request'); };
        env.grant(false);
        assert.deepEqual(await discoverChatGPTAccounts(), []);
        env.grant(true); env.open(false);
        assert.deepEqual(await discoverChatGPTAccounts(), []);
        assert.deepEqual(await listAccounts(), []);
        assert.equal(ProviderRegistry.get('chatgpt'), undefined);
    } finally { env.restore(); }
});

test('Granted discovery registers the session workspace and the production scan commits ChatGPT indexes', async () => {
    const env = await environment();
    try {
        globalThis.fetch = async (input, init) => {
            const url = String(input); env.calls.push(new URL(url).pathname);
            assert.equal(init?.credentials, 'include');
            if (url.endsWith('/api/auth/session')) return new Response(JSON.stringify(chatgptSessionGen('C_DISCOVERY_SESSION_01')));
            assert.equal(url, 'https://chatgpt.com/backend-api/conversations?offset=0&limit=100');
            return new Response(JSON.stringify(chatgptListGen('C_DISCOVERY_LIST_01')));
        };
        const [account] = await discoverChatGPTAccounts();
        assert.equal(account.providerId, 'chatgpt');
        assert.equal(account.providerAccountId, JSON.stringify(['user', 'workspace']));
        assert.equal(ProviderRegistry.get('chatgpt')?.id, 'chatgpt');
        assert.deepEqual(await scanAll({ accountId: account.id }), {
            status: 'complete', pagesFetched: 1, conversationsFetched: 1, indexChanges: { added: 1, updated: 0 },
        });
        assert.equal((await listIndexes(account.id))[0].title, 'ChatGPT conversation');
        assert.deepEqual((await listAccounts()).filter(account => account.providerId === 'gemini'), []);
        assert.ok(env.calls.includes('/backend-api/conversations'));
        const again = await discoverChatGPTAccounts();
        assert.equal(again[0].id, account.id, 'discovery reuses the canonical account');
    } finally { env.restore(); }
});

test('Missing login or workspace identity cannot create a ChatGPT scan account', async () => {
    const env = await environment();
    try {
        for (const key of ['C_DISCOVERY_SESSION_02', 'C_DISCOVERY_SESSION_03', 'C_DISCOVERY_SESSION_04', 'C_DISCOVERY_SESSION_06'] as const) {
            const value = chatgptSessionGen(key);
            globalThis.fetch = async () => new Response(JSON.stringify(value));
            assert.deepEqual(await discoverChatGPTAccounts(), []);
        }
        assert.deepEqual(await listAccounts(), []);
        assert.equal(ProviderRegistry.get('chatgpt'), undefined);
        globalThis.fetch = async () => new Response(JSON.stringify(chatgptSessionGen('C_DISCOVERY_SESSION_05')), { status: 401 });
        await assert.rejects(discoverChatGPTAccounts(), /session failed: 401/);
    } finally { env.restore(); }
});
