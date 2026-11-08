import { GeminiProtocol } from '../../../protocol/gemini/protocol.js';
import { robustFirstPayload } from './extractors.js';
import { extractInnerPayload, type InnerPayloadDiscoveryResult } from './payload.js';

/** One transport decode per acquisition. Raw wire values stay inside L1. */
export class GeminiResponseEnvelope {
    readonly top: unknown[] | null;
    private readonly byRpc = new Map<string, unknown[][]>();
    private readonly payloads = new Map<string, InnerPayloadDiscoveryResult>();

    constructor(readonly text: string) {
        this.top = robustFirstPayload(text);
        for (const raw of this.top ?? []) {
            if (!Array.isArray(raw)) continue;
            const row: unknown[] = raw;
            if (row[0] !== GeminiProtocol.WRB || typeof row[1] !== 'string') continue;
            const rows = this.byRpc.get(row[1]) ?? [];
            rows.push(row);
            this.byRpc.set(row[1], rows);
        }
    }

    rows(rpcId: string): unknown[][] {
        return this.byRpc.get(rpcId) ?? [];
    }

    /** A known WRB envelope may never fall back to another RPC's payload.
     * Headerless historical captures retain the existing drift recovery. */
    scope(rpcId: string): unknown[] | null {
        return this.byRpc.size ? this.rows(rpcId) : this.top;
    }

    payload(rpcId: string): InnerPayloadDiscoveryResult {
        let payload = this.payloads.get(rpcId);
        if (!payload) {
            payload = extractInnerPayload(this.scope(rpcId), {
                wrb: GeminiProtocol.WRB, rpcId,
                ...(rpcId === GeminiProtocol.RPCS.DETAIL ? {
                    heuristicFilter: (s: string) => /c_[a-zA-Z0-9_-]{8,64}/.test(s) || s.includes('rc_') || s.startsWith('[['),
                } : {}),
            });
            this.payloads.set(rpcId, payload);
        }
        return payload;
    }
}

export function geminiResponse(input: string | GeminiResponseEnvelope): GeminiResponseEnvelope {
    return typeof input === 'string' ? new GeminiResponseEnvelope(input) : input;
}
