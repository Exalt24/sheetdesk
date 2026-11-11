'use strict';
/**
 * A record from the ad platform that does not become a Campaigns row must be
 * counted with the reason, on the result and in the menu message. Found by the
 * final blind recall (round 5): R5-6, a day record with fractional conversions
 * (docs/summaries-and-pdfs.md says Google Ads gives 2.5) was dropped as invalid,
 * records for an account no client has were dropped, and the menu message said
 * only "N new, N changed", so a pull that lost days read as a good one.
 *
 * Every skip point of the ad sync is a reason of AD_DROP_WORDS_: the eight ways a
 * record is unusable (checkAdItem_), an account id no client has, and a record
 * replaced by a later one for the same client, channel and day. The tables are
 * built by code: each reason against the result, the message and the stored rows,
 * then each kind of conversions value.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadSeeded } = require('./helpers/load');
const { installAdPlatform } = require('./fake/services');

const KEY = 'test-key';
const GOOD = { date: '2026-11-01', account_id: 'acct-1000', channel: 'search', cost_micros: 12345678, currency: 'USD', clicks: 10, conversions: 1 };
const rec = (over, i) => Object.assign({}, GOOD, i === undefined ? {} : { date: '2026-11-0' + (1 + i % 9), channel: 'ch' + i }, over);

/** [code, a record that has that problem, the words of the sentence]. */
const UNUSABLE = [
  ['not_an_object', null, 'a record that is not an object'],
  ['bad_date', rec({ date: '2026-11-01x' }), 'no usable date'],
  ['bad_account_id', rec({ account_id: '' }), 'no account id'],
  ['bad_channel', rec({ channel: '  ' }), 'no channel'],
  ['bad_cost_micros', rec({ cost_micros: -5 }), 'a cost that is not a whole number of micros'],
  ['bad_currency', rec({ currency: 'usd' }), 'a currency that is not three capital letters'],
  ['bad_clicks', rec({ clicks: 1.5 }), 'clicks that are not a whole number'],
  ['bad_conversions', rec({ conversions: 'many' }), 'conversions that are below zero or not a number']
];
const UNKNOWN = 'an account id that no client has in the Clients tab';
const DUPLICATE = 'the same client, channel and day as a later record, which replaced it';

function setup(extra) {
  const p = loadSeeded();
  installAdPlatform(p.w, { days: [GOOD].concat(extra), apiKey: KEY });
  p.setProp('AD_API_KEY', KEY);
  return p;
}
const sentence = (n, parts) => n + (n === 1 ? ' record from the ad platform is' : ' records from the ad platform are') + ' not in Campaigns as its own row: ' + parts.join(', ') + '.';
const sync = (p) => p.plain(p.call('syncAdCosts', '2026-11-01', '2026-11-09'));

// CLASS-TABLE: every way a record is unusable against the result, the message and the rows
test('CLASS-TABLE: an unusable ad record is counted with its reason in the sync result and the menu message, and never written', () => {
  for (const [code, bad, words] of UNUSABLE) {
    for (const count of [1, 3]) {
      const where = code + ' x' + count;
      const records = Array.from({ length: count }, () => bad);
      const want = { records: count, reasons: { [code]: count }, text: sentence(count, [count + ' with ' + words]) };
      const p = setup(records);
      const before = p.rows('Campaigns').length;
      const r = sync(p);
      assert.deepEqual(r.dropped, want, where + ': the result');
      assert.equal(r.invalid, count, where + ': the older count stays');
      assert.equal(r.inserted, 1, where + ': the good record is written');
      assert.equal(p.rows('Campaigns').length, before + 1, where + ': and nothing else');
      const q = setup(records);
      q.call('menuSyncAdCosts');
      assert.deepEqual(q.w.ui.toasts, [{ msg: '1 new, 0 changed. ' + want.text, title: 'Ad costs' }], where + ': the message');
      assert.equal(q.plain(q.call('checkAdItem_', bad)), code, where + ': the check');
    }
  }
  assert.strictEqual(setup([]).call('checkAdItem_', GOOD), null, 'a usable record has no problem, and the answer is null and not undefined');
});

