import type { GeminiSourceAttribution } from './sourceAttributions.js';
import type { ImageAttachment, DocLink } from './sourceAttachments.js';
import type { Citation, TitleResult } from './extractors.js';
import type { GeminiStructuredDocument, GeminiStructuredExtraction } from './structuredContent.js';
import type { SourceGeneratedMediaIdentity } from '../../shared/resources/generationEvent.js';
import type { classifyDetailBody } from './emptyDetail.js';

/** Source extraction evidence, not the persisted Conversation/Message contract. */
export interface GeminiAttachmentEvidence {
    type: string;
    id?: string;
    fileName?: string;
    dataBuffer?: Uint8Array;
    src?: string;
    name?: string;
    title?: string;
    url?: string;
    contentMarkdown?: string;
    alt?: string;
    isBlob?: boolean;
    isImage?: boolean;
    originalUrl?: string;
    token?: string;
    providerRequestId?: string;
    imageOrdinal?: number;
    isGenerated?: boolean;
    generation?: Omit<SourceGeneratedMediaIdentity, 'time'> & { time?: number };
}

export interface GeminiDocumentEvidence {
    id: string;
    title: string;
    createdAt?: number | null;
    chipUrl: string;
    sections: string[];
    links: DocLink[];
    contentMarkdown?: string;
    url: string;
    candidates?: string[];
    type: string;
    hasFabricatedText?: boolean;
}

export interface GeminiMessageEvidence {
    id: string;
    role: 'user' | 'model';
    timestamp: number | null;
    content: string;
    model?: string;
    providerRequestId?: string;
    /** Source-authored token, kept separately from the historical normalized lookup key. */
    rawProviderRequestId?: string;
    turnId?: string;
    thoughts?: string;
    citations?: Citation[];
    sourceAttributions?: GeminiSourceAttribution[];
    images?: Array<ImageAttachment & { type: string; isImage?: boolean; generation?: SourceGeneratedMediaIdentity }>;
    documents?: GeminiDocumentEvidence[];
    attachments?: GeminiAttachmentEvidence[];
    attachmentCount: number;
    messageCount: number;
    /** Unfiltered body-local images, decoded with the response image evidence. */
    structuredImages: ImageAttachment[];
    structuredContent?: GeminiStructuredDocument;
    structuredExtraction?: GeminiStructuredExtraction;
    groundingCitationMarkers?: string[];
}

export interface GeminiDetailDebugEvidence {
    turnsLen?: number;
    innerKeys?: string[] | null;
    innerPreview?: string;
    topPreview?: string | null;
    schemaDriftWarnings?: string[];
}

/** Decoder-local source facts and transport evidence for native Domain parsing. */
export interface GeminiDetailEvidence {
    id: string;
    title: string;
    titleSource: TitleResult['source'];
    messages: GeminiMessageEvidence[];
    metadataConversation?: { id: string; title: string };
    updatedAt: number | null;
    url: string;
    nextPageToken: string | null;
    attachmentCount: number;
    schemaDrift?: string[];
    /** Elements discarded because no request/conversation or candidate identity can be decoded. */
    turnsRejected?: number;
    /** Decodable turns recovered despite a failed structural recognizer. */
    turnsRecovered?: number;
    bodyShape?: ReturnType<typeof classifyDetailBody>;
    /** Opaque replay evidence for offline differential audits, never acquisition decisions. */
    _raw?: unknown;
    _debug?: GeminiDetailDebugEvidence | null;
}
