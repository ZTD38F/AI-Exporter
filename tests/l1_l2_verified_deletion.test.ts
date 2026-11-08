import { parseGeminiRequest } from '../src/l1/parsers/gemini/rpc/request.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBObjectStore } from 'fake-indexeddb';
import { indexStorage } from './helpers/indexStorage.js';
import { fixtureAccount } from './helpers/domainFixture.js';
import { ingestDetail, ingestDeletedConversation } from '../src/l2/ingestion.js';
import { getDetail, getIndex, getExportRecord, putExportRecord, getCoverage, updateCoverageAtomically } from '../src/l3a/storageService.js';
import { GeminiProvider } from '../src/l1/client/gemini/geminiProvider.js';
import type { GeminiProviderClient } from '../src/l1/client/gemini/geminiContracts.js';
import { ConfirmedGeminiConversationNotFound } from '../src/l1/client/gemini/geminiClient.js';
import { getConversationDetail } from '../src/l1/client/gemini/api/pagination.js';
import { sourceDetail } from './helpers/l1SourceFixture.js';
import { parseConfirmedGeminiDeletion, isConfirmedGeminiDetailNotFound } from '../src/l1/parsers/gemini/rpc/parseDeletion.js';
import { parseList } from '../src/l1/parsers/gemini/rpc/parseList.js';
import { geminiListObservation } from '../src/l1/client/gemini/listObservation.js';
import { GeminiProtocol } from '../src/l1/protocol/gemini/protocol.js';
import { listGen as geminiListGen } from './fixtures/providers/gemini.js';
import { detailGen as geminiDetailGen } from './fixtures/providers/geminiDetail.js';
import { deleteGen as geminiDeleteGen } from './fixtures/providers/geminiDelete.js';
import { deleteRequestGen as geminiDeleteRequestGen } from './fixtures/providers/geminiDeleteRequest.js';

const account = fixtureAccount(), otherAccount = fixtureAccount('chatgpt'), conversationId = 'deadbeef00112233';
const makeKey = (accountId = account.id) => ({ accountId, conversationId });
const detail = {
    quality: { status: 'complete' as const }, assets: [],
    messages: [{ role: 'assistant' as const, content: [{ type: 'paragraph' as const,
        children: [{ type: 'text' as const, text: 'archived body' }] }] }]
};
async function seed(accountId = account.id) {
    const key = makeKey(accountId);
    await ingestDetail(key.accountId, key.conversationId, detail);
    await putExportRecord(key, { format: 'markdown', status: 'ok', exportedAt: 100, chatTime: 100 });
    return key;
}

test('L2 confirmed remote deletion atomically removes one key but preserves Coverage and other accounts', async () => {
    const env = indexStorage();
    try {
        const key = await seed(), other = await seed(otherAccount.id);
        await updateCoverageAtomically(account.id, 'recent', () => ({ next: { range: {
            head: { id: conversationId, time: 100 }, tail: { id: conversationId, time: 100 }
        } }, result: undefined }));
        await ingestDeletedConversation(account.id, conversationId);
        assert.equal(await getIndex(key), null);
        assert.equal(await getDetail(key), null);
        assert.equal(await getExportRecord(key), null);
        assert.ok((await getCoverage(account.id, 'recent'))?.range);
        assert.ok(await getIndex(other));
        assert.ok(await getDetail(other));
        assert.ok(await getExportRecord(other));
        await ingestDeletedConversation(account.id, conversationId); // idempotent
        await assert.rejects(ingestDeletedConversation('10000000-0000-4000-8000-000000000099', conversationId), /account does not exist/);
    } finally { env.restore(); }
});

test('L2 rejected physical delete aborts all three stores, including ExportRecord', async () => {
    const env = indexStorage(), priorDelete = IDBObjectStore.prototype.delete;
    try {
        const key = await seed();
        IDBObjectStore.prototype.delete = function(k: IDBValidKey) {
            if (this.name === 'details') throw new Error('simulated delete failure');
            return priorDelete.call(this, k);
        };
        await assert.rejects(ingestDeletedConversation(account.id, conversationId), /simulated delete failure/);
        assert.ok(await getIndex(key));
        assert.ok(await getDetail(key));
        assert.ok(await getExportRecord(key));
    } finally { IDBObjectStore.prototype.delete = priorDelete; env.restore(); }
});

