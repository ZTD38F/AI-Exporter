import test from 'node:test';
import assert from 'node:assert/strict';
import { indexStorage } from './helpers/indexStorage.js';
import { accountRuntime, ACCOUNT_UUID, ACCOUNT_OBSERVATION } from './helpers/accountRuntime.js';
import { ingestIndexes } from '../src/l2/ingestion.js';
import { listIndexes } from '../src/l3a/storageService.js';
import { init, handleWindowMessage } from '../src/l1/sniffer/gemini/messageBridge.js';
import { listGen as geminiListGen } from './fixtures/providers/gemini.js';

// V2 retires title-driven active detail fetching. The passive source observation
// upgrades titles through L2 without starting network acquisition or inventing time.
test('passive RPC titles upgrade unresolved, derived and undated titles without active fetches', async t => {
    const store = indexStorage(), runtime = accountRuntime('u2');
    const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Passive ingestion must not fetch'); });
    const ids = ['generic_title_01', 'sniff_title_01', 'resolved_title_01', 'undated_rpc_01'];
    try {
        await ingestIndexes(ACCOUNT_UUID, [
            { conversationId: ids[0], fields: {} },
            { conversationId: ids[1], fields: { title: 'Initial question', titleSource: 'derived', updatedAt: 1700000000000 } },
            { conversationId: ids[2], fields: { title: 'Resolved title', titleSource: 'provider', updatedAt: 1700000000000 } },
            { conversationId: ids[3], fields: { title: 'Undated title', titleSource: 'provider' } },
        ]);
        const text = geminiListGen('G_ACTIVE_TITLE_01');
        const capture = () => ({ origin: location.origin, source: window, data: {
            type: 'GEMINI_NETWORK_BATCHEXECUTE', payload: { text, slot: 'u2',
                requestAccountObservation: ACCOUNT_OBSERVATION, truncated: false, requestedAt: 1,
                url: 'https://gemini.google.com/_/BardChatUi/data/batchexecute',
                listRequest: { streamId: 'recent', requestCursor: null } },
        } }) as unknown as MessageEvent;
        init(); await handleWindowMessage(capture());
        const indexes = await listIndexes(ACCOUNT_UUID);
        for (const id of ids) {
            const index = indexes.find(index => index.key.conversationId === id);
            assert.equal(index?.title, 'Observed ' + id);
            assert.equal(index?.titleSource, 'provider');
            assert.equal(index?.updatedAt, id === ids[3] ? undefined : 1700000000000);
        }
        await handleWindowMessage(capture());
        assert.deepEqual(await listIndexes(ACCOUNT_UUID), indexes, 'duplicate passive observations remain idempotent');
        assert.equal(fetch.mock.callCount(), 0);
    } finally { runtime.restore(); store.restore(); }
});
