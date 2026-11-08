import { extractAttachmentInlineBytes } from '../../../resources/attachmentBytes.js';
import { copyDefinedField, type ResourceEvidence } from './resourceEvidence.js';
import { normalizeTimestamp } from '../time.js';
import { sameGenerationEvent } from './generationEvent.js';

/** Acquisition aliases are resolved here; none of these lists is part of Domain. */
export interface SourceAttachmentInput extends Omit<Partial<ResourceEvidence>, 'generation' | 'createdAt'> {
    generation?: Omit<NonNullable<ResourceEvidence['generation']>, 'time'> & { time?: number | null };
    createdAt?: number | string | null;
    token?: string;
    dataBuffer?: ArrayBuffer | ArrayBufferView | number[];
}
export interface SourceAttachmentLists {
    attachments?: readonly SourceAttachmentInput[];
    images?: readonly SourceAttachmentInput[];
    documents?: readonly SourceAttachmentInput[];
}

const attachmentFields = [
    'url', 'sourceUrl', 'resolvedUrl', 'src', 'localName', 'fileName', 'name', 'title',
    'mimeType', 'mime', 'size', 'width', 'height', 'source', 'subDir', 'isGenerated',
    'providerRequestId', 'imageOrdinal', 'isImage', 'blobBase64', 'dataBase64',
    'id', 'chipUrl', 'contentMarkdown', 'hasFabricatedText',
] as const;

function portableBytes(value: SourceAttachmentInput['dataBuffer']): string | undefined {
    const bytes = value instanceof ArrayBuffer ? new Uint8Array(value)
        : ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
        : Array.isArray(value) ? new Uint8Array(value) : undefined;
    if (!bytes?.length) return undefined;
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 8192) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    }
    return btoa(binary);
}

/** Only semantic metadata survives; parser tokens/evidence and mutable byte views do not. */
function copyAttachment(input: SourceAttachmentInput, defaultType: string): ResourceEvidence {
    const result: ResourceEvidence = { type: input.type || defaultType };
    for (const field of attachmentFields) {
        copyDefinedField(result, input, field, true);
    }
    const createdAt = normalizeTimestamp(input.createdAt);
    if (createdAt !== undefined) result.createdAt = createdAt;
    if (input.generation) {
        const { time: rawTime, ...generation } = input.generation;
        const time = normalizeTimestamp(rawTime);
        result.generation = { ...generation, ...(time !== undefined ? { time } : {}) };
    }
    if (input.sections) result.sections = [...input.sections];
    if (input.links) result.links = input.links.map(link => ({ ...link }));
    if (input.candidates) result.candidates = [...input.candidates];
    // Binary acquisition buffers otherwise turn into empty objects during JSON serialization.
    const encoded = portableBytes(input.dataBuffer);
    if (encoded) result.dataBase64 = encoded;
    if (result.size === undefined) {
        const bytes = extractAttachmentInlineBytes(input);
        if (bytes) result.size = bytes.byteLength;
    }
    return result;
}

