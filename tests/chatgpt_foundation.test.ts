export {};
const test = require('node:test');
const assert = require('node:assert');

const {
    acquireChatGPTSession,
    safeSessionSummary,
    ChatGPTAuthError
} = require('../src/core/provider/chatgpt/auth.js');
const {
    ChatGPTTransport,
    ChatGPTTransportError,
    validateChatGPTReadPath
} = require('../src/core/provider/chatgpt/transport.js');
const {
    parseChatGPTWorkspaces,
    workspaceKey,
    publicWorkspace
} = require('../src/core/provider/chatgpt/workspaces.js');
const TabService = require('../src/core/utils/tabService.js');

function jsonResponse(status: number, body: any, headers: Record<string, string> = {}) {
    const text = JSON.stringify(body);
    const bytes = new TextEncoder().encode(text);
    const normalized = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    return {
        status,
        ok: status >= 200 && status < 300,
        headers: {
            get(name: string) {
                if (name.toLowerCase() === 'content-length') return normalized['content-length'] ?? String(bytes.byteLength);
                return normalized[name.toLowerCase()] ?? null;
            }
        },
        async json() { return body; },
        async arrayBuffer() {
            return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        }
    };
}

test('ChatGPT auth - session bootstrap uses browser cookies and safe summary never exposes bearer', async () => {
    const calls: any[] = [];
    const fetchImpl = async (url: string, init: any) => {
        calls.push([url, init]);
        return jsonResponse(200, {
            accessToken: 'abcdefghijklmnopqrstuvwxyz0123456789',
            expires: '2026-09-22T02:00:00Z',
            user: { email: 'user@example.com', name: 'Example User' }
        });
    };

    const session = await acquireChatGPTSession(fetchImpl);
    assert.strictEqual(session.accessToken, 'abcdefghijklmnopqrstuvwxyz0123456789');
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0][0], 'https://chatgpt.com/api/auth/session');
    assert.strictEqual(calls[0][1].credentials, 'include');
    assert.strictEqual(calls[0][1].cache, 'no-store');

    const summary = safeSessionSummary(session);
    assert.strictEqual(summary.authenticated, true);
    assert.strictEqual((summary as any).user.email, 'user@example.com');
    assert.ok(!JSON.stringify(summary).includes('abcdefghijklmnopqrstuvwxyz0123456789'));
    assert.ok(!Object.prototype.hasOwnProperty.call(summary, 'accessToken'));
});

test('ChatGPT auth - missing token fails explicitly', async () => {
    await assert.rejects(
        () => acquireChatGPTSession(async () => jsonResponse(200, { user: { email: 'x@y.z' } })),
        (error: any) => error instanceof ChatGPTAuthError && error.code === 'AUTH_REQUIRED'
    );
});

test('ChatGPT transport - rejects arbitrary origins, traversal and non-allowlisted endpoints', () => {
    assert.throws(
        () => validateChatGPTReadPath('https://evil.example/data'),
        (error: any) => error instanceof ChatGPTTransportError && error.code === 'PATH_REJECTED'
    );
    assert.throws(
        () => validateChatGPTReadPath('/backend-api/conversation/%2e%2e/settings'),
        (error: any) => error instanceof ChatGPTTransportError && error.code === 'PATH_REJECTED'
    );
    assert.throws(
        () => validateChatGPTReadPath('/backend-api/conversation/delete-all/action'),
        (error: any) => error instanceof ChatGPTTransportError && error.code === 'PATH_NOT_ALLOWLISTED'
    );
    assert.strictEqual(
        validateChatGPTReadPath('/backend-api/accounts/check/v4-2023-04-27'),
        '/backend-api/accounts/check/v4-2023-04-27'
    );
    assert.strictEqual(
        validateChatGPTReadPath('/backend-api/conversations?offset=0&limit=28&order=updated'),
        '/backend-api/conversations?offset=0&limit=28&order=updated'
    );
});