// CLASS-TABLE: an account id that no client has is named, up to five, and an ordinary pull has no sentence
test('CLASS-TABLE: records for an account no client has are counted with the account ids, and a pull with nothing dropped adds no key and no sentence', () => {
  for (const n of [1, 2, 5, 6, 7]) {
    const ids = Array.from({ length: n }, (_, i) => 'acct-90' + i);
    const records = ids.map((id) => rec({ account_id: id, channel: 'other' }));
    const twice = ids.slice(0, 1).map((id) => rec({ account_id: id, channel: 'again' }));
    const p = setup(records.concat(twice));
    const r = sync(p);
    const shown = ids.slice(0, 5).join(', ') + (n > 5 ? ' and ' + (n - 5) + ' more' : '');
    const total = n + twice.length;
    assert.equal(r.unknownAccount, total, n);
    assert.deepEqual(r.dropped, { records: total, reasons: { unknown_account: total }, text: sentence(total, [total + ' with ' + UNKNOWN + ' (' + shown + ')']) }, n);
  }
  const p = setup([]);
  const r = sync(p);
  assert.equal(r.dropped, undefined);
  assert.ok(!('dropped' in r));
  p.call('menuSyncAdCosts');
  assert.match(p.w.ui.toasts[0].msg, /^\d+ new, \d+ changed$/);
  assert.equal(p.plain(p.call('adDroppedOf_', {}, [])), null);
});

// CLASS-TABLE: a record replaced by a later one is a count and a reason too
test('CLASS-TABLE: two records for one client, channel and day are counted as one replaced, and the later one is written', () => {
  const first = rec({ cost_micros: 1000000 }, 3);
  const later = rec({ cost_micros: 2000000 }, 3);
  const p = setup([first, later]);
  const r = sync(p);
  assert.equal(r.duplicates, 1);
  assert.deepEqual(r.dropped, { records: 1, reasons: { duplicate: 1 }, text: sentence(1, ['1 with ' + DUPLICATE]) });
  assert.equal(p.rows('Campaigns').filter((row) => row[1] === 'ch3').length, 1);
  assert.equal(p.rows('Campaigns').filter((row) => row[1] === 'ch3')[0][3], 2);
});

// CLASS-TABLE: every reason at once is listed in a fixed order with its own count, and a reason the list does not know is still named
test('CLASS-TABLE: several reasons are listed in a fixed order, and a reason the list does not know is named', () => {
  const unknownAccount = rec({ account_id: 'acct-9999', channel: 'nobody' });
  const dup1 = rec({ channel: 'twice', cost_micros: 1000000 });
  const dup2 = rec({ channel: 'twice', cost_micros: 2000000 });
  const p = setup(UNUSABLE.map((u) => u[1]).concat([unknownAccount, dup1, dup2]));
  const r = sync(p);
  const parts = UNUSABLE.map((u) => '1 with ' + u[2]).concat(['1 with ' + UNKNOWN + ' (acct-9999)', '1 with ' + DUPLICATE]);
  assert.equal(r.dropped.records, 10);
  assert.equal(r.dropped.text, sentence(10, parts));
  assert.deepEqual(Object.keys(r.dropped.reasons).sort(), UNUSABLE.map((u) => u[0]).concat(['duplicate', 'unknown_account']).sort());
  const odd = p.plain(p.call('adDroppedOf_', { weird: 2, bad_clicks: 1, none: 0 }, []));
  assert.equal(odd.text, sentence(3, ['1 with clicks that are not a whole number', '2 with the problem weird']));
  assert.equal(odd.records, 3);
});

