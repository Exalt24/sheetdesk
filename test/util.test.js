'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadProject, HEADERS } = require('./helpers/load');
const { rng } = require('../scripts/seed');

const p = loadProject();
const f = (name, ...args) => p.w.run(() => p.ctx[name](...args));

// Every start a cell can be misread from, crossed with a few bodies: the class, not one example.
const RISKY_STARTS = ['=', '+', '-', '@', '\t', '\r', "'"];
const BODIES = ['1+1', 'SUM(A1:A2)', 'cmd|calc', ' x', 'IMPORTXML("http://e.example.test","//a")', '63 912 345 6789'];
const LOOKS_LIKE_DATA = ['007', '12', '-5', '12.50', '2026-10-05', '2026-10-05 10:00', '2026-10-05T10:00:00', 'true', 'TRUE', 'False'];
const PLAIN = ['hello', 'Ana Archer', 'a=b', 'x-1', '12 apples', '(555) 0100', 'Harbor Lane Bakery', '1e3', 'v1.2.3', '', 'a@b.co'];

test('sheetText_: anything Sheets could read as a formula, number, date or boolean gets an apostrophe', () => {
  const risky = [];
  for (const s of RISKY_STARTS) for (const b of BODIES) risky.push(s + b);
  risky.push(...LOOKS_LIKE_DATA);
  for (const v of risky) assert.equal(f('sheetText_', v), "'" + v, JSON.stringify(v));
  for (const v of PLAIN) assert.equal(f('sheetText_', v), v, JSON.stringify(v));
  assert.equal(f('sheetText_', null), '');
  assert.equal(f('sheetText_', undefined), '');
  assert.equal(f('sheetText_', 42), "'42");
});

test('sheetText_: every risky value reads back exactly as sent after a trip through the sheet, with no formula', () => {
  const q = loadProject();
  const values = [];
  for (const s of RISKY_STARTS) for (const b of BODIES) values.push(s + b);
  values.push(...LOOKS_LIKE_DATA, ...PLAIN.filter((x) => x));
  q.w.run(() => {
    const sh = q.ss.getSheetByName('Sheet1');
    const written = values.map((v) => [q.ctx.sheetText_(v)]);
    sh.getRange(1, 1, written.length, 1).setValues(written);
    const back = sh.getRange(1, 1, written.length, 1).getValues();
    // a leading apostrophe in the original is kept as typed text, so compare strings
    values.forEach((v, i) => assert.strictEqual(back[i][0], v, JSON.stringify(v)));
  });
  assert.deepEqual(q.w.formulas, []);
});

test('the same values WITHOUT sheetText_ would have become formulas or numbers (the guard has a reason)', () => {
  const q = loadProject();
  q.w.run(() => {
    const sh = q.ss.getSheetByName('Sheet1');
    sh.getRange(1, 1, 3, 1).setValues([['=IMPORTXML("x","y")'], ['007'], ['2026-10-05']]);
    const v = sh.getRange(1, 1, 3, 1).getValues();
    assert.equal(v[1][0], 7);
    assert.equal(Object.prototype.toString.call(v[2][0]), '[object Date]');
  });
  assert.equal(q.w.formulas.length, 1);
});

test('centsToText_', () => {
  const table = [[0, '0.00'], [5, '0.05'], [100, '1.00'], [123456, '1,234.56'], [100000000, '1,000,000.00'], [-250, '-2.50'], [99999, '999.99']];
  for (const [c, t] of table) assert.equal(f('centsToText_', c), t);
});

test('toCents_ never drifts: every amount with two decimals up to 2,000.00 round trips', () => {
  for (let c = 0; c <= 200000; c++) {
    const amount = Number((c / 100).toFixed(2));
    if (f('toCents_', amount) !== c) assert.fail('drift at ' + c);
  }
  assert.equal(f('toCents_', 0.29), 29);
});

test('round2_, parseNumber_ and parseCount_', () => {
  assert.equal(f('round2_', 1.234), 1.23);
  assert.equal(f('round2_', 0.1 + 0.2), 0.3);
  assert.equal(f('round2_', 2.5), 2.5);
  for (const [v, n] of [[5, 5], ['5', 5], [' 5.5 ', 5.5], ['-3', -3], ['5,5', null], ['abc', null], ['', null], [NaN, null], [Infinity, null], [null, null], [undefined, null], [{}, null], ['1e3', null]]) {
    assert.strictEqual(f('parseNumber_', v), n, JSON.stringify(v));
  }
  for (const [v, n] of [[5, 5], ['0', 0], [5.5, null], [-1, null], ['-1', null], ['abc', null], [null, null]]) {
    assert.strictEqual(f('parseCount_', v), n, JSON.stringify(v));
  }
});

