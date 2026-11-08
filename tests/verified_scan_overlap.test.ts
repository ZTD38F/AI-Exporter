import { observeDomainChanges } from '../src/runtime/api/domainChanges.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { indexStorage } from './helpers/indexStorage.js';
import { ACCOUNT_UUID } from './helpers/accountRuntime.js';
import { defaultGeminiProvider } from '../src/l1/client/gemini/geminiProvider.js';
import { ProviderRegistry } from '../src/l1/client/providerRegistry.js';
import { scanAll } from '../src/application/sync/scanController.js';
import { GeminiProvider } from '../src/l1/client/gemini/geminiProvider.js';
import { parseList } from '../src/l1/parsers/gemini/rpc/parseList.js';
import { listGen as geminiListGen } from './fixtures/providers/gemini.js';
import { getCoverage } from '../src/l3a/storageService.js';
import { sourceDetail } from './helpers/l1SourceFixture.js';

test('production scan entry admits one pagination call per account and releases the lock on completion', async () => {
    const store = indexStorage();
    const original = ProviderRegistry.get('gemini');
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    let calls = 0;
    let first: ReturnType<typeof scanAll> | undefined;
    const provider = Object.create(defaultGeminiProvider) as typeof defaultGeminiProvider;
    provider.listConversations = async () => { calls++; entered(); await gate; return 'source_end'; };
    ProviderRegistry.unregister('gemini');
    ProviderRegistry.register(provider);
    try {
        first = scanAll({ accountId: ACCOUNT_UUID });
        await started;
        assert.deepEqual(await scanAll({ accountId: ACCOUNT_UUID }), {
            status: 'error', reason: 'Scan already running', pagesFetched: 0, conversationsFetched: 0,
        });
        assert.equal(calls, 1);
        release();
        assert.equal((await first).status, 'complete');
        assert.equal((await scanAll({ accountId: ACCOUNT_UUID })).status, 'complete');
        assert.equal(calls, 2);
    } finally {
        release(); await first;
        ProviderRegistry.unregister('gemini');
        if (original) ProviderRegistry.register(original);
        store.restore();
    }
});

test('failed scan retains the bound parser diagnostics without establishing coverage', async () => {
    const store = indexStorage();
    const original = ProviderRegistry.get('gemini');
    const wire = geminiListGen('G_VERIFIED_SCAN_OVERLAP_01');
    const parsed = parseList(wire);
    const provider = new GeminiProvider({ getConversationList: async () => parsed,
        getConversationDetail: async () => sourceDetail() }, async () => 'u0');
    ProviderRegistry.unregister('gemini');
    ProviderRegistry.register(provider);
    try {
        const result = await scanAll({ accountId: ACCOUNT_UUID });
        assert.equal(result.status, 'error');
        assert.equal(result.reason, 'Gemini list failed: invalid_response');
        assert.equal(result.diagnostics?.page, 1);
        assert.equal(result.diagnostics?.requestCursor, null);
        assert.equal(result.diagnostics?.failure, 'invalid_response');
        assert.deepEqual(result.diagnostics?.details, parsed._debug);
        assert.equal((await getCoverage(ACCOUNT_UUID, 'recent'))?.range ?? null, null);
    } finally {
        ProviderRegistry.unregister('gemini');
        if (original) ProviderRegistry.register(original);
        store.restore();
    }
});


test('active scan publishes committed pages without waiting for the view to refresh', async () => {
    const store = indexStorage();
    const original = ProviderRegistry.get('gemini');
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const notifications: string[] = [];
    let finishedViewReads = 0;
    const stop = observeDomainChanges(async id => { notifications.push(id); await gate; finishedViewReads++; });
    const provider = Object.create(defaultGeminiProvider) as typeof defaultGeminiProvider;
    provider.listConversations = async options => {
        await options.onPageCommitted?.({ page: 1, totalObserved: 50 });
        await options.onPageCommitted?.({ page: 2, totalObserved: 100 });
        return 'source_end';
    };
    ProviderRegistry.unregister('gemini'); ProviderRegistry.register(provider);
    try {
        const result = await scanAll({ accountId: ACCOUNT_UUID });
        assert.equal(result.status, 'complete');
        assert.equal(result.conversationsFetched, 100);
        assert.deepEqual(notifications, [ACCOUNT_UUID, ACCOUNT_UUID]);
        assert.equal(finishedViewReads, 0, 'view work must not block page fetching or scan completion');
        release(); await new Promise<void>(resolve => setTimeout(resolve, 0));
        assert.equal(finishedViewReads, 2);
    } finally {
        release(); stop(); ProviderRegistry.unregister('gemini');
        if (original) ProviderRegistry.register(original);
        store.restore();
    }
});