/** Conversions values: [label, what the platform sent, what the Campaigns cell holds (undefined when the record is dropped)]. */
const CONVERSIONS = [
  ['a whole number', 7, 7],
  ['zero', 0, 0],
  ['a half', 0.5, 0.5],
  ['2.5, as Google Ads gives it', 2.5, 2.5],
  ['2.5 as text', '2.5', 2.5],
  ['a sum with float noise', 0.1 + 0.2, 0.3],
  ['more than four decimals', 1.23456, 1.2346],
  ['negative', -0.5, undefined],
  ['text', 'many', undefined],
  ['an empty string', '', undefined],
  ['null', null, undefined],
  ['no value', undefined, undefined],
  ['a list', [2], undefined]
];

// CLASS-TABLE: every kind of conversions value against the stored row and the dropped count
test('CLASS-TABLE: fractional conversions are accepted and stored to four decimals, and a negative or non numeric value drops the record with its reason', () => {
  for (const [label, value, stored] of CONVERSIONS) {
    const p = setup([rec({ conversions: value, channel: 'frac' })]);
    const r = sync(p);
    const row = p.rows('Campaigns').filter((x) => x[1] === 'frac')[0];
    if (stored === undefined) {
      assert.equal(row, undefined, label + ': not written');
      assert.deepEqual(r.dropped.reasons, { bad_conversions: 1 }, label);
      assert.equal(r.invalid, 1, label);
    } else {
      assert.ok(row, label + ': written');
      assert.equal(row[5], stored, label + ': the cell');
      assert.equal(r.dropped, undefined, label + ': nothing dropped');
      assert.equal(r.invalid, 0, label);
      const again = sync(p);
      assert.deepEqual([again.inserted, again.updated, again.unchanged], [0, 0, 2], label + ': a rerun changes nothing');
    }
  }
  // a changed fraction is an update, not a new row
  const days = [GOOD, rec({ conversions: 2.5, channel: 'frac' })];
  const p = loadSeeded();
  installAdPlatform(p.w, { days, apiKey: KEY });
  p.setProp('AD_API_KEY', KEY);
  sync(p);
  days[1] = rec({ conversions: 3.25, channel: 'frac' });
  const r = sync(p);
  assert.deepEqual([r.inserted, r.updated], [0, 1]);
  assert.equal(p.rows('Campaigns').filter((x) => x[1] === 'frac')[0][5], 3.25);
});

// CLASS-TABLE: the fractional conversions reach the report totals the sync wrote
test('CLASS-TABLE: a synced day with fractional conversions is in the summary of the client', () => {
  const p = setup([rec({ conversions: 2.5, channel: 'frac', date: '2026-11-02' }), rec({ conversions: 0.5, channel: 'frac', date: '2026-11-03' })]);
  sync(p);
  p.call('buildClientSummaries');
  const rows = p.rows('Summary - Harbor Lane Bakery').filter((x) => x[0] === '2026-11' && x[1] === 'frac');
  assert.equal(rows.length, 1);
  assert.equal(rows[0][4], 3);
});

/** Costs: [what the platform sent in micros of a dollar, what the Campaigns row holds in dollars]. */
const COSTS = [
  [0, 0],
  [4999, 0],
  [5000, 0.01],
  [14999, 0.01],
  [15000, 0.02],
  [1000000, 1],
  [12344500, 12.34],
  [12345000, 12.35],
  [12345678, 12.35]
];

// CLASS-TABLE: every cost against the dollars that are stored
test('CLASS-TABLE: the cost in micros is stored as dollars rounded to the cent, for every kind of fraction', () => {
  const records = COSTS.map(([micros], i) => rec({ cost_micros: micros, channel: 'cost' + i }));
  const p = setup(records);
  sync(p);
  COSTS.forEach(([micros, dollars], i) => {
    const row = p.rows('Campaigns').filter((x) => x[1] === 'cost' + i)[0];
    assert.ok(row, micros + ': written');
    assert.equal(row[3], dollars, micros + ' micros');
  });
});
