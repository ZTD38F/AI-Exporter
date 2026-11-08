import { editCapturedRpc } from './geminiCaptureWire.js';
import corpusJson from '../provider/gemini_rpc/detail-and-pinned.json';

interface CapturedRpcPacket {
    capturedAt: string;
    method: string;
    endpoint: string;
    rpcids: string;
    status: number;
    captureKind: string;
    requestBody: string;
    responseBody: string;
}
const corpus: { packets: Record<'detail' | 'pinned', CapturedRpcPacket> } = corpusJson;
export function geminiRpcPacket(kind: 'detail' | 'pinned'): CapturedRpcPacket {
    return { ...corpus.packets[kind] };
}
/** Independently recorded expectations from the seven-turn source conversation. */
export const GEMINI_DETAIL_CAPTURE = {
    conversationId: '0000000000000001',
    messages: 14,
    title: 'xxxxxxxxxxxxxxxxx',
    firstRequestId: 'r_0000000000000014',
    firstTimestamp: 1792651574037,
    lastTimestamp: 1792652355202,
    lastAnswer: 'xxxxxxxxxxxxxxxxxxxxxxxxx，xxxxxxxxxxxxxxxxxxxx。',
} as const;

/** Derived identity-only input; all seven captured turns and timestamps remain intact. */
export function geminiDetailIdentityVariant(conversationId: string): string {
    return editCapturedRpc(geminiRpcPacket('detail').responseBody, 'hNvQHb', inner => {
        const replace = (value: unknown): unknown => {
            if (value === 'c_' + GEMINI_DETAIL_CAPTURE.conversationId) return 'c_' + conversationId;
            return Array.isArray(value) ? value.map(replace) : value;
        };
        inner.splice(0, inner.length, ...inner.map(replace));
    });
}
