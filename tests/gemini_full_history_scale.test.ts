import test from 'node:test';
import assert from 'node:assert/strict';
import { indexStorage } from './helpers/indexStorage.js';
import { ACCOUNT_UUID } from './helpers/accountRuntime.js';
import { sourceDetail } from './helpers/l1SourceFixture.js';
import { GeminiProvider } from '../src/l1/client/gemini/geminiProvider.js';
import { ProviderRegistry } from '../src/l1/client/providerRegistry.js';
import { defaultGeminiProvider } from '../src/l1/client/gemini/geminiProvider.js';
import { scanAll } from '../src/application/sync/scanController.js';
import { listIndexes } from '../src/l3a/storageService.js';

// Synthetic provider pages are a regression contract, not evidence that Google's
// authenticated server exposes historical pages beyond its own sliding window.
for (const count of [299, 300, 301, 350, 500, 501, 1000]) {
    test('Gemini fetches and stores every discoverable chat, count=' + count, async () => {
        const store = indexStorage();
        await store.ready;
        const original = ProviderRegistry.get('gemini');
        let calls = 0;
        const provider = new GeminiProvider({
            getConversationList: async cursor => {
                calls++;
                const start = Number(cursor ?? 0);
                const end = Math.min(count, start + 50);
                const conversations = Array.from({ length: end - start }, (_, i) => {
                    const n = start + i;
                    return { id: 'c_history_' + String(n).padStart(7, '0'),
                        title: 'History ' + n, titleSource: 'provider' as const,
                        createdAt: 1800000000000 - n * 1000, updatedAt: 1800000000000 - n * 1000 };
                });
                return { conversations, nextPageToken: end < count ? String(end) : null,
                    pageEvidence: { valid: true, ordered: true,
                        keys: conversations.map(item => ({ id: item.id, time: item.updatedAt })) } };
            },
            getConversationDetail: async () => sourceDetail()
        }, async () => 'u0');
        ProviderRegistry.unregister('gemini');
        ProviderRegistry.register(provider);
        try {
            const result = await scanAll({ accountId: ACCOUNT_UUID, forceFull: true });
            assert.equal(result.status, 'complete');
            assert.equal(result.conversationsFetched, count);
            assert.equal(result.pagesFetched, Math.ceil(count / 50));
            assert.equal(calls, Math.ceil(count / 50));
            const stored = await listIndexes(ACCOUNT_UUID);
            assert.equal(stored.length, count, 'every ID must be physically stored');
            assert.equal(new Set(stored.map(item => item.key.conversationId)).size, count);
        } finally {
            ProviderRegistry.unregister('gemini');
            if (original) ProviderRegistry.register(original);
            store.restore();
        }
    });
}

for (const count of [5000, 10000]) {
    test('Full-scan coordinator processes pages without any 300-chat stop, count=' + count, async () => {
        const store = indexStorage();
        await store.ready;
        const original = ProviderRegistry.get('gemini');
        let calls = 0;
        const provider = Object.create(defaultGeminiProvider) as typeof defaultGeminiProvider;
        provider.listConversations = async options => {
            for (let n = 50; n <= count; n += 50) {
                calls++;
                const stopped = await options.onPageCommitted?.({ page: calls, totalObserved: n });
                assert.notEqual(stopped, true, 'forceFull must not stop on incremental boundary');
            }
            return 'source_end';
        };
        ProviderRegistry.unregister('gemini');
        ProviderRegistry.register(provider);
        try {
            const result = await scanAll({ accountId: ACCOUNT_UUID, forceFull: true });
            assert.equal(result.status, 'complete');
            assert.equal(result.conversationsFetched, count);
            assert.equal(calls, count / 50);
        } finally {
            ProviderRegistry.unregister('gemini');
            if (original) ProviderRegistry.register(original);
            store.restore();
        }
    });
}

test('Confirmed Gemini 300-window limit must be reported as partial, not complete', async () => {
    const store = indexStorage();
    await store.ready;
    const original = ProviderRegistry.get('gemini');
    const provider = new GeminiProvider({
        getConversationList: async cursor => {
            const start = Number(cursor ?? 0);
            if (start === 300) return { conversations: [], nextPageToken: null,
                failure: 'hit_google_limit' as const,
                pageEvidence: { valid: false, ordered: false, keys: [] } };
            const conversations = Array.from({ length: 50 }, (_, i) => {
                const n = start + i;
                return { id: 'c_limit_' + String(n).padStart(7, '0'),
                    title: 'History ' + n, titleSource: 'provider' as const,
                    updatedAt: 1800000000000 - n * 1000 };
            });
            return { conversations, nextPageToken: String(start + 50),
                pageEvidence: { valid: true, ordered: true,
                    keys: conversations.map(item => ({ id: item.id, time: item.updatedAt })) } };
        }, getConversationDetail: async () => sourceDetail()
    }, async () => 'u0');
    ProviderRegistry.unregister('gemini');
    ProviderRegistry.register(provider);
    try {
        const result = await scanAll({ accountId: ACCOUNT_UUID, forceFull: true });
        assert.equal(result.status, 'partial_limit');
        assert.equal(result.reason, 'provider_limit');
        assert.equal(result.conversationsFetched, 300);
        assert.equal((await listIndexes(ACCOUNT_UUID)).length, 300);
    } finally {
        ProviderRegistry.unregister('gemini');
        if (original) ProviderRegistry.register(original);
        store.restore();
    }
});
