import type { ChatGPTConversationNode } from '../src/l1/parsers/chatgpt/chatgptTypes.js';
import { parseGeminiRequest } from '../src/l1/parsers/gemini/rpc/request.js';
import { geminiListPage, geminiListPages, GEMINI_LIST_CAPTURE } from './fixtures/providers/geminiListCapture.js';
import { createSourceResourceContext } from '../src/l1/resources/sourceResources.js';
import { ingestIndexes } from '../src/runtime/api/domainIngestion.js';
import { ingestDetail as commitDetail } from '../src/l2/ingestion.js';
import { parseGeminiIndexObservation } from '../src/l1/parsers/gemini/parseIndexObservation.js';
import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { indexStorage } from './helpers/indexStorage.js';
import { ACCOUNT_UUID, OTHER_ACCOUNT_UUID, ACCOUNT_OBSERVATION } from './helpers/accountRuntime.js';
import { GeminiProvider, defaultGeminiProvider } from '../src/l1/client/gemini/geminiProvider.js';
import type { GeminiProviderClient } from '../src/l1/client/gemini/geminiContracts.js';
import type { CommittedListPage } from '../src/l1/client/aiProvider.js';
import { parseList, type ListParseResult } from '../src/l1/parsers/gemini/rpc/parseList.js';
import { parseGeminiRpcConversation } from '../src/l1/parsers/gemini/rpc/parseConversation.js';
import { getConversationDetail } from '../src/l1/client/gemini/api/pagination.js';
import { listIndexes as getConversations } from '../src/l3a/storageService.js';
import { getDetail } from '../src/l3a/storageService.js';
import { getCoverage } from '../src/l2/coverageAdmission.js';
import { getAccount } from '../src/runtime/api/accountRegistry.js';
import { init, handleWindowMessage } from '../src/l1/sniffer/gemini/messageBridge.js';
import { CrossWorldEvents } from '../src/l1/protocol/gemini/protocol.js';
import { importTakeout } from '../src/l1/imports/takeout/importTakeout.js';
import { parseChatGPTConversation } from '../src/l1/parsers/chatgpt/parseConversation.js';
import { ChatGPTProvider } from '../src/l1/client/chatgpt/chatgptProvider.js';
import { listGen as geminiListGen } from './fixtures/providers/gemini.js';
import { detailGen as geminiDetailGen } from './fixtures/providers/geminiDetail.js';
import { requestGen as geminiDetailRequestGen } from './fixtures/providers/geminiDetailRequest.js';
import { listGen as chatgptListGen } from './fixtures/providers/chatgpt.js';
import { sessionGen as chatgptSessionGen } from './fixtures/providers/chatgptSession.js';
import { fixtureAccount } from './helpers/domainFixture.js';

let storage: ReturnType<typeof indexStorage>;
beforeEach(() => {
    storage = indexStorage();
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { addEventListener() {}, removeEventListener() {} } });
    init();
});
afterEach(() => storage.restore());
function client(pages: (ListParseResult | Error)[], requests: unknown[] = []): GeminiProviderClient {
    return { async getConversationList(cursor, slot, filter, options) {
        requests.push({ cursor, slot, filter, signal: options?.signal });
        const page = pages.shift();
        if (page instanceof Error) throw page;
        assert.ok(page, 'unexpected next request');
        return page;
    }, async getConversationDetail() { throw new Error('Unexpected detail acquisition'); } };
}
const provider = (pages: (ListParseResult | Error)[], requests: unknown[] = []) => new GeminiProvider(client(pages, requests), async () => 'u0');
const options = () => ({ accountId: ACCOUNT_UUID, streamId: 'recent' });
const detailWire = (key: Parameters<typeof geminiDetailGen>[0] = 'G_L1_CONTRACT_DETAIL_DEFAULT_01') =>
    geminiDetailGen(key);
const sourceEvent = (text: string, extra: Record<string, unknown> = {}) => ({ source: window, origin: typeof location !== 'undefined' ? location.origin : 'https://gemini.google.com', data: {
    type: CrossWorldEvents.NETWORK_BATCHEXECUTE, payload: { text, slot: 'u0', requestedAt: Date.now(), truncated: false,
        url: 'https://gemini.google.com/_/BardChatUi/data/batchexecute', requestAccountObservation: ACCOUNT_OBSERVATION, ...extra },
} } as unknown as MessageEvent);

