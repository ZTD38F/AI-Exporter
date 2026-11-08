import test from 'node:test';
import assert from 'node:assert/strict';
import type { AIProvider } from '../src/l1/client/aiProvider.js';
import { makeTestExportProvider, makeTestWorker } from './helpers/makeTestWorker.js';

const accountId = '10000000-0000-4000-8000-000000000001';

test('v2 Export provider mock uses the L1 Promise<void> Detail refresh contract', async () => {
    const refreshed: string[] = [];
    const signal = new AbortController().signal;
    const provider: AIProvider = makeTestExportProvider({
        async fetchConversationDetail(account, conversationId, receivedSignal) {
            assert.equal(account, accountId);
            assert.equal(receivedSignal, signal);
            refreshed.push(conversationId);
            // The mocked L1 side would commit to L2 here; no parse result is
            // returned for Application to re-admit.
        },
    });

    assert.equal(await provider.fetchConversationDetail(accountId, 'detail-a', signal), undefined);
    assert.deepEqual(refreshed, ['detail-a']);
    assert.deepEqual(await provider.checkReadiness(accountId), { ready: true });
    assert.equal(await provider.listConversations({ accountId, streamId: 'recent' }), 'source_end');
});

test('v2 Export provider mock only returns task-owned resource bytes through acquireResource', async () => {
    const key = { accountId, conversationId: 'detail-b' };
    const bytes = new Uint8Array([137, 80, 78, 71]);
    const provider = makeTestExportProvider({
        async acquireResource(receivedKey, asset) {
            assert.deepEqual(receivedKey, key);
            assert.equal(asset.id, 'image');
            return { bytes, mediaType: 'image/png' };
        },
    });
    const resource = await provider.acquireResource(key, { id: 'image', kind: 'image', mediaType: 'image/png' });
    assert.strictEqual(resource.bytes, bytes);
    assert.equal(resource.mediaType, 'image/png');
});

test('v2 provider mock fails on unconfigured external operations, never silently succeeds', async () => {
    const provider = makeTestExportProvider();
    await assert.rejects(
        provider.fetchConversationDetail(accountId, 'missing'),
        /fetchConversationDetail must be supplied/,
    );
    await assert.rejects(
        provider.acquireResource({ accountId, conversationId: 'missing' }, { id: 'x', kind: 'file' }),
        /acquireResource must be supplied/,
    );
});

test('the old helper name cannot silently accept a v1 BatchWorker contract', async () => {
    assert.throws(
        () => makeTestWorker({ fetchChatDetail: async () => ({ success: true }) }),
        /Unsupported v1 BatchWorker overrides: fetchChatDetail/,
    );
    const provider = makeTestWorker({ fetchConversationDetail: async () => {} });
    assert.equal(await provider.fetchConversationDetail(accountId, 'v2'), undefined);
});
