import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BOOTSTRAP_START_DATE,
  cumulativeHistory,
  getHistoryRange,
  getQueryRange,
  mergeHistory,
  renderSvg,
} from './update-install-stats.mjs';

test('GA query always covers exactly the latest 60 days through yesterday', () => {
  assert.deepEqual(getQueryRange(new Date('2026-10-07T12:00:00Z')), {
    startDate: '2026-08-08',
    endDate: '2026-10-06',
  });
});

test('Pacific evening manual run ends on the last complete GA property day', () => {
  assert.deepEqual(getQueryRange(new Date('2026-10-08T03:25:00Z')), {
    startDate: '2026-08-08',
    endDate: '2026-10-06',
  });
});

test('bootstrap history boundary is August 30, 2026', () => {
  assert.equal(BOOTSTRAP_START_DATE, '2026-08-30');
  assert.deepEqual(getHistoryRange({ startDate: '2026-08-08', endDate: '2026-10-06' }), {
    startDate: BOOTSTRAP_START_DATE,
    endDate: '2026-10-06',
  });
  assert.deepEqual(getHistoryRange({ startDate: '2026-08-31', endDate: '2026-10-29' }), {
    startDate: '2026-08-31',
    endDate: '2026-10-29',
  });
});

test('merge replaces queried dates, fills missing dates with zero, and preserves older history', () => {
  const merged = mergeHistory(
    [
      { date: '2026-08-01', installs: 4 },
      { date: '2026-09-02', installs: 99 },
      { date: '2026-09-04', installs: 7 },
    ],
    [{ date: '2026-09-02', installs: 3 }],
    { startDate: '2026-09-02', endDate: '2026-09-04' },
  );
  assert.deepEqual(merged, [
    { date: '2026-08-01', installs: 4 },
    { date: '2026-09-02', installs: 3 },
    { date: '2026-09-03', installs: 0 },
    { date: '2026-09-04', installs: 0 },
  ]);
  assert.deepEqual(
    mergeHistory(merged, [{ date: '2026-09-02', installs: 3 }], { startDate: '2026-09-02', endDate: '2026-09-04' }),
    merged,
  );
});

test('cumulative values and SVG present the requested title and current total', () => {
  const daily = [
    { date: '2026-09-01', installs: 2 },
    { date: '2026-09-02', installs: 3 },
  ];
  assert.deepEqual(cumulativeHistory(daily).map((row) => row.cumulative), [2, 5]);
  const svg = renderSvg(daily);
  assert.match(svg, /Cumulative Chrome Web Store Installs/);
  assert.match(svg, />5<\/text>/);
});
