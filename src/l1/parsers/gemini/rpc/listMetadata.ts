import type { GeminiResponseEnvelope } from './responseEnvelope.js';
import { GeminiProtocol } from '../../../protocol/gemini/protocol.js';
import { normId, cleanTitle, isRealTitle } from './extractors.js';
import { decodeGeminiListRow } from './parseList.js';
import type { GeminiIndexObservationInput } from '../parseIndexObservation.js';

/** Metadata returned beside detail belongs to the requested conversation, never a nearby row. */
export function findListConversationMetadata(response: GeminiResponseEnvelope, targetId: string): (GeminiIndexObservationInput & { id: string }) | undefined {
    const protocol = GeminiProtocol;
    if (!targetId) return undefined;
    const normalizedTarget = normId(targetId);
    for (const rpc of [protocol.RPCS.LIST, protocol.RPCS.LEGACY_LIST]) {
        const { inner } = response.payload(rpc);
        if (!Array.isArray(inner)) continue;
        const rows: unknown[] = [inner[1], inner[2], inner[0]].find(Array.isArray) ?? [];
        for (const rawRow of rows) {
            const item = decodeGeminiListRow(rawRow);
            if (!item || item.id !== normalizedTarget) continue;
            const title = cleanTitle(item.title);
            const realTitle = isRealTitle(title, normalizedTarget);
            return { id: normalizedTarget, title: realTitle ? title : '',
                titleSource: realTitle ? 'rpc' : 'derived',
                ...(item.updatedAt !== null ? { updatedAt: item.updatedAt } : {}) };
        }
    }
    return undefined;
}

