import { isDurableSourceUri } from '../../../../l2/sourceUri.js';
import type { ResourceAcquisitionHint, ResourceAcquisitionHints } from '../../../resources/resourceAcquisition.js';
import type { DomainAsset, DomainAssetKind, DomainMessage, DomainGeneratedMediaIdentity } from '../../../../l2/conversationDetail.js';
import { copyDefinedField, type ResourceEvidence } from './resourceEvidence.js';
import { normalizedSourceReference, normalizedResourceReference, resolveSourceAttachmentGroups, type SourceAttachmentGroup } from './resolveResources.js';
import { mapContentAssetReferences } from '../../../../l2/content/assetReferences.js';

/** Stable semantic identities do not depend on message order or export numbering. */
function resourceId(key: string): string {
    let first = 0x811c9dc5, second = 0x9e3779b9;
    for (let index = 0; index < key.length; index++) {
        first = Math.imul(first ^ key.charCodeAt(index), 0x01000193);
        second = Math.imul(second ^ key.charCodeAt(index), 0x85ebca6b);
    }
    return `resource-${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`;
}
function displayName(record: ResourceEvidence): string | undefined {
    return record.title || record.name || record.fileName;
}
function kindOf(record: ResourceEvidence): DomainAssetKind {
    const mediaType = (record.mimeType || record.mime || '').toLowerCase();
    if (record.type === 'image' || record.isImage || mediaType.startsWith('image/')
        || /\.(png|jpe?g|webp|gif|svg|bmp|avif)$/i.test(displayName(record) ?? '')) return 'image';
    if (mediaType.startsWith('audio/') || record.type === 'audio') return 'audio';
    if (mediaType.startsWith('video/') || record.type === 'video') return 'video';
    return ['file', 'doc', 'code'].includes(record.type) || mediaType ? 'file' : 'other';
}
function identityKey(record: ResourceEvidence, providerId: string, sourceReferences = false): string | undefined {
    const request = (record.providerRequestId || record.generation?.providerRequestId || '').toLowerCase().replace(/^r_/, '');
    const ordinal = record.imageOrdinal ?? record.generation?.imageOrdinal ?? (record.generation?.imageCount === 1 ? 0 : undefined);
    const chat = (record.generation?.chatId ?? '').replace(/^c_/, '');
    const uri = [record.sourceUrl, record.url, record.src, record.resolvedUrl].find(isDurableSourceUri)
        ?? record.resolvedUrl ?? record.sourceUrl ?? record.url ?? record.src
        ?? (/^https?:\/\//i.test(record.localName ?? '') ? record.localName : undefined);
    const location = uri;
    if (sourceReferences && location) return JSON.stringify([providerId, kindOf(record), normalizedSourceReference(location)]);
    if (request) return JSON.stringify([providerId, 'generation', chat, request, ordinal ?? location ?? null]);
    if (record.generation?.time && record.generation.prompt && ordinal !== undefined) {
        return JSON.stringify([providerId, 'generation', chat, Math.floor(record.generation.time / 1000), record.generation.generationOrdinal, record.generation.prompt.trim(), ordinal]);
    }
    if (record.id && kindOf(record) !== 'image') return JSON.stringify([providerId, 'document', record.id]);
    if (location) return JSON.stringify([providerId, kindOf(record), normalizedResourceReference(location)]);
    // No evidence establishes whether two anonymous missing records are one resource.
    return undefined;
}
function toAsset(record: ResourceEvidence, id: string): DomainAsset {
    const kind = kindOf(record);
    const name = displayName(record);
    const uri = [record.sourceUrl, record.url, record.src, record.resolvedUrl,
        /^https?:\/\//i.test(record.localName ?? '') ? record.localName : undefined].find(isDurableSourceUri);
    const mediaType = record.mimeType || record.mime;
    const body = record.contentMarkdown ?? '';
    const additions = [
        ...(record.sections ?? []).filter(section => section.trim() && !body.includes(section.trim())),
        ...(record.links ?? []).filter(link => !body.includes(link.url)).map(link => `[${link.title}](${link.url})`),
    ];
    const contentMarkdown = [body, ...additions].filter(Boolean).join('\n\n');
    const document = {
        ...(record.id !== undefined ? { id: record.id } : {}),
        ...(contentMarkdown ? { contentMarkdown } : {}),
    };
    const generation: DomainGeneratedMediaIdentity = {};
    if (record.generation) {
        for (const field of ['providerRequestId', 'time', 'prompt', 'generationOrdinal', 'imageCount', 'imageOrdinal'] as const)
            copyDefinedField(generation, record.generation, field, true);
    }
    if (!generation.providerRequestId && record.providerRequestId) generation.providerRequestId = record.providerRequestId;
    if (generation.imageOrdinal === undefined && record.imageOrdinal !== undefined) generation.imageOrdinal = record.imageOrdinal;
    return { id, kind, ...(name ? { name } : {}),
        ...(mediaType ? { mediaType } : {}),
        ...(record.size !== undefined ? { byteLength: record.size } : {}),
        ...(uri ? { sourceUri: uri } : {}),
        ...(Object.keys(generation).length ? { generation } : {}),
        ...(Object.keys(document).length ? { document } : {}),
    };
}

function acquisitionHint(record: ResourceEvidence): ResourceAcquisitionHint {
    const fields = ['url', 'sourceUrl', 'resolvedUrl', 'src', 'localName', 'fileName', 'name', 'title',
        'mimeType', 'mime', 'providerRequestId', 'imageOrdinal'] as const;
    const hint: ResourceAcquisitionHint = {
        ...(record.dataBase64 || record.blobBase64 ? { dataBase64: record.dataBase64 || record.blobBase64 } : {}),
        ...(record.candidates ? { candidates: [...record.candidates] } : {}),
        ...(record.generation ? { generation: { ...record.generation } } : {}),
    };
    for (const field of fields) copyDefinedField(hint, record, field, true);
    return hint;
}

/** Close every body/reasoning reference over one conversation resource registry before Domain. */
export function closeDomainResources(providerId: string, messages: DomainMessage[], groups: SourceAttachmentGroup[], options: { sourceReferences?: boolean } = {}): { assets: DomainAsset[]; heuristicDocumentIds: string[]; messages: DomainMessage[]; acquisitionHints: ResourceAcquisitionHints } {
    const normalize = options.sourceReferences ? normalizedSourceReference : normalizedResourceReference;
    const resolved = resolveSourceAttachmentGroups(groups, { semanticOnly: true, ...options });
    const claimedIds = new Set<string>();
    const assets = resolved.attachments.map((record, index) => {
        const key = identityKey(record, providerId, options.sourceReferences);
        const candidate = key ? resourceId(key) : undefined;
        // Conflicting or incomplete evidence must not collapse distinct resources.
        const id = candidate && !claimedIds.has(candidate) ? candidate : resourceId(JSON.stringify([providerId, 'unidentified', index]));
        claimedIds.add(id);
        return toAsset(record, id);
    });
    const acquisitionHints: Record<string, ResourceAcquisitionHint> = {};
    resolved.attachments.forEach((record, index) => { acquisitionHints[assets[index].id] = acquisitionHint(record); });
    const inline = new Map<string, string>();
    const closed = messages.map((message, groupIndex) => {
        const resolve = (ref: string, kind: 'image' | 'file', alt?: string): string => {
            const index = resolved.findReference(ref, groupIndex);
            if (index !== undefined) return assets[index].id;
            const hasSource = !resolved.isExportAlias(ref, groupIndex);
            const key = JSON.stringify([providerId, 'inline', hasSource ? null : groupIndex, normalize(ref)]);
            const known = inline.get(key);
            if (known) return known;
            const id = resourceId(hasSource ? key : JSON.stringify([providerId, 'unidentified-inline', assets.length]));
            if (claimedIds.has(id)) {
                // The input contains conflicting resources with this source; keep the unresolved reference separate.
                const ambiguousId = `resource-${crypto.randomUUID()}`;
                assets.push({ id: ambiguousId, kind, ...(isDurableSourceUri(ref) ? { sourceUri: ref } : {}) });
                acquisitionHints[ambiguousId] = { url: ref };
                inline.set(key, ambiguousId);
                return ambiguousId;
            }
            claimedIds.add(id);
            const name = alt?.trim() || (hasSource && !/^data:/i.test(ref) ? (ref.split('/').pop() ?? '').split('?')[0] : undefined);
            assets.push({ id, kind, ...(name ? { name } : {}), ...(hasSource && isDurableSourceUri(ref) ? { sourceUri: ref } : {}) });
            if (hasSource) acquisitionHints[id] = { url: ref, ...(name ? { fileName: name } : {}) };
            inline.set(key, id);
            return id;
        };
        // Reasoning precedes the body in the existing export presentation.
        const reasoning = message.reasoning && mapContentAssetReferences(message.reasoning, resolve);
        const content = mapContentAssetReferences(message.content, resolve);
        const attachmentIds = resolved.attachmentIndexes[groupIndex].map(index => assets[index].id);
        return { ...message, content, ...(reasoning ? { reasoning } : {}),
            ...(attachmentIds.length || groups[groupIndex].input.attachments ? { attachmentIds } : {}) };
    });
    const heuristicDocumentIds = resolved.attachments.flatMap((record, index) => record.hasFabricatedText ? [assets[index].id] : []);
    return { assets, heuristicDocumentIds, messages: closed, acquisitionHints };
}
