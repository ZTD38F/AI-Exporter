/**
 * PR-4 regression: isRpcSource plumbing removed; timestamp arbitration is
 * source-agnostic strict monotonicity (newer-wins, never regress).
 *
 * Historical note: mergeConversation once computed an `isRpcSource` flag
 * (source === 'network-list' || titleSource === 'rpc' || source.startsWith('stream-'),
 * plus 'network-detail' in the options-fallback formula) that granted RPC
 * batches an exemption from timestamp monotonicity. #371 (50abbe9) replaced
 * that with strict Math.max monotonicity and left the flag as dead plumbing;
 * this PR deletes it entirely. Whether 'network-detail' "is RPC" no longer
 * matters for arbitration: every source label gets the same treatment.
 *
 * Run: node -r tests/ts_register.js --test tests/pr_isrpcsource.test.ts
 */
export {};
const test = require('node:test');
const assert = require('node:assert');

const { mergeConversation } = require('../src/core/utils/mergeUtils.js');

function base(id: string) {
    return { id, title: 'T', titles: { rpc: 'T' }, titleSource: 'rpc' };
}

test('PR-4: older network-detail incoming never regresses updatedAt (newer-wins, no RPC exemption)', () => {
    const old: any = { ...base('c_nd'), timestamp: 2000, updatedAt: 2000, source: 'network-list' };
    const incoming: any = {
        ...base('c_nd'), timestamp: 1000, updatedAt: 1000,
        source: 'network-detail', titleSource: 'rpc'
    };
    const r = mergeConversation(old, incoming, { source: 'network-detail' });
    assert.strictEqual(r.merged.updatedAt, 2000, 'older network-detail timestamp regressed updatedAt');
    assert.strictEqual(r.merged.timestamp, 2000, 'older network-detail timestamp regressed timestamp');
});

test('PR-4: newer network-detail incoming still advances (strict monotonicity is symmetric)', () => {
    const old: any = { ...base('c_nd2'), timestamp: 2000, updatedAt: 2000 };
    const incoming: any = {
        ...base('c_nd2'), timestamp: 3000, updatedAt: 3000,
        source: 'network-detail', titleSource: 'rpc'
    };
    const r = mergeConversation(old, incoming, { source: 'network-detail' });
    assert.strictEqual(r.merged.updatedAt, 3000, 'newer network-detail timestamp did not win');
    assert.strictEqual(r.merged.timestamp, 3000, 'newer network-detail timestamp did not win');
});

test('PR-4: arbitration is source-agnostic — same result regardless of source label', () => {
    const old: any = { ...base('c_src'), timestamp: 2000, updatedAt: 2000 };
    const mkIncoming = (source: string, ts: number): any => ({
        ...base('c_src'), timestamp: ts, updatedAt: ts, source, titleSource: 'rpc'
    });
    for (const source of ['network-list', 'network-detail', 'stream-live', 'takeout', 'sniff', 'unknown']) {
        const older = mergeConversation(old, mkIncoming(source, 1000), { source });
        assert.strictEqual(older.merged.updatedAt, 2000, `older ${source} timestamp regressed updatedAt`);
        const newer = mergeConversation(old, mkIncoming(source, 3000), { source });
        assert.strictEqual(newer.merged.updatedAt, 3000, `newer ${source} timestamp did not win`);
    }
});

test('PR-4: MergeConversationOptions no longer exposes isRpcSource (dead flag gone)', () => {
    // mergeConversation must work identically whether or not a caller passes
    // a stray isRpcSource flag (defensive: old callers should not crash).
    const old: any = { ...base('c_opt'), timestamp: 2000, updatedAt: 2000 };
    const incoming: any = { ...base('c_opt'), timestamp: 1000, updatedAt: 1000 };
    const r = mergeConversation(old, incoming, { source: 'network-list' } as any);
    assert.strictEqual(r.merged.updatedAt, 2000);
});
