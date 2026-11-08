import { ClaudeProvider } from '../src/l1/client/claude/claudeProvider.js';
import { listGen as claudeListGen } from './fixtures/providers/claudeList.js';
import { organizationsGen as claudeOrganizationsGen } from './fixtures/providers/claudeOrganizations.js';
import { useIndexStorage } from './helpers/indexStorage.js';
useIndexStorage();
import test from 'node:test';
import assert from 'node:assert/strict';
import { restoreConversationIndex } from '../src/l2/conversationIndex.js';
import { parseChatGPTList } from '../src/l1/parsers/chatgpt/parseList.js';
import { listGen as chatgptListGen } from './fixtures/providers/chatgpt.js';
import { sessionGen as chatgptSessionGen } from './fixtures/providers/chatgptSession.js';
import { listGen as geminiListGen } from './fixtures/providers/gemini.js';
import { parseList } from '../src/l1/parsers/gemini/rpc/parseList.js';
import { domListGen } from './fixtures/providers/geminiDomList.js';
import { ChatGPTProvider } from '../src/l1/client/chatgpt/chatgptProvider.js';
import { geminiListObservation } from '../src/l1/client/gemini/listObservation.js';
import { GeminiProvider } from '../src/l1/client/gemini/geminiProvider.js';
import { ACCOUNT_UUID } from './helpers/accountRuntime.js';
import { getOrCreateAccount } from '../src/runtime/api/accountRegistry.js';
import { sourceDetail } from './helpers/l1SourceFixture.js';
import { listIndexes as getConversations } from '../src/l3a/storageService.js';
import { parseGeminiDomIndex } from '../src/l1/parsers/gemini/dom/parseIndex.js';

test('ChatGPT lists emit exact Domain indexes with source times and no invented fallback facts', () => {
    const page = parseChatGPTList(chatgptListGen('C_LIST_SOURCE_BOUNDARY_01'));
    assert.deepEqual(page.conversations[0], { id: 'api-chat', title: 'Source title',
        titleSource: 'provider', createdAt: 1700000000125, updatedAt: 1700000060000 });
    const empty = page.conversations[1];
    assert.equal(empty.title, undefined);
    assert.equal(empty.titleSource, undefined);
    assert.equal(Object.hasOwn(empty, 'updatedAt'), false);
    assert.equal(Object.hasOwn(empty, 'createdAt'), false);
    assert.equal(page.conversations[2].createdAt, 1700000000123);
    assert.equal(Object.hasOwn(page.conversations[2], 'updatedAt'), false);
    for (const index of page.conversations) assert.equal(Object.hasOwn(index, 'key'), false);
    assert.equal(page.total, 3);
    assert.equal(page.nextCursor, 'next');
});

test('malformed ChatGPT pages cannot masquerade as empty exhausted history', async () => {
    for (const key of ['C_LIST_SOURCE_BOUNDARY_02_0', 'C_LIST_SOURCE_BOUNDARY_02_1', 'C_LIST_SOURCE_BOUNDARY_02_2', 'C_LIST_SOURCE_BOUNDARY_02_3', 'C_LIST_SOURCE_BOUNDARY_02_4', 'C_LIST_SOURCE_BOUNDARY_02_5'] as const) {
        const value = chatgptListGen(key);
        assert.throws(() => parseChatGPTList(value), TypeError);
    }
    const account = await getOrCreateAccount('chatgpt', 'default');
    let progress = 0;
    const provider = new ChatGPTProvider({ fetchFn: async url => new Response(JSON.stringify(
        url.includes('/api/auth/session') ? chatgptSessionGen('C_LIST_SOURCE_BOUNDARY_03') : chatgptListGen('C_LIST_SOURCE_BOUNDARY_04')
    )) });
    await assert.rejects(provider.listConversations({ accountId: account.id, streamId: 'recent', onPageCommitted: async () => { progress++; return false; } }), TypeError);
    assert.equal(progress, 0);
});

