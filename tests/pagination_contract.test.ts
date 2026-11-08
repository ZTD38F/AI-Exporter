import { parseGeminiRpcConversation } from '../src/l1/parsers/gemini/rpc/parseConversation.js';
import { ConfirmedSourceEmptyError } from '../src/l1/client/sourceErrors.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { useIndexStorage } from './helpers/indexStorage.js';
import { ACCOUNT_UUID } from './helpers/accountRuntime.js';
import { sourceDetail, sourceList, sourceMessage } from './helpers/l1SourceFixture.js';
import { GeminiProvider } from '../src/l1/client/gemini/geminiProvider.js';
import { getConversationDetail, type GeminiPaginationDetailClient } from '../src/l1/client/gemini/api/pagination.js';
import type { GeminiRpcParseResult } from '../src/l1/parsers/gemini/rpc/parseConversation.js';
import type { ListParseResult } from '../src/l1/parsers/gemini/rpc/parseList.js';
import { listIndexes as getConversations } from '../src/l3a/storageService.js';
import { getCoverage } from '../src/l2/coverageAdmission.js';
import { detailGen as geminiDetailGen } from './fixtures/providers/geminiDetail.js';
useIndexStorage();
function listProvider(pages: (ListParseResult | Error)[]) {
    return new GeminiProvider({ async getConversationList() { const p = pages.shift(); if (p instanceof Error) throw p; assert.ok(p); return p; },
        getConversationDetail: async () => sourceDetail() }, async () => 'u0');
}
function detailClient(pages: GeminiRpcParseResult[]): GeminiPaginationDetailClient {
    return { async fetchConversationPage() { const page = pages.shift(); assert.ok(page); return page; } };
}
const options = { accountId: ACCOUNT_UUID, streamId: 'recent' };
for (const ids of [[], ['one']]) test(`list: terminal ${ids.length} rows commit before natural end`, async () => {
    assert.equal(await listProvider([sourceList(ids.length ? 'G_SOURCE_ONE_01' : 'G_SOURCE_EMPTY_01')]).listConversations(options), 'source_end');
    assert.equal((await getConversations(ACCOUNT_UUID)).length, ids.length);
    if (ids.length) assert.ok((await getCoverage(ACCOUNT_UUID, 'recent'))?.range);
});
test('list: invalid populated page saves valid rows but throws and cannot certify coverage', async () => {
    const invalid = sourceList('G_SOURCE_TWO_01'); invalid.pageEvidence.valid = false;
    const progress: number[] = [];
    await assert.rejects(listProvider([sourceList('G_SOURCE_ONE_NEXT_01'), invalid]).listConversations({ ...options, onPageCommitted: async p => { progress.push(p.totalObserved); return false; } }), /Unverified Gemini list page/);
    assert.deepEqual((await getConversations(ACCOUNT_UUID)).map(i => i.key.conversationId).sort(), ['one', 'two']);
    assert.equal((await getCoverage(ACCOUNT_UUID, 'recent'))?.range, null);
    assert.deepEqual(progress, [1, 2]);
});
test('list: loop and ordinary errors propagate after committed progress', async () => {
    for (const last of [sourceList('G_SOURCE_TWO_LOOP_01'), new Error('HTTP 429')]) {
        await assert.rejects(listProvider([sourceList('G_SOURCE_ONE_LOOP_01'), last]).listConversations(options), /loop|429/);
    }
});
test('list: safety budget is internal and reports max_pages without coverage', async () => {
    let pages = 0;
    const provider = new GeminiProvider({ getConversationList: async () => sourceList(`G_SOURCE_PAGINATION_BUDGET_PAGE_${++pages}`), getConversationDetail: async () => sourceDetail() }, async () => 'u0');
    assert.equal(await provider.listConversations(options), 'max_pages'); assert.equal(pages, 2000);
    assert.equal((await getCoverage(ACCOUNT_UUID, 'recent'))?.range, null);
});
test('Detail: complete source chain reverses pages, keeps source version and exposes no Account/Key', async () => {
    const newer = sourceDetail({ messages: [sourceMessage('new')], nextPageToken: 'next' });
    const older = sourceDetail({ messages: [sourceMessage('old')], nextPageToken: null });
    const result = await getConversationDetail(detailClient([newer, older]), 'source_chat_123');
    assert.deepEqual(result.conversation.detail.messages.map(m => m.id), ['old', 'new']);
    assert.equal(result.conversation.detail.quality.status, 'complete');
    assert.equal(result.conversation.detail.savedAt, 1700000000000);
    assert.equal('account' in result, false); assert.equal('key' in result.conversation.detail, false);
});
for (const retry of [false, true]) {
    const mode = retry ? 'metadata-only retry' : 'normal';
    function paginatedClient(count: number, terminal: 'end' | 'loop' | 'error' | 'abort' | 'budget', controller?: AbortController) {
        let calls = 0;
        const cursors: (string | null | undefined)[] = [];
        const client: GeminiPaginationDetailClient = { async fetchConversationPage(_id, cursor, _slot, opts) {
            cursors.push(cursor);
            if (retry && calls++ === 0) return sourceDetail({ messages: [], _raw: [null, null, [['c_source_chat_123']]] });
            assert.equal(opts?.altParams, retry ? true : undefined);
            const index = cursors.length - (retry ? 2 : 1);
            if (terminal === 'error' && index === count - 1) throw new Error('HTTP 429');
            if (terminal === 'abort' && index === count - 1) controller?.abort();
            return sourceDetail({ messages: [sourceMessage('m' + index)], nextPageToken: index === count - 1
                ? terminal === 'end' ? null : terminal === 'loop' ? 'next1' : 'next' + index
                : 'next' + index });
        } };
        return { client, cursors };
    }
    test(`Detail: ${mode} reads 25 pages through natural end without losing oldest messages`, async () => {
        const { client, cursors } = paginatedClient(25, 'end');
        const result = await getConversationDetail(client, 'source_chat_123');
        assert.equal(cursors.length, 25 + Number(retry));
        assert.deepEqual(result.conversation.detail.messages.map(m => m.id), Array.from({ length: 25 }, (_, i) => 'm' + (24 - i)));
        assert.equal(result.conversation.detail.quality.status, 'complete');
        assert.equal(result.transport.nextPageToken, null);
    });
    test(`Detail: ${mode} detects late token loops and preserves partial evidence`, async () => {
        const { client, cursors } = paginatedClient(25, 'loop');
        const result = await getConversationDetail(client, 'source_chat_123');
        assert.equal(cursors.length, 25 + Number(retry));
        assert.equal(result.conversation.detail.quality.status, 'partial');
        assert.equal(result.evidence?.truncation, 'token_loop');
    });
    test(`Detail: ${mode} propagates late errors and cancellation`, async () => {
        const { client } = paginatedClient(25, 'error');
        await assert.rejects(getConversationDetail(client, 'source_chat_123'), /429/);
        const controller = new AbortController();
        const aborted = paginatedClient(25, 'abort', controller);
        await assert.rejects(getConversationDetail(aborted.client, 'source_chat_123', 'u0', undefined, controller.signal), { name: 'AbortError' });
        assert.equal(aborted.cursors.length, 25 + Number(retry));
    });
    test(`Detail: ${mode} stops runaway unique tokens with explicit incomplete evidence`, async () => {
        const { client, cursors } = paginatedClient(2000, 'budget');
        const result = await getConversationDetail(client, 'source_chat_123');
        assert.equal(cursors.length, 2000 + Number(retry));
        assert.equal(result.conversation.detail.quality.status, 'partial');
        assert.equal(result.evidence?.truncation, 'max_turns_page_limit_2000');
        assert.ok(result.transport.nextPageToken);
    });
}
test('Detail: identity mismatch and transport errors reject instead of inventing completion', async () => {
    await assert.rejects(getConversationDetail(detailClient([sourceDetail({ id: 'other' })]), 'source_chat_123'), /identity/);
    await assert.rejects(getConversationDetail({ fetchConversationPage: async () => { throw new Error('offline'); } }, 'source_chat_123'), /offline/);
});
test('Detail: abort between pages prevents another request', async () => {
    const controller = new AbortController(); let calls = 0;
    await assert.rejects(getConversationDetail({ fetchConversationPage: async () => { calls++; controller.abort(); return sourceDetail({ nextPageToken: 'next' }); } }, 'source_chat_123', 'u0', undefined, controller.signal), { name: 'AbortError' });
    assert.equal(calls, 1);
});
test('Detail: metadata-only fallback follows the replacement chain and remains source-bound', async () => {
    const metadata = sourceDetail({ messages: [], _raw: [null, null, [['c_source_chat_123']]] });
    const requested: unknown[] = [];
    const pages = [metadata, sourceDetail({ nextPageToken: 'retry-next' }), sourceDetail({ messages: [sourceMessage('old')] })];
    const result = await getConversationDetail({ fetchConversationPage: async (_id, cursor, _slot, opts) => { requested.push([cursor, opts?.altParams]); return pages.shift()!; } }, 'source_chat_123');
    assert.equal(result.conversation.detail.quality.status, 'complete');
    assert.deepEqual(requested, [[null, undefined], [null, true], ['retry-next', true]]);
});
test('Detail: failed metadata-only retry rejects empty content rather than admitting it', async () => {
    const metadata = sourceDetail({ messages: [], _raw: [null, null, [['c_source_chat_123']]] });
    let calls = 0;
    await assert.rejects(
        getConversationDetail({ fetchConversationPage: async () => { if (calls++) throw new Error('no alternate'); return metadata; } }, 'source_chat_123'),
        /GEMINI_DETAIL_EMPTY_UNVERIFIED/,
    );
    assert.equal(calls, 2);
});

