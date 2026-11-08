/** Trusted passive pages can advance Coverage; uncorrelated facts cannot. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { indexStorage } from './helpers/indexStorage.js';
import { accountRuntime, ACCOUNT_UUID, ACCOUNT_OBSERVATION } from './helpers/accountRuntime.js';
import { init, handleWindowMessage } from '../src/l1/sniffer/gemini/messageBridge.js';
import { listIndexes, getCoverage } from '../src/l3a/storageService.js';
import { listGen as geminiListGen } from './fixtures/providers/gemini.js';
function capture(key: Parameters<typeof geminiListGen>[0], correlated: boolean): MessageEvent {
    return { origin: location.origin, source: window, data: { type: 'GEMINI_NETWORK_BATCHEXECUTE', payload: {
        text: geminiListGen(key), slot: 'u0', requestAccountObservation: ACCOUNT_OBSERVATION, requestedAt: Date.now(),
        truncated: false, url: 'https://gemini.google.com/_/BardChatUi/data/batchexecute',
        ...(correlated ? { listRequest: { streamId: 'recent', requestCursor: null } } : {}),
    } } } as unknown as MessageEvent;
}
test('repeated uncorrelated captures preserve authoritative timestamps without establishing Coverage', async () => {
    const storage = indexStorage(), runtime = accountRuntime();
    try {
        init();
        for (const key of ['G_DYNAMIC_WATERMARK_LIST_01', 'G_DYNAMIC_WATERMARK_LIST_02',
            'G_DYNAMIC_WATERMARK_LIST_01'] as const) await handleWindowMessage(capture(key, false));
        const indexes = await listIndexes(ACCOUNT_UUID);
        assert.equal(indexes.length, 1); assert.equal(indexes[0].updatedAt, 1700000000000);
        assert.equal(await getCoverage(ACCOUNT_UUID, 'recent'), null);
        assert.equal(Object.hasOwn(indexes[0], 'cloudAvailability'), false);
        await handleWindowMessage(capture('G_DYNAMIC_WATERMARK_LIST_01', true));
        assert.deepEqual((await getCoverage(ACCOUNT_UUID, 'recent'))?.range, {
            head: { id: 'abcdef123', time: 1700000000000 }, tail: { id: 'abcdef123', time: 1700000000000 }
        });
    } finally { runtime.restore(); storage.restore(); }
});
