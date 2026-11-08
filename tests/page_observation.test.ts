import { geminiListPage, GEMINI_LIST_CAPTURE } from './fixtures/providers/geminiListCapture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { listGen as geminiListGen } from './fixtures/providers/gemini.js';
import { requestGen as geminiListRequestGen } from './fixtures/providers/geminiListRequest.js';
import { parseList } from '../src/l1/parsers/gemini/rpc/parseList.js';
import { geminiListObservation } from '../src/l1/client/gemini/listObservation.js';
import { parseGeminiRequest } from '../src/l1/parsers/gemini/rpc/request.js';
test('active and passive normalization retain identical independent cursor and ordering evidence', () => {
    for (const streamId of ['recent', 'pinned'] as const) {
        const result = parseList(geminiListPage().responseBody);
        const request = parseGeminiRequest(geminiListRequestGen(streamId === 'recent' ? 'G_PAGE_OBSERVATION_02_RECENT' : 'G_PAGE_OBSERVATION_02_PINNED')).list;
        assert.deepEqual(request, { streamId, requestCursor: 'incoming' });
        const observation = geminiListObservation(result, request, 'account');
        assert.equal(observation.providerId, 'gemini');
        assert.equal(observation.accountId, 'account');
        assert.equal(observation.streamId, streamId);
        assert.equal(observation.requestKnown, true);
        assert.equal(observation.requestCursor, 'incoming');
        assert.equal(observation.nextCursor, parseGeminiRequest(geminiListPage(1).requestBody).list!.requestCursor);
        assert.equal(observation.valid, true);
        assert.equal(observation.keys.length, GEMINI_LIST_CAPTURE.firstPageRows);
        assert.deepEqual(observation.keys[0], { id: GEMINI_LIST_CAPTURE.first.id, time: GEMINI_LIST_CAPTURE.first.updatedAt });
        assert.equal(observation.ordered, streamId === 'recent');
    }
});
test('fallback timestamps, rising times, malformed or truncated responses cannot certify ordering', () => {
    const request = { streamId: 'recent' as const, requestCursor: null };
    assert.equal(geminiListObservation(parseList(geminiListGen('G_PAGE_OBSERVATION_03')), request, 'account').ordered, false);
    const parsed = parseList(geminiListGen('G_PAGE_OBSERVATION_04'));
    assert.equal(geminiListObservation(parsed, request, 'account').ordered, false);
    assert.equal(geminiListObservation(parsed, request, 'account', true).valid, false);
    assert.equal(geminiListObservation(parsed, null, 'account').requestKnown, false);
    assert.equal(parseGeminiRequest(geminiListRequestGen('G_PAGE_OBSERVATION_05')).list, null);
});

test('captured empty Gemini list payload [] is valid exhaustion, while unknown nonempty shapes are not', () => {
    const empty = parseList(geminiListGen('G_PAGE_OBSERVATION_06'));
    assert.equal(geminiListObservation(empty, { streamId: 'pinned', requestCursor: null }, 'account').valid, true);
    assert.equal(geminiListObservation(empty, { streamId: 'recent', requestCursor: null }, 'account').ordered, true);
    assert.equal(geminiListObservation(parseList(geminiListGen('G_PAGE_OBSERVATION_07')), { streamId: 'recent', requestCursor: null }, 'account').valid, false);
});

test('different conversations with equal official timestamps retain ordering evidence', () => {
    const request = { streamId: 'recent' as const, requestCursor: null };
    const parsed = parseList(geminiListGen('G_PAGE_OBSERVATION_08'));
    const observation = geminiListObservation(parsed, request, 'account');
    assert.equal(observation.valid, true);
    assert.equal(observation.ordered, true);
    assert.equal(observation.keys[0].time, observation.keys[1].time);
    assert.equal(geminiListObservation(parseList(geminiListGen('G_PAGE_OBSERVATION_09')), request, 'account').ordered, true);
    const duplicate = geminiListObservation(parseList(geminiListGen('G_PAGE_OBSERVATION_10')), request, 'account');
    assert.equal(duplicate.valid, false);
    assert.equal(duplicate.ordered, false);
});

test('captured expanded webpage recent filter establishes request identity without accepting arbitrary layouts', () => {
    const valid = geminiListRequestGen('G_PAGE_OBSERVATION_11_VALID');
    assert.deepEqual(parseGeminiRequest(valid).list, { streamId: 'recent', requestCursor: null });
    for (const key of ['G_PAGE_OBSERVATION_11_INVALID_0', 'G_PAGE_OBSERVATION_11_INVALID_1',
        'G_PAGE_OBSERVATION_11_INVALID_2'] as const) {
        const request = geminiListRequestGen(key);
        assert.equal(parseGeminiRequest(request).list, null);
    }
});

test('list coverage uses the parser failure outcome, never the diagnostic payload', () => {
    const result = parseList(geminiListPage().responseBody);
    const request = { streamId: 'recent' as const, requestCursor: null };
    const debug = { error: 'NO_INNER_STR' as const, bardError: null, textLen: 3, rawPreview: 'bad', topParsed: null };
    assert.deepEqual(geminiListObservation({ ...result, _debug: debug }, request, 'account'),
        geminiListObservation(result, request, 'account'));
    assert.equal(geminiListObservation({ ...result, failure: 'invalid_response' }, request, 'account').valid, false);
});
