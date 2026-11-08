import type { GeminiRequestContext } from './request.js';
import { geminiResponse, type GeminiResponseEnvelope } from './responseEnvelope.js';
import { GeminiProtocol } from '../../../protocol/gemini/protocol.js';

/** The Detail RPC itself must contain the Gemini 1167 business error; a LIST error in the
 * same batchexecute envelope is not evidence that the target conversation disappeared. */
export function isConfirmedGeminiDetailNotFound(responseText: string | GeminiResponseEnvelope): boolean {
    const top = geminiResponse(responseText).rows(GeminiProtocol.RPCS.DETAIL);
    return top.some(row => GeminiProtocol.isConfirmedDeletedError(JSON.stringify(row[5] ?? null), 200));
}

/** Only a request-bound DELETE RPC with a matching positive response may delete local facts. */
export function parseConfirmedGeminiDeletion(request: GeminiRequestContext, responseText: string | GeminiResponseEnvelope): string | null {
    try {
        const sourceId = request.deletionId;
        if (!sourceId) return null;

        const response = geminiResponse(responseText);
        const replies = response.rows(GeminiProtocol.RPCS.DELETE);
        if (replies.length !== 1) return null;
        const reply = replies[0];
        if (typeof reply[2] !== 'string' || reply[5] != null) return null;
        const confirmation = response.payload(GeminiProtocol.RPCS.DELETE).inner;
        if (!Array.isArray(confirmation)) return null;
        // Native GzXR5e is a void RPC: a successful reply contains [] (captured live).
        // The unique outgoing DELETE binds that acknowledgement to its target.
        const voidSuccess = confirmation.length === 0;
        const echoedSuccess = confirmation.length === 2 && confirmation[0] === null && confirmation[1] === sourceId;
        if (!voidSuccess && !echoedSuccess) return null;
        return sourceId.slice(2);
    } catch { return null; }
}
