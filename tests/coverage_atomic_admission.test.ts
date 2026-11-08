import test from 'node:test';
import assert from 'node:assert/strict';
import { fixtureAccount } from './helpers/domainFixture.js';
import { indexStorage } from './helpers/indexStorage.js';
import type { PageObservation } from '../src/l2/pageObservation.js';
import CoverageAdmission from '../src/l2/coverageAdmission.js';
import { ingestIndexes } from '../src/l2/ingestion.js';
import { clearStoredAccountScanRecords, getCoverage, updateCoverageAtomically, getIndex,
    putIndexes, getExportRecord, putExportRecord } from '../src/l3a/storageService.js';

const accountId = fixtureAccount().id;
const otherId = fixtureAccount('chatgpt').id;
const baseline = { range: { head: { id: 'old100', time: 100 }, tail: { id: 'old70', time: 70 } } };
function seedCoverage(accountId: string, stream: string, value: typeof baseline): Promise<void> {
    return updateCoverageAtomically(accountId, stream, () => ({ next: value, result: undefined }));
}
function page(times: number[], requestCursor: string | null, nextCursor: string | null): PageObservation {
    return { providerId: 'gemini', accountId, streamId: 'recent',
        requestCursor, nextCursor, requestedAt: 1, requestKnown: true, valid: true, ordered: true,
        keys: times.map(time => ({ id: 'id' + time, time })) };
}

test('Coverage atomic callback reads the latest row and writes only an explicit next value', async () => {
    const env = indexStorage();
    try {
        assert.equal(await updateCoverageAtomically(accountId, 'recent', current => {
            assert.equal(current, null);
            return { next: baseline, result: 'first' };
        }), 'first');
        assert.deepEqual(await getCoverage(accountId, 'recent'), baseline);
        const beforeNoop = env.writes();
        assert.equal(await updateCoverageAtomically(accountId, 'recent', current => {
            assert.deepEqual(current, baseline);
            return { result: 'no-op' };
        }), 'no-op');
        assert.equal(env.writes(), beforeNoop);
        await assert.rejects(updateCoverageAtomically(accountId, 'recent', () => {
            throw new Error('invalid source evidence');
        }), /invalid source evidence/);
        assert.deepEqual(await getCoverage(accountId, 'recent'), baseline);
    } finally { env.restore(); }
});

test('Scan cleanup deletes current Account Index, streams and ExportRecords while preserving other accounts', async () => {
    const env = indexStorage();
    try {
        const key = { accountId, conversationId: 'unchanged' };
        await putIndexes([{ key, updatedAt: 10 }]);
        await putExportRecord(key, { status: 'ok', format: 'markdown', exportedAt: 10, chatTime: 10 });
        await seedCoverage(accountId, 'recent', baseline);
        await seedCoverage(accountId, 'pinned', baseline);
        await seedCoverage(otherId, 'recent', baseline);
        await clearStoredAccountScanRecords(accountId);
        assert.equal(await getCoverage(accountId, 'recent'), null);
        assert.equal(await getCoverage(accountId, 'pinned'), null);
        assert.deepEqual(await getCoverage(otherId, 'recent'), baseline);
        assert.equal(await getIndex(key), null);
        assert.equal(await getExportRecord(key), null);
    } finally { env.restore(); }
});

test('Clearing Coverage invalidates previous in-memory page chain; a late terminal cannot revive it', async () => {
    const env = indexStorage();
    try {
        await CoverageAdmission.recordPageCoverage(accountId, page([120, 110], null, 'tail'));
        assert.equal((await getCoverage(accountId, 'recent'))?.range, null);
        await clearStoredAccountScanRecords(accountId);
        assert.equal(await getCoverage(accountId, 'recent'), null);
        await CoverageAdmission.recordPageCoverage(accountId, page([90], 'tail', null));
        assert.equal((await getCoverage(accountId, 'recent'))?.range, null,
            'the stale head was invalidated; a fresh head is required');
    } finally { env.restore(); }
});