test('L1 list commits the captured 23-page chain before callbacks and emits only first trusted head', async () => {
    const pages = geminiListPages(), requests: unknown[] = [], progress: CommittedListPage[] = [];
    const end = await provider(pages.map(page => parseList(page.responseBody)), requests).listConversations({ ...options(),
        async onPageCommitted(info) {
            assert.equal((await getConversations(ACCOUNT_UUID)).length, info.totalObserved);
            progress.push(info); return false;
        } });
    assert.equal(end, 'source_end');
    assert.equal(progress.length, GEMINI_LIST_CAPTURE.pageCount);
    assert.equal(progress[0].totalObserved, GEMINI_LIST_CAPTURE.firstPageRows);
    assert.equal(progress.at(-1)?.totalObserved, GEMINI_LIST_CAPTURE.totalRows);
    assert.ok(progress[0].scanHead); assert.ok(progress.slice(1).every(page => page.scanHead === undefined));
    assert.equal('items' in progress[0], false);
    assert.equal((await getCoverage(ACCOUNT_UUID, 'recent'))?.range !== null, true);
    assert.deepEqual(requests.map(request => (request as { cursor: unknown }).cursor),
        pages.map(page => parseGeminiRequest(page.requestBody).list!.requestCursor));
});
test('L1 callback stop never overrides a real source terminal', async () => {
    assert.equal(await provider([parseList(geminiListPage(22).responseBody)]).listConversations({ ...options(), onPageCommitted: async () => true }), 'source_end');
    assert.equal(await provider([parseList(geminiListPage().responseBody)]).listConversations({ ...options(), onPageCommitted: async () => true }), 'stopped');
});
test('L1 counts committed source rows but refuses to trust duplicate IDs across pages', async () => {
    const counts: number[] = [];
    await assert.rejects(provider([parseList(geminiListGen('G_L1_CONTRACT_06')), parseList(geminiListGen('G_L1_CONTRACT_07'))]).listConversations({
        ...options(), onPageCommitted: async info => { counts.push(info.totalObserved); return false; },
    }), /Unverified Gemini list page/);
    assert.deepEqual(counts, [1, 2], 'progress describes committed rows, not unique local Index records');
    assert.equal((await getConversations(ACCOUNT_UUID)).length, 1);
    assert.equal((await getCoverage(ACCOUNT_UUID, 'recent'))?.range ?? null, null);
});
test('L1 propagates commit failure without callback or another request', async () => {
    storage.fail(`conversations_${ACCOUNT_UUID}`);
    let called = false;
    await assert.rejects(provider([parseList(geminiListPage().responseBody)]).listConversations({ ...options(), onPageCommitted: async () => { called = true; return false; } }), /write failed/);
    assert.equal(called, false);
});
test('L1 propagates network errors even after a committed page', async () => {
    await assert.rejects(provider([parseList(geminiListPage().responseBody), new Error('offline')]).listConversations(options()), /offline/);
    assert.equal((await getConversations(ACCOUNT_UUID)).length, GEMINI_LIST_CAPTURE.firstPageRows);
});
test('L1 rejects malformed pages and cursor loops', async () => {
    await assert.rejects(provider([parseList(geminiListGen('G_L1_CONTRACT_10')), parseList(geminiListGen('G_L1_CONTRACT_11'))]).listConversations(options()), /cursor loop/);
    await assert.rejects(provider([parseList(geminiListGen('G_L1_CONTRACT_12'))]).listConversations(options()), /list failed/);
});
test('L1 abort never reports exhaustion or starts another page', async () => {
    const controller = new AbortController(); controller.abort();
    await assert.rejects(provider([]).listConversations({ ...options(), signal: controller.signal }), { name: 'AbortError' });
});
test('L1 routes exactly the requested stream', async () => {
    const requests: unknown[] = [];
    assert.equal(await provider([parseList(geminiListGen('G_L1_CONTRACT_13'))], requests).listConversations({ ...options(), streamId: 'pinned' }), 'source_end');
    assert.deepEqual((requests[0] as { filter: unknown }).filter, [1, null, 1]); assert.equal(requests.length, 1);
});
test('L1 rejects account mismatch and route changes before acquisition', async () => {
    await assert.rejects(provider([]).listConversations({ ...options(), accountId: fixtureAccount('chatgpt').id }), /mismatch/);
    let routeCalls = 0;
    const p = new GeminiProvider(client([]), async () => ++routeCalls === 1 ? 'u0' : 'u1');
    await assert.rejects(p.listConversations(options()), /route changed/);
});
test('L1 unknown identity can retain rows but emits no trusted scanHead', async () => {
    const defaultId = '10000000-0000-4000-8000-000000000003';
    let head: unknown;
    await assert.rejects(provider([parseList(geminiListPage(22).responseBody)]).listConversations({ ...options(), accountId: defaultId,
        onPageCommitted: async info => { head = info.scanHead; return false; },
    }), /Unverified Gemini list endpoint/);
    assert.equal(head, undefined);
    assert.equal((await getConversations(defaultId)).length, GEMINI_LIST_CAPTURE.lastPageRows, 'unknown identity still admits source Index facts');
    assert.equal(await getCoverage(defaultId, 'recent'), null);
});
test('L1 unknown Bard errors cannot become a history-window terminal', () => {
    for (const key of ['G_L1_CONTRACT_15_0', 'G_L1_CONTRACT_15_1'] as const) {
        const parsed = parseList(geminiListGen(key));
        assert.equal(parsed.failure, 'invalid_response');
    }
});
test('L1 detail request decoding accepts only the actual RPC layout', () => {
    assert.deepEqual(parseGeminiRequest(geminiDetailRequestGen('G_L1_DETAIL_REQUEST_VALID_01')).detail, {
        conversationId: 'source_chat_123', requestCursor: 'tC_NEXT_PAGE_123456789',
    });
    assert.equal(parseGeminiRequest(geminiDetailRequestGen('G_L1_DETAIL_REQUEST_TRUNCATED_01')).detail, null);
    assert.equal(parseGeminiRequest(geminiDetailRequestGen('G_L1_DETAIL_REQUEST_GARBAGE_01')).detail, null);
});
test('L1 passive list commits the captured chain including its nonempty terminal', async () => {
    for (const page of geminiListPages()) {
        await handleWindowMessage(sourceEvent(page.responseBody, { listRequest: parseGeminiRequest(page.requestBody).list }));
    }
    assert.equal((await getConversations(ACCOUNT_UUID)).length, GEMINI_LIST_CAPTURE.totalRows);
    assert.ok((await getCoverage(ACCOUNT_UUID, 'recent'))?.range);
});
test('L1 passive empty continuation still commits a natural terminal without deleting Index facts', async () => {
    const first = geminiListPage();
    await handleWindowMessage(sourceEvent(first.responseBody, { listRequest: parseGeminiRequest(first.requestBody).list }));
    await handleWindowMessage(sourceEvent(geminiListGen('G_PAGE_OBSERVATION_06'), {
        listRequest: parseGeminiRequest(geminiListPage(1).requestBody).list,
    }));
    assert.equal((await getConversations(ACCOUNT_UUID)).length, GEMINI_LIST_CAPTURE.firstPageRows);
    assert.ok((await getCoverage(ACCOUNT_UUID, 'recent'))?.range);
});
test('L1 passive list uses captured identity and never borrows current account', async () => {
    await handleWindowMessage(sourceEvent(geminiListPage().responseBody, { requestAccountObservation: { providerId: 'gemini', providerAccountId: '10000000002' } }));
    assert.equal((await getConversations(ACCOUNT_UUID)).length, 0);
    assert.equal((await getConversations(OTHER_ACCOUNT_UUID)).length, GEMINI_LIST_CAPTURE.firstPageRows);
});
test('L1 passive input validates URL, required fields and capture limits', async () => {
    for (const extra of [{ url: 'https://evil.test/batchexecute' }, { requestedAt: undefined }, { truncated: undefined }, { text: geminiListGen('G_MESSAGE_BRIDGE_OVERSIZED_BODY_01') }]) {
        await handleWindowMessage(sourceEvent(geminiListPage().responseBody, extra));
    }
    assert.equal((await getConversations(ACCOUNT_UUID)).length, 0);
});
test('L1 passive uncorrelated detail cannot become complete or issue a request', async () => {
    await handleWindowMessage(sourceEvent(detailWire()));
    const stored = await getDetail({ accountId: ACCOUNT_UUID, conversationId: 'source_chat_123' });
    assert.ok(stored); assert.equal(stored.quality.status, 'unknown');
});
test('L1 passive observed detail chain shares active source assembly', async () => {
    const next = 'tC_NEXT_PAGE_123456789';
    await handleWindowMessage(sourceEvent(detailWire('G_L1_CONTRACT_DETAIL_NEWER_01'), { detailRequest: { conversationId: 'source_chat_123', requestCursor: null } }));
    await handleWindowMessage(sourceEvent(detailWire('G_L1_CONTRACT_DETAIL_OLDER_01'), { detailRequest: { conversationId: 'source_chat_123', requestCursor: next } }));
    const stored = await getDetail({ accountId: ACCOUNT_UUID, conversationId: 'source_chat_123' });
    assert.ok(stored); assert.equal(stored.quality.status, 'complete');
    assert.equal(stored.messages.length, 4);
});
test('L1 receiver re-init cannot complete a Detail chain from the previous receiver lifetime', async () => {
    await handleWindowMessage(sourceEvent(detailWire('G_L1_CONTRACT_DETAIL_NEWER_01'), {
        detailRequest: { conversationId: 'source_chat_123', requestCursor: null },
    }));
    init({});
    await handleWindowMessage(sourceEvent(detailWire('G_L1_CONTRACT_DETAIL_OLDER_01'), {
        detailRequest: { conversationId: 'source_chat_123', requestCursor: 'tC_NEXT_PAGE_123456789' },
    }));
    const stored = await getDetail({ accountId: ACCOUNT_UUID, conversationId: 'source_chat_123' });
    assert.ok(stored);
    assert.notEqual(stored.quality.status, 'complete', 'a new receiver has no evidence of a complete source chain');
});

