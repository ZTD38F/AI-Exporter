import { account, key, reset, stubModule, provider, state } from './helpers/applicationHarness.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { StreamCoverage } from '../src/l2/streamCoverage.js';
import type { ScanHead } from '../src/l2/coverageAdmission.js';
import type { ListEnd } from '../src/l1/client/aiProvider.js';
let baseline: StreamCoverage | null;
let boundary: boolean;
let reads = 0;
const checks: { baseline: StreamCoverage; head: ScanHead }[] = [];
stubModule('../../src/l2/coverageAdmission.js', { __esModule: true, default: {
    async getCoverage(accountId: string, streamId: string) {
        assert.equal(accountId, key().accountId); assert.equal(streamId, 'recent'); reads++; return baseline;
    },
    async hasTrustedBoundary(_account: string, baseline: StreamCoverage, head: ScanHead) { checks.push({ baseline, head }); return boundary; },
} });
const { scanAll } = require('../src/application/sync/scanController.js') as typeof import('../src/application/sync/scanController.js');
const head: ScanHead = { streamId: 'recent', requestKnown: true, requestCursor: null, nextCursor: 'next',
    valid: true, ordered: true, requestedAt: 1, keys: [{ id: 'first', time: 100 }] };
function trusted(): StreamCoverage {
    // L2 evidence is opaque to Application; use a real-shaped frozen historical range.
    return { range: { head: { id: 'old', time: 90 }, tail: { id: 'older', time: 10 } } } as StreamCoverage;
}
test.beforeEach(() => { reset(); baseline = null; boundary = false; reads = 0; checks.length = 0; });
test('Scan All fails closed on an invalid UUID or unverified online Account before Coverage or L1', async () => {
    let listCalls = 0;
    provider.listConversations = async () => { listCalls++; return 'source_end'; };
    assert.deepEqual(await scanAll({ accountId: 'not-a-uuid' }), {
        status: 'error', pagesFetched: 0, conversationsFetched: 0, reason: 'Invalid account UUID',
    });
    for (const unavailable of [null, { ...account, providerAccountId: 'default' }, { ...account, providerId: 'unsupported' }]) {
        state.accountOverride = unavailable;
        assert.deepEqual(await scanAll({ accountId: account.id }), {
            status: 'error', pagesFetched: 0, conversationsFetched: 0, reason: 'Verified provider account unavailable',
        });
    }
    assert.equal(reads, 0);
    assert.equal(listCalls, 0);
    state.accountOverride = undefined;
    assert.equal((await scanAll({ accountId: account.id })).status, 'complete', 'rejected attempts do not block later valid scans');
});
test('trusted empty Recent result can be complete without manufacturing a Coverage boundary', async () => {
    provider.listConversations = async () => 'source_end';
    const progress: unknown[] = [];
    assert.deepEqual(await scanAll({ accountId: account.id }, { onProgress: value => progress.push(value) }), {
        status: 'complete', pagesFetched: 0, conversationsFetched: 0,
    });
    assert.deepEqual(progress, []);
    assert.equal(reads, 1); assert.equal(checks.length, 0);
});

