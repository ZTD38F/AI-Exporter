import type { Asset } from './assets.js';
import type { BlockNode } from './blocks.js';
import type { Citation } from './citations.js';

export interface ConversationKey {
    providerId: string;
    accountId: string;
    conversationId: string;
}

export type MessageRole =
    | 'user'
    | 'assistant'
    | 'system'
    | 'developer'
    | 'unknown';

export interface MessageAuthor {
    name?: string;
    model?: string;
    rawRole?: string;
}

export interface MessageNode {
    id: string;

    role: MessageRole;
    author?: MessageAuthor;
    createdAt?: string;

    blocks: BlockNode[];
    citationIds?: string[];

}

export interface Conversation {
    key: ConversationKey;
    title?: string;
    url?: string;

    createdAt?: string;
    updatedAt?: string;

    /** The array order is the authoritative message order. */
    messages: MessageNode[];

}

export interface CanonicalConversationBundle {
    schemaVersion: 1;
    conversation: Conversation;
    assets: Asset[];
    citations: Citation[];
}