test('L1 passive Live Save is driven only by committed Detail changed, not duplicate capture', async () => {
    const changed: string[] = [];
    const resources = createSourceResourceContext();
    const retained: string[] = [];
    const retainParsed = resources.retainParsed.bind(resources);
    resources.retainParsed = (key, parsed) => { retained.push(key.conversationId); retainParsed(key, parsed); };
    init({ resources, onDetailChanged: key => changed.push(key.conversationId) });
    try {
        const capture = sourceEvent(detailWire(), { detailRequest: { conversationId: 'source_chat_123', requestCursor: null } });
        await handleWindowMessage(capture);
        await handleWindowMessage(capture);
        assert.deepEqual(changed, ['source_chat_123'], 'same snapshot is not a second content change');
        assert.deepEqual(retained, ['source_chat_123', 'source_chat_123'], 'accepted same-content candidates may refresh task bytes');
        assert.equal((await getDetail({ accountId: ACCOUNT_UUID, conversationId: 'source_chat_123' }))?.quality.status, 'complete');
    } finally { resources.release(); }
});

test('L1 rejected passive Detail never retains source bytes or emits Live Save', async () => {
    const key = { accountId: ACCOUNT_UUID, conversationId: 'source_chat_123' };
    await commitDetail(ACCOUNT_UUID, key.conversationId, {
        savedAt: 1700000060000, quality: { status: 'complete' },
        assets: [], messages: [{ role: 'assistant', content: [{ type: 'paragraph',
            children: [{ type: 'text', text: 'already selected newer body' }] }] }],
    });
    const selected = await getDetail(key);
    let retained = 0, changed = 0;
    const resources = createSourceResourceContext();
    resources.retainParsed = () => { retained++; };
    init({ resources, onDetailChanged: () => { changed++; } });
    try {
        await handleWindowMessage(sourceEvent(detailWire(), {
            detailRequest: { conversationId: key.conversationId, requestCursor: null },
        }));
        assert.equal(retained, 0, 'rejected candidates cannot supply export resources');
        assert.equal(changed, 0, 'rejected candidates cannot schedule Live Save');
        assert.deepEqual(await getDetail(key), selected, 'L2 remains the sole selector of stored Detail');
    } finally { resources.release(); }
});

