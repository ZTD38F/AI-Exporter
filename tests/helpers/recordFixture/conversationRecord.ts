/** Historical disk record grammar, accepted only by the legacy-storage parser. */

import type { GeneratedMediaIdentity } from '../historicalConversation.js';
import type { SourceAttachmentInput as ConversationRecordAttachment } from '../../../src/l1/parsers/shared/resources/resolveResources.js';
export type { SourceAttachmentInput as ConversationRecordAttachment } from '../../../src/l1/parsers/shared/resources/resolveResources.js';

export interface ConversationRecordMessage {
    id?: string;
    role?: string;
    model?: unknown;
    author?: { model?: unknown };
    turnId?: string;
    providerRequestId?: string;
    generation?: GeneratedMediaIdentity;
    content?: unknown;
    timestamp?: unknown;
    thoughts?: unknown;
    thinking?: unknown;
    attachments?: ConversationRecordAttachment[];
    images?: ConversationRecordAttachment[];
    documents?: ConversationRecordAttachment[];
    citations?: unknown[];
    sources?: unknown[];
    structuredContent?: unknown;
    groundingCitationMarkers?: unknown[];
}

export interface ConversationRecordTurn {
    messages?: ConversationRecordMessage[];
    timestamp?: unknown;
    userContent?: unknown;
    modelContent?: unknown;
    model?: unknown;
    author?: { model?: unknown };
    thoughts?: unknown;
    attachments?: ConversationRecordAttachment[];
    images?: ConversationRecordAttachment[];
    sources?: unknown[];
    structuredContent?: unknown;
}

export interface ConversationRecordInput {
    source?: string;
    id?: string;
    title?: string;
    titleSource?: unknown;
    titles?: unknown;
    timestamp?: unknown;
    createdAt?: unknown;
    updatedAt?: unknown;
    chatTime?: unknown;
    lastSeen?: unknown;
    url?: string;
    href?: string;
    messages?: ConversationRecordMessage[];
    turns?: ConversationRecordTurn[];
    /** Explicit source coverage, when the producer knows it. Absence means unknown. */
    completeness?: { status: 'complete' | 'partial' | 'unknown'; reason?: string };
    truncated?: boolean;
    isTruncated?: boolean;
    truncateReason?: string;
    /** Acquisition state: used only as evidence of partial coverage, never retained in Domain. */
    nextPageToken?: string | null;
}