test('L1 Detail only deletes after typed, target-bound Gemini 1167; generic 404 remains recoverable', async () => {
    const env = indexStorage();
    try {
        const key = await seed(), route = async () => 'u0';
        const client = (failure: Error) => ({
            getConversationDetail: async () => { throw failure; },
            getConversationList: async () => { throw new Error('unneeded'); }
        }) as unknown as GeminiProviderClient;
        const generic = new GeminiProvider(client(new Error('HTTP 404')), route);
        await assert.rejects(generic.fetchConversationDetail(account.id, conversationId), /HTTP 404/);
        assert.ok(await getDetail(key), 'a generic 404 does not delete local facts');
        const wrong = new GeminiProvider(client(new ConfirmedGeminiConversationNotFound('c_other')), route);
        await assert.rejects(wrong.fetchConversationDetail(account.id, conversationId), /Confirmed Gemini/);
        assert.ok(await getDetail(key), 'another conversation cannot delete this key');
        const confirmed = new GeminiProvider(client(new ConfirmedGeminiConversationNotFound('c_' + conversationId)), route);
        await assert.rejects(confirmed.fetchConversationDetail(account.id, conversationId), /conversation_not_found/);
        assert.equal(await getIndex(key), null);
        assert.equal(await getDetail(key), null);
        assert.equal(await getExportRecord(key), null);
    } finally { env.restore(); }
});

test('Detail not-found classifier refuses HTTP status alone and unrelated error codes', () => {
    assert.equal(GeminiProtocol.isConfirmedDeletedError('HTTP 404', 404), false);
    assert.equal(GeminiProtocol.isConfirmedDeletedError('HTTP 404'), false);
    assert.equal(GeminiProtocol.isConfirmedDeletedError('["BardErrorInfo",11167]', 200), false);
    assert.equal(GeminiProtocol.isConfirmedDeletedError('["BardErrorInfo",1167]', 200), true);
    assert.equal(GeminiProtocol.isConfirmedDeletedError('["BardErrorInfo",1167]', 429), false);
});

test('Detail 1167 must belong to target hNvQHb RPC, not a simultaneous list or arbitrary HTTP response', () => {
    assert.equal(isConfirmedGeminiDetailNotFound(geminiDetailGen('G_L1_VERIFIED_DETAIL_1167_01')), true);
    assert.equal(isConfirmedGeminiDetailNotFound(geminiListGen('G_L1_VERIFIED_LIST_1167_01')), false);
    assert.equal(isConfirmedGeminiDetailNotFound(geminiDetailGen('G_L1_VERIFIED_DETAIL_1096_01')), false);
    assert.equal(isConfirmedGeminiDetailNotFound('HTTP 404'), false);
});

test('L1 delete parsing needs a matching acknowledged DELETE RPC, not the outgoing request alone', () => {
    const requestBody = geminiDeleteRequestGen('G_L1_VERIFIED_DELETE_REQUEST_01');
    assert.equal(parseConfirmedGeminiDeletion(parseGeminiRequest(requestBody), geminiDeleteGen('G_L1_VERIFIED_DELETE_ACK_01')), conversationId);
    assert.equal(parseConfirmedGeminiDeletion(parseGeminiRequest(requestBody), ''), null);
    assert.equal(parseConfirmedGeminiDeletion(parseGeminiRequest(requestBody), geminiListGen('G_L1_VERIFIED_LIST_FALSE_DELETE_01')), null);
    assert.equal(parseConfirmedGeminiDeletion(parseGeminiRequest(requestBody), geminiDeleteGen('G_L1_VERIFIED_DELETE_OTHER_ACK_01')), null);
    assert.equal(parseConfirmedGeminiDeletion(parseGeminiRequest(requestBody), '["BardErrorInfo",1167]'), null);
    assert.equal(parseConfirmedGeminiDeletion(parseGeminiRequest(requestBody), geminiDeleteGen('G_L1_VERIFIED_DELETE_LIMIT_01')), null);
});

