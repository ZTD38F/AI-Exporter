/**
 * src/types/wire.ts
 * Type definitions and type narrowing guards for Google Gemini JSPB / batchexecute wire format.
 *
 * Gemini uses Google batchexecute RPC where payloads are returned as serialized
 * JSPB (sparse JSON arrays) wrapped inside multi-part envelopes.
 */

export type JspbArray = unknown[];

export type BatchexecuteRpcId = 'MaZiqc' | 'hNvQHb' | string;

/**
 * A single batchexecute RPC chunk tuple:
 * [0]: 'wrb.fr'
 * [1]: RPC ID (e.g. 'MaZiqc' for list, 'hNvQHb' for detail)
 * [2]: JSON serialized payload string, or null
 * [3..n]: metadata/status fields
 */
export type BatchexecuteRpcChunk = [
    prefix: string,
    rpcId: string,
    payloadJson: string | null,
    ...rest: unknown[]
];

/**
 * Top-level response envelope parsed from batchexecute response.
 */
export type RawBatchexecuteEnvelope = unknown[];

/**
 * Wire representation of a conversation list item in MaZiqc payload.
 * [0]: Conversation ID (string, e.g. "c_123...")
 * [1]: Title (string | null)
 * [2]: Array of timestamps/turns/metadata
 */
export interface RawConversationListItem {
    0: string;
    1?: string | null;
    [key: number]: unknown;
}

/**
 * Wire representation of a single conversation turn in hNvQHb payload.
 * [0]: Turn ID (string)
 * [1]: Turn author/messages
 * [2]: Attachments/thoughts
 */
export interface RawTurnItem {
    0?: string;
    [key: number]: unknown;
}

/**
 * Type guard to check if a value is a valid array (JSPB array).
 */
export function isJspbArray(val: unknown): val is unknown[] {
    return Array.isArray(val);
}

/**
 * Type guard to check if an item is a valid batchexecute chunk tuple.
 */
export function isBatchexecuteChunk(val: unknown): val is BatchexecuteRpcChunk {
    return Array.isArray(val) &&
        val.length >= 3 &&
        val[0] === 'wrb.fr' &&
        typeof val[1] === 'string';
}

/**
 * Type guard to safely check if a value is an object (record).
 */
export function isRecord(val: unknown): val is Record<string, unknown> {
    return typeof val === 'object' && val !== null && !Array.isArray(val);
}
