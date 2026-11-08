import { geminiListPage, GEMINI_LIST_CAPTURE } from './fixtures/providers/geminiListCapture.js';
export {};
const test = require('node:test');
const assert = require('node:assert');

const { GeminiAPIClient } = require('../src/l1/client/gemini/geminiClient.js');
const { handleHttp400 } = require('../src/l1/client/gemini/api/retryPolicy.js');
const { useIndexStorage } = require('./helpers/indexStorage.js');
useIndexStorage();

// 1. handleHttp400 XSRF recovery logic in retryPolicy
test('retryPolicy - handleHttp400 extracts xsrf token from response snippet and signals retry', async () => {
    const mockSnippet = ')]}\'\n[["xsrf","fresh_xsrf_token_456"],["error","invalid_token"]]';
    const params = {
        resp: { status: 400 },
        snippet: mockSnippet,
        cred: { at: 'old_stale_token', sid: 'sid_123' },
        isRetried: false
    };

    const res = await handleHttp400(params);
    assert.strictEqual(res.shouldRetry, true, 'Should signal retry on 400 with xsrf token');
    assert.strictEqual(res.freshAt, 'fresh_xsrf_token_456');

    // Already retried should not retry again (prevent loop)
    const resAlready = await handleHttp400({ ...params, isRetried: true });
    assert.strictEqual(resAlready.shouldRetry, false, 'Should not retry if already retried');
});

test('retryPolicy - handleHttp400 uses getAtFromPage fallback if snippet has no xsrf token', async () => {
    const params = {
        resp: { status: 400 },
        snippet: 'General 400 Bad Request',
        cred: { at: 'old_token', sid: 'sid_123' },
        isRetried: false,
        getAtFromPage: () => 'page_fresh_token_789'
    };

    const res = await handleHttp400(params);
    assert.strictEqual(res.shouldRetry, true);
    assert.strictEqual(res.freshAt, 'page_fresh_token_789');

    // If page token is identical to current cred.at, do not retry
    const resSame = await handleHttp400({
        ...params,
        getAtFromPage: () => 'old_token'
    });
    assert.strictEqual(resSame.shouldRetry, false, 'Should not retry if token unchanged');
});

// 2. GeminiAPIClient HTTP 400 automatic retry
test('geminiClient - getConversationList recovers on HTTP 400 with fresh credentials', async () => {
    const client = new GeminiAPIClient();
    const originalFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
    let callCount = 0;

    (global as any).fetch = async (_url: string, _opts: any) => {
        callCount++;
        if (callCount === 1) {
            // First call fails with 400 and xsrf token snippet
            return {
                ok: false,
                status: 400,
                statusText: 'Bad Request',
                text: async () => ')]}\'\n[["xsrf","fresh_xsrf_token_999"]]'
            };
        }
        // Second call succeeds with valid batchexecute list
        return {
            ok: true,
            status: 200,
            text: async () => geminiListPage().responseBody
        };
    };

    try {
        const res = await client.getConversationList(null, 'u0');
        assert.strictEqual(callCount, 2, 'Should have retried once on 400');
        assert.strictEqual(res.conversations.length, GEMINI_LIST_CAPTURE.firstPageRows);
        assert.strictEqual(res.conversations[0].id, GEMINI_LIST_CAPTURE.first.id);
    } finally {
        if (originalFetch) Object.defineProperty(globalThis, 'fetch', originalFetch);
        else delete (global as any).fetch;
    }
});

// 3. GeminiAPIClient AbortSignal handling
test('geminiClient - abort signal immediately halts client and flags isAborted', () => {
    const client = new GeminiAPIClient();
    assert.strictEqual(client.isAborted(), false);

    client.abort();
    assert.strictEqual(client.isAborted(), true);

    const controller = new AbortController();
    const clientWithSignal = new GeminiAPIClient({ signal: controller.signal });
    assert.strictEqual(clientWithSignal.isAborted(), false);

    controller.abort();
    assert.strictEqual(clientWithSignal.isAborted(), true);
});


