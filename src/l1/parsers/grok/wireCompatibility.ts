import { grokObject, grokUuid } from './source.js';

export type GrokWireResponse = Record<string, unknown> & { responseId: string; message: string };

/** Bridge current Grok asset metadata to Loominary's existing attachment schema. */
export function compatibleGrokBodies(payload: { responses: GrokWireResponse[] }, warn: (code: string, message: string) => void) {
    return { ...payload, responses: payload.responses.map((value): GrokWireResponse => {
        const row = structuredClone(value);
        const images: Record<string, unknown>[] = [], files: Record<string, unknown>[] = [];
        const seen = new Set<string>(), resolvedIds = new Set<string>();
        const assetUrl = (value: unknown): string | undefined => {
            if (typeof value !== 'string' || !value || grokUuid(value)) return undefined;
            try {
                const url = new URL(value, 'https://assets.grok.com/');
                return url.protocol === 'https:' && !url.username && !url.password ? url.href : undefined;
            } catch { return undefined; }
        };
        const image = (entry: Record<string, unknown>) => {
            const url = assetUrl(entry.url);
            if (!url || seen.has(url)) return;
            seen.add(url); images.push({ ...entry, url });
        };
        for (const value of Array.isArray(row.imageAttachments) ? row.imageAttachments : []) {
            if (typeof value === 'string') { const url = assetUrl(value); if (url) image({ url }); }
            else image(grokObject(value));
        }
        for (const value of Array.isArray(row.generatedImageUrls) ? row.generatedImageUrls : []) {
            const url = assetUrl(value); if (url) image({ url });
            else warn('grok.image.invalid', 'Invalid generated image locator');
        }
        for (const value of Array.isArray(row.cardAttachmentsJson) ? row.cardAttachmentsJson : []) {
            try {
                const card = grokObject(typeof value === 'string' ? JSON.parse(value) : value);
                if (card.cardType === 'citation_card') continue; // Upstream resolves these.
                if (card.cardType !== 'generated_image_card' || !card.image_chunk) {
                    warn('grok.card.unsupported', 'Unsupported Grok card'); continue;
                }
                const chunk = grokObject(card.image_chunk), url = assetUrl(chunk.imageUrl);
                if (!url || chunk.progress !== 100 || chunk.moderated === true) {
                    warn('grok.image.incomplete', 'Grok generated image is incomplete or unavailable'); continue;
                }
                const generation = { ...(typeof chunk.imageUuid === 'string' ? { providerRequestId: chunk.imageUuid } : {}),
                    ...(typeof card.prompt === 'string' ? { prompt: card.prompt } : {}),
                    ...(typeof chunk.imageIndex === 'number' && Number.isFinite(chunk.imageIndex) ? { imageOrdinal: chunk.imageIndex } : {}) };
                image({ url, fileName: chunk.imageTitle || 'generated-image', mimeType: chunk.mimeType, generation });
                if (generation.providerRequestId !== undefined) resolvedIds.add(generation.providerRequestId);
                // Source names the image model separately from the chat orchestrator.
                if (typeof chunk.imageModel === 'string' && row.message.replace(/<grok:render[^]*?<\/grok:render>/g, '').trim() === '') row.model = chunk.imageModel;
            } catch { warn('grok.card.invalid', 'Malformed Grok card'); }
        }
        // Asset records carry downloadable keys; legacy metadata can contain only UUIDs.
        const metadata = [...(Array.isArray(row.fileAttachmentAssetMetadata) ? row.fileAttachmentAssetMetadata : []),
            ...(Array.isArray(row.fileAttachmentsMetadata) ? row.fileAttachmentsMetadata : [])];
        for (const value of metadata) {
            const file = grokObject(value), id = file.fileMetadataId ?? file.assetId;
            const url = assetUrl(file.fileUri || file.key);
            const mime = typeof file.fileMimeType === 'string' && file.fileMimeType
                ? file.fileMimeType
                : typeof file.mimeType === 'string' ? file.mimeType : undefined;
            if (typeof id === 'string' && resolvedIds.has(id)) continue;
            if (!url || file.isDeleted === true) { warn('grok.file.unavailable', 'Grok file has no available source'); continue; }
            if (typeof id === 'string') resolvedIds.add(id);
            const mapped = { url, fileName: file.fileName || file.name, mimeType: mime, size: file.sizeBytes };
            if (mime?.startsWith('image/')) image(mapped);
            else if (!seen.has(url)) { seen.add(url); files.push(mapped); }
        }
        for (const value of Array.isArray(row.fileAttachments) ? row.fileAttachments : []) {
            if (typeof value === 'string') {
                if (!resolvedIds.has(value)) warn('grok.file.unresolved', 'Grok file identity has no downloadable metadata');
            } else {
                const file = grokObject(value);
                files.push({ ...file, mimeType: typeof file.mimeType === 'string' ? file.mimeType : undefined });
            }
        }
        for (const key of ['fileUris', 'fileIds']) for (const id of Array.isArray(row[key]) ? row[key] : []) {
            if (grokUuid(id) && !resolvedIds.has(id)) warn('grok.file.unresolved', 'Grok file identity has no downloadable metadata');
        }
        // Native metadata is preferable to DOM enrichment of the same image.
        const captured = (Array.isArray(row.capturedImages) ? row.capturedImages : []).filter(value => {
            const uri = grokObject(value).original_src;
            if (typeof uri !== 'string') return true;
            if (seen.has(uri)) return false;
            seen.add(uri);
            return true;
        });
        return { ...row, imageAttachments: images, fileAttachments: files, capturedImages: captured };
    }) };
}
