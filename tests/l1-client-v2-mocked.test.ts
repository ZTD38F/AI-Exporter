import { parseGeminiRequest } from '../src/l1/parsers/gemini/rpc/request.js';
import { geminiListPage, geminiListPages, GEMINI_LIST_CAPTURE } from './fixtures/providers/geminiListCapture.js';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ports, GEMINI_ACCOUNT, CHATGPT_ACCOUNT, DEFAULT_ACCOUNT } from './helpers/l1V2UnitMocks.js';
import { GeminiProvider } from '../src/l1/client/gemini/geminiProvider.js';
import { ChatGPTProvider } from '../src/l1/client/chatgpt/chatgptProvider.js';
import { ConfirmedGeminiConversationNotFound } from '../src/l1/client/gemini/geminiClient.js';
import { createSourceResourceContext } from '../src/l1/resources/sourceResources.js';
import type { Diagnostic } from '../src/shared/diagnostics/diagnostic.js';
import { mergeConversationPages } from '../src/l1/parsers/gemini/rpc/mergePages.js';
import { sourceDetail, sourceMessage } from './helpers/l1SourceFixture.js';
import { parseList, type ListParseResult } from '../src/l1/parsers/gemini/rpc/parseList.js';
import { listGen as geminiListGen } from './fixtures/providers/gemini.js';
import { listGen as chatgptListGen } from './fixtures/providers/chatgpt.js';
import { sessionGen as chatgptSessionGen } from './fixtures/providers/chatgptSession.js';

beforeEach(() => ports.reset());
const route = async () => 'u0';
const client = (pages: ListParseResult[]) => ({
    async getConversationList() {
        const next = pages.shift();
        if (!next) throw new Error('Unexpected source request');
        return next;
    },
    async getConversationDetail() { return sourceDetail(); },
});

test('Gemini Client commits canonical keyless Index/page evidence before callback', async () => {
    const pages = geminiListPages();
    const provider = new GeminiProvider(client(pages.map(page => parseList(page.responseBody))), route);
    const seen: Array<{ page: number; committed: number; head: boolean }> = [];
    const end = await provider.listConversations({
        accountId: GEMINI_ACCOUNT.id, streamId: 'recent',
        onPageCommitted: async info => {
            seen.push({ page: info.page, committed: ports.indexes.length, head: !!info.scanHead });
            return false;
        },
    });
    assert.equal(end, 'source_end');
    assert.deepEqual(seen, pages.map((_, index) => ({ page: index + 1, committed: index + 1, head: index === 0 })));
    assert.equal(ports.indexes.length, GEMINI_LIST_CAPTURE.pageCount);
    assert.deepEqual(ports.indexes.map(call => call.items.length), [31, ...Array<number>(21).fill(20), 7]);
    assert.deepEqual(ports.indexes.flatMap(call => call.items.map(row => row.conversationId)),
        Array.from({ length: GEMINI_LIST_CAPTURE.totalRows }, (_, index) => String(index + 1).padStart(16, '0')));
    assert.equal(ports.indexes.reduce((sum, call) => sum + call.items.length, 0), GEMINI_LIST_CAPTURE.totalRows);
    assert.equal(ports.indexes[0].items[0].conversationId, GEMINI_LIST_CAPTURE.first.id);
    assert.equal(ports.indexes[22].items.at(-1)?.conversationId, GEMINI_LIST_CAPTURE.last.id);
    assert.equal(ports.indexes[0].accountId, GEMINI_ACCOUNT.id);
    assert.equal(ports.indexes[0].page?.requestCursor, null);
    assert.equal(ports.indexes[0].page?.keys[0]?.time, GEMINI_LIST_CAPTURE.first.updatedAt);
    assert.equal(ports.indexes[22].page?.nextCursor, null);
    assert.ok(ports.indexes.every(call => call.page?.valid && call.page?.requestKnown));
});

test('L1 preserves Index facts without certifying an untrusted page or default account', async () => {
    const untrusted = parseList(geminiListPage().responseBody);
    untrusted.pageEvidence.valid = false;
    await assert.rejects(new GeminiProvider(client([untrusted]), route).listConversations({
        accountId: GEMINI_ACCOUNT.id, streamId: 'recent',
    }), /Unverified Gemini list page/);
    assert.equal(ports.indexes.length, 1);
    assert.equal(ports.indexes[0].page?.valid, false);
    ports.reset();
    await assert.rejects(new GeminiProvider(client([parseList(geminiListPage(22).responseBody)]), route).listConversations({
        accountId: DEFAULT_ACCOUNT.id, streamId: 'recent',
    }), /Unverified Gemini list endpoint/);
    assert.equal(ports.indexes.length, 1);
    assert.equal(ports.indexes[0].page, undefined, 'default identity cannot contribute trusted Coverage');
});

