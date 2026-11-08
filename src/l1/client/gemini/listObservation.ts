import type { PageObservation } from '../../../l2/pageObservation.js';
import type { ListParseResult } from '../../parsers/gemini/rpc/parseList.js';
import type { GeminiListRequestContext } from '../../parsers/gemini/rpc/request.js';

export function geminiListObservation(result: ListParseResult, request: GeminiListRequestContext | null,
    accountId: string | null, truncated = false, requestedAt = 0): PageObservation {
    const { keys, valid: parsedValid, ordered } = result.pageEvidence;
    const providerLimit = !truncated && request?.streamId === 'recent' && request.requestCursor !== null
        && result.failure === 'hit_google_limit' && result.conversations.length === 0;
    const valid = !truncated && (providerLimit || parsedValid && !result.failure);
    const page: PageObservation = { providerId: 'gemini', accountId, streamId: request?.streamId ?? 'unknown',
        requestCursor: request?.requestCursor ?? null, nextCursor: result.nextPageToken,
        requestedAt, requestKnown: request !== null, valid,
        ordered: valid && request?.streamId === 'recent' && (providerLimit || ordered), keys };
    if (providerLimit) page.terminal = 'provider_limit';
    return page;
}
