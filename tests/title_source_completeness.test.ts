import test from 'node:test';
import assert from 'node:assert/strict';
import { TITLE_AUTHORITY_RANK, titleAuthorityRank, resolveTitle } from '../src/l2/titleAuthority.js';

test('canonical title authority gives every declared source a numeric rank', () => {
    for (const [source, rank] of Object.entries(TITLE_AUTHORITY_RANK)) {
        assert.equal(typeof rank, 'number', source);
        assert.equal(titleAuthorityRank(source), rank);
    }
    assert.equal(titleAuthorityRank('unknown'), 0);
});

test('canonical title authority ranks are distinct and ordered by source', () => {
    assert.deepEqual(TITLE_AUTHORITY_RANK, { user: 3, provider: 2, derived: 1 });
});

test('detail title outranks passive sniff in canonical authority', () => {
    assert.ok(TITLE_AUTHORITY_RANK.provider > TITLE_AUTHORITY_RANK.derived);
    assert.deepEqual(resolveTitle([
        { source: "derived", value: 'Passive title' },
        { source: "provider", value: 'Detailed title' },
    ])?.value, 'Detailed title');
});
