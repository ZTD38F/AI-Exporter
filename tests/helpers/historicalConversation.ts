/** Historical fixture grammar, never an application index. */
import type { TitleSource } from '../../src/l2/titleAuthority.js';
export type { TitleSource };
export interface TitleSources {
    rpc?: string;
    dom?: string;
    takeout?: string;
    openai?: string;
    sniff?: string;
    'api-detail'?: string;
    legacy?: string;
    [key: string]: string | undefined;
}

export type AttachmentType = 'image' | 'file' | 'doc' | 'grounding' | 'code';

export interface GeneratedMediaIdentity {
    chatId: string;
    providerRequestId?: string;
    time?: number | null;
    prompt?: string;
    generationOrdinal: number;
    imageCount?: number;
    /** Present only when the source establishes a stable ordinal (single image => 0). */
    imageOrdinal?: number;
    turnId?: string;
}

export interface Attachment {
    /** Runtime resource identity used to acquire durable Domain bytes. */
    assetId?: string;
    type: AttachmentType | string;
    url?: string;
    sourceUrl?: string;
    resolvedUrl?: string;
    src?: string;
    localName?: string;
    fileName?: string;
    name?: string;
    title?: string;
    mimeType?: string;
    mime?: string;
    size?: number;
    width?: number;
    height?: number;
    source?: string;
    subDir?: string;
    isGenerated?: boolean;
    providerRequestId?: string;
    imageOrdinal?: number;
    generation?: GeneratedMediaIdentity;
    isImage?: boolean;
    dataBuffer?: ArrayBuffer | ArrayBufferView;
    blobBase64?: string;
    dataBase64?: string;
}

/** Normalized citation emitted by a conversation producer. Raw source payloads remain unknown. */
export interface MessageCitation {
    url: string;
    title?: string;
}

interface DocumentLink {
    title: string;
    url: string;
}

/** Shared report/file metadata; parser-only required fields belong to ParserDocument. */
export interface MessageDocument extends Attachment {
    id?: string;
    createdAt?: number | null;
    chipUrl?: string;
    sections?: string[];
    links?: DocumentLink[];
    contentMarkdown?: string;
    candidates?: string[];
    hasFabricatedText?: boolean;
}

export type AuthorRole = 'user' | 'model' | 'assistant' | 'system';

export interface ChatMessage {
    id?: string;
    role: AuthorRole;
    model?: string;
    author?: { model?: string };
    content: string;
    /** Server-authoritative message time; null when the server provided none (never fabricate Date.now()). */
    timestamp?: number | null;
    turnId?: string;
    providerRequestId?: string;
    generation?: GeneratedMediaIdentity;
    attachments?: Attachment[];
    thoughts?: string | string[];
    thinking?: string;
    citations?: MessageCitation[];
    images?: Attachment[];
    documents?: MessageDocument[];
    attachmentCount?: number;
    messageCount?: number;
    sources?: unknown[];
    structuredContent?: unknown;
    groundingCitationMarkers?: string[];
}

export interface Turn {
    id?: string;
    timestamp?: number | null;
    messages?: ChatMessage[];
    userContent?: string;
    modelContent?: string;
    model?: string;
    author?: { model?: string };
    thoughts?: string | string[];
    attachments?: Attachment[];
    images?: Attachment[];
    sources?: unknown[];
    structuredContent?: unknown;
}


export interface HistoricalConversation {
    id: string;
    title: string;
    timestamp: number | null;
    updatedAt?: number | string | null;
    createdAt?: number | string | null;
    chatTime?: number | string;
    lastSeen?: number | string;
    source?: string;
    titleSource?: TitleSource | string;
    titles?: TitleSources;
    messages?: ChatMessage[];
    turns?: Turn[];
    accountSlot?: string;
    isTakeoutOnly?: boolean;
    cloudAvailability?: 'deleted' | 'unlisted';
    hitGoogleLimit?: boolean;
    url?: string;
    attachmentCount?: number;
    messageCount?: number;
    href?: string;
    sidebarIndex?: number;
    hasExplicitPrompt?: boolean;
}