test('provider commits indexes before progress and exposes control facts only', async () => {
    const provider = new ChatGPTProvider({ fetchFn: async url => new Response(JSON.stringify(
        url.includes('/api/auth/session') ? chatgptSessionGen('C_LIST_SOURCE_BOUNDARY_05')
            : chatgptListGen('C_LIST_SOURCE_BOUNDARY_06')
    )) });
    const account = await getOrCreateAccount('chatgpt', JSON.stringify(['u-index', 'w-index']));
    let observed: unknown;
    const result = await provider.listConversations({ accountId: account.id, streamId: 'recent', onPageCommitted: async info => {
        observed = info; assert.equal((await getConversations(account.id)).length, 1); return false;
    } });
    assert.equal(result, 'source_end');
    assert.equal((observed as { page: number; totalObserved: number }).page, 1);
    assert.equal((observed as { page: number; totalObserved: number }).totalObserved, 1);
    assert.deepEqual((observed as { scanHead: { keys: unknown[] } }).scanHead.keys, [{ id: 'listed', time: 1700000060000 }]);

});

test('Gemini observations and pagination consume parsed evidence without reading decoded payloads', async () => {
    const parsed = parseList(geminiListGen('G_LIST_SOURCE_BOUNDARY_07'));
    Object.defineProperty(parsed, '_raw', { get() { throw new Error('downstream interpreted raw source'); } });
    const observation = geminiListObservation(parsed, { streamId: 'recent', requestCursor: null }, 'account');
    assert.equal(observation.valid, true);
    assert.equal(observation.ordered, true);
    assert.deepEqual(observation.keys, [{ id: 'boundary123', time: 1700000060000 }]);
    const provider = new GeminiProvider({ getConversationList: async () => parsed, getConversationDetail: async () => sourceDetail() }, async () => 'u0');
    assert.equal(await provider.listConversations({ accountId: ACCOUNT_UUID, streamId: 'recent' }), 'source_end');
    assert.equal((await getConversations(ACCOUNT_UUID))[0].updatedAt, 1700000060000);
});

test('Gemini parser rejects incomplete row coverage and unknown layouts as exhaustion evidence', () => {
    for (const key of ['G_LIST_SOURCE_BOUNDARY_08_0', 'G_LIST_SOURCE_BOUNDARY_08_1', 'G_LIST_SOURCE_BOUNDARY_08_2', 'G_LIST_SOURCE_BOUNDARY_08_3'] as const) {
        const source = geminiListGen(key);
        const page = parseList(source);
        assert.equal(page.pageEvidence.valid, false, source);
        assert.equal(page.pageEvidence.ordered, false);
    }
});

test('an empty Gemini continuation page preserves its cursor instead of claiming exhaustion', () => {
    const parsed = parseList(geminiListGen('G_LIST_SOURCE_BOUNDARY_09'));
    assert.equal(parsed.pageEvidence.valid, true);
    assert.equal(parsed.nextPageToken, 'tC_cursor');
    assert.deepEqual(parsed.conversations, []);
});

test('Gemini list requires an explicit natural-terminal cursor, not an unrecognized slot', () => {
    const explicit = parseList(geminiListGen('G_LIST_SOURCE_BOUNDARY_10_EXPLICIT'));
    const ambiguous = parseList(geminiListGen('G_LIST_SOURCE_BOUNDARY_10_AMBIGUOUS'));
    assert.equal(explicit.pageEvidence.valid, true);
    assert.equal(ambiguous.nextPageToken, null);
    assert.equal(ambiguous.pageEvidence.valid, false);
    assert.equal(ambiguous.pageEvidence.ordered, false);
});

test('DOM metadata preserves title precedence and keeps UI labels and observation clocks out of Domain', () => {
    const { header, doc } = domListGen('G_LIST_SOURCE_BOUNDARY_11');
    const index = parseGeminiDomIndex(doc, 'boundary123');
    assert.equal(index.title, 'Header title');
    assert.equal(index.titleSource, 'dom');
    assert.equal(Reflect.get(index, 'cloudAvailability'), undefined);
    assert.equal(Object.hasOwn(index, 'key'), false);
    header.textContent = 'Google Gemini';
    const fallback = parseGeminiDomIndex(doc, 'boundary123');
    assert.equal(fallback.title, 'First user question');
    assert.equal(fallback.titleSource, 'sniff');
    assert.equal(Object.hasOwn(fallback, 'updatedAt'), false);
    assert.equal(Object.hasOwn(fallback, 'createdAt'), false);
});