test('L1 unverified delete notification cannot invoke L2 or emit a committed callback', async () => {
    let observed: unknown;
    init({ onConversationDeleted: (id, accountId) => { observed = [id, accountId]; } });
    await handleWindowMessage({ ...sourceEvent('unused'), data: { type: CrossWorldEvents.CONVERSATION_DELETED,
        payload: { id: 'source_chat_123', slot: 'u0', requestAccountObservation: ACCOUNT_OBSERVATION } } });
    assert.equal(observed, undefined);
});
test('L1 detail returns void after successful L2 admission', async () => {
    const account = await getAccount(ACCOUNT_UUID); assert.ok(account);
    const source = parseGeminiRpcConversation(detailWire(), { providerId: 'gemini', account });
    const p = new GeminiProvider({ ...client([]), getConversationDetail: async () => source }, async () => 'u0');
    assert.equal(await p.fetchConversationDetail(ACCOUNT_UUID, 'source_chat_123'), undefined);
    assert.equal((await getConversations(ACCOUNT_UUID)).length, 1);
});
test('L1 active Detail forwards AbortSignal to every source request', async () => {
    const controller = new AbortController(), account = await getAccount(ACCOUNT_UUID); assert.ok(account);
    const parsed = parseGeminiRpcConversation(detailWire(), { providerId: 'gemini', account });
    let seen: unknown;
    await getConversationDetail({ fetchConversationPage: async (_id, _token, _slot, opts) => { seen = opts?.signal; return parsed; } }, 'source_chat_123', 'u0', account, controller.signal);
    assert.equal(seen, controller.signal);
});
test('L1 import submits facts and returns count/status with numerical progress', async () => {
    const html = '<div class="outer-cell"><a href="https://gemini.google.com/app/source_chat_123">Conversation</a><div class="content-cell mdl-cell mdl-cell--6-col mdl-typography--body-1">Prompted Question<br>2026-09-02T12:00:00Z<br><p>Answer</p></div></div>';
    const archive = { file() {}, files: { 'Takeout/Gemini/MyActivity.html': { _data: { uncompressedSize: html.length }, async: async () => html } } };
    const progress: number[] = [];
    const result = await importTakeout(archive as unknown as File, ACCOUNT_UUID, percent => progress.push(percent));
    assert.deepEqual(result, { imported: 1, status: 'partial' });
    assert.equal((await getConversations(ACCOUNT_UUID)).length, 1);
    assert.ok(progress.every(value => typeof value === 'number' && value >= 0 && value <= 100)); assert.equal(progress.at(-1), 100);
});
test('L1 ChatGPT body quality is independent of missing image bytes', () => {
    const parsed = parseChatGPTConversation({ account: fixtureAccount('chatgpt'), conversation: { id: 'chatgpt_123', createdAtMs: 1700000000000, updatedAtMs: 1700000001000, is_archived: false, title: 'Images', current_node: 'node', mapping: new Map(Object.entries<ChatGPTConversationNode>({
        root: { id: 'root', children: ['node'] },
        node: { id: 'node', parent: 'root', children: [], message: { id: 'msg', author: { role: 'assistant' }, recipient: 'all', status: 'finished_successfully', weight: 1, content: { content_type: 'multimodal_text', parts: [{ content_type: 'image_asset_pointer', asset_pointer: 'sediment://file_123' }] } } },
    })) }, assetsByNode: new Map() });
    assert.equal(parsed.conversation.detail.quality.status, 'complete');
    assert.equal(parsed.conversation.detail.assets.length, 1);
});
test('L1 ChatGPT rejects conflicting session identity before list submission', async () => {
    const p = new ChatGPTProvider({ fetchFn: async () => ({ ok: true, json: async () => chatgptSessionGen('C_L1_CONTRACT_20') } as Response) });
    await assert.rejects(p.listConversations({ accountId: fixtureAccount('chatgpt').id, streamId: 'recent' }), /account mismatch/);
});

