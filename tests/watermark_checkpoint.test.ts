import test from 'node:test';
import assert from 'node:assert/strict';
import { indexStorage } from './helpers/indexStorage.js';
import { fixtureAccount } from './helpers/domainFixture.js';
import { getCoverage, recordPageCoverage, hasTrustedBoundary } from '../src/l2/coverageAdmission.js';
import type { PageObservation } from '../src/l2/pageObservation.js';
const accountId = fixtureAccount().id;
let time = 0;
function page(cursor: string | null = null, next: string | null = null, values = [100, 70]): PageObservation {
    return { accountId, providerId: 'gemini', streamId: 'recent', requestCursor: cursor, nextCursor: next,
        requestedAt: ++time, requestKnown: true, valid: true, ordered: true, keys: values.map(t => ({ id: 'id' + t, time: t })) };
}
test('Coverage exposes only committed range and callers receive detached baselines', async () => {
    const env = indexStorage();
    try {
        assert.equal(await getCoverage(accountId,'recent'),null);
        await recordPageCoverage(accountId,page());
        const frozen = (await getCoverage(accountId,'recent'))!;
        assert.deepEqual(Object.keys(frozen),['range']);
        frozen.range!.head.time = 999;
        assert.equal((await getCoverage(accountId,'recent'))!.range!.head.time,100);
        assert.deepEqual(env.local,{},'cursor/run/checkpoint state never enters Chrome Settings');
    } finally { env.restore(); }
});
test('a fresh partial chain cannot establish range, terminal proof can, and retries preserve prior range', async () => {
    const env = indexStorage();
    try {
        await recordPageCoverage(accountId, page(null, 'limit'));
        assert.deepEqual(await getCoverage(accountId, 'recent'), { range: null });
        await recordPageCoverage(accountId, { ...page('limit', null, []), terminal: 'provider_limit' });
        const frozen = (await getCoverage(accountId, 'recent'))!;
        assert.equal(frozen.range?.head.time, 100);
        const head = page(null, 'bridge', [120, 110]);
        await recordPageCoverage(accountId, head);
        assert.deepEqual(await getCoverage(accountId, 'recent'), frozen);
        assert.equal(await hasTrustedBoundary(accountId, frozen, head), false);
        await recordPageCoverage(accountId, page('bridge', 'unread', [105, 85]));
        assert.equal(await hasTrustedBoundary(accountId, frozen, head), true);
        assert.equal((await getCoverage(accountId, 'recent'))?.range?.head.time, 120);
        assert.equal(frozen.range?.head.time, 100, 'frozen baseline is detached');
        assert.equal(JSON.stringify(env.local).includes('unread'), false);
    } finally { env.restore(); }
});
test('coverage storage is isolated by account and stream and propagates commit failures', async () => {
    const env = indexStorage();
    try {
        await recordPageCoverage(accountId, { ...page(), streamId: 'pinned' });
        assert.equal(await getCoverage(accountId, 'recent'), null);
        assert.equal(await getCoverage('10000000-0000-4000-8000-000000000002', 'pinned'), null);
        env.fail('coverage');
        await assert.rejects(recordPageCoverage(accountId, page()), /write failed/);
        assert.equal(await getCoverage(accountId, 'recent'), null);
        await assert.rejects(recordPageCoverage(accountId, { ...page(), accountId: null }), /Registry UUID/);
        await assert.rejects(recordPageCoverage(accountId, page(), () => false), /cancelled/);
    } finally { env.restore(); }
});

test('failed terminal commit cannot become reusable proof in a later partial observation', async () => {
    const env = indexStorage();
    try {
        await recordPageCoverage(accountId, page(null, 'end'));
        env.fail('coverage');
        await assert.rejects(recordPageCoverage(accountId, page('end', null, [60, 50])), /write failed/);
        env.fail();
        await recordPageCoverage(accountId, page('unrelated', 'unseen', [40, 30]));
        assert.deepEqual(await getCoverage(accountId, 'recent'), { range: null });
        await recordPageCoverage(accountId, page('end', null, [60, 50]));
        assert.equal((await getCoverage(accountId, 'recent'))!.range!.tail.time, 50);
    } finally { env.restore(); }
});
