import { CrossWorldEvents } from '../../../protocol/gemini/protocol.js';
import type { GeminiCaptureContext, GeminiResponseHandler } from './router.js';

// processSession carries length-prefixed WebChannel JSON frames containing base64
// protobuf messages. A final answered candidate precedes the persistence receipt;
// wait for both before Application rereads the server history snapshot.
type Field = { number: number; value: number | Uint8Array };
function fields(bytes: Uint8Array): Field[] {
    let offset = 0;
    const varint = () => {
        let value = 0;
        let scale = 1;
        for (let n = 0; n < 8 && offset < bytes.length; n++) {
            const byte = bytes[offset++];
            value += (byte & 127) * scale;
            if (byte < 128 && Number.isSafeInteger(value)) return value;
            scale *= 128;
        }
        throw new Error('Invalid protobuf varint');
    };
    const result: Field[] = [];
    while (offset < bytes.length) {
        const tag = varint();
        const number = Math.floor(tag / 8);
        const wire = tag % 8;
        if (!number) throw new Error('Invalid protobuf tag');
        if (wire === 0) result.push({ number, value: varint() });
        else if (wire === 2 || wire === 1 || wire === 5) {
            const length = wire === 2 ? varint() : wire === 1 ? 8 : 4;
            if (offset + length > bytes.length) throw new Error('Incomplete protobuf field');
            if (wire === 2) result.push({ number, value: bytes.slice(offset, offset + length) });
            offset += length;
        } else throw new Error('Unsupported protobuf wire type');
    }
    return result;
}
function message(parent: Field[], number: number): Field[] {
    const matches = parent.filter(field => field.number === number);
    if (matches.length !== 1 || !(matches[0].value instanceof Uint8Array)) throw new Error('Missing message');
    return fields(matches[0].value);
}
function scalar(parent: Field[], number: number): number | undefined {
    const matches = parent.filter(field => field.number === number);
    return matches.length === 1 && typeof matches[0].value === 'number' ? matches[0].value : undefined;
}
function string(parent: Field[], number: number): string {
    const matches = parent.filter(field => field.number === number);
    if (matches.length !== 1 || !(matches[0].value instanceof Uint8Array)) throw new Error('Missing string');
    return new TextDecoder('utf-8', { fatal: true }).decode(matches[0].value);
}
function turn(encoded: string) {
    const bytes = Uint8Array.from(atob(encoded), char => char.charCodeAt(0));
    const envelope = message(message(message(fields(bytes), 2), 7), 1);
    const detail = message(message(envelope, 4), 4);
    const identity = message(detail, 2);
    const id = string(identity, 1);
    const responseId = string(identity, 2);
    if (!/^c_[a-f0-9]{8,64}$/i.test(id) || !/^r_[a-f0-9]+$/i.test(responseId)
        || string(message(envelope, 2), 1) !== responseId) return null;
    const candidates = detail.filter(field => field.number === 5);
    const persisted = detail.some(field => field.number === 26 && field.value instanceof Uint8Array
        && field.value.length > 0 && field.value.length <= 4096);
    const answered = candidates.length > 0 && candidates.every(candidate => {
        if (!(candidate.value instanceof Uint8Array)) return false;
        const fields_ = fields(candidate.value);
        return /^rc_[a-f0-9]+$/i.test(string(fields_, 1)) && scalar(message(fields_, 9), 1) === 2;
    });
    return { id: id.slice(2), responseId, complete: scalar(envelope, 1) === 1 && answered, persisted };
}

export function createProcessSessionHandler() {
    const completed = new Set<string>();
    const answeredTurns = new Set<string>();
    const persistedTurns = new Set<string>();
    return (context: GeminiCaptureContext): GeminiResponseHandler => {
        let pending = '';
        let invalid = false;
        let started: string | undefined;
        return {
            captureLimit: 100 * 1024 * 1024,
            start() {},
            progress(chunk) {
                if (invalid) return;
                pending += chunk;
                while (pending) {
                    const newline = pending.indexOf('\n');
                    if (newline < 0) break;
                    const header = pending.slice(0, newline);
                    if (!/^\d+$/.test(header)) { invalid = true; return; }
                    const length = Number(header);
                    if (!Number.isSafeInteger(length) || length > 10 * 1024 * 1024) { invalid = true; return; }
                    if (pending.length < newline + 1 + length) break;
                    const frame = pending.slice(newline + 1, newline + 1 + length);
                    pending = pending.slice(newline + 1 + length);
                    try {
                        const rows: unknown = JSON.parse(frame);
                        if (!Array.isArray(rows)) continue;
                        for (const row of rows) {
                            if (!Array.isArray(row) || !Array.isArray(row[1]) || typeof row[1][0] !== 'string') continue;
                            let evidence;
                            try { evidence = turn(row[1][0]); } catch { continue; }
                            if (!evidence) continue;
                            const identity = JSON.stringify([context.slot, context.requestAccountObservation?.providerAccountId,
                                evidence.id, evidence.responseId]);
                            if (completed.has(identity)) continue;
                            window.__geminiActiveStreamConvId = evidence.id;
                            if (started !== identity) {
                                started = identity;
                                window.postMessage({ type: CrossWorldEvents.STREAM_START, payload: {
                                    id: evidence.id, slot: context.slot, requestAccountObservation: context.requestAccountObservation,
                                } }, location.origin);
                            }
                            if (evidence.complete) answeredTurns.add(identity);
                            if (evidence.persisted) persistedTurns.add(identity);
                            if (answeredTurns.has(identity) && persistedTurns.has(identity)) {
                                answeredTurns.delete(identity);
                                persistedTurns.delete(identity);
                                completed.add(identity);
                                window.__geminiIsStreaming = false;
                                window.__geminiLastStreamComplete = Date.now();
                                window.postMessage({ type: CrossWorldEvents.STREAM_COMPLETE, payload: {
                                    id: evidence.id, slot: context.slot, requestAccountObservation: context.requestAccountObservation, url: context.url,
                                } }, location.origin);
                            } else {
                                window.__geminiIsStreaming = true;
                                window.__geminiLastStreamStart = Date.now();
                            }
                        }
                    } catch { invalid = true; return; }
                }
            },
            complete() {},
            end() {},
        };
    };
}
