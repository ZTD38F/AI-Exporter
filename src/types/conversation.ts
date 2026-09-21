/**
 * src/types/conversation.ts
 * Single source of truth for Conversation, Turn, Attachment, and Title data models.
 */

export type TitleSource =
    | 'sniff'
    | 'dom'
    | 'user-edit'
    | 'takeout'
    | 'api-detail'
    | 'api-list'
    | 'url';

export interface TitleSources {
    sniff?: string;
    dom?: string;
    'user-edit'?: string;
    takeout?: string;
    'api-detail'?: string;
    'api-list'?: string;
    url?: string;
    [key: string]: string | undefined;
}

export type AttachmentType = 'image' | 'file' | 'doc' | 'grounding' | 'code';

export interface Attachment {
    type: AttachmentType | string;
    url?: string;
    sourceUrl?: string;
    resolvedUrl?: string;
    src?: string;
    localName?: string;
    fileName?: string;
    title?: string;
    mimeType?: string;
    mime?: string;
    size?: number;
    width?: number;
    height?: number;
    dataBuffer?: ArrayBuffer | ArrayBufferView;
    blobBase64?: string;
    dataBase64?: string;
    [key: string]: any;
}

export interface ThoughtBlock {
    text: string;
    timestamp?: number;
}

export interface CitationSource {
    title?: string;
    url?: string;
    snippet?: string;
    [key: string]: any;
}

export type AuthorRole = 'user' | 'model' | 'assistant' | 'system';

export interface ChatMessage {
    role: AuthorRole;
    content: string;
    timestamp?: number;
    turnId?: string;
    attachments?: Attachment[];
    thoughts?: string[];
    sources?: CitationSource[];
    [key: string]: any;
}

export type Message = ChatMessage;


export interface Turn {
    id?: string;
    timestamp?: number; // In milliseconds
    messages?: ChatMessage[];
    userContent?: string;
    modelContent?: string;
    thoughts?: string[];
    attachments?: Attachment[];
    sources?: CitationSource[];
    [key: string]: any;
}

export interface Conversation {
    id: string;
    title: string;
    /**
     * Normalized timestamp in milliseconds (SSoT).
     */
    timestamp: number;
    updatedAt?: number | string;
    createdAt?: number | string;
    chatTime?: number | string;
    lastSeen?: number | string;
    source?: string;
    titleSource?: TitleSource | string;
    titles?: TitleSources;
    messages?: ChatMessage[];
    turns?: Turn[];
    accountSlot?: string;
    isTakeoutOnly?: boolean;
    hitGoogleLimit?: boolean;
    url?: string;
    [key: string]: any;
}
