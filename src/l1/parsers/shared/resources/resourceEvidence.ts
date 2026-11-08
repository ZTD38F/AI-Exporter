import type { SourceGeneratedMediaIdentity } from './generationEvent.js';

/** Clean acquisition record before constructing the final Domain resource. */
export interface ResourceEvidence {
    type: string;
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
    generation?: Omit<SourceGeneratedMediaIdentity, 'time'> & { time?: number };
    isImage?: boolean;
    blobBase64?: string;
    dataBase64?: string;
    /** Document metadata belongs to its resource record. */
    id?: string;
    createdAt?: number;
    chipUrl?: string;
    sections?: string[];
    links?: Array<{ title: string; url: string }>;
    contentMarkdown?: string;
    candidates?: string[];
    hasFabricatedText?: boolean;
}

/** Copy a known field without losing the relationship between its key and value. */
export function copyDefinedField<T extends object, K extends keyof T>(target: T, source: Pick<Partial<T>, K>, key: K, overwrite = false): void {
    const value = source[key];
    if (value !== undefined && (overwrite || target[key] === undefined || target[key] === '')) target[key] = value;
}
