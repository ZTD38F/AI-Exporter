import test from 'node:test';
import assert from 'node:assert/strict';
import type { AIProvider, ProviderListOptions, CommittedListPage, ListEnd } from '../src/l1/client/aiProvider.js';
import type { SourceConversationParseResult } from '../src/l1/parsers/parsingResult.js';
import { GeminiProvider } from '../src/l1/client/gemini/geminiProvider.js';
import { ProviderRegistryClass } from '../src/l1/client/providerRegistry.js';
import { parseGeminiIndexObservation } from '../src/l1/parsers/gemini/parseIndexObservation.js';
import { parseGeminiRpcConversation } from '../src/l1/parsers/gemini/rpc/parseConversation.js';
import { geminiRpcPacket, GEMINI_DETAIL_CAPTURE } from './fixtures/providers/geminiRpcCapture.js';
import { parseGeminiTakeoutArchive } from '../src/l1/parsers/gemini/takeout/parseConversation.js';

type Assert<T extends true> = T;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Contracts = [
    Assert<Equal<ReturnType<AIProvider['listConversations']>, Promise<ListEnd>>>,
    Assert<Equal<ReturnType<AIProvider['fetchConversationDetail']>, Promise<void>>>,
    Assert<Equal<keyof ProviderListOptions, 'accountId' | 'streamId' | 'signal' | 'onPageCommitted' | 'onDiagnostic'>>,
    Assert<Equal<keyof CommittedListPage, 'page' | 'totalObserved' | 'scanHead' | 'indexChanges'>>,
    Assert<'key' extends keyof SourceConversationParseResult['conversation']['index'] ? false : true>,
    Assert<'key' extends keyof SourceConversationParseResult['conversation']['detail'] ? false : true>,
    Assert<GeminiProvider extends AIProvider ? true : false>,
];
const contracts: Contracts = [true, true, true, true, true, true, true];
test('provider contract exposes control results and keyless pure source candidates', () => assert.ok(contracts.every(Boolean)));
test('provider registry accepts the thin neutral API without a Gemini companion', async () => {
    const registry = new ProviderRegistryClass();
    const provider: AIProvider = { id: 'other', name: 'Other', hostPatterns: [], matchesUrl: () => true,
        checkReadiness: async () => ({ ready: true }), listConversations: async () => 'source_end',
        fetchConversationDetail: async () => {}, acquireResource: async () => ({ bytes: Uint8Array.of(1) }) };
    registry.register(provider);
    assert.equal(registry.get('other'), provider);
    assert.equal(await provider.listConversations({ accountId: 'uuid', streamId: 'recent' }), 'source_end');
});
test('Index normalization needs no Registry UUID and uses semantic title sources', () => {
    assert.deepEqual(parseGeminiIndexObservation({ id: 'c_source123', title: 'Source title', titleSource: 'rpc' }, 'rpc-list'),
        { conversationId: 'source123', fields: { title: 'Source title', titleSource: 'provider' } });
    assert.deepEqual(parseGeminiIndexObservation({ id: 'source123' }, 'dom'), { conversationId: 'source123', fields: {} });
});
test('RPC source parsing creates no local Key or Account', () => {
    const wire = geminiRpcPacket('detail').responseBody;
    const parsed = parseGeminiRpcConversation(wire, { providerId: 'gemini' });
    assert.equal(parsed.conversationId, GEMINI_DETAIL_CAPTURE.conversationId);
    assert.equal('account' in parsed, false);
    assert.equal('key' in parsed.conversation.index, false);
    assert.equal('key' in parsed.conversation.detail, false);
    assert.equal(parsed.conversation.detail.savedAt, undefined);
    assert.equal(parsed.conversation.detail.quality.status, 'unknown');
});
test('Takeout pure HTML parser produces the same keyless candidates without ZIP IO', () => {
    const htmlText = '<div class="outer-cell"><a href="https://gemini.google.com/app/source123">Conversation</a><div class="content-cell mdl-cell mdl-cell--6-col mdl-typography--body-1">Prompted Question<br>2026-09-02T12:00:00Z<br><p>Answer</p></div></div>';
    const [parsed] = parseGeminiTakeoutArchive({ htmlText }, { providerId: 'gemini' });
    assert.equal(parsed.conversationId, 'source123');
    assert.equal(parsed.conversation.index.titleSource, 'derived');
    assert.equal('account' in parsed, false);
    assert.equal('key' in parsed.conversation.index, false);
    assert.equal(parsed.conversation.detail.quality.status, 'partial');
});