test('L1 known window heuristic commits empty terminal after real continuation, never on first page', async () => {
    const limited = parseList(geminiListGen('G_L1_CONTRACT_21'));
    assert.equal(limited.failure, 'hit_google_limit');
    const progress: CommittedListPage[] = [];
    assert.equal(await provider([parseList(geminiListPage().responseBody), limited]).listConversations({ ...options(),
        onPageCommitted: async info => { progress.push(info); return false; } }), 'provider_limit');
    assert.equal(progress.length, 2);
    assert.ok((await getCoverage(ACCOUNT_UUID, 'recent'))?.range);
    await assert.rejects(provider([limited]).listConversations(options()), /list failed/);
});

test('L1 HTTP 429 stays a network failure after committed rows', async () => {
    await assert.rejects(provider([parseList(geminiListPage().responseBody), new Error('HTTP 429 :: BardErrorInfo 1096')]).listConversations(options()), /HTTP 429/);
    assert.equal((await getCoverage(ACCOUNT_UUID, 'recent'))?.range, null);
});
test('L1 source resource operation returns bytes and respects pre-abort', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () => new Response(Uint8Array.of(1, 2, 3));
    try {
        const p = provider([]);
        const asset = { id: 'image', kind: 'image' as const, sourceUri: 'https://example.test/image', mediaType: 'image/png' };
        const result = await p.acquireResource({ accountId: ACCOUNT_UUID, conversationId: 'source_chat_123' }, asset);
        assert.deepEqual(result, { bytes: Uint8Array.of(1, 2, 3), mediaType: 'image/png' });
        const controller = new AbortController(); controller.abort();
        await assert.rejects(p.acquireResource({ accountId: ACCOUNT_UUID, conversationId: 'source_chat_123' }, asset, controller.signal), { name: 'AbortError' });
        await assert.rejects(p.acquireResource({ accountId: ACCOUNT_UUID, conversationId: 'source_chat_123' }, { ...asset, sourceUri: 'blob:temporary' }), /locator/);
    } finally { globalThis.fetch = original; }
});

