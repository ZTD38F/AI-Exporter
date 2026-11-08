import { geminiListVariant, geminiListRow } from '../../geminiListCapture.js';
import { timestampPairs } from '../sources.js';
/** Gemini List edge/legacy responses. Normal traffic is shared via geminiListCapture.ts. */
export const wire = geminiListVariant;
export const sourceRow = geminiListRow;

/** Synthetic identity/cursor variants for focused protocol regressions. */
export function geminiList(ids: readonly string[] = [], nextCursor: string | null = null) {
    return wire(ids.map(id => sourceRow(id, 'Title ' + id, 1700000000)), nextCursor);
}

export const boundaryRow = () => sourceRow('boundary123', 'Source title', 1700000060);
export const contractRow = (id = 'source_chat_123', seconds = 1700000050) =>
    sourceRow(id, 'Source title', seconds);
export const rpcRow = () => sourceRow('verifiedrpc123', 'Verified', 1700000050);
export const rpcEnvelope = (rpc: string, inner: unknown) => ['wrb.fr', rpc, JSON.stringify(inner)];
export const rpcBatchWire = (...rows: unknown[][]) => JSON.stringify(rows);
// Native Any envelope regression characterized from 2026-10-20 hNvQHb NotFound.
export const nativeAnyError = (rpc: string, code: unknown,
    type = 'type.googleapis.com/assistant.boq.bard.application.BardErrorInfo') =>
    ['wrb.fr', rpc, null, null, null, [5, null, [[type, [code]]]], 'generic'];



// Keep explicit protocol edge cases; ordinary success data is shared from the real capture.

/** Preserve the historic P1-E List envelope, whose items occupy inner slot 1. */
export function p1RegressionList(items: unknown[]): string {
    return ")]}'\n\n" + JSON.stringify([['wrb.fr', 'MaZiqc', JSON.stringify([null, items, null])]]);
}


export const scanFlowWire = (rows: unknown[]): string => wire(rows);
export const scanRows = (renamed = false): unknown[] => [
    sourceRow('scan_003', '微服务架构与分布式事务', 1700000200),
    sourceRow('scan_002', 'Rust 高性能异步网络编程', 1700000100),
    sourceRow('scan_001', renamed ? '改名后的老会话' : '量子计算与超导量子比特', 1700000000),
];
export const fixedPage = (id: string, title: string, seconds: number): string => wire([sourceRow(id, title, seconds)]);

/** Captured transport with explicit synthetic identities/times for state transitions. */
export function e2eIncrementalList(prefix: string, values: readonly number[], cursor: string | null): string {
    return wire(values.map(time => sourceRow(prefix + time,
        (prefix === 'chat' ? 'Chat ' : 'Rebuild ') + time, 1700000000 + time)), cursor);
}
export function e2eUuidList(id: string): string {
    return wire([sourceRow(id, 'Source title', 1700000000)]);
}



/** Six fixed anonymized source timestamp pairs, consumed through List keys. */
export function versionPairList(index: number): string {
    const pairs: Array<{ listWire: number[] }> = timestampPairs;
    const pair = pairs[index];
    if (!pair) throw new Error('Missing Gemini timestamp pair ' + index);
    return JSON.stringify([['wrb.fr', 'MaZiqc', JSON.stringify([null, null,
        [['c_version_chat', 'Source title', null, null, null, pair.listWire]]])]]);
}
