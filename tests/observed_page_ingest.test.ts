import { geminiListPage, GEMINI_LIST_CAPTURE } from './fixtures/providers/geminiListCapture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { indexStorage } from './helpers/indexStorage.js';
import { accountRuntime, ACCOUNT_UUID, ACCOUNT_OBSERVATION } from './helpers/accountRuntime.js';
import { ingestIndexes } from '../src/l2/ingestion.js';
import { getCoverage, listIndexes } from '../src/l3a/storageService.js';
import { parseList } from '../src/l1/parsers/gemini/rpc/parseList.js';
import { parseGeminiIndexObservation } from '../src/l1/parsers/gemini/parseIndexObservation.js';
import { geminiListObservation } from '../src/l1/client/gemini/listObservation.js';
import { init, handleWindowMessage } from '../src/l1/sniffer/gemini/messageBridge.js';

const text = geminiListPage().responseBody;
const request = { streamId: 'recent' as const, requestCursor: null };
const parsed = parseList(text);
const capture = (extra = {}): MessageEvent => ({ origin: location.origin, source: window,
    data: { type: 'GEMINI_NETWORK_BATCHEXECUTE', payload: { text, slot: 'u0', listRequest: request,
        url: 'https://gemini.google.com/_/BardChatUi/data/batchexecute', truncated: false,
        requestedAt: 100, requestAccountObservation: ACCOUNT_OBSERVATION, ...extra } } }) as unknown as MessageEvent;

test('active and passive list admissions preserve the same Index facts without inventing a partial boundary', async () => {
    const outcomes: unknown[] = [];
    for (const active of [true, false]) {
        const storage = indexStorage(), runtime = accountRuntime();
        try {
            if (active) await ingestIndexes(ACCOUNT_UUID, parsed.conversations.map(item => parseGeminiIndexObservation(item, 'rpc-list')),
                geminiListObservation(parsed, request, ACCOUNT_UUID, false, 100));
            else { init(); await handleWindowMessage(capture()); }
            assert.deepEqual(await getCoverage(ACCOUNT_UUID, 'recent'), { range: null });
            const indexes = await listIndexes(ACCOUNT_UUID); assert.equal(indexes.length, GEMINI_LIST_CAPTURE.firstPageRows); outcomes.push(indexes);
        } finally { runtime.restore(); storage.restore(); }
    }
    assert.deepEqual(outcomes[0], outcomes[1]);
});

test('failed Index commit prevents passive Coverage admission and rejects the operation', async () => {
    const storage = indexStorage(), runtime = accountRuntime();
    try {
        init(); storage.fail('indexes');
        await assert.rejects(handleWindowMessage(capture()), /write failed/);
        assert.equal(await getCoverage(ACCOUNT_UUID, 'recent'), null);
        storage.fail(); await handleWindowMessage(capture());
        assert.equal((await listIndexes(ACCOUNT_UUID)).length, GEMINI_LIST_CAPTURE.firstPageRows);
        assert.deepEqual(await getCoverage(ACCOUNT_UUID, 'recent'), { range: null });
    } finally { runtime.restore(); storage.restore(); }
});

test('uncertain identity and truncated captures cannot certify the identified account boundary', async () => {
    const storage = indexStorage(), runtime = accountRuntime();
    try {
        init();
        await handleWindowMessage(capture({ requestAccountObservation: null }));
        assert.equal(await getCoverage(ACCOUNT_UUID, 'recent'), null);
        await handleWindowMessage(capture({ truncated: true }));
        assert.equal((await getCoverage(ACCOUNT_UUID, 'recent'))?.range ?? null, null);
        // Passive capture is independent of Application cancellation; it never owns a ScanRun.
        assert.equal((await listIndexes(ACCOUNT_UUID)).length, GEMINI_LIST_CAPTURE.firstPageRows);
    } finally { runtime.restore(); storage.restore(); }
});
