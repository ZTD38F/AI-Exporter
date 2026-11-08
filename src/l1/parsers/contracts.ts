import type { Account } from '../../l2/accountRegistry.js';

/** Every raw parser knows its producer. No filename/source-string heuristics at this boundary. */
export interface ConversationParseContext {
    providerId: string;
    account?: Account;
}

/** Pure source parsers return keyless L2 candidates, never trusted stored Domain. */
export type ConversationParser<Raw, Result extends import('./parsingResult.js').SourceConversationParseResult = import('./parsingResult.js').SourceConversationParseResult> =
    (raw: Raw, context: ConversationParseContext) => Result | Promise<Result>;

/** Transient list source facts; L1 binds these to a Registry UUID before L2 admission. */
export interface ProviderConversationItem { id: string; title?: string; titleSource?: string; createdAt?: number; updatedAt?: number }
