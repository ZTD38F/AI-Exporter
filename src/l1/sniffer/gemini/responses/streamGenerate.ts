import { CrossWorldEvents } from '../../../protocol/gemini/protocol.js';
import type { GeminiStreamStartPayload, GeminiStreamCompletePayload } from '../../../protocol/gemini/events.js';
import type { GeminiCaptureContext, GeminiResponseHandler } from './router.js';

// candidate[8][0] == 2 means answered. Require complete JSON frames and EOF.
// This signals generation completion; Application must acquire actual Detail.
// Transport-only trailers and unknown/error responses cannot complete a turn.
function completedTurn(text: string): { conversationId: string; responseId: string } | null {
    let identity: { conversationId: string; responseId: string } | null = null;
    let answered = false;
    try {
        let expectedLength: number | undefined;
        for (const line of text.split('\n').map(value => value.trim()).filter(Boolean)) {
            if (line === ")]}'") continue;
            if (/^\d+$/.test(line)) {
                if (expectedLength !== undefined) return null;
                expectedLength = Number(line); continue;
            }
            if (expectedLength !== undefined) {
                const bytes = new TextEncoder().encode(line).length;
                // Live StreamGenerate counts UTF-16 code units, including
                // surrounding LFs. Legacy captures use bare UTF-8 byte lengths.
                if (expectedLength !== bytes && expectedLength !== line.length + 2) return null;
            }
            expectedLength = undefined;
            const rows: unknown = JSON.parse(line);
            if (!Array.isArray(rows)) return null;
            for (const row of rows) {
                if (!Array.isArray(row)) return null;
                if (row[0] === 'er' || row[5] != null) return null;
                if (row[0] !== 'wrb.fr') continue;
                if (typeof row[2] !== 'string') return null;
                const inner: unknown = JSON.parse(row[2]);
                if (!Array.isArray(inner)) return null;
                const metadata: unknown = inner[1];
                if (Array.isArray(metadata) && typeof metadata[0] === 'string' && /^c_[a-f0-9]{8,64}$/i.test(metadata[0])
                    && typeof metadata[1] === 'string' && /^r_[a-f0-9]+$/i.test(metadata[1])) {
                    const next = { conversationId: metadata[0].slice(2), responseId: metadata[1] };
                    if (identity && (identity.conversationId !== next.conversationId || identity.responseId !== next.responseId)) return null;
                    identity = next;
                }
                if (Array.isArray(inner[4]) && inner[4].length) {
                    answered = inner[4].every((candidate: unknown) => Array.isArray(candidate)
                        && typeof candidate[0] === 'string' && candidate[0].startsWith('rc_')
                        && Array.isArray(candidate[8]) && candidate[8][0] === 2);
                }
            }
        }
        return expectedLength === undefined && answered ? identity : null;
    } catch { return null; }
}

/** One page-local handler owns stream identity, completion and replay suppression. */
export function createStreamGenerateHandler() {
    let lastCompletedTurn: string | undefined;
    return (context: GeminiCaptureContext): GeminiResponseHandler => ({
        captureLimit: 100 * 1024 * 1024,
        start(body) {
            let decoded = body;
            try { decoded = decodeURIComponent(body); } catch { /* Keep undecodable request evidence. */ }
            const id = decoded.match(/c_([a-f0-9]{8,64})/i)?.[1]
                ?? context.pagePath.match(/\/app\/([a-f0-9]{8,64})/i)?.[1] ?? null;
            window.__geminiIsStreaming = true;
            window.__geminiLastStreamStart = Date.now();
            if (id) window.__geminiActiveStreamConvId = id;
            const payload: GeminiStreamStartPayload = { id, slot: context.slot,
                requestAccountObservation: context.requestAccountObservation };
            window.postMessage({ type: CrossWorldEvents.STREAM_START, payload }, location.origin);
        },
        complete(_body, text, truncated, successful) {
            if (!successful || truncated) return;
            const turn = completedTurn(text);
            if (!turn) return;
            const { slot, requestAccountObservation, url } = context;
            const identity = JSON.stringify([slot, requestAccountObservation?.providerAccountId, turn.conversationId, turn.responseId]);
            if (identity === lastCompletedTurn) return;
            lastCompletedTurn = identity;
            window.__geminiLastStreamComplete = Date.now();
            window.__geminiActiveStreamConvId = turn.conversationId;
            const payload: GeminiStreamCompletePayload = { id: turn.conversationId, requestAccountObservation, slot, url };
            window.postMessage({ type: CrossWorldEvents.STREAM_COMPLETE, payload }, location.origin);
        },
        end() { window.__geminiIsStreaming = false; },
    });
}