test('Gemini provider-limit is conveyed as a committed empty request-bound page, not estimated history length', async () => {
    const limit = parseList(geminiListGen('G_L1_CLIENT_V2_MOCKED_02'));
    let callbacks = 0;
    const end = await new GeminiProvider(client([parseList(geminiListPage().responseBody), limit]), route)
        .listConversations({ accountId: GEMINI_ACCOUNT.id, streamId: 'recent',
            onPageCommitted: async () => { callbacks++; return false; } });
    assert.equal(end, 'provider_limit');
    assert.equal(callbacks, 2);
    assert.equal(ports.indexes.length, 2);
    assert.deepEqual(ports.indexes[1].items, []);
    assert.deepEqual(ports.indexes[1].page?.keys, []);
    assert.equal(ports.indexes[1].page?.terminal, 'provider_limit');
    assert.equal(ports.indexes[1].page?.requestCursor, parseGeminiRequest(geminiListPage(1).requestBody).list!.requestCursor);
});

test('failed L2 Index commit prevents Client progress and next-page acquisition', async () => {
    ports.indexError = new Error('mock Index transaction failed');
    let callback = false, requests = 0;
    const provider = new GeminiProvider({
        async getConversationList() { requests++; return parseList(geminiListPage().responseBody); },
        async getConversationDetail() { return sourceDetail(); },
    }, route);
    await assert.rejects(provider.listConversations({
        accountId: GEMINI_ACCOUNT.id, streamId: 'recent',
        onPageCommitted: async () => { callback = true; return false; },
    }), /mock Index transaction failed/);
    assert.equal(requests, 1);
    assert.equal(callback, false);
    assert.equal(ports.indexes.length, 0);
});

test('Gemini Detail may retain source bytes only for L2 accepted candidates', async () => {
    const base = sourceDetail();
    const asset = { id: 'current-image', kind: 'image' as const, mediaType: 'image/png' };
    // Acquisition hints are a read-only L1 side channel; construct the fixture
    // with its image and bytes rather than mutating an already parsed result.
    const parsed = {
        ...base,
        conversation: {
            ...base.conversation,
            detail: { ...base.conversation.detail, assets: [...base.conversation.detail.assets, asset] },
        },
        acquisitionHints: { ...base.acquisitionHints, [asset.id]: { dataBase64: 'AQID' } },
    };
    const resources = createSourceResourceContext();
    const provider = new GeminiProvider({
        async getConversationList() { return parseList(geminiListPage().responseBody); },
        async getConversationDetail() { return parsed; },
    }, route, resources);
    const key = { accountId: GEMINI_ACCOUNT.id, conversationId: parsed.conversationId };
    try {
        ports.detailDecision = { accepted: false, changed: false };
        assert.equal(await provider.fetchConversationDetail(GEMINI_ACCOUNT.id, parsed.conversationId), undefined);
        await assert.rejects(resources.acquire(key, asset), /No supported source locator/);
        assert.equal(ports.details.length, 1);
        assert.equal(ports.details[0].detail.assets[0].id, asset.id);
        assert.equal(ports.details[0].indexFields?.titleSource, 'provider');

        ports.detailDecision = { accepted: true, changed: false };
        await provider.fetchConversationDetail(GEMINI_ACCOUNT.id, parsed.conversationId);
        assert.deepEqual((await resources.acquire(key, asset)).bytes, Uint8Array.of(1, 2, 3));
        assert.equal(ports.details.length, 2);
    } finally { resources.release(); }
});

test('source-confirmed target deletion waits for L2 committed deletion and reports stable not-found', async () => {
    const provider = new GeminiProvider({
        async getConversationList() { return parseList(geminiListPage().responseBody); },
        async getConversationDetail() {
            throw new ConfirmedGeminiConversationNotFound('c_source_chat_123');
        },
    }, route);
    const steps: string[] = [];
    ports.beforeDeletionCommit = async () => { steps.push('commit'); };
    await assert.rejects(provider.fetchConversationDetail(GEMINI_ACCOUNT.id, 'source_chat_123'),
        /conversation_not_found/);
    assert.deepEqual(steps, ['commit']);
    assert.deepEqual(ports.deletions, [[GEMINI_ACCOUNT.id, 'source_chat_123']]);
    ports.reset();
    ports.deletionError = new Error('mock deletion commit failure');
    await assert.rejects(provider.fetchConversationDetail(GEMINI_ACCOUNT.id, 'source_chat_123'),
        /mock deletion commit failure/);
});

