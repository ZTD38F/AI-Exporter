import type { DomainConversationWithDetail } from '../src/l2/conversation.js';
import { validateParserDomain, restoreDomainSnapshot, type TrustedDomain } from '../src/l2/runtimeValidation.js';
function typeContract(domain: DomainConversationWithDetail, raw: unknown): void {
    // @ts-expect-error An ordinary builder cannot manufacture trust.
    const forged: TrustedDomain = domain;
    // @ts-expect-error Raw data must pass recovery, not the typed parser boundary.
    validateParserDomain(raw);
    const parsed: TrustedDomain = validateParserDomain(domain);
    const restored: TrustedDomain = restoreDomainSnapshot(raw);
    const compatible: DomainConversationWithDetail = parsed;
    void [forged, restored, compatible];
}
void typeContract;

import type { GeminiRpcParseResult } from '../src/l1/parsers/gemini/rpc/parseConversation.js';
import type { GeminiTakeoutParseResult } from '../src/l1/parsers/gemini/takeout/parseConversation.js';
function parserOutputs(rpc: GeminiRpcParseResult, takeout: GeminiTakeoutParseResult): void {
    // @ts-expect-error L1 RPC candidates need L2 key binding and validation.
    const trustedRpc: TrustedDomain = rpc.conversation;
    // @ts-expect-error Pure Takeout output is a source candidate, not stored Domain.
    const trustedTakeout: TrustedDomain = takeout.conversation;
    void [trustedRpc, trustedTakeout];
}
void parserOutputs;
