import { OperationError } from '../../../../shared/errors/operationError.js';
import { ConfirmedSourceEmptyError } from '../../sourceErrors.js';
import type { Account } from '../../../../l2/accountRegistry.js';
import { mergeConversationPages } from '../../../parsers/gemini/rpc/mergePages.js';
import type { SourceConversationParseResult } from '../../../parsers/parsingResult.js';
import { getErrorMessage } from '../../../../shared/utils/errorText.js';
import { isDevMode } from '../../../../runtime/devMode.js';
import { normId } from '../../../../shared/utils/pathUtils.js';
import type { ListParseResult } from '../../../parsers/gemini/rpc/parseList.js';
import type { DetailParseResult } from './detailTypes.js';

export interface GeminiListRequestOptions {
    signal?: AbortSignal | null;
    maxRetries?: number;
    _retried?: boolean;
    _retryCount?: number;
    _overrideAt?: string;
    _overrideBl?: string | null;
}
export interface GeminiDetailRequestOptions extends Omit<GeminiListRequestOptions, '_retried'> {
    account?: Account;
    _retriedXsrf?: boolean;
    detailOnly?: boolean;
    altParams?: boolean;
}
// Gemini LIST RPC accepts only the known Recent/Pinned stream selector tuple.
export type GeminiListFilter = readonly [0 | 1, null, 1];

export interface GeminiPaginationListClient {
    getConversationList(pageToken?: string | null, targetSid?: string | null,
        customFilter?: GeminiListFilter, opts?: GeminiListRequestOptions): Promise<ListParseResult>;
}
export interface GeminiPaginationDetailClient {
    fetchConversationPage(conversationId: string, pageToken?: string | null,
        targetSid?: string | null, opts?: GeminiDetailRequestOptions): Promise<DetailParseResult>;
}
export interface PaginatedDetailResult extends SourceConversationParseResult {
    transport: DetailParseResult['transport'];
}
interface GeminiClientPaginationModule { getConversationDetail: typeof getConversationDetail }

// Match the list-sync runaway budget; ordinary long histories follow tokens to source end.
const MAX_DETAIL_PAGES = 2000;

/** Empty messages are trustworthy only when the native Detail body explicitly contains empty turns. */
function isExplicitlyEmptyDetail(page: DetailParseResult): boolean {
    return page.conversation.detail.messages.length === 0 && !page.transport.nextPageToken
        && page.transport.bodyShape === 'empty_turn_array'
        && !page.diagnostics.some(diagnostic => diagnostic.code === 'GEMINI_SCHEMA_DRIFT'
            && diagnostic.message.startsWith('Envelope drift:'));
}

async function getConversationDetail(client: GeminiPaginationDetailClient, conversationId: string, targetSid?: string | null, account?: Account, signal?: AbortSignal): Promise<PaginatedDetailResult> {
    const pages: DetailParseResult[] = [];
    const seenTokens = new Set<string>();
    let token: string | null = null;
    let truncateReason: 'token_loop' | 'max_turns_page_limit_2000' | undefined;
    do {
        signal?.throwIfAborted();
        const page = await client.fetchConversationPage(conversationId, token, targetSid, { account, signal });
        pages.push(page);
        token = page.transport.nextPageToken;
        if (token && seenTokens.has(token)) { truncateReason = 'token_loop'; break; }
        if (token) seenTokens.add(token);
    } while (token && pages.length < MAX_DETAIL_PAGES);
    if (token && !truncateReason) truncateReason = 'max_turns_page_limit_2000';
    let first = pages[0];
    if (!first) throw new Error('no data');
    const metadataOnly = !pages.some(page => page.conversation.detail.messages.length)
        && first.transport.bodyShape === 'metadata_only';
    if (metadataOnly) {
        try {
            signal?.throwIfAborted();
            const retry = await client.fetchConversationPage(conversationId, null, targetSid, { detailOnly: true, altParams: true, account, signal });
            if (retry.conversation.detail.messages.length || isExplicitlyEmptyDetail(retry)) {
                // The retry replaces the original metadata-only source, including its transport evidence.
                pages.splice(0, pages.length, retry);
                first = retry;
                seenTokens.clear();
                truncateReason = undefined;
                token = retry.transport.nextPageToken;
                while (token && pages.length < MAX_DETAIL_PAGES) {
                    if (seenTokens.has(token)) { truncateReason = 'token_loop'; break; }
                    seenTokens.add(token);
                    signal?.throwIfAborted();
                    const next = await client.fetchConversationPage(conversationId, token, targetSid, { detailOnly: true, altParams: true, account, signal });
                    pages.push(next);
                    token = next.transport.nextPageToken;
                }
                if (token && !truncateReason) truncateReason = 'max_turns_page_limit_2000';
            }
        } catch (error: unknown) {
            signal?.throwIfAborted();
            if (error instanceof Error && error.name === 'ConfirmedGeminiConversationNotFound'
                || pages.some(page => page.conversation.detail.messages.length)) throw error;
            if (isDevMode()) console.warn('[Gemini Exporter Client] metadata-only retry failed:', getErrorMessage(error));
        }
    }
    const expectedId = normId(conversationId);
    if (pages.some(page => page.conversationId !== expectedId)) throw new OperationError('SOURCE_RESPONSE_INVALID', 'Detail response identity mismatch');
    const hasMessages = pages.some(page => page.conversation.detail.messages.length > 0);
    // An explicitly empty Detail turn array is different from a metadata-only or
    // unrecognized response. Without positive source evidence, do not admit an
    // empty body to L2 as though Gemini had returned the conversation.
    const explicitlyEmpty = pages.length === 1 && !token && !truncateReason && isExplicitlyEmptyDetail(first);
    if (!hasMessages && !explicitlyEmpty) {
        if (pages.length === 1 && !token && !truncateReason
            && first.transport.bodyShape === 'confirmed_empty_turns'
            && !first.conversation.detail.assets.length && !first.evidence?.rejectedTurns
            && !first.diagnostics.some(d => d.code === 'GEMINI_SCHEMA_DRIFT')) {
            throw new ConfirmedSourceEmptyError();
        }
        throw new OperationError('SOURCE_RESPONSE_INVALID', 'GEMINI_DETAIL_EMPTY_UNVERIFIED: Detail returned no verifiable messages');
    }
    const result = mergeConversationPages(pages, truncateReason, !token && hasMessages);
    return { ...result, transport: { ...first.transport, nextPageToken: token } };
}

export { getConversationDetail };
const GeminiClientPagination: GeminiClientPaginationModule = { getConversationDetail };
export default GeminiClientPagination;