test('Client refuses changed account route and mismatched Provider before committing anything', async () => {
    let checks = 0, fetched = false;
    const provider = new GeminiProvider({
        async getConversationList() { fetched = true; return parseList(geminiListPage().responseBody); },
        async getConversationDetail() { fetched = true; return sourceDetail(); },
    }, async () => ++checks === 1 ? 'u0' : 'u1');
    await assert.rejects(provider.listConversations({ accountId: GEMINI_ACCOUNT.id, streamId: 'recent' }),
        /route changed/);
    assert.equal(fetched, false);
    assert.equal(ports.indexes.length, 0);
    const foreign = new GeminiProvider(client([parseList(geminiListPage().responseBody)]), route);
    await assert.rejects(foreign.listConversations({ accountId: CHATGPT_ACCOUNT.id, streamId: 'recent' }),
        /Provider account mismatch/);
});

test('ChatGPT uses the same v2 Index/page port and checks native completeness before source_end', async () => {
    const fetchFn = async (url: string) => new Response(JSON.stringify(
        url.endsWith('/api/auth/session')
            ? chatgptSessionGen('C_L1_CLIENT_V2_MOCKED_03')
            : chatgptListGen('C_L1_CLIENT_V2_MOCKED_04'),
    ), { status: 200 });
    const provider = new ChatGPTProvider({ fetchFn });
    const committed: number[] = [];
    const end = await provider.listConversations({
        accountId: CHATGPT_ACCOUNT.id, streamId: 'recent',
        onPageCommitted: async progress => { committed.push(ports.indexes.length); assert.ok(progress.scanHead); return false; },
    });
    assert.equal(end, 'source_end');
    assert.deepEqual(committed, [1]);
    assert.deepEqual(ports.indexes[0].items, [{
        conversationId: 'chatgpt-source', fields: {
            title: 'Owned title', titleSource: 'provider', createdAt: 1700000000000,
            updatedAt: 1700000010000,
        },
    }]);
    assert.equal(ports.indexes[0].page?.keys[0]?.time, 1700000010000);
    assert.equal(ports.indexes[0].page?.nextCursor, null);

    ports.reset();
    const invalid = new ChatGPTProvider({ fetchFn: async url => new Response(JSON.stringify(
        url.endsWith('/api/auth/session')
            ? chatgptSessionGen('C_L1_CLIENT_V2_MOCKED_05')
            : chatgptListGen('C_L1_CLIENT_V2_MOCKED_06'),
    ), { status: 200 }) });
    await assert.rejects(invalid.listConversations({ accountId: CHATGPT_ACCOUNT.id, streamId: 'recent' }),
        /Unverified ChatGPT list page/);
    assert.equal(ports.indexes.length, 1);
    assert.equal(ports.indexes[0].page?.valid, false);
});


test('Detail diagnostics expose parsing evidence and L2 admission without exporting source bodies', async () => {
    const page = sourceDetail({ turnsRejected: 2, messages: [{
        ...sourceMessage('newer-answer', 'Private source body'), timestamp: 1700000001000,
    }] });
    const parsed = { ...mergeConversationPages([page], 'token_loop', false), transport: page.transport };
    const provider = new GeminiProvider({
        async getConversationList() { return parseList(geminiListPage().responseBody); },
        async getConversationDetail() { return parsed; },
    }, route);
    ports.detailDecision = { accepted: false, changed: false };
    const events: Diagnostic[] = [];
    await provider.fetchConversationDetail(GEMINI_ACCOUNT.id, parsed.conversationId, undefined, event => events.push(event));
    assert.ok(events.some(event => event.code === 'GEMINI_TURNS_REJECTED'));
    assert.deepEqual(events.find(event => event.code === 'CONVERSATION_VERSION_MISMATCH')?.details,
        { sourceVersion: 1700000000000, newerMessages: [{ id: 'newer-answer', role: 'assistant', timestamp: 1700000001000 }] });
    const pagination = events.find(event => event.code === 'GEMINI_DETAIL_PAGES')?.details;
    assert.ok(pagination && typeof pagination === 'object' && !Array.isArray(pagination));
    assert.equal(pagination.pageCount, 1);
    assert.equal(pagination.truncation, 'token_loop');
    assert.equal(pagination.versionMismatch, true);
    const summary = events.find(event => event.code === 'GEMINI_DETAIL_PARSE_RESULT')?.details;
    assert.ok(summary && typeof summary === 'object' && !Array.isArray(summary));
    assert.equal(summary.quality, 'partial');
    assert.equal(summary.rejectedTurns, 2);
    assert.equal(summary.messageCount, 1);
    assert.deepEqual(events.find(event => event.code === 'GEMINI_DETAIL_ADMISSION')?.details,
        { accepted: false, changed: false });
    assert.doesNotMatch(JSON.stringify(events), /Private source body|decodedPayload|dataBase64/);
    await provider.fetchConversationDetail(GEMINI_ACCOUNT.id, parsed.conversationId, undefined,
        () => { throw new Error('Diagnostic observer failed'); });
    assert.equal(ports.details.length, 2, 'diagnostic listener failures do not suppress source admission');
    assert.equal(ports.details[1].detail.quality.status, 'partial');
});
