import type { DomainConversationIndex } from '../../src/l2/conversationIndex.js';
import type { ListParseResult } from '../../src/l1/parsers/gemini/rpc/parseList.js';

/** Pagination unit tests stub the parser seam; they do not establish source ordering evidence. */
export function listFixture(conversations: (DomainConversationIndex | import('../../src/l1/parsers/gemini/rpc/parseList.js').ConversationListItem)[] = [], nextPageToken: string | null = null): ListParseResult {
    const items = conversations.map(item => "key" in item ? (({ key, ...fields }) => ({ ...fields, id: key.conversationId }))(item) : item);
    return { conversations: items, nextPageToken, pageEvidence: { valid: true, ordered: false,
        keys: items.map(item => ({ id: item.id, time: 0 })) } };
}