test('L1 DOM capture commits source metadata without fabricating activity clocks', async () => {
    await ingestIndexes(ACCOUNT_UUID, [parseGeminiIndexObservation({ id: 'dom_source_123', title: 'Observed title' }, 'dom')]);
    const [index] = await getConversations(ACCOUNT_UUID);
    assert.equal(index.titleSource, 'provider');
    assert.equal(index.updatedAt, undefined);
    assert.equal(await getCoverage(ACCOUNT_UUID, 'recent'), null);
});
test('L1 current inline bytes survive missing locator without network or Runtime route', async () => {
    const account = await getAccount(ACCOUNT_UUID); assert.ok(account);
    const parsed = parseGeminiRpcConversation(detailWire(), { providerId: 'gemini', account });
    const asset = { id: 'inline', kind: 'image' as const, mediaType: 'image/png' };
    parsed.conversation.detail.assets.push(asset);
    parsed.acquisitionHints = { inline: { dataBase64: 'AQID' } };
    const resources = createSourceResourceContext();
    const p = new GeminiProvider({ ...client([]), getConversationDetail: async () => parsed }, async () => 'u0', resources);
    await p.fetchConversationDetail(ACCOUNT_UUID, parsed.conversationId);
    const offline = new GeminiProvider(client([]), async () => { throw new Error('No online route'); }, resources);
    const key = { accountId: ACCOUNT_UUID, conversationId: parsed.conversationId };
    assert.deepEqual((await offline.acquireResource(key, asset)).bytes, Uint8Array.of(1, 2, 3));
    for (const wrong of [{ ...key, conversationId: 'another_chat' }, { ...key, accountId: OTHER_ACCOUNT_UUID }]) {
        await assert.rejects(offline.acquireResource(wrong, asset));
    }
    resources.release();
    await assert.rejects(offline.acquireResource(key, asset), /released/);
});

test('L1 task resource contexts isolate identical keys and propagate cancellation during read', async () => {
    const resources = createSourceResourceContext(), otherTask = createSourceResourceContext();
    const key = { accountId: ACCOUNT_UUID, conversationId: 'source_chat_123' };
    const asset = { id: 'same', kind: 'image' as const };
    const controller = new AbortController();
    resources.retain(key, asset.id, async () => { controller.abort(); return { bytes: Uint8Array.of(1) }; });
    await assert.rejects(resources.acquire(key, asset, controller.signal), { name: 'AbortError' });
    await assert.rejects(otherTask.acquire(key, asset), /locator/);
    resources.release(); otherTask.release();
});

