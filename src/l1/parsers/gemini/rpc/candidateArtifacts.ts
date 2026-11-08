import type { GeminiAttachmentEvidence, GeminiDocumentEvidence } from './detailEvidence.js';

function isUnknownArray(value: unknown): value is unknown[] {
    return Array.isArray(value);
}

interface DecodedCandidateArtifacts {
    generatedFiles: GeminiAttachmentEvidence[];
    nativeDocuments: GeminiDocumentEvidence[];
}

/** Interpret candidate[30] once. Packet kinds are exclusive; no flattened
 * metadata may become document prose, and native IDs must belong to this chat. */
export function decodeCandidateArtifacts(candidate: unknown[], conversationId?: string): DecodedCandidateArtifacts {
    const generatedFiles: GeminiAttachmentEvidence[] = [];
    const nativeDocuments: GeminiDocumentEvidence[] = [];

    const rawPackets: unknown = candidate[30];
    if (!isUnknownArray(rawPackets)) return { generatedFiles, nativeDocuments };
    const nativeIdPrefix = conversationId ? `c_${conversationId.replace(/^c_/, '')}_` : null;

    for (const raw of rawPackets) {
        if (!isUnknownArray(raw)) continue;
        const row = raw;
        const kind = row[10];

        if (kind === 26) {
            const id = row[0];
            const name = row[9];
            const sourceMarker = row[2];
            const data = row[32];
            if (typeof id !== 'string' || !id || typeof sourceMarker !== 'string'
                || typeof name !== 'string' || !name || !isUnknownArray(data)
                || data[1] !== 2 || typeof data[2] !== 'string') continue;
            generatedFiles.push({
                type: 'file', id, url: id, name, title: name, fileName: name,
                dataBuffer: new TextEncoder().encode(data[2])
            });
            continue;
        }

        if (!nativeIdPrefix || (kind !== 1 && kind !== 2 && kind !== 3)) continue;
        const id = row[0];
        const title = row[2];
        const body = row[4];
        if (typeof id !== 'string' || !id.startsWith(nativeIdPrefix)
            || typeof title !== 'string' || !title.trim()
            || typeof body !== 'string' || !body.trim()) continue;
        nativeDocuments.push({
            id, title: title.trim(), contentMarkdown: body, type: 'file',
            sections: [], links: [], url: '', chipUrl: ''
        });
    }

    return { generatedFiles, nativeDocuments };
}