test('Cleared frozen Coverage cannot authorize early stop or resurrect a deleted range', async () => {
    const env = indexStorage();
    try {
        await seedCoverage(accountId, 'recent', baseline);
        const head = page([130, 110], null, 'tail');
        await CoverageAdmission.recordPageCoverage(accountId, head);
        await CoverageAdmission.recordPageCoverage(accountId, page([95], 'tail', 'more'));
        const { providerId: _provider, accountId: _account, ...scanHead } = head;
        assert.equal(await CoverageAdmission.hasTrustedBoundary(accountId, baseline, scanHead), true);
        await clearStoredAccountScanRecords(accountId);
        assert.equal(await CoverageAdmission.hasTrustedBoundary(accountId, baseline, scanHead), false);
        assert.equal(await getCoverage(accountId, 'recent'), null);
    } finally { env.restore(); }
});

test('Failed Coverage commit does not publish a partial in-memory cursor chain', async () => {
    const env = indexStorage();
    try {
        env.fail('coverage');
        await assert.rejects(CoverageAdmission.recordPageCoverage(accountId, page([120], null, 'tail')), /write failed/);
        env.fail();
        assert.equal(await getCoverage(accountId, 'recent'), null);
        await CoverageAdmission.recordPageCoverage(accountId, page([100], 'tail', null));
        assert.equal((await getCoverage(accountId, 'recent'))?.range, null);
    } finally { env.restore(); }
});

test('a disjoint committed replacement cannot authorize an early stop from an obsolete baseline', async () => {
    const env = indexStorage();
    try {
        await seedCoverage(accountId, 'recent', baseline);
        const head = page([130, 110], null, 'tail');
        await CoverageAdmission.recordPageCoverage(accountId, head);
        await CoverageAdmission.recordPageCoverage(accountId, page([95], 'tail', 'more'));
        const replacement = { range: { head: { id: 'new500', time: 500 }, tail: { id: 'new400', time: 400 } } };
        await seedCoverage(accountId, 'recent', replacement);
        const { providerId: _provider, accountId: _account, ...scanHead } = head;
        assert.equal(await CoverageAdmission.hasTrustedBoundary(accountId, baseline, scanHead), false);
        assert.deepEqual(await getCoverage(accountId, 'recent'), replacement);
    } finally { env.restore(); }
});

test('L2 accepts an empty provider-limit terminal after a committed Index page', async () => {
    const env = indexStorage();
    try {
        const identity = 'source-verified';
        const streamId = 'recent-limit';
        await ingestIndexes(accountId, [{ conversationId: identity, fields: { updatedAt: 100 } }], {
            streamId, requestCursor: null, nextCursor: 'limit', requestedAt: 1,
            requestKnown: true, valid: true, ordered: true, keys: [{ id: identity, time: 100 }],
        });
        assert.deepEqual((await getCoverage(accountId, streamId))?.range, null);
        await ingestIndexes(accountId, [], {
            streamId, requestCursor: 'limit', nextCursor: null, requestedAt: 2,
            requestKnown: true, valid: true, ordered: true, keys: [], terminal: 'provider_limit',
        });
        assert.deepEqual((await getCoverage(accountId, streamId))?.range, {
            head: { id: identity, time: 100 }, tail: { id: identity, time: 100 },
        });
        assert.ok(await getIndex({ accountId, conversationId: identity }));
    } finally { env.restore(); }
});

test('a genuinely empty trusted list establishes no fictitious range or Index', async () => {
    const env = indexStorage();
    try {
        await ingestIndexes(accountId, [], {
            streamId: 'recent-empty', requestCursor: null, nextCursor: null, requestedAt: 1,
            requestKnown: true, valid: true, ordered: true, keys: [],
        });
        assert.deepEqual((await getCoverage(accountId, 'recent-empty'))?.range, null);
    } finally { env.restore(); }
});
