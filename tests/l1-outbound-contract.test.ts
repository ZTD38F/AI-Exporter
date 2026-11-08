import test from 'node:test';
import assert from 'node:assert/strict';
import type { Account } from '../src/l2/accountRegistry.js';
import type { ConversationKey } from '../src/l2/conversationKey.js';
import type { DomainAsset } from '../src/l2/conversationDetail.js';
import type { PageObservation } from '../src/l2/pageObservation.js';
import type { ResourceBytes } from '../src/shared/resources/resourceResult.js';
import type { AIProvider, ProviderListOptions, PageEvidence, CommittedListPage,
    ListEnd, ProviderReadiness } from '../src/l1/client/aiProvider.js';
import type { GeminiProvider } from '../src/l1/client/gemini/geminiProvider.js';
import type { ChatGPTProvider } from '../src/l1/client/chatgpt/chatgptProvider.js';
import type { GeminiNetworkBatchexecutePayload } from '../src/l1/protocol/gemini/events.js';
import type { TakeoutParseResult } from '../src/l1/imports/takeout/importTakeout.js';

type Assert<T extends true> = T;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Takeout = typeof import('../src/l1/imports/takeout/importTakeout.js').importTakeout;
type FrozenPageEvidence = Omit<PageObservation, 'providerId' | 'accountId'>;

type Contract = [
    Assert<Equal<PageEvidence, FrozenPageEvidence>>,
    Assert<Equal<keyof ProviderListOptions, 'accountId' | 'streamId' | 'signal' | 'onPageCommitted' | 'onDiagnostic'>>,
    Assert<Equal<ProviderListOptions['accountId'], Account['id']>>,
    Assert<Equal<ProviderListOptions['onPageCommitted'],
        ((info: CommittedListPage) => Promise<boolean>) | undefined>>,
    Assert<Equal<keyof CommittedListPage, 'page' | 'totalObserved' | 'scanHead' | 'indexChanges'>>,
    Assert<Equal<CommittedListPage['scanHead'], FrozenPageEvidence | undefined>>,
    Assert<Equal<ListEnd, 'source_end' | 'provider_limit' | 'max_pages' | 'stopped'>>,
    Assert<Equal<Parameters<AIProvider['listConversations']>[0], ProviderListOptions>>,
    Assert<Equal<ReturnType<AIProvider['listConversations']>, Promise<ListEnd>>>,
    Assert<Equal<Parameters<AIProvider['checkReadiness']>[0], Account['id']>>,
    Assert<Equal<ReturnType<AIProvider['checkReadiness']>, Promise<ProviderReadiness>>>,
    Assert<Equal<Parameters<AIProvider['fetchConversationDetail']>[0], Account['id']>>,
    Assert<Equal<Parameters<AIProvider['fetchConversationDetail']>[1], ConversationKey['conversationId']>>,
    Assert<Equal<ReturnType<AIProvider['fetchConversationDetail']>, Promise<void>>>,
    Assert<Equal<Parameters<AIProvider['acquireResource']>[0], ConversationKey>>,
    Assert<Equal<Parameters<AIProvider['acquireResource']>[1], DomainAsset>>,
    Assert<Equal<ReturnType<AIProvider['acquireResource']>, Promise<ResourceBytes>>>,
    Assert<Equal<keyof GeminiNetworkBatchexecutePayload,
        'text' | 'url' | 'slot' | 'requestedAt' | 'truncated' | 'requestAccountObservation' | 'listRequest' | 'detailRequest'>>,
    Assert<Equal<GeminiNetworkBatchexecutePayload['detailRequest'],
        { conversationId: ConversationKey['conversationId']; requestCursor: string | null } | undefined>>,
    Assert<Equal<Parameters<Takeout>[0], File>>,
    Assert<Equal<Parameters<Takeout>[1], Account['id']>>,
    Assert<Equal<ReturnType<Takeout>, Promise<TakeoutParseResult>>>,
    Assert<Equal<TakeoutParseResult, { imported: number; status: 'ok' | 'partial' }>>,
];
const verified: Contract = [
    true, true, true, true, true, true, true, true,
    true, true, true, true, true, true, true, true,
    true, true, true, true, true, true, true,
];

type ConcreteClientContract = [
    Assert<Equal<Parameters<GeminiProvider['checkReadiness']>[0], Account['id']>>,
    Assert<Equal<Parameters<GeminiProvider['fetchConversationDetail']>[1], ConversationKey['conversationId']>>,
    Assert<Equal<Parameters<ChatGPTProvider['checkReadiness']>[0], Account['id']>>,
    Assert<Equal<Parameters<ChatGPTProvider['fetchConversationDetail']>[1], ConversationKey['conversationId']>>,
];
const concreteVerified: ConcreteClientContract = [true, true, true, true];

test('L1 exposed Client, Sniffer and Takeout types match frozen public contracts', () => {
    assert.equal(verified.length, 23);
    assert.ok(verified.every(Boolean) && concreteVerified.every(Boolean));
});
