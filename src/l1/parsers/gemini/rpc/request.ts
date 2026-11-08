import { GeminiProtocol } from '../../../protocol/gemini/protocol.js';

export interface GeminiListRequestContext {
    streamId: 'recent' | 'pinned';
    requestCursor: string | null;
}
export interface GeminiDetailRequestContext { conversationId: string; requestCursor: string | null }
export interface GeminiRequestContext {
    list: GeminiListRequestContext | null;
    detail: GeminiDetailRequestContext | null;
    deletionId: string | null;
}

function array(value: unknown): value is unknown[] { return Array.isArray(value); }

function listRequest(args: unknown): GeminiListRequestContext | null {
    if (!array(args) || args.length !== 3 || typeof args[0] !== 'number' || !Number.isInteger(args[0]) || args[0] <= 0
        || !(args[1] === null || typeof args[1] === 'string') || !array(args[2])) return null;
    const filter = args[2];
    const classic = filter.length === 3 && (filter[0] === 0 || filter[0] === 1) && filter[1] === null && filter[2] === 1;
    // Captured webpage recent-list request. The expanded filter is exact evidence;
    // arbitrary extra fields still cannot establish scan coverage.
    const expandedRecent = filter.length === 10 && filter.every((value, index) => value === (index === 2 || index === 9 ? 1 : null));
    if (!classic && !expandedRecent) return null;
    return { streamId: classic && filter[0] === 1 ? 'pinned' : 'recent', requestCursor: args[1] };
}

function detailRequest(args: unknown): GeminiDetailRequestContext | null {
    if (!array(args) || args.length !== 8 || typeof args[0] !== 'string' || !/^c_[\w-]+$/.test(args[0])
        || (args[1] !== null && args[1] !== 10) || (args[2] !== null && typeof args[2] !== 'string')
        || args[3] !== 1 || JSON.stringify(args[4]) !== '[1]' || JSON.stringify(args[5]) !== '[4]'
        || args[6] !== null || args[7] !== 1) return null;
    return { conversationId: args[0].slice(2), requestCursor: args[2] };
}

/** Decode the batch once; duplicate RPCs cannot establish a unique request identity.
 * Each RPC owns its argument layout. Malformed unrelated calls do not mask valid ones. */
export function parseGeminiRequest(body: unknown): GeminiRequestContext {
    const result: GeminiRequestContext = { list: null, detail: null, deletionId: null };
    if (typeof body !== 'string') return result;
    try {
        const batch: unknown = JSON.parse(new URLSearchParams(body).get('f.req') || 'null');
        if (!array(batch)) return result;
        const calls = batch.flat().filter(array);
        const argumentsFor = (rpc: string): unknown => {
            const matches = calls.filter(call => call[0] === rpc);
            if (matches.length !== 1 || typeof matches[0][1] !== 'string') return undefined;
            try { const args: unknown = JSON.parse(matches[0][1]); return args; }
            catch { return undefined; }
        };
        result.list = listRequest(argumentsFor(GeminiProtocol.RPCS.LIST));
        result.detail = detailRequest(argumentsFor(GeminiProtocol.RPCS.DETAIL));
        const deletionArgs = argumentsFor(GeminiProtocol.RPCS.DELETE);
        const ids = JSON.stringify(deletionArgs)?.match(/c_[a-f0-9]{8,64}/gi);
        if (ids?.length === 1) result.deletionId = ids[0].toLowerCase();
    } catch { /* Invalid transport input provides no request evidence. */ }
    return result;
}