test('ChatGPT transport - sends bearer only to allowlisted chatgpt.com API and isolates workspace header', async () => {
    const calls: any[] = [];
    const transport = new ChatGPTTransport(
        { accessToken: 'abcdefghijklmnopqrstuvwxyz0123456789' },
        {
            fetchImpl: async (url: string, init: any) => {
                calls.push([url, init]);
                return jsonResponse(200, { accounts: {} });
            },
            maxRetries: 0
        }
    );

    const value = await transport.requestJson('/backend-api/accounts/check/v4-2023-04-27', 'workspace-123');
    assert.deepStrictEqual(value, { accounts: {} });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0][0], 'https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27');
    assert.strictEqual(calls[0][1].method, 'GET');
    assert.strictEqual(calls[0][1].credentials, 'include');
    assert.strictEqual(calls[0][1].headers.Authorization, 'Bearer abcdefghijklmnopqrstuvwxyz0123456789');
    assert.strictEqual(calls[0][1].headers['X-Authorization'], 'Bearer abcdefghijklmnopqrstuvwxyz0123456789');
    assert.strictEqual(calls[0][1].headers['ChatGPT-Account-Id'], 'workspace-123');
});

test('ChatGPT transport - 401 is AUTH_REQUIRED and 429 retry is bounded', async () => {
    const authTransport = new ChatGPTTransport(
        { accessToken: 'abcdefghijklmnopqrstuvwxyz0123456789' },
        {
            fetchImpl: async () => jsonResponse(401, {}),
            maxRetries: 0
        }
    );
    await assert.rejects(
        () => authTransport.requestJson('/backend-api/accounts/check/v4-2023-04-27'),
        (error: any) => error instanceof ChatGPTTransportError && error.code === 'AUTH_REQUIRED' && error.status === 401
    );

    let calls = 0;
    const sleeps: number[] = [];
    const limited = new ChatGPTTransport(
        { accessToken: 'abcdefghijklmnopqrstuvwxyz0123456789' },
        {
            fetchImpl: async () => {
                calls++;
                if (calls === 1) return jsonResponse(429, {}, { 'retry-after': '0.001' });
                return jsonResponse(200, { ok: true });
            },
            sleep: async (ms: number) => { sleeps.push(ms); },
            random: () => 0,
            maxRetries: 1
        }
    );
    const value = await limited.requestJson('/backend-api/accounts/check/v4-2023-04-27');
    assert.deepStrictEqual(value, { ok: true });
    assert.strictEqual(calls, 2);
    assert.ok(sleeps.length <= 1, 'cooldown may resolve before a synthetic sleep is needed');
});

test('ChatGPT workspace discovery - filters deactivated/duplicates and never exposes raw account id publicly', async () => {
    const raw = {
        accounts: {
            one: { account: { account_id: 'acct_A', account_name: 'Personal' } },
            dup: { account: { account_id: 'acct_A', account_name: 'Duplicate' } },
            two: { account: { account_id: 'acct_B', account_name: 'Work' } },
            off: { is_deactivated: true, account: { account_id: 'acct_C', account_name: 'Disabled' } }
        }
    };

    const workspaces = await parseChatGPTWorkspaces(raw);
    assert.strictEqual(workspaces.length, 2);
    assert.deepStrictEqual(workspaces.map((w: any) => w.name), ['Personal', 'Work']);

    const expectedA = await workspaceKey('acct_A');
    assert.strictEqual(workspaces[0].key, expectedA);
    assert.ok(!workspaces[0].key.includes('acct_A'));

    const publicValue = publicWorkspace(workspaces[0]);
    assert.deepStrictEqual(publicValue, { key: expectedA, name: 'Personal' });
    assert.ok(!JSON.stringify(publicValue).includes('acct_A'));
});

test('TabService - ChatGPT discovery is narrow and provider-specific', async () => {
    const oldChrome = (global as any).chrome;
    const queries: string[] = [];
    try {
        (global as any).chrome = {
            tabs: {
                query: async ({ url }: any) => {
                    queries.push(url);
                    if (url === 'https://chatgpt.com/*') {
                        return [{ id: 77, active: true, url: 'https://chatgpt.com/c/example' }];
                    }
                    return [];
                }
            },
            runtime: { lastError: null }
        };

        const tab = await TabService.getAITab('chatgpt');
        assert.strictEqual(tab.id, 77);
        assert.deepStrictEqual(queries, ['https://chatgpt.com/*']);
    } finally {
        (global as any).chrome = oldChrome;
    }
});
