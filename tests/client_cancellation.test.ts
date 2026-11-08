import test from 'node:test';
import assert from 'node:assert/strict';
import { useIndexStorage } from './helpers/indexStorage.js';
import { GeminiAPIClient } from '../src/l1/client/gemini/geminiClient.js';
import retryPolicy from '../src/l1/client/gemini/api/retryPolicy.js';
useIndexStorage();
for (const operation of ['list', 'detail'] as const) for (const signalSource of ['call', 'client'] as const) {
    test(`${operation}: cancellation during actual HTTP 429 backoff propagates AbortError (${signalSource} signal)`, async () => {
        const originalFetch = globalThis.fetch, originalRetry = retryPolicy.handleHttp429;
        const controller = new AbortController();
        let requests = 0, backoffs = 0;
        globalThis.fetch = async () => { requests++; return new Response('rate limited', { status: 429, headers: { 'retry-after': '30' } }); };
        retryPolicy.handleHttp429 = async params => {
            backoffs++;
            const waiting = originalRetry(params);
            queueMicrotask(() => controller.abort());
            return waiting;
        };
        try {
            const client = new GeminiAPIClient(signalSource === 'client' ? { signal: controller.signal } : {});
            const opts = signalSource === 'call' ? { signal: controller.signal } : undefined;
            await assert.rejects(operation === 'list' ? client.getConversationList(null, 'u0', undefined, opts)
                : client.fetchConversationPage('source_chat_123', null, 'u0', opts), { name: 'AbortError' });
            assert.equal(requests, 1); assert.equal(backoffs, 1);
        } finally { globalThis.fetch = originalFetch; retryPolicy.handleHttp429 = originalRetry; }
    });
}
test('exhausted 429 retries remain an ordinary source failure', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () => new Response('rate limited', { status: 429 });
    try { await assert.rejects(new GeminiAPIClient().getConversationList(null, 'u0', undefined, { maxRetries: 0 }), error => error instanceof Error && error.name !== 'AbortError' && /429/.test(error.message)); }
    finally { globalThis.fetch = original; }
});