test('L1 Takeout hands bound ZIP entries to current resource context', async () => {
    const html = '<div class="outer-cell"><a href="https://gemini.google.com/app/source_chat_123">Conversation</a><div class="content-cell mdl-cell mdl-cell--6-col mdl-typography--body-1">Prompted Question<br>2026-09-02T12:00:00Z<br><p>Answer<img src="picture.png"></p></div></div>';
    let reads = 0, unreadable = false;
    const archive = { file() {}, files: {
        'Takeout/Gemini/MyActivity.html': { _data: { uncompressedSize: html.length }, async: async () => html },
        'Takeout/Gemini/picture.png': { _data: { uncompressedSize: 3 }, async: async () => { reads++; if (unreadable) throw new Error('Unreadable ZIP entry'); return Uint8Array.of(4, 5, 6); } },
    } };
    const resources = createSourceResourceContext();
    try {
        await importTakeout(archive as unknown as File, ACCOUNT_UUID, undefined, resources);
        assert.equal(reads, 0, 'Import must not decompress attachment bytes');
        const stored = await getDetail({ accountId: ACCOUNT_UUID, conversationId: 'source_chat_123' });
        assert.ok(stored);
        const asset = stored.assets[0]; assert.ok(asset);
        const offline = new GeminiProvider(client([]), async () => { throw new Error('No online route'); }, resources);
        const result = await offline.acquireResource({ accountId: ACCOUNT_UUID, conversationId: 'source_chat_123' }, asset);
        assert.deepEqual(result.bytes, Uint8Array.of(4, 5, 6));
        assert.equal(reads, 1);
        unreadable = true;
        await assert.rejects(offline.acquireResource({ accountId: ACCOUNT_UUID, conversationId: 'source_chat_123' }, asset));
        assert.equal(reads, 2);
        const afterFailure = await getDetail({ accountId: ACCOUNT_UUID, conversationId: 'source_chat_123' });
        assert.deepEqual(afterFailure?.quality, stored.quality);
    } finally { resources.release(); }
});


test('L1 Takeout import discards temporary archive readers when L2 rejects its Detail', async () => {
    const cid = 'source_chat_123';
    const key = { accountId: ACCOUNT_UUID, conversationId: cid };
    const newer = Date.parse('2026-09-04T12:00:00Z');
    await commitDetail(ACCOUNT_UUID, cid, {
        savedAt: newer, quality: { status: 'complete' }, messages: [], assets: [],
    });
    const selected = await getDetail(key);
    const html = '<div class="outer-cell"><a href="https://gemini.google.com/app/source_chat_123">Conversation</a>'
        + '<div class="content-cell mdl-cell mdl-cell--6-col mdl-typography--body-1">'
        + 'Prompted Draw<br>2026-09-02T12:00:00Z<br><img src="picture.png"></div></div>';
    const archive = { file() {}, files: {
        'Takeout/Gemini/MyActivity.html': { _data: { uncompressedSize: html.length }, async: async () => html },
        'Takeout/Gemini/picture.png': { _data: { uncompressedSize: 3 }, async: async () => Uint8Array.of(1, 2, 3) },
    } };
    const resources = createSourceResourceContext();
    let retained = 0;
    resources.retainParsed = () => { retained++; };
    resources.retain = () => { retained++; };
    try {
        await importTakeout(archive as unknown as File, ACCOUNT_UUID, undefined, resources);
        assert.equal(retained, 0);
        assert.deepEqual(await getDetail(key), selected);
    } finally { resources.release(); }
});

test('L1 unavailable current bytes fall back to remote locator with signal', async () => {
    const resources = createSourceResourceContext(), original = globalThis.fetch;
    const key = { accountId: ACCOUNT_UUID, conversationId: 'source_chat_123' };
    const asset = { id: 'image', kind: 'image' as const, sourceUri: 'https://example.test/image' };
    const controller = new AbortController();
    resources.retain(key, asset.id, async () => { throw new Error('Unavailable current entry'); });
    globalThis.fetch = async (url, options) => {
        assert.equal(url, asset.sourceUri); assert.equal(options?.signal, controller.signal);
        return new Response(Uint8Array.of(7));
    };
    try {
        const p = new GeminiProvider(client([]), async () => 'u0', resources);
        assert.deepEqual((await p.acquireResource(key, asset, controller.signal)).bytes, Uint8Array.of(7));
    } finally { resources.release(); globalThis.fetch = original; }
});

