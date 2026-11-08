import { readAccountParameters, type Account } from '../../../l2/accountRegistry.js';
import { CrossWorldEvents } from '../../protocol/gemini/protocol.js';
import { parseGeminiRequest, type GeminiListRequestContext, type GeminiDetailRequestContext } from './rpc/request.js';
import { parseConfirmedGeminiDeletion } from './rpc/parseDeletion.js';
import { parseGeminiResponse } from './rpc/parseResponse.js';
import type { ListParseResult } from './rpc/parseList.js';
import type { GeminiRpcParseResult } from './rpc/parseConversation.js';

interface CaptureIdentity { slot: string; identity: Omit<Account, 'id'> | null }
export type GeminiCapturedSource = CaptureIdentity & (
    | { kind: 'network'; truncated: boolean; requestedAt: number;
        list: { parsed: ListParseResult; request: GeminiListRequestContext | null } | null;
        detail: { parsed: GeminiRpcParseResult; request: GeminiDetailRequestContext | null } | null }
    | { kind: 'deleted'; id: string }
    | { kind: 'stream-start' | 'stream-complete'; id: string | null }
);

/** ISOLATED ingress: validate the wire message and decode its source facts before account allocation. */
export function parseGeminiCapturedSource(raw: unknown): GeminiCapturedSource | null {
    if (!raw || typeof raw !== 'object' || !('type' in raw) || !('payload' in raw)) return null;
    const payload = raw.payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    const field = (name: string): unknown => Reflect.get(payload, name);
    const slot = field('slot');
    if (typeof slot !== 'string' || !/^u\d+$/.test(slot)) return null;
    // Validate source and parse useful facts before anything can create a default Account.
    const capturedIdentity = field('requestAccountObservation');
    if (raw.type === CrossWorldEvents.NETWORK_BATCHEXECUTE) {
        const text = field('text'), truncated = field('truncated'), requestedAt = field('requestedAt'), url = field('url');
        if (typeof text !== 'string' || !text || text.length > 3000000 || typeof truncated !== 'boolean'
            || typeof requestedAt !== 'number' || !Number.isFinite(requestedAt) || requestedAt <= 0 || typeof url !== 'string') return null;
        const source = new URL(url);
        if (source.protocol !== 'https:' || !['gemini.google.com', 'bard.google.com'].includes(source.hostname)
            || !source.pathname.endsWith('/batchexecute')) return null;
        const response = parseGeminiResponse(text);
        let parsedList: ListParseResult | null = null;
        let parsedDetail: GeminiRpcParseResult | null = null;
        let listRequest: GeminiListRequestContext | null = null;
        let detailRequest: GeminiDetailRequestContext | null = null;
        if (response.hasList) {
            const request = field('listRequest');
            if (request !== undefined) {
                if (!request || typeof request !== 'object' || !('streamId' in request) || !('requestCursor' in request)
                    || (request.streamId !== 'recent' && request.streamId !== 'pinned')
                    || (request.requestCursor !== null && typeof request.requestCursor !== 'string')) return null;
                listRequest = { streamId: request.streamId, requestCursor: request.requestCursor };
            }
            parsedList = response.list();
        }
        if (response.hasDetail) {
            const request = field('detailRequest');
            if (request !== undefined) {
                if (!request || typeof request !== 'object' || !('conversationId' in request)
                    || typeof request.conversationId !== 'string' || !/^[\w-]{1,128}$/.test(request.conversationId)
                    || !('requestCursor' in request) || (request.requestCursor !== null && typeof request.requestCursor !== 'string')) return null;
                detailRequest = { conversationId: request.conversationId, requestCursor: request.requestCursor };
            }
            parsedDetail = response.detail({ providerId: 'gemini' });
            if (detailRequest && detailRequest.conversationId !== parsedDetail.conversationId) return null;
        }
        if (!parsedList && !parsedDetail) return null;
        if (capturedIdentity === null && !(parsedList && parsedList.conversations.length > 0)
            && !(parsedDetail && parsedDetail.conversation.detail.messages.length > 0)) return null;
        const identity = readIdentity(capturedIdentity);
        if (identity === undefined) return null;
        return { kind: 'network', slot, identity, truncated, requestedAt,
            list: parsedList ? { parsed: parsedList, request: listRequest } : null,
            detail: parsedDetail ? { parsed: parsedDetail, request: detailRequest } : null };
    } else if (raw.type === CrossWorldEvents.CONVERSATION_DELETED) {
        const id = field('id'), url = field('url'), requestBody = field('requestBody'), responseText = field('responseText');
        if (!capturedIdentity || typeof capturedIdentity !== 'object' || Array.isArray(capturedIdentity)
            || typeof id !== 'string' || !/^[\w-]{1,128}$/.test(id)
            || typeof url !== 'string' || typeof requestBody !== 'string' || typeof responseText !== 'string') return null;
        const source = new URL(url);
        if (source.protocol !== 'https:' || !['gemini.google.com', 'bard.google.com'].includes(source.hostname)
            || !source.pathname.endsWith('/batchexecute')) return null;
        const confirmedDeletion = parseConfirmedGeminiDeletion(parseGeminiRequest(requestBody), responseText);
        if (confirmedDeletion !== id) return null;
        const identity = readIdentity(capturedIdentity);
        if (!identity) return null;
        return { kind: 'deleted', slot, identity, id };
    } else if (raw.type === CrossWorldEvents.STREAM_START || raw.type === CrossWorldEvents.STREAM_COMPLETE) {
        // Unknown Stream signals by themselves are not proof of persistable content.
        const identity = readIdentity(capturedIdentity);
        if (!identity) return null;
        const id = field('id');
        if (id !== null && id !== undefined && (typeof id !== 'string' || !/^[\w-]{1,128}$/.test(id))) return null;
        return { kind: raw.type === CrossWorldEvents.STREAM_START ? 'stream-start' : 'stream-complete',
            slot, identity, id: typeof id === 'string' ? id : null };
    } else return null;
}
function readIdentity(raw: unknown): Omit<Account, 'id'> | null | undefined {
    if (raw === undefined || raw === null) return raw;
    const identity = readAccountParameters(raw);
    if (identity.providerId !== 'gemini') throw new TypeError('Wrong request account provider');
    return identity;
}
