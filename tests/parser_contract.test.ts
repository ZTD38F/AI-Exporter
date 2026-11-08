import { fixtureAccount } from './helpers/domainFixture.js';
import { listGen as geminiListGen } from './fixtures/providers/gemini.js';
import { detailGen as geminiDetailGen } from './fixtures/providers/geminiDetail.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ListParseResult } from '../src/l1/parsers/gemini/rpc/parseList.js';
import type { DetailParseResult } from '../src/l1/client/gemini/api/detailTypes.js';
import type { GeminiDetailEvidence } from '../src/l1/parsers/gemini/rpc/detailEvidence.js';
import type { DecodedGeminiCandidate } from '../src/l1/parsers/gemini/rpc/extractors.js';
import { decodeCandidateArtifacts } from '../src/l1/parsers/gemini/rpc/candidateArtifacts.js';
import { parseGeminiRpcConversation } from '../src/l1/parsers/gemini/rpc/parseConversation.js';
import type { DomainMessage } from '../src/l2/conversationDetail.js';
import type { ListParseDiagnostics } from '../src/l1/parsers/gemini/rpc/parseList.js';
import { parseList } from '../src/l1/parsers/gemini/rpc/parseList.js';
import { decodeGeminiDetail } from '../src/l1/parsers/gemini/rpc/detailDecoder.js';
import type { GeminiProtocolModule, isConfirmedDeletedError, classifyDetailError } from '../src/l1/protocol/gemini/protocol.js';
import type { ListFailureDiagnostics } from '../src/l1/client/aiProvider.js';
import type { Diagnostic } from '../src/shared/diagnostics/diagnostic.js';

import type { ChatGPTApiConversation, ChatGPTNodeMessage, ChatGPTConversationNode } from '../src/l1/parsers/chatgpt/chatgptTypes.js';

// Compile-time regression: native evidence and application views preserve contracts rather
// than widening media/results/dependencies back to an unchecked escape.
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type OutputContracts = [
    Assert<Equal<Parameters<typeof isConfirmedDeletedError>[0], string>>,
    Assert<Equal<Parameters<typeof classifyDetailError>[0], string>>,
    Assert<Equal<Parameters<GeminiProtocolModule['isConfirmedDeletedError']>[0], string>>,
    Assert<Equal<Parameters<GeminiProtocolModule['classifyDetailError']>[0], string>>,
    Assert<Equal<ChatGPTApiConversation['mapping'], ReadonlyMap<string, ChatGPTConversationNode>>>,
    Assert<Equal<ReturnType<ChatGPTApiConversation['mapping']['get']>, ChatGPTConversationNode | undefined>>,
    Assert<Equal<ChatGPTApiConversation['createdAtMs'], number | undefined>>,
    Assert<Equal<ChatGPTApiConversation['updatedAtMs'], number | undefined>>,
    Assert<Equal<ChatGPTNodeMessage['createdAtMs'], number | undefined>>,
    Assert<Equal<ListParseResult['_raw'], unknown>>,
    Assert<Equal<DetailParseResult['transport']['decodedPayload'], unknown>>,
    Assert<Equal<DetailParseResult['transport']['bodyShape'], 'metadata_only' | 'empty_turn_array' | 'confirmed_empty_turns' | undefined>>,
    Assert<Equal<ListParseResult['_debug'], ListParseDiagnostics | undefined>>,
    Assert<Equal<ListFailureDiagnostics['details'], Diagnostic['details']>>,
    Assert<Equal<DetailParseResult['conversation']['detail']['messages'][number], DomainMessage>>,
    Assert<Equal<ReturnType<typeof parseList>, ListParseResult>>,
    Assert<Equal<ReturnType<typeof parseGeminiRpcConversation>, DetailParseResult>>,
    Assert<Equal<ReturnType<typeof decodeGeminiDetail>, GeminiDetailEvidence>>,
    Assert<Equal<DecodedGeminiCandidate['source'], unknown[]>>,
    Assert<Equal<Parameters<typeof decodeCandidateArtifacts>[0], unknown[]>>,
];
const contracts: OutputContracts = [true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true];
// The tuple already enforces these contracts at TypeScript compile time.
// A runtime .every(Boolean) assertion on literal true values cannot detect a parser bug.
void contracts;

test('cross-provider list errors preserve JSON diagnostics without a Gemini-shaped contract', () => {
    const failure = { providerId: 'claude', streamId: 'recent', page: 2, requestCursor: 'next',
        failure: 'rate_limited', details: { retryAfterMs: 1000, code: 'throttled' } } satisfies ListFailureDiagnostics;
    assert.deepEqual(failure.details, { retryAfterMs: 1000, code: 'throttled' });
});

test('malformed list and detail wire inputs fail closed without creating conversation evidence', () => {
    const previousWarn = console.warn;
    try {
        console.warn = () => {};
        const parsed = parseList(geminiListGen('G_PARSER_CONTRACT_MALFORMED_LIST_01'));
        assert.deepEqual(parsed.conversations, []);
        assert.equal(parsed.nextPageToken, null);
        assert.equal(parsed._debug?.error, 'NO_INNER_STR');
        assert.throws(
            () => parseGeminiRpcConversation(geminiDetailGen('G_PARSER_CONTRACT_MALFORMED_DETAIL_01'), { account: fixtureAccount('gemini'), providerId: 'gemini' }),
            /detail parse fail:/,
        );
    } finally {
        console.warn = previousWarn;
    }
});