test('Gemini list limit requires LIST-specific 1096 plus a bound Recent continuation', () => {
    const valid = parseList(geminiListGen('G_L1_VERIFIED_LIST_LIMIT_01'));
    assert.equal(valid.failure, 'hit_google_limit');
    const observation = geminiListObservation(valid, { streamId: 'recent', requestCursor: 'page1' }, account.id);
    assert.equal(observation.terminal, 'provider_limit');
    assert.equal(observation.valid, true);
    assert.deepEqual(observation.keys, []);
    for (const ctx of [{ streamId: 'recent' as const, requestCursor: null },
        { streamId: 'pinned' as const, requestCursor: 'page1' }]) {
        assert.equal(geminiListObservation(valid, ctx, account.id).terminal, undefined);
    }
    for (const error of [
        geminiDetailGen('G_L1_VERIFIED_DETAIL_1096_02'),
        geminiListGen('G_L1_VERIFIED_LIST_LIMIT_10961'),
        geminiListGen('G_L1_VERIFIED_LIST_LIMIT_429'),
        geminiListGen('G_L1_VERIFIED_LIST_LIMIT_STRING'),
    ]) assert.equal(parseList(error).failure, 'invalid_response');
});

test('Metadata-only Detail retry propagates confirmed NotFound instead of accepting stale metadata', async () => {
    const first = sourceDetail({ messages: [], _raw: [null, null, [['c_source_chat_123', 'Source title']]] });
    let calls = 0;
    await assert.rejects(getConversationDetail({
        async fetchConversationPage() {
            if (++calls === 1) return first;
            throw new ConfirmedGeminiConversationNotFound('c_source_chat_123');
        },
    }, 'source_chat_123'), error => error instanceof ConfirmedGeminiConversationNotFound);
    assert.equal(calls, 2);
});

test('Metadata-only Detail with a transient retry failure cannot be admitted as empty', async () => {
    const first = sourceDetail({ messages: [], _raw: [null, null, [['c_source_chat_123', 'Source title']]] });
    let calls = 0;
    await assert.rejects(getConversationDetail({
        async fetchConversationPage() {
            if (++calls === 1) return first;
            throw new Error('transient metadata retry failure');
        },
    }, 'source_chat_123'), /GEMINI_DETAIL_EMPTY_UNVERIFIED/);
    assert.equal(calls, 2);
});


test('Tier 2 captured native void DELETE acknowledgement removes only the request-bound local key', async () => {
    const requestBody = geminiDeleteRequestGen('G_NATIVE_CAPTURE_DELETE_REQUEST_01');
    const responseText = geminiDeleteGen('G_NATIVE_CAPTURE_DELETE_RESPONSE_01');
    const id = parseConfirmedGeminiDeletion(parseGeminiRequest(requestBody), responseText);
    assert.equal(id, conversationId);
    const env = indexStorage();
    try {
        const key = await seed(), other = await seed(otherAccount.id);
        await ingestDeletedConversation(key.accountId, id!);
        assert.equal(await getIndex(key), null); assert.equal(await getDetail(key), null); assert.equal(await getExportRecord(key), null);
        assert.ok(await getDetail(other)); assert.ok(await getExportRecord(other));
    } finally { env.restore(); }
    for (const key of ['G_NATIVE_CAPTURE_DELETE_MALFORMED_NULL_01',
        'G_NATIVE_CAPTURE_DELETE_MALFORMED_ARRAY_01', 'G_NATIVE_CAPTURE_DELETE_MALFORMED_FALSE_01',
        'G_NATIVE_CAPTURE_DELETE_MALFORMED_OTHER_01'] as const) {
        assert.equal(parseConfirmedGeminiDeletion(parseGeminiRequest(requestBody), geminiDeleteGen(key)), null);
    }
    assert.equal(parseConfirmedGeminiDeletion(parseGeminiRequest(
        geminiDeleteRequestGen('G_NATIVE_CAPTURE_DELETE_DUPLICATE_REQUEST_01')), responseText), null);
});
