'use strict';
/**
 * Spend and the date are the only values a Campaigns row must have. A blank
 * clicks or conversions cell counts as 0 and conversions may be fractional;
 * text, a negative number or fractional clicks still reject the row, and the
 * summary and the bulk job agree on which rows those are.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadProject, HEADERS } = require('./helpers/load');

const CLIENT = ['Summit Yoga', 'Priya Raman', 'priya@example.com', 'acct-1', 'social', 4000, 'active', '', ''];

function project(rows) {
  const p = loadProject();
  p.fill('Clients', HEADERS.clients, [CLIENT]);
  p.fill('Campaigns', HEADERS.campaigns, rows);
  return p;
}

/** The ALL line of October: [month, ALL, spend, clicks, conversions, cpc, cpa, conv_rate] or undefined. */
function allLine(p) {
  return (p.rows('Summary - Summit Yoga') || []).find((r) => r[0] === '2026-10' && r[1] === 'ALL');
}

// CLASS-TABLE: every count cell value in each count column. accepted: false means the row is rejected and its spend is left out.
const VALUES = [
  ['blank', '', true, 0],
  ['spaces only', '   ', true, 0],
  ['zero', 0, true, 0],
  ['whole number', 7, true, 7],
  ['whole number as text', '7', true, 7],
  ['fractional', 2.5, 'conversions', 2.5],
  ['fractional as text', '2.5', 'conversions', 2.5],
  ['text', 'abc', false, null],
  ['negative', -1, false, null],
  ['negative as text', '-3', false, null]
];
const TABLE = [];
for (const column of ['clicks', 'conversions']) {
  for (const [label, value, accepted, counted] of VALUES) {
    TABLE.push({ column, label, value, accepted: accepted === true || accepted === column, counted });
  }
}

test('CLASS-TABLE: a count cell value either counts or rejects the row, and spend is only lost when it rejects', () => {
  for (const row of TABLE) {
    const idx = row.column === 'clicks' ? 4 : 5;
    const odd = ['Summit Yoga', 'search', '2026-10-04', 40, 10, 2, 'USD'];
    odd[idx] = row.value;
    const p = project([['Summit Yoga', 'search', '2026-10-03', 10, 5, 1, 'USD'], odd]);
    const where = row.column + ' ' + row.label;
    const r = p.plain(p.call('buildClientSummaries'));
    const all = allLine(p);
    assert.equal(r.rejected, row.accepted ? 0 : 1, where + ' rejected');
    assert.equal(all[2], row.accepted ? 50 : 10, where + ' spend');
    const clicks = row.column === 'clicks' ? (row.accepted ? 5 + row.counted : 5) : (row.accepted ? 15 : 5);
    const conversions = row.column === 'conversions' ? (row.accepted ? 1 + row.counted : 1) : (row.accepted ? 3 : 1);
    assert.equal(all[3], clicks, where + ' clicks');
    assert.equal(all[4], conversions, where + ' conversions');
    // the bulk job reads the same rows the same way
    p.call('startBulkNormalize');
    const status = p.rows('Clean')[2][8];
    assert.equal(status, row.accepted ? 'ok' : 'bad:bad_' + row.column, where + ' bulk status');
  }
  assert.ok(TABLE.some((x) => x.accepted && x.label === 'blank') && TABLE.some((x) => !x.accepted && x.label === 'text'), 'harm rows and rows that stay rejected');
});

test('CLASS-TABLE: parseCampaignRow_ reads every shape of an empty count cell the same way', () => {
  const p = project([]);
  const fmt = (d) => d.toISOString().slice(0, 10);
  const day = p.get('new Date(Date.UTC(2026, 9, 3, 12))');
  const shapes = [['undefined', undefined, true], ['null', null, true], ['empty text', '', true], ['tab and spaces', ' \t ', true],
    ['zero', 0, true], ['text', 'n/a', false], ['false', false, false]];
  for (const column of [4, 5]) {
    for (const [label, value, ok] of shapes) {
      const row = ['Summit Yoga', 'search', day, 10, 5, 1, 'USD'];
      row[column] = value;
      const r = p.plain(p.call('parseCampaignRow_', row, fmt, {}));
      const where = 'column ' + column + ' ' + label;
      assert.equal(r.ok, ok, where);
      if (ok) assert.equal(r[column === 4 ? 'clicks' : 'conversions'], 0, where + ' counts as 0');
      else assert.equal(r.reason, column === 4 ? 'bad_clicks' : 'bad_conversions', where);
    }
  }
});

test('CLASS-TABLE: fractional conversions add up without float drift, in one channel, across channels and for ALL', () => {
  const parts = [0.1, 0.2, 0.7, 0.3, 1.1, 2.2, 0.35, 0.65];
  for (const second of ['search', 'social']) {
    for (let i = 0; i < parts.length; i++) {
      for (let j = 0; j < parts.length; j++) {
        const p = project([
          ['Summit Yoga', 'search', '2026-10-03', 10, 5, parts[i], 'USD'],
          ['Summit Yoga', second, '2026-10-04', 10, 5, parts[j], 'USD']
        ]);
        p.call('buildClientSummaries');
        const want = Math.round((parts[i] + parts[j]) * 100) / 100;
        const where = parts[i] + ' + ' + parts[j] + ' with the second row in ' + second;
        assert.equal(allLine(p)[4], want, where);
        if (second === 'search') {
          const channel = p.rows('Summary - Summit Yoga').find((r) => r[0] === '2026-10' && r[1] === 'search');
          assert.equal(channel[4], want, 'channel line, ' + where);
        }
        p.call('startBulkNormalize');
        assert.equal(p.rows('Rollup')[1][4], want, 'rollup, ' + where);
      }
    }
  }
});

test('whole counts still sum as before', () => {
  const p = project([
    ['Summit Yoga', 'search', '2026-10-03', 10, 5, 1, 'USD'],
    ['Summit Yoga', 'search', '2026-10-04', 10, 5, 2, 'USD']
  ]);
  p.call('buildClientSummaries');
  assert.deepEqual(allLine(p), ['2026-10', 'ALL', 20, 10, 3, 2, 6.67, 0.3]);
});
