import test from 'node:test';
import assert from 'node:assert/strict';
import { CoverageSession, emptyStream } from '../src/l2/streamCoverage.js';
import type { PageObservation } from '../src/l2/pageObservation.js';
function page(times: number[], requestCursor: string | null = null, nextCursor: string | null = null): PageObservation {
    return { providerId: 'other-provider', accountId: 'a', streamId: 'activity', requestCursor, nextCursor,
        requestKnown: true, requestedAt: 1, valid: true, ordered: true, keys: times.map(time => ({ id: 'id' + time, time })) };
}
test('partial and disconnected pages never establish a new trusted history boundary', () => {
    const s = new CoverageSession();
    assert.deepEqual(s.observe(emptyStream(), page([100, 90], null, 'next')), { range: null });
    assert.deepEqual(s.observe(emptyStream(), page([80], 'unrelated')), { range: null });
    assert.equal(s.exhausted(), false);
});
test('out of order arrival and repeated identical pages certify the same terminal chain', () => {
    const pages = [page([100, 90], null, 'next'), page([80, 70], 'next')];
    for (const order of [[0, 1], [1, 0], [1, 1, 0, 0]]) {
        const s = new CoverageSession(); let result = emptyStream();
        for (const i of order) result = s.observe(result, pages[i]);
        assert.deepEqual(result, { range: { head: pages[0].keys[0], tail: pages[1].keys[1] } });
        assert.equal(s.exhausted(), true);
    }
});
test('a provider history limit is a terminal boundary only behind a continuous head chain', () => {
    const s = new CoverageSession(), head = page([100], null, 'limit');
    const limit = { ...page([], 'limit'), terminal: 'provider_limit' as const };
    assert.deepEqual(s.observe(emptyStream(), limit), emptyStream());
    assert.deepEqual(s.observe(emptyStream(), head), { range: { head: head.keys[0], tail: head.keys[0] } });
});
test('interruption retains the prior range, and only a connected current head can extend it', () => {
    const prior = { range: { head: { id: 'old100', time: 100 }, tail: { id: 'old70', time: 70 } } };
    const s = new CoverageSession(), head = page([120, 110], null, 'bridge');
    assert.deepEqual(s.observe(prior, head), prior);
    s.observe(prior, page([105, 85], 'unrelated', 'unread'));
    assert.equal(s.connects(prior, head), false);
    s.observe(prior, page([105, 85], 'bridge', 'unread'));
    assert.equal(s.connects(prior, head), true);
    assert.deepEqual(s.extend(prior), { range: { head: head.keys[0], tail: prior.range.tail } });
    assert.equal(s.connects(emptyStream(), head), false);
});
test('invalid evidence, cursor loops and repeated IDs cannot certify a terminal chain', () => {
    for (const kind of ['invalid', 'unknown', 'loop', 'duplicate', 'missing']) {
        const s = new CoverageSession(), head = page([100], null, 'next');
        s.observe(emptyStream(), head);
        const tail = page([80], kind === 'missing' ? 'unrelated' : 'next');
        if (kind === 'invalid') tail.valid = false;
        if (kind === 'unknown') tail.requestKnown = false;
        if (kind === 'loop') tail.nextCursor = 'next';
        if (kind === 'duplicate') tail.keys[0].id = head.keys[0].id;
        assert.deepEqual(s.observe(emptyStream(), tail), emptyStream(), kind);
        assert.equal(s.exhausted(), false, kind);
    }
});
test('complete disjoint snapshots replace the old boundary; empty history retains only range null', () => {
    const prior = { range: { head: { id: 'old', time: 100 }, tail: { id: 'tail', time: 70 } } };
    assert.deepEqual(new CoverageSession().observe(prior, page([200, 150])), { range: { head: { id: 'id200', time: 200 }, tail: { id: 'id150', time: 150 } } });
    assert.deepEqual(new CoverageSession().observe(prior, page([])), emptyStream());
});
test('unordered source rows never certify Coverage or a trusted early-stop boundary', () => {
    const s = new CoverageSession();
    assert.deepEqual(s.observe(emptyStream(), { ...page([100, 60, 90], null, 'tail'), ordered: false }), emptyStream());
    assert.deepEqual(s.observe(emptyStream(), page([80, 50], 'tail')), emptyStream());
    assert.equal(s.exhausted(), false);
});
test('a cursor link cannot stitch pages of different accounts, streams or acquisition order', () => {
    for (const patch of [{ accountId: 'other' }, { streamId: 'other' }, { providerId: 'other' }, { requestedAt: 0 }]) {
        const s = new CoverageSession(), head = page([100], null, 'next');
        s.observe(emptyStream(), head);
        assert.deepEqual(s.observe(emptyStream(), { ...page([90], 'next'), ...patch }), emptyStream());
        assert.equal(s.exhausted(), false);
    }
    const crossPageTime = new CoverageSession();
    crossPageTime.observe(emptyStream(), page([100], null, 'next'));
    assert.deepEqual(crossPageTime.observe(emptyStream(), page([110], 'next')), emptyStream());
});

test('Coverage observations require safe-integer Unix milliseconds, not merely finite numbers', () => {
    for (const time of [0.5, Number.MAX_SAFE_INTEGER + 1]) {
        const session = new CoverageSession();
        assert.deepEqual(session.observe(emptyStream(), page([time])), emptyStream());
        assert.equal(session.exhausted(), false);
        assert.deepEqual(session.observe(emptyStream(), { ...page([100]), requestedAt: time }), emptyStream());
    }
});

test('replayed Coverage observations identify keys by ID and source time, not object property order', () => {
    const s = new CoverageSession();
    const head = page([100], null, 'next');
    assert.deepEqual(s.observe(emptyStream(), head), emptyStream());
    const replay = { ...head, keys: [{ time: 100, id: 'id100' }] };
    assert.deepEqual(s.observe(emptyStream(), replay), emptyStream());
    const tail = page([80], 'next');
    assert.deepEqual(s.observe(emptyStream(), tail), { range: { head: head.keys[0], tail: tail.keys[0] } });
});

test('Coverage caches only cursor evidence, never extra properties', () => {
    const s = new CoverageSession();
    const rows = [{ token: 'source-only-secret' }];
    const observation = {
        ...page([100]), items: rows,
    };
    assert.deepEqual(s.observe(emptyStream(), observation), {
        range: { head: observation.keys[0], tail: observation.keys[0] },
    });
    const pages: unknown = Reflect.get(s, 'pages');
    assert.ok(pages instanceof Map);
    const retained: unknown = pages.get(null);
    assert.ok(retained && typeof retained === 'object');
    assert.notStrictEqual(retained, observation);
    assert.equal(Object.hasOwn(retained, 'items'), false, 'source items must not be retained in coverage');
});

test('Coverage early-stop matching accepts evidence without source items', () => {
    const prior = { range: { head: { id: 'old100', time: 100 }, tail: { id: 'old70', time: 70 } } };
    const s = new CoverageSession();
    const head = page([120, 110], null, 'bridge');
    s.observe(prior, head);
    s.observe(prior, page([105, 85], 'bridge', 'more'));
    assert.equal(s.connects(prior, head), true);
});
