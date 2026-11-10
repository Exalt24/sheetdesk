'use strict';
/**
 * Text that Sheets reads as a value. The fake converts the forms below the way
 * Sheets does (KNOWN: seen in practice, not in the reference, US English
 * reading), and sheetText_ must protect every one of them.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadProject } = require('./helpers/load');
const { formatDate } = require('./fake/gas');

// [text, what a cell holds after it is written as if typed]
const TYPED_AS_IF_TYPED = [
  ['007', 7], ['12.50', 12.5], ['1,000', 1000], ['1,234,567.5', 1234567.5], ['1e5', 100000], ['1.5E-3', 0.0015], ['.5', 0.5],
  ['50%', 0.5], ['$5', 5], ['$1,250.75', 1250.75], ['10:30', 'time 10:30'], ['2:05 PM', 'time 14:05'],
  ['2026-10', 'date 2026-10-01'], ['2026-10-03', 'date 2026-10-03'], ['2026/10/03', 'date 2026-10-03'],
  ['3/4', 'date 2026-03-04'], ['3/4/2027', 'date 2027-03-04'], ['Oct 5', 'date 2026-10-05'], ['October 5, 2025', 'date 2025-10-05'],
  ['5 Oct', 'date 2026-10-05'], ['Oct 2026', 'date 2026-10-01'], ['true', true], ['FALSE', false]
];

// Text that stays text in Sheets: no month word, a month 13, a stray letter.
const STAYS_TEXT = ['12 apples', 'e5', '1e', '1,00', '2026-13', 'Market 5', 'Octopus 5', 'v1.2.3', 'a@b.co', '(555) 0100', 'Ana Archer'];

// Text that stays text in the fake but has the shape of a date or a time, so the guard covers it too. Another
// locale or a different day order would read some of these as a value, and an extra apostrophe costs nothing.
const SHAPED_LIKE_VALUES = ['13/40', '25:00'];

// Forms the fake does not convert but another locale or a newer Sheets might. The guard covers them anyway.
const OTHER_LOCALES = ['3-4', '3-4-2026', '4/3/2026', '2026/10'];

const p = loadProject();
const f = (name, ...args) => p.w.run(() => p.ctx[name](...args));

function show(v) {
  if (Object.prototype.toString.call(v) !== '[object Date]') return v;
  return v.getUTCFullYear() < 1900 ? 'time ' + v.toISOString().slice(11, 16) : 'date ' + formatDate(v, 'America/Chicago', 'yyyy-MM-dd');
}

function writeAndRead(values) {
  const q = loadProject();
  return q.w.run(() => {
    const sh = q.ss.getSheetByName('Sheet1');
    sh.getRange(1, 1, values.length, 1).setValues(values.map((v) => [v]));
    return sh.getRange(1, 1, values.length, 1).getValues().map((r) => r[0]);
  });
}

test('KNOWN (fake): text written to a cell is read as if typed', () => {
  const back = writeAndRead(TYPED_AS_IF_TYPED.map((r) => r[0]));
  TYPED_AS_IF_TYPED.forEach((r, i) => assert.deepEqual(show(back[i]), r[1], JSON.stringify(r[0])));
  const kept = writeAndRead(STAYS_TEXT);
  STAYS_TEXT.forEach((v, i) => assert.strictEqual(kept[i], v, JSON.stringify(v)));
});

test('KNOWN (fake): appendRow reads text as if typed, the same way setValues does', () => {
  const q = loadProject();
  q.w.run(() => {
    const sh = q.ss.getSheetByName('Sheet1');
    sh.appendRow(['2026-10', "'2026-10", '1e5']);
    const row = sh.getRange(1, 1, 1, 3).getValues()[0];
    assert.equal(Object.prototype.toString.call(row[0]), '[object Date]');
    assert.strictEqual(row[1], '2026-10');
    assert.strictEqual(row[2], 100000);
  });
});

test('sheetText_ guards every form the fake converts, and the text comes back exactly as sent', () => {
  const sent = TYPED_AS_IF_TYPED.map((r) => r[0]);
  for (const v of sent) assert.equal(f('sheetText_', v), "'" + v, JSON.stringify(v));
  const back = writeAndRead(sent.map((v) => f('sheetText_', v)));
  sent.forEach((v, i) => assert.strictEqual(back[i], v, JSON.stringify(v)));
});

test('sheetText_ leaves ordinary text alone, so names and notes are not littered with apostrophes', () => {
  for (const v of STAYS_TEXT) assert.equal(f('sheetText_', v), v, JSON.stringify(v));
});

test('sheetText_ also guards forms that only other locales read as a value', () => {
  for (const v of OTHER_LOCALES.concat(SHAPED_LIKE_VALUES)) assert.equal(f('sheetText_', v), "'" + v, JSON.stringify(v));
  const kept = writeAndRead(SHAPED_LIKE_VALUES);
  SHAPED_LIKE_VALUES.forEach((v, i) => assert.strictEqual(kept[i], v, 'the fake keeps ' + v + ' as text'));
});

test('a month key written by the script stays text: each writer of 2026-10 goes through the guard', () => {
  // The lookups compare String(cell) with '2026-10'. A date cell would never match.
  const q = loadProject();
  q.fill('Clients', ['client', 'contact_name', 'contact_email', 'ad_account_id', 'primary_channel', 'monthly_budget', 'status', 'intake_response_id', 'created_at'],
    [['Harbor Lane Bakery', 'Mira', 'mira@harborlanebakery.example.com', 'a1', 'search', 100, 'active', '', '']]);
  q.fill('Campaigns', ['client', 'channel', 'date', 'spend', 'clicks', 'conversions', 'currency'],
    [['Harbor Lane Bakery', 'search', '2026-10-02', 10, 5, 1, 'USD']]);
  q.call('runClientReport', 'Harbor Lane Bakery', '2026-10', { preview: true });
  q.call('buildClientSummaries');
  q.call('runMonthClose', '2026-10');
  q.call('startBulkNormalize');
  const kinds = (name, col) => q.rows(name).slice(1).map((r) => typeof r[col]);
  assert.deepEqual(kinds('Report Log', 1), ['string']);
  assert.deepEqual(q.rows('Report Log')[1][1], '2026-10');
  assert.deepEqual(q.rows('Summary - Harbor Lane Bakery').slice(1).map((r) => r[0]), ['2026-10', '2026-10']);
  assert.deepEqual(q.rows('Job Log').filter((r) => r[0] === 'month close').map((r) => r[1]), ['2026-10']);
  assert.deepEqual(q.rows('Clean')[1][3], '2026-10');
  assert.deepEqual(q.rows('Rollup')[1].slice(0, 2), ['Harbor Lane Bakery', '2026-10']);
});

test('a month close that runs twice leaves one Job Log row and one Report Log row for the month', () => {
  const q = loadProject();
  q.fill('Clients', ['client', 'contact_name', 'contact_email', 'ad_account_id', 'primary_channel', 'monthly_budget', 'status', 'intake_response_id', 'created_at'],
    [['Harbor Lane Bakery', 'Mira', 'mira@harborlanebakery.example.com', 'a1', 'search', 100, 'active', '', '']]);
  q.fill('Campaigns', ['client', 'channel', 'date', 'spend', 'clicks', 'conversions', 'currency'],
    [['Harbor Lane Bakery', 'search', '2026-10-02', 10, 5, 1, 'USD']]);
  q.call('runMonthClose', '2026-10');
  q.call('runMonthClose', '2026-10');
  assert.equal(q.rows('Job Log').filter((r) => r[0] === 'month close').length, 1);
  assert.equal(q.rows('Report Log').length, 2);
  assert.equal(q.w.sent.length, 1, 'the client was emailed once');
});
