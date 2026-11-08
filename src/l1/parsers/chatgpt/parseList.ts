import type { ProviderConversationItem } from '../contracts.js';
import { chatGPTTimestamp } from './timestamp.js';

interface ChatGPTListParseResult {
    conversations: ProviderConversationItem[];
    total?: number;
    offset?: number;
    limit?: number;
    hasMissingConversations?: boolean;
    nextCursor: string | null;
}

/** Backend list metadata -> Domain; pagination controls remain explicit beside business facts. */
export function parseChatGPTList(page: unknown): ChatGPTListParseResult {
    if (!page || typeof page !== 'object' || Array.isArray(page)) throw new TypeError('Invalid ChatGPT list payload');
    const items = 'items' in page ? page.items : undefined;
    const total = 'total' in page ? page.total : undefined;
    const cursor = 'cursor' in page ? page.cursor : undefined;
    const offset = 'offset' in page ? page.offset : undefined;
    const limit = 'limit' in page ? page.limit : undefined;
    const hasMissingConversations = 'has_missing_conversations' in page ? page.has_missing_conversations : undefined;
    if (!Array.isArray(items)
        || (total != null && (typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0))
        || (cursor != null && typeof cursor !== 'string')
        || (offset != null && (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0))
        || (limit != null && (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit <= 0))
        || (hasMissingConversations !== undefined && typeof hasMissingConversations !== 'boolean')) throw new TypeError('Invalid ChatGPT list page');
    const conversations = items.map((item: unknown) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) throw new TypeError('Invalid ChatGPT list payload');
        const rawId = 'id' in item ? item.id : undefined;
        const rawTitle = 'title' in item ? item.title : undefined;
        if (typeof rawId !== 'string' || !rawId.trim()
            || (rawTitle != null && typeof rawTitle !== 'string')) throw new TypeError('Invalid ChatGPT list item');
        const id = rawId.trim();
        const title = rawTitle?.trim() ?? '';
        const createdAt = chatGPTTimestamp('create_time' in item ? item.create_time : undefined);
        const updatedAt = chatGPTTimestamp('update_time' in item ? item.update_time : undefined);
        return { id, ...(title ? { title, titleSource: 'provider' } : {}),
            ...(createdAt !== undefined ? { createdAt } : {}), ...(updatedAt !== undefined ? { updatedAt } : {}) };
    });
    return { conversations, ...(total != null ? { total } : {}),
        ...(offset != null ? { offset } : {}),
        ...(limit != null ? { limit } : {}),
        ...(hasMissingConversations !== undefined ? { hasMissingConversations } : {}),
        nextCursor: cursor ?? null };
}