export function normalizedResourceReference(ref: string): string {
    if (/^[a-z][a-z\d+.-]*:/i.test(ref)) return ref;
    try { return decodeURIComponent(ref).replace(/^\.\//, '').replace(/^assets\//, ''); }
    catch { return ref.replace(/^\.\//, '').replace(/^assets\//, ''); }
}
/** Raw archive paths are source identities; an authored assets/ prefix is significant. */
export function normalizedSourceReference(ref: string): string {
    if (/^[a-z][a-z\d+.-]*:/i.test(ref)) return ref;
    try { return decodeURIComponent(ref).replace(/^\.\//, ''); }
    catch { return ref.replace(/^\.\//, ''); }
}
function references(input: ResourceEvidence, semanticOnly = false, normalize = normalizedResourceReference): Set<string> {
    return new Set([...(semanticOnly && !/^https?:\/\//i.test(input.localName ?? '') ? [] : [input.localName]), input.url, input.sourceUrl, input.resolvedUrl, input.src, input.chipUrl]
        .filter((ref): ref is string => !!ref)
        .map(normalize));
}
function imageOrdinal(input: ResourceEvidence): number | undefined {
    return input.imageOrdinal ?? input.generation?.imageOrdinal ?? (input.generation?.imageCount === 1 ? 0 : undefined);
}
function requestId(input: ResourceEvidence): string {
    return (input.providerRequestId || input.generation?.providerRequestId || '').toLowerCase().replace(/^r_/, '');
}
function chatId(input: ResourceEvidence): string {
    return (input.generation?.chatId || '').trim().replace(/^c_/, '');
}
function generationConflict(a: ResourceEvidence, b: ResourceEvidence): boolean {
    const ar = requestId(a), br = requestId(b), ac = chatId(a), bc = chatId(b);
    return !!(ar && br && ar !== br) || !!(ac && bc && ac !== bc)
        || (ar !== '' && ar === br && imageOrdinal(a) !== undefined && imageOrdinal(b) !== undefined && imageOrdinal(a) !== imageOrdinal(b))
        || !!(!ar && !br && a.generation && b.generation && ac && bc
            && a.generation.time && b.generation.time && a.generation.prompt && b.generation.prompt
            && !sameGenerationEvent(a.generation, b.generation));
}
function identityConflict(a: ResourceEvidence, b: ResourceEvidence): boolean {
    return generationConflict(a, b)
        || !!(a.type !== 'image' && b.type !== 'image' && a.id && b.id && a.id !== b.id);
}
function sameGeneration(a: ResourceEvidence, b: ResourceEvidence): boolean {
    const request = requestId(a), ordinal = imageOrdinal(a);
    const eventMatch = request && request === requestId(b)
        || (a.generation && b.generation && sameGenerationEvent(a.generation, b.generation));
    return !!eventMatch && ordinal !== undefined && ordinal === imageOrdinal(b) && !generationConflict(a, b);
}
function stableValue(value: ResourceEvidence | string | NonNullable<ResourceEvidence['links']>[number]): string {
    return JSON.stringify(value, (_key, entry: unknown) => {
        if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
            return Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b)));
        }
        return entry;
    });
}
function fingerprint(attachment: ResourceEvidence): string | undefined {
    // A bare kind has no evidence of identity. Identical named records in different
    // source lists can be aliases even when no downloadable source exists.
    if (!attachment.fileName && !attachment.name && !attachment.title && !attachment.contentMarkdown) return undefined;
    const type = ['file', 'doc', 'code'].includes(attachment.type) ? 'file' : attachment.type;
    return stableValue({ ...attachment, type });
}
/** Preserve each collection's element type and the existing occurrence-based merge. */
function mergeValues<T extends string | NonNullable<ResourceEvidence['links']>[number]>(existing: readonly T[] = [], source: readonly T[]): T[] {
    const values = [...existing];
    const counts = new Map<string, number>();
    values.forEach(value => {
        const key = stableValue(value);
        counts.set(key, (counts.get(key) ?? 0) + 1);
    });
    const incoming = new Map<string, number>();
    for (const value of source) {
        const key = stableValue(value), count = (incoming.get(key) ?? 0) + 1;
        incoming.set(key, count);
        if (count > (counts.get(key) ?? 0)) values.push(value);
    }
    return values;
}
function mergeMetadata(target: ResourceEvidence, source: ResourceEvidence, preferGenerated: boolean): void {
    for (const key of ['type', ...attachmentFields, 'createdAt'] as const) copyDefinedField(target, source, key, preferGenerated);
    if (source.isGenerated) target.isGenerated = true;
    if (source.generation) {
        const merged = { ...(target.generation ?? source.generation) };
        // Generation fields fill only absent values; an authored empty prompt is retained.
        for (const key of ['chatId', 'providerRequestId', 'time', 'prompt', 'generationOrdinal', 'imageCount', 'imageOrdinal', 'turnId'] as const) {
            if (merged[key] === undefined) copyDefinedField(merged, source.generation, key, true);
        }
        target.generation = merged;
    }
    if (source.sections) target.sections = mergeValues(target.sections, source.sections);
    if (source.links) target.links = mergeValues(target.links, source.links);
    if (source.candidates) target.candidates = mergeValues(target.candidates, source.candidates);
}

interface ResolvedAttachment {
    attachment: ResourceEvidence;
    refs: Set<string>;
    lookupRefs: Set<string>;
    tokens: Set<string>;
    documentIds: Set<string>;
    aliases: Map<string, Set<number>>;
    owners: Map<number, number>;
}

/** One message's source resource evidence, kept outside the final Domain model. */
export interface SourceAttachmentGroup {
    input: SourceAttachmentLists;
    bodyAttachments?: readonly SourceAttachmentInput[];
}
interface SourceAttachmentGroupResolution {
    attachments: ResourceEvidence[];
    attachmentIndexes: number[][];
    findReference(ref: string, groupIndex?: number): number | undefined;
    isExportAlias(ref: string, groupIndex: number): boolean;
}

export function resolveSourceAttachmentGroups(groups: readonly SourceAttachmentGroup[], options: { semanticOnly?: boolean; sourceReferences?: boolean } = {}): SourceAttachmentGroupResolution {
    const normalize = options.sourceReferences ? normalizedSourceReference : normalizedResourceReference;
    const resolved: ResolvedAttachment[] = [];
    groups.forEach(({ input, bodyAttachments = [] }, groupIndex) => {
        let occurrence = 0;
        const lists = [input.attachments ?? [], input.images ?? [], input.documents ?? [], bodyAttachments];
        lists.forEach((list, listIndex) => {
            const origin = groupIndex * 4 + listIndex;
            for (const raw of list) {
                const ordinal = occurrence++;
                const attachment = copyAttachment(raw, listIndex === 1 || listIndex === 3 ? 'image' : 'file');
                const refs = references(attachment, options.semanticOnly, normalize);
                const lookupRefs = references(attachment, false, normalize);
                const token = raw.token || undefined;
                const docId = attachment.type !== 'image' && attachment.id ? attachment.id : undefined;
                const alias = !refs.size && !token && !docId ? fingerprint(options.semanticOnly ? { type: attachment.type, fileName: attachment.fileName || attachment.name || attachment.title, contentMarkdown: attachment.contentMarkdown } : attachment) : undefined;
                const matches = resolved.filter(record => {
                    if (identityConflict(record.attachment, attachment)) return false;
                    const aliasOrigins = alias === undefined ? undefined : record.aliases.get(alias);
                    return [...refs].some(ref => record.refs.has(ref))
                        || (token !== undefined && record.tokens.has(token))
                        || (docId !== undefined && record.documentIds.has(docId))
                        || (!options.sourceReferences && sameGeneration(record.attachment, attachment))
                        || (aliasOrigins !== undefined && !aliasOrigins.has(origin)
                            && [...aliasOrigins].some(value => Math.floor(value / 4) === groupIndex && value !== origin));
                });
                // An untagged alias cannot bridge two explicitly different resources.
                const ambiguous = matches.some((record, index) => matches.slice(index + 1)
                    .some(other => identityConflict(record.attachment, other.attachment)));
                const first = ambiguous ? undefined : matches[0];
                if (!first) {
                    resolved.push({ attachment, refs, lookupRefs, tokens: new Set(token ? [token] : []),
                        documentIds: new Set(docId ? [docId] : []), aliases: new Map(alias ? [[alias, new Set([origin])]] : []), owners: new Map([[groupIndex, ordinal]]) });
                    continue;
                }
                // A record with both a local path and remote URL may bridge two old aliases.
                for (const duplicate of matches.slice(1)) {
                    mergeMetadata(first.attachment, duplicate.attachment, false);
                    duplicate.refs.forEach(ref => first.refs.add(ref));
                    duplicate.lookupRefs.forEach(ref => first.lookupRefs.add(ref));
                    duplicate.tokens.forEach(value => first.tokens.add(value));
                    duplicate.documentIds.forEach(value => first.documentIds.add(value));
                    duplicate.aliases.forEach((origins, key) => {
                        const known = first.aliases.get(key) ?? new Set<number>();
                        origins.forEach(origin => known.add(origin));
                        first.aliases.set(key, known);
                    });
                    duplicate.owners.forEach((order, owner) => first.owners.set(owner, Math.min(order, first.owners.get(owner) ?? order)));
                    resolved.splice(resolved.indexOf(duplicate), 1);
                }
                const resourceMatch = [...refs].some(ref => first.refs.has(ref));
                mergeMetadata(first.attachment, attachment, !resourceMatch && !!token && first.tokens.has(token) && !!attachment.isGenerated && !first.attachment.isGenerated);
                refs.forEach(ref => first.refs.add(ref));
                lookupRefs.forEach(ref => first.lookupRefs.add(ref));
                if (token) first.tokens.add(token);
                if (docId) first.documentIds.add(docId);
                first.owners.set(groupIndex, Math.min(ordinal, first.owners.get(groupIndex) ?? ordinal));
                if (alias) {
                    const known = first.aliases.get(alias) ?? new Set<number>();
                    known.add(origin);
                    first.aliases.set(alias, known);
                }
            }
        });
    });
    const attachmentIndexes = groups.map((_group, groupIndex) => resolved
        .map((record, index) => ({ index, order: record.owners.get(groupIndex) }))
        .filter((entry): entry is { index: number; order: number } => entry.order !== undefined)
        .sort((a, b) => a.order - b.order).map(entry => entry.index));
    const unique = (indexes: number[]): number | undefined => indexes.length === 1 ? indexes[0] : undefined;
    const findReference = (ref: string, groupIndex?: number): number | undefined => {
        const key = normalize(ref);
        const exact = resolved.flatMap((record, index) => record.lookupRefs.has(key) ? [index] : []);
        if (groupIndex !== undefined) {
            const owned = exact.filter(index => resolved[index].owners.has(groupIndex));
            if (owned.length) return unique(owned);
        }
        if (exact.length) return unique(exact);
        if (/^[a-z][a-z\d+.-]*:/i.test(key)) return undefined;
        const base = key.split('/').pop();
        const local = resolved.flatMap((record, index) => groupIndex !== undefined && record.owners.has(groupIndex)
            && [...record.lookupRefs].some(value => !/^[a-z][a-z\d+.-]*:/i.test(value) && value.split('/').pop() === base) ? [index] : []);
        return unique(local);
    };
    const isExportAlias = (ref: string, groupIndex: number): boolean => {
        const key = normalize(ref);
        return !/^[a-z][a-z\d+.-]*:/i.test(key) && resolved.some(record => record.owners.has(groupIndex) && record.lookupRefs.has(key) && !record.refs.has(key));
    };
    return { attachments: resolved.map(record => record.attachment), attachmentIndexes, findReference, isExportAlias };
}