test('Detail: metadata-only retry returning another empty response still fails closed', async () => {
    const metadata = sourceDetail({ messages: [], _raw: [null, null, [['c_source_chat_123']]] });
    let calls = 0;
    await assert.rejects(
        getConversationDetail({ fetchConversationPage: async () => { calls++; return metadata; } }, 'source_chat_123'),
        /GEMINI_DETAIL_EMPTY_UNVERIFIED/,
    );
    assert.equal(calls, 2);
});

test('Detail: unrecognized empty response without affirmative empty-turn evidence fails closed', async () => {
    const unknown = sourceDetail({ messages: [], _raw: [null, 'unexpected', 'Title'] });
    let calls = 0;
    await assert.rejects(
        getConversationDetail({ fetchConversationPage: async () => { calls++; return unknown; } }, 'source_chat_123'),
        /GEMINI_DETAIL_EMPTY_UNVERIFIED/,
    );
    assert.equal(calls, 1);
});

test('Detail: verified blank native turns have a distinct empty-source outcome; schema drift remains an error', async () => {
    const page = parseGeminiRpcConversation(geminiDetailGen('G_PAGINATION_EMPTY_01'),
        { providerId: 'gemini', targetConvId: 'source_chat_123' });
    assert.equal(page.transport.bodyShape, 'confirmed_empty_turns');
    Object.defineProperty(page.transport, 'decodedPayload', {
        get() { throw new Error('Pagination must not read opaque audit payload'); },
    });
    await assert.rejects(getConversationDetail(detailClient([page]), 'source_chat_123'), ConfirmedSourceEmptyError);
    const drift = parseGeminiRpcConversation(geminiDetailGen('G_PAGINATION_EMPTY_01'), { providerId: 'gemini' });
    drift.diagnostics.push({ code: 'GEMINI_SCHEMA_DRIFT', severity: 'warning', message: 'Unknown field' });
    await assert.rejects(getConversationDetail(detailClient([drift]), 'source_chat_123'), /GEMINI_DETAIL_EMPTY_UNVERIFIED/);
    for (const [key, error] of [
        ['G_PAGINATION_EMPTY_FOREIGN', /identity/],
        ['G_PAGINATION_EMPTY_DOCUMENT', /GEMINI_DETAIL_EMPTY_UNVERIFIED/],
    ] as const) {
        const malformed = parseGeminiRpcConversation(geminiDetailGen(key), { providerId: 'gemini', targetConvId: 'source_chat_123' });
        await assert.rejects(getConversationDetail(detailClient([malformed]), 'source_chat_123'), error);
    }
});
