import type { DomainConversationDetail } from './conversationDetail.js';
import type { DomainConversationIndex } from './conversationIndex.js';

/** Body facts only. Metadata in a conversation is owned exclusively by its index. */
export type DomainConversationBody = DomainConversationDetail;

/** A catalogued conversation can exist before a body has been acquired. */
export interface DomainConversation {
    index: DomainConversationIndex;
    /** Absent means no saved body, not an empty or failed acquisition. */
    detail?: DomainConversationBody;
}

/** Parser/acquisition results have a body, including an explicitly empty one. */
export interface DomainConversationWithDetail extends DomainConversation {
    detail: DomainConversationDetail;
}