test('isIsoDate_, isMonth_, isEmail_', () => {
  for (const v of ['2026-10-05', '2028-02-29', '2026-12-31']) assert.equal(f('isIsoDate_', v), true, v);
  for (const v of ['2026-02-30', '2027-02-29', '2026-13-01', '2026-00-10', '26-10-05', '2026-10-5', '', null, 20261005, '2026-10-05 ']) assert.equal(f('isIsoDate_', v), false, String(v));
  for (const v of ['2026-01', '2026-12']) assert.equal(f('isMonth_', v), true);
  for (const v of ['2026-00', '2026-13', '2026-1', '202-10', ' 2026-10', '2026-10\n', null, 202610]) assert.equal(f('isMonth_', v), false, String(v));
  for (const v of ['a@b.co', 'first.last@sub.example.com', 'x+tag@example.org']) assert.equal(f('isEmail_', v), true, v);
  for (const v of ['a@b', '@b.co', 'a b@c.co', 'a@b.co,c@d.co', 'a@b.co;c@d.co', '<a@b.co>', '', null, 'a@@b.co', 'x'.repeat(250) + '@b.co']) assert.equal(f('isEmail_', v), false, String(v));
});

test('safeEquals_ is true only for identical strings', () => {
  assert.equal(f('safeEquals_', 'abc', 'abc'), true);
  for (const [a, b] of [['abc', 'abd'], ['abc', 'abcd'], ['abcd', 'abc'], ['', 'a'], ['a', ''], ['abc', 'ABC'], [1, 1], [null, null], [undefined, 'a'], ['a', ['a']]]) {
    assert.equal(f('safeEquals_', a, b), false, JSON.stringify([a, b]));
  }
  assert.equal(f('safeEquals_', '', ''), true);
});

test('summaryTabName_ stays under 100 characters and has none of the forbidden ones', () => {
  assert.equal(f('summaryTabName_', 'A/B [Co]: *?'), 'Summary - A-B -Co-- --');
  assert.ok(f('summaryTabName_', 'x'.repeat(500)).length <= 100);
  assert.ok(!/[[\]*/\\?:]/.test(f('summaryTabName_', '[]*/\\?:')));
});

test('makeDateFormatter_ gives what Utilities.formatDate gives, and caches by time', () => {
  const calls = [];
  p.w.hook = ({ name }) => { if (name === 'Utilities.formatDate') calls.push(1); };
  const out = p.w.run(() => {
    const fmt = p.ctx.makeDateFormatter_('America/Chicago', 'yyyy-MM-dd');
    const d = new Date(Date.UTC(2026, 9, 3, 3, 0, 0));
    return [fmt(d), fmt(new Date(d.getTime())), fmt(d)];
  });
  p.w.hook = null;
  assert.deepEqual(out, ['2026-10-02', '2026-10-02', '2026-10-02']);
});

test('perUsdFor_ picks the latest earlier day within 7 days, by binary search over any size', () => {
  const rand = rng(5);
  const days = [];
  let t = Date.UTC(2026, 0, 1);
  for (let i = 0; i < 300; i++) {
    if (rand() < 0.7) days.push(new Date(t).toISOString().slice(0, 10));
    t += 86400000;
  }
  const rows = days.map((d, i) => [new Date(d + 'T06:00:00Z'), 'EUR', 0.5 + i / 1000]);
  const table = p.w.run(() => p.ctx.buildRateTable_(rows, 'Etc/UTC'));
  for (let probe = 0; probe < 400; probe++) {
    const iso = new Date(Date.UTC(2025, 11, 20) + probe * 86400000).toISOString().slice(0, 10);
    let want = null;
    for (let i = days.length - 1; i >= 0; i--) {
      if (days[i] <= iso) {
        const gap = (Date.parse(iso) - Date.parse(days[i])) / 86400000;
        want = gap <= 7 ? 0.5 + i / 1000 : null;
        break;
      }
    }
    assert.strictEqual(f('perUsdFor_', table, 'EUR', iso), want, iso);
  }
  assert.equal(f('perUsdFor_', table, 'USD', '2026-01-01'), 1);
  assert.equal(f('perUsdFor_', table, 'JPY', '2026-01-01'), null);
});

test('upsertCampaigns_: new rows go in one block, changed rows in runs, same rows are left alone', () => {
  const q = loadProject();
  q.fill('Campaigns', HEADERS.campaigns, [
    ['A', 'search', '2026-10-01', 1, 1, 0, 'USD'],
    ['A', 'search', '2026-10-02', 2, 1, 0, 'USD'],
    ['A', 'search', '2026-10-03', 3, 1, 0, 'USD'],
    ['A', 'search', '2026-10-04', 4, 1, 0, 'USD'],
    ['A', 'search', '2026-10-05', 5, 1, 0, 'USD']
  ]);
  let writes = 0;
  q.w.hook = ({ name }) => { if (name === 'Range.setValues') writes++; };
  const r = q.w.run(() => q.ctx.upsertCampaigns_(q.ss, [
    ['A', 'Search', '2026-10-01', 1, 1, 0, 'usd'],
    ['A', 'search', '2026-10-02', 20, 1, 0, 'USD'],
    ['A', 'search', '2026-10-03', 30, 1, 0, 'USD'],
    ['A', 'search', '2026-10-05', 50, 1, 0, 'USD'],
    ['B', 'search', '2026-10-01', 9, 1, 0, 'USD'],
    ['B', 'search', '2026-10-02', 9, 1, 0, 'USD']
  ]));
  assert.deepEqual(q.plain(r), { inserted: 2, updated: 3, unchanged: 1 });
  assert.equal(writes, 3, 'two runs of changed rows and one block of new rows');
  assert.deepEqual(q.rows('Campaigns').slice(1).map((x) => x[3]), [1, 20, 30, 4, 50, 9, 9]);
});
