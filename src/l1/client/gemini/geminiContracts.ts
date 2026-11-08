import type { Account } from '../../../l2/accountRegistry.js';
import type { AIProvider } from '../aiProvider.js';
import type { PaginatedDetailResult, GeminiPaginationListClient } from './api/pagination.js';
/** The two client operations this adapter actually calls; also permits typed DI. */
export interface GeminiProviderClient {
    getConversationList: GeminiPaginationListClient['getConversationList'];
    getConversationDetail(conversationId: string, targetSid?: string | null, account?: Account, signal?: AbortSignal): Promise<PaginatedDetailResult>;
}
export interface GeminiProviderContract extends AIProvider {}
