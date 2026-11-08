import { fixtureAccountFor } from './domainFixture.js';
import type { ResourceAcquisitionHints } from '../../src/l1/resources/resourceAcquisition.js';
import { validateParserDomain } from '../../src/l2/runtimeValidation.js';
import { historicalFixture } from './nativeFixture.js';


import { composeDomainDocument } from '../../src/l3b/compose/composeDomainDocument.js';


/** Exercise the public semantic and resource boundaries independently. */
export async function composeFixture(domain: DomainConversationWithDetail, resourceHints: LegacyResourceHints = {}, sourceVersion?: number, acquisitionHints: ResourceAcquisitionHints = {}) {
    return { document: composeDomainDocument(validateParserDomain(sourceVersion === undefined ? domain : { ...domain, index: { ...domain.index, updatedAt: sourceVersion } }), fixtureAccountFor(validateParserDomain(sourceVersion === undefined ? domain : { ...domain, index: { ...domain.index, updatedAt: sourceVersion } }))), resources: await fixtureBindings(domain, resourceHints, acquisitionHints) };
}

import type { ConversationRecordInput } from './recordFixture/conversationRecord.js';

/** Historical fixture decoding feeds the same native composer and preparation APIs as production. */
export async function parseFixture(raw: ConversationRecordInput) {
    const parsed = historicalFixture(raw, { providerId: 'gemini' });
    const composed = await composeFixture(parsed.conversation, parsed.resourceHints, parsed.sourceVersion, parsed.acquisitionHints);
    return { ...composed, domain: parsed.conversation, sourceVersion: parsed.sourceVersion, diagnostics: [...parsed.diagnostics] };
}

import type { LegacyResourceHints } from './recordFixture/resourceHints.js';
import type { DomainConversationWithDetail } from '../../src/l2/conversation.js';
import { normalizeArchiveResourceName } from '../../src/shared/utils/archivePath.js';
import { extractAttachmentInlineBytes } from '../../src/l1/resources/attachmentBytes.js';
import { createHash } from 'node:crypto';
import type { ResourceBindings } from '../../src/l4/packaging/resourceBindings.js';

/** Resource preparation is a side channel; never replace Domain identities with export identities. */
async function fixtureBindings(conversation: DomainConversationWithDetail, hints: LegacyResourceHints = {}, acquisitionHints: ResourceAcquisitionHints = {}): Promise<ResourceBindings> {
    const bindings: Record<string, string> = {};
    for (const asset of conversation.detail.assets) {
        const path = hints[asset.id]?.archivePath;
        const dataBase64 = acquisitionHints[asset.id]?.dataBase64;
        if (path) {
            bindings[asset.id] = normalizeArchiveResourceName(path);
        } else {
            const inlineBytes = dataBase64
                ? extractAttachmentInlineBytes({ dataBase64 })
                : extractAttachmentInlineBytes({ contentMarkdown: asset.document?.contentMarkdown });
            const uri = [acquisitionHints[asset.id]?.url, acquisitionHints[asset.id]?.sourceUrl, asset.sourceUri]
                .find(value => /^data:/i.test(value ?? ''));
            let bytes = inlineBytes;
            if (!bytes && uri) {
                try {
                    const response = await fetch(uri);
                    if (response.ok) bytes = new Uint8Array(await response.arrayBuffer());
                } catch { /* Unavailable fixture data has no resource binding. */ }
            }
            if (!bytes?.byteLength) continue;
            const mimeType = asset.mediaType ?? uri?.match(/^data:([^;,]+)/i)?.[1] ?? 'application/octet-stream';
            const extensions: Record<string, string> = {
                'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg',
                'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg',
                'image/bmp': 'bmp', 'image/avif': 'avif', 'image/x-icon': 'ico',
                'image/tiff': 'tif', 'image/heic': 'heic', 'image/heif': 'heif',
                'text/plain': 'txt', 'text/html': 'html', 'text/csv': 'csv',
                'application/pdf': 'pdf', 'application/json': 'json', 'application/zip': 'zip',
            };
            const digest = createHash('sha256').update(bytes).digest('hex');
            bindings[asset.id] = `assets/sha256/${digest.slice(0, 2)}/${digest.slice(2, 4)}/${digest}.${extensions[mimeType] ?? 'bin'}`;
        }
    }
    return bindings;
}

/** Renderer fixtures declare available resources; production receipts come from actual writes. */
export async function fixtureResourceResults(domain: DomainConversationWithDetail, hints: LegacyResourceHints = {}, acquisitionHints: ResourceAcquisitionHints = {}) {
    return Object.entries(await fixtureBindings(domain, hints, acquisitionHints)).map(([resourceId, path]) => ({ ok: true as const, resourceId, value: { path } }));
}