test('L1 Sniffer hands only correlated conversation resources to the task context', async () => {
    const resources = createSourceResourceContext();
    const retained: unknown[] = [];
    const retainParsed = resources.retainParsed.bind(resources);
    resources.retainParsed = (key, parsed) => { retained.push(key); retainParsed(key, parsed); };
    init({ resources });
    try {
        await handleWindowMessage(sourceEvent(detailWire(), { detailRequest: { conversationId: 'wrong_chat', requestCursor: null } }));
        assert.equal(retained.length, 0);
        await handleWindowMessage(sourceEvent(detailWire(), { detailRequest: { conversationId: 'source_chat_123', requestCursor: null } }));
        assert.deepEqual(retained, [{ accountId: ACCOUNT_UUID, conversationId: 'source_chat_123' }]);
    } finally { resources.release(); }
});


test('L1 providers without task injection never retain inline Detail resources', async () => {
    const account = await getAccount(ACCOUNT_UUID); assert.ok(account);
    const parsed = parseGeminiRpcConversation(detailWire(), { providerId: 'gemini', account });
    const asset = { id: 'inline', kind: 'image' as const };
    parsed.conversation.detail.assets.push(asset);
    parsed.acquisitionHints = { inline: { dataBase64: 'AQID' } };
    const p = new GeminiProvider({ ...client([]), getConversationDetail: async () => parsed }, async () => 'u0');
    for (let i = 0; i < 3; i++) await p.fetchConversationDetail(ACCOUNT_UUID, parsed.conversationId);
    await assert.rejects(p.acquireResource({ accountId: ACCOUNT_UUID, conversationId: parsed.conversationId }, asset), /locator/);
    assert.equal(Reflect.get(defaultGeminiProvider, 'resources'), undefined);
    assert.equal(Reflect.get(new ChatGPTProvider(), 'resources'), undefined);
    const stored = await getDetail({ accountId: ACCOUNT_UUID, conversationId: parsed.conversationId });
    assert.ok(stored); assert.equal(stored.assets[0].id, asset.id);
});

test('L1 successive Takeout tasks keep ZIP handles isolated and release independently of L2 facts', async () => {
    const html = '<div class="outer-cell"><a href="https://gemini.google.com/app/source_chat_123">Conversation</a><div class="content-cell mdl-cell mdl-cell--6-col mdl-typography--body-1">Prompted Question<br>2026-09-02T12:00:00Z<br><p>Answer<img src="picture.png"></p></div></div>';
    const archive = (value: number) => ({ file() {}, files: {
        'Takeout/Gemini/MyActivity.html': { _data: { uncompressedSize: html.length }, async: async () => html },
        'Takeout/Gemini/picture.png': { _data: { uncompressedSize: 1 }, async: async () => Uint8Array.of(value) },
    } });
    const first = createSourceResourceContext(), second = createSourceResourceContext();
    const key = { accountId: ACCOUNT_UUID, conversationId: 'source_chat_123' };
    try {
        await importTakeout(archive(1) as unknown as File, ACCOUNT_UUID, undefined, first);
        await importTakeout(archive(2) as unknown as File, ACCOUNT_UUID, undefined, second);
        const stored = await getDetail(key); assert.ok(stored);
        const asset = stored.assets[0]; assert.ok(asset);
        assert.deepEqual((await first.acquire(key, asset)).bytes, Uint8Array.of(1));
        assert.deepEqual((await second.acquire(key, asset)).bytes, Uint8Array.of(2));
        first.release();
        await assert.rejects(first.acquire(key, asset), /released/);
        assert.deepEqual((await second.acquire(key, asset)).bytes, Uint8Array.of(2));
        const unscoped = new GeminiProvider(client([]), async () => 'u0');
        await assert.rejects(unscoped.acquireResource(key, asset), /locator/);
        second.release();
        assert.ok(await getDetail(key));
    } finally { first.release(); second.release(); }
});
