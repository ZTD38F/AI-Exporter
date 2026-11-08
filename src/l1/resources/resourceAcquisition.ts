import type { DomainGeneratedMediaIdentity } from '../../l2/conversationDetail.js';

/** Acquisition context carried beside Domain/AST, never conversation semantics or delivery state. */
export interface ResourceAcquisitionHint {
    /** Transient inline acquisition input. Decoded bytes belong to the current task resource context. */
    dataBase64?: string;
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
    candidates?: string[];
    providerRequestId?: string;
    imageOrdinal?: number;
    generation?: Partial<DomainGeneratedMediaIdentity>;
}

/** Domain asset identity, rather than a URL or export destination, owns acquisition. */
export type ResourceAcquisitionHints = Readonly<Record<string, ResourceAcquisitionHint>>;

/** Every runtime acquisition is owned by a Domain asset, never identified by URL alone. */
export interface ResourceRequest extends ResourceAcquisitionHint { assetId: string }