test('Scan All accepts a verified ChatGPT account and passes its UUID to the registered provider', async () => {
    state.accountOverride = { ...account, providerId: 'chatgpt', providerAccountId: '["user","workspace"]' };
    provider.listConversations = async options => {
        assert.equal(options.accountId, account.id);
        await options.onPageCommitted!({ page: 1, totalObserved: 2, scanHead: head });
        return 'source_end';
    };
    assert.deepEqual(await scanAll({ accountId: account.id }), {
        status: 'complete', pagesFetched: 1, conversationsFetched: 2,
    });
});
test('Scan All aggregates actual committed metadata admissions instead of source row counts', async () => {
    provider.listConversations = async options => {
        await options.onPageCommitted!({ page: 1, totalObserved: 25, indexChanges: { added: 12, updated: 8 } });
        await options.onPageCommitted!({ page: 2, totalObserved: 40, indexChanges: { added: 0, updated: 1 } });
        return 'source_end';
    };
    assert.deepEqual(await scanAll({ accountId: account.id }), {
        status: 'complete', pagesFetched: 2, conversationsFetched: 40, indexChanges: { added: 12, updated: 9 },
    });
});
test('unexpected Provider termination becomes a structured error, never undefined', async () => {
    provider.listConversations = async () => 'unknown_end' as ListEnd;
    assert.deepEqual(await scanAll({ accountId: account.id }), {
        status: 'error', pagesFetched: 0, conversationsFetched: 0, reason: 'Unknown provider list termination',
    });
});
test('already-aborted Scan does not read Coverage or enter the Provider', async () => {
    const controller = new AbortController(); controller.abort();
    let listCalls = 0;
    provider.listConversations = async () => { listCalls++; return 'source_end'; };
    assert.deepEqual(await scanAll({ accountId: account.id }, { signal: controller.signal }), {
        status: 'aborted', pagesFetched: 0, conversationsFetched: 0,
    });
    assert.equal(reads, 0); assert.equal(listCalls, 0);
});
for (const [end, status, reason] of [ ['source_end', 'complete', undefined], ['provider_limit', 'partial_limit', 'provider_limit'],
    ['max_pages', 'partial_limit', 'max_pages'], ['stopped', 'error', 'Unverified scan stop'] ] as const) {
    test(`L1 ${end} maps to ${status} using only committed counters`, async () => {
        provider.listConversations = async options => {
            assert.equal(options.streamId, 'recent'); assert.equal(options.accountId, key().accountId);
            assert.equal('cursor' in options, false); assert.equal('maxPages' in options, false);
            await options.onPageCommitted!({ page: 1, totalObserved: 25, scanHead: head });
            await options.onPageCommitted!({ page: 2, totalObserved: 40 });
            return end as ListEnd;
        };
        const progress: unknown[] = [];
        const result = await scanAll({ accountId: key().accountId }, { onProgress: p => progress.push(p) });
        assert.deepEqual(result, { status, pagesFetched: 2, conversationsFetched: 40, ...(reason ? { reason } : {}) });
        assert.deepEqual(progress, [{ pagesFetched: 1, conversationsFetched: 25 }, { pagesFetched: 2, conversationsFetched: 40 }]);
        assert.equal(checks.length, 0); assert.equal(reads, 1);
    });
}
test('historical range never skips the head request; trusted L2 connection stops the same sequential pipeline', async () => {
    baseline = trusted(); boundary = true;
    provider.listConversations = async options => {
        assert.equal(checks.length, 0);
        assert.equal(await options.onPageCommitted!({ page: 1, totalObserved: 1, scanHead: head }), true);
        return 'stopped';
    };
    assert.equal((await scanAll({ accountId: key().accountId })).status, 'up_to_date');
    assert.equal(checks.length, 1); assert.equal(checks[0].head, head);
});
test('baseline is cloned once; fresh coverage cannot replace startup history', async () => {
    baseline = trusted(); const original = structuredClone(baseline);
    provider.listConversations = async options => {
        baseline!.range = null;
        await options.onPageCommitted!({ page: 1, totalObserved: 2, scanHead: head });
        await options.onPageCommitted!({ page: 2, totalObserved: 4 });
        return 'source_end';
    };
    await scanAll({ accountId: key().accountId });
    assert.equal(checks.length, 2); assert.deepEqual(checks[0].baseline, original); assert.equal(reads, 1);
});
test('Force Full only bypasses boundary stopping and still calls the same Recent provider', async () => {
    baseline = trusted(); boundary = true;
    provider.listConversations = async options => {
        assert.equal(await options.onPageCommitted!({ page: 1, totalObserved: 1, scanHead: head }), false);
        return 'source_end';
    };
    assert.equal((await scanAll({ accountId: key().accountId, forceFull: true })).status, 'complete');
    assert.equal(checks.length, 0);
});
test('no baseline or no scanHead cannot produce trusted early stop', async () => {
    baseline = trusted(); boundary = true;
    provider.listConversations = async options => {
        assert.equal(await options.onPageCommitted!({ page: 1, totalObserved: 0 }), false); return 'source_end';
    };
    assert.equal((await scanAll({ accountId: key().accountId })).status, 'complete'); assert.equal(checks.length, 0);
});
test('failed later admission reports error and retains only previously committed counts', async () => {
    provider.listConversations = async options => {
        await options.onPageCommitted!({ page: 1, totalObserved: 10 }); throw new Error('Index commit failed');
    };
    assert.deepEqual(await scanAll({ accountId: key().accountId }), { status: 'error', pagesFetched: 1, conversationsFetched: 10, reason: 'Index commit failed' });
});
test('AbortSignal reaches L1; cancellation preserves committed pages and releases reentry guard', async () => {
    const controller = new AbortController();
    provider.listConversations = async options => {
        assert.equal(options.signal, controller.signal);
        await options.onPageCommitted!({ page: 1, totalObserved: 5 }); controller.abort(); options.signal!.throwIfAborted(); return 'source_end';
    };
    assert.deepEqual(await scanAll({ accountId: key().accountId }, { signal: controller.signal }), { status: 'aborted', pagesFetched: 1, conversationsFetched: 5 });
    provider.listConversations = async () => 'source_end';
    assert.equal((await scanAll({ accountId: key().accountId })).status, 'complete');
});
test('same-account reentry fails without starting a second scan', async () => {
    let nested: unknown;
    provider.listConversations = async () => { nested = await scanAll({ accountId: key().accountId }); return 'source_end'; };
    await scanAll({ accountId: key().accountId });
    assert.deepEqual(nested, { status: 'error', pagesFetched: 0, conversationsFetched: 0, reason: 'Scan already running' });
});