test('Claude readiness narrows unknown organization members before matching the account', async () => {
    const account = await getOrCreateAccount('claude', '11111111-1111-4111-8111-111111111111');
    const matching = new ClaudeProvider({ apiGet: async path => {
        assert.equal(path, '/api/organizations');
        return claudeOrganizationsGen('CL_ACCOUNT_MIXED_ROWS_01');
    } });
    assert.equal((await matching.checkReadiness(account.id)).ready, true);
    const wrongShape = new ClaudeProvider({ apiGet: async () =>
        claudeOrganizationsGen('CL_ACCOUNT_INVALID_ENVELOPE_01') });
    assert.equal((await wrongShape.checkReadiness(account.id)).ready, false);
});

test('Claude rejects malformed search_incomplete before trusting a list page', async () => {
    const account = await getOrCreateAccount('claude', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    for (const key of ['CL_LIST_BOUNDARY_BAD_SEARCH_STRING_01',
        'CL_LIST_BOUNDARY_BAD_SEARCH_NUMBER_01', 'CL_LIST_BOUNDARY_BAD_SEARCH_NULL_01'] as const) {
        let committed = 0;
        const provider = new ClaudeProvider({ apiGet: async () => claudeListGen(key) });
        await assert.rejects(provider.listConversations({ accountId: account.id, streamId: 'recent',
            onPageCommitted: async () => { committed++; return false; } }), /Invalid Claude paginated list/);
        assert.equal(committed, 0, key);
        assert.deepEqual(await getConversations(account.id), [], key);
    }
    const withoutFlag = new ClaudeProvider({ apiGet: async () => claudeListGen('CL_LIST_BOUNDARY_SEARCH_ABSENT_01') });
    assert.equal(await withoutFlag.listConversations({ accountId: account.id, streamId: 'recent' }), 'source_end');
});

test('Claude provider refuses malformed stored organization and conversation UUIDs before making API calls', async () => {
    const valid = await getOrCreateAccount('claude', '11111111-1111-4111-8111-111111111111');
    const malformed = await getOrCreateAccount('claude', '-'.repeat(36));
    const calls: string[] = [];
    const provider = new ClaudeProvider({ apiGet: async path => {
        calls.push(path);
        throw new Error('Unexpected source read');
    } });
    await assert.rejects(provider.listConversations({ accountId: malformed.id, streamId: 'recent' }), /Claude account mismatch/);
    await assert.rejects(provider.fetchConversationDetail(valid.id, '-'.repeat(36)), /Invalid Claude conversation UUID/);
    assert.deepEqual(calls, []);
});

test('Claude paginated source proves exhaustion and rejects unordered or truncated pages', async () => {
    const account = await getOrCreateAccount('claude', '11111111-1111-4111-8111-111111111111');
    const paths: string[] = [];
    const provider = new ClaudeProvider({ apiGet: async path => {
        paths.push(path);
        return claudeListGen('CL_LIST_BOUNDARY_VALID_01');
    } });
    let head: unknown;
    assert.equal(await provider.listConversations({ accountId: account.id, streamId: 'recent',
        onPageCommitted: async info => { head = info.scanHead; return false; } }), 'source_end');
    assert.equal(paths.length, 1);
    assert.ok(paths[0].endsWith('chat_conversations_v2?limit=100&offset=0&consistency=strong'));
    assert.equal((head as { nextCursor: unknown }).nextCursor, null);
    for (const key of [
        'CL_LIST_BOUNDARY_REVERSED_01',
        'CL_LIST_BOUNDARY_TRUNCATED_01',
        'CL_LIST_BOUNDARY_INCOMPLETE_01',
        'CL_LIST_BOUNDARY_MISSING_FLAG_01',
    ] as const) {
        await assert.rejects(new ClaudeProvider({ apiGet: async () => claudeListGen(key) }).listConversations({
            accountId: account.id, streamId: 'recent' }), /Claude/);
    }
});
