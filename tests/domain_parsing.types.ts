import type { ConversationParser } from '../src/l1/parsers/contracts.js';
import type { SourceConversationParseResult } from '../src/l1/parsers/parsingResult.js';
import type { TrustedDomain } from '../src/l2/runtimeValidation.js';
import { parseGeminiRpcConversation, type GeminiRpcParseResult } from '../src/l1/parsers/gemini/rpc/parseConversation.js';
import { detailGen as geminiDetailGen } from './fixtures/providers/geminiDetail.js';
import { parseGeminiTakeoutConversation, type GeminiTakeoutRaw, type GeminiTakeoutParseResult } from '../src/l1/parsers/gemini/takeout/parseConversation.js';
import { parseGeminiTakeoutZipArchive, type GeminiTakeoutZipRaw } from '../src/l1/imports/takeout/readArchive.js';
// @ts-expect-error The old trusted Parser contract is not a public L1 API.
import type { ConversationParseResult } from '../src/l1/parsers/contracts.js';
// @ts-expect-error The old resource/Domain output is not a public L1 API.
import type { ResourceConversationParseResult } from '../src/l1/parsers/parsingResult.js';

const rawParser: ConversationParser<{ text: string }> = raw => ({ conversationId: 'source',
    conversation: { index: {}, detail: { quality: { status: 'unknown' }, assets: [], messages: [{ role: 'user', content: [{ type: 'paragraph', children: [{ type: 'text', text: raw.text }] }] }] } },
    diagnostics: [], acquisitionHints: {} });
const asyncParser: ConversationParser<{ text: string }> = async (raw, context) => rawParser(raw, context);
const rpcParser: ConversationParser<string, GeminiRpcParseResult> = parseGeminiRpcConversation;
const takeoutParser: ConversationParser<GeminiTakeoutRaw, GeminiTakeoutParseResult> = parseGeminiTakeoutConversation;
// ZIP acquisition returns every source conversation; it is not a single-conversation L1 parser.
const zipArchiveReader: (raw: GeminiTakeoutZipRaw, context: Parameters<typeof parseGeminiTakeoutZipArchive>[1]) => Promise<GeminiTakeoutParseResult[]> = parseGeminiTakeoutZipArchive;
function sourceContract(result: SourceConversationParseResult) {
    // @ts-expect-error Export destinations belong to a delivery task, not the L1 parser result.
    result.resourceHints;
    // @ts-expect-error L1 output has no local Account.
    result.account;
    // @ts-expect-error Local identity binding belongs to L2.
    result.conversation.index.key;
    // @ts-expect-error Detail has no local identity before L2 admission.
    result.conversation.detail.key;
    // @ts-expect-error Unadmitted Parser output is not trusted Domain.
    const trusted: TrustedDomain = result.conversation;
    void trusted;
}
// @ts-expect-error Provider identity is required by the RPC parser.
parseGeminiRpcConversation(geminiDetailGen('G_DETAIL_NATIVE_TRANSPORT_EMPTY_BATCH_01'), {});
// @ts-expect-error RPC expects raw response text, not an object.
parseGeminiRpcConversation({}, { providerId: 'gemini' });
// @ts-expect-error ZIP IO belongs to Import, not the raw Takeout parser.
parseGeminiTakeoutConversation(new Uint8Array(), { providerId: 'gemini' });
void [asyncParser, rpcParser, takeoutParser, zipArchiveReader, sourceContract];
