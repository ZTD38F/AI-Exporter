import type { DomainConversation } from '../src/l2/conversation.js';
import { readConversation } from '../src/l2/readConversation.js';

/** Compile-time L2 repository contract: Index owns catalog facts, Detail owns body facts. */
function contract(conversation: DomainConversation, key: Parameters<typeof readConversation>[0]) {
    const title: string | undefined = conversation.index.title;
    // @ts-expect-error Metadata is owned by the Index, not by optional Detail.
    const duplicateTitle = conversation.detail?.title;
    // Captured source version is a Detail fact, distinct from Index activity.
    const savedAt: number | undefined = conversation.detail?.savedAt;
    // @ts-expect-error Index activity cannot be read as Detail metadata.
    const updatedAt = conversation.detail?.updatedAt;
    // @ts-expect-error ConversationKey is account UUID + conversation ID, never a UI slot.
    key.accountSlot = 'u1';
    void [title, duplicateTitle, savedAt, updatedAt];
}
void contract;
