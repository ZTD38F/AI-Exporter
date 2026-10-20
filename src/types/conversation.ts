export type TitleSource =
    | 'rpc'
    | 'dom'
    | 'takeout'
    | 'openai'
    | 'sniff'
    | 'api-detail'
    | 'legacy'
    | 'default';

export interface TitleSources {
    rpc?: string;
    dom?: string;
    takeout?: string;
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
    provider?: string;
    providerMetadata?: unknown;
    assetPointer?: string;
    fileId?: string;
    providerRole?: string;
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

export type AuthorRole = 'user' | 'model' | 'assistant' | 'system';

export interface ChatMessage {
    nodeId?: string;
    parentNodeId?: string | null;
    contentType?: string;
    unparsedContentParts?: number;
    provider?: string;
    providerMetadata?: unknown;
    assetPointer?: string;
    fileId?: string;
    providerRole?: string;
    id?: string;
    role: AuthorRole;
    content: string;
    /** Server-authoritative message time; null when the server provided none (never fabricate Date.now()). */
    timestamp?: number | null;
    turnId?: string;
    providerRequestId?: string;
    generation?: GeneratedMediaIdentity;
    attachments?: Attachment[];
    thoughts?: string | string[];
    thinking?: string;
    citations?: any[];
    images?: Attachment[];
    documents?: any[];
    attachmentCount?: number;
    messageCount?: number;
    sources?: unknown[];
    structuredContent?: unknown;
    groundingCitationMarkers?: string[];
}

export type Message = ChatMessage;

export interface Turn {
    id?: string;
    timestamp?: number | null;
    messages?: ChatMessage[];
    userContent?: string;
    modelContent?: string;
    thoughts?: string | string[];
    attachments?: Attachment[];
    images?: Attachment[];
    sources?: unknown[];
    structuredContent?: unknown;
}

export interface Conversation {
    id: string;
    title: string;
    timestamp: number | null;
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
    attachmentCount?: number;
    messageCount?: number;
    href?: string;
    hasExplicitPrompt?: boolean;
}
