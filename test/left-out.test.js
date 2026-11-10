'use strict';
/**
 * A Campaigns row that is left out of the totals must be counted and explained
 * on every screen that reports a total. Found by the final blind recall (round 4,
 * F1): Pull currency rates covered only the last 30 days, so the euro rows of
 * last month had no rate, were rejected and left out, and no screen showed the
 * count. A month where every row was left out read as "No data for that month".
 *
 * The tables are built by code: each reason a row is left out against each place
 * that shows a total (the report, the summaries, the menu message, the month
 * close and its dialog, the sidebar and the dialog page), then each spread of
 * euro days against the rate pull that must cover it.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadSeeded, loadProject, HEADERS } = require('./helpers/load');
const { openPage } = require('./helpers/page');
const { installFrankfurter } = require('./fake/services');

const NO_RATE = 'no currency rate for the day (sheetdesk, Data, Pull currency rates fetches them)';

/** Reasons: [code, a Campaigns row that is left out for it, the words of the sentence for it]. */
const REASONS = [
  ['no_rate', ['Summit Yoga', 'search', '2026-10-05', 100, 10, 1, 'JPY'], NO_RATE],
  ['bad_date', ['Summit Yoga', 'search', 'sometime in October', 100, 10, 1, 'USD'], 'no usable date'],
  ['no_client', ['', 'search', '2026-10-05', 100, 10, 1, 'USD'], 'no client name'],
  ['no_channel', ['Summit Yoga', '', '2026-10-05', 100, 10, 1, 'USD'], 'no channel'],
  ['bad_spend', ['Summit Yoga', 'search', '2026-10-05', -5, 10, 1, 'USD'], 'a spend that is below zero or not a number'],
  ['bad_clicks', ['Summit Yoga', 'search', '2026-10-05', 100, 1.5, 1, 'USD'], 'clicks that are not a whole number'],
  ['bad_conversions', ['Summit Yoga', 'search', '2026-10-05', 100, 10, 'many', 'USD'], 'conversions that are below zero or not a number']
];

const sentence = (n, parts) => n + (n === 1 ? ' Campaigns row is' : ' Campaigns rows are') + ' left out of the totals: ' + parts.join(', ') + '.';

/** The seeded project with `count` copies of a bad row, each on its own day so none replaces another. */
function withBad(row, count) {
  const p = loadSeeded();
  const rows = [];
  for (let i = 0; i < count; i++) rows.push(row.map((v, j) => (j === 2 && /^2026/.test(String(v)) ? '2026-10-0' + (1 + i) : v)));
  p.append('Campaigns', rows);
  return p;
}

const quiet = () => {
  const p = loadSeeded();
  return { p, report: p.plain(p.call('runClientReport', 'Summit Yoga', '2026-10')) };
};

// CLASS-TABLE: every reason a row is left out against every screen that shows a total
test('CLASS-TABLE: a row left out of the totals is counted, with the reason, in the report, the summaries, the menu message and the month close', () => {
  const base = quiet().report.spend;
  for (const [code, row, words] of REASONS) {
    for (const count of [1, 3]) {
      const where = code + ' x' + count;
      const want = { rows: count, reasons: { [code]: count }, text: sentence(count, [count + ' with ' + words]) };

      const p = withBad(row, count);
      const report = p.plain(p.call('runClientReport', 'Summit Yoga', '2026-10'));
      assert.deepEqual(report.leftOut, want, where + ': the report says it');
      assert.equal(report.spend, base, where + ': and the row is not in the figures');

      const q = withBad(row, count);
      const s = q.plain(q.call('buildClientSummaries'));
      assert.deepEqual(s.leftOut, want, where + ': the summaries say it');
      assert.equal(s.rejected, count, where + ': and still count it');

      const m = withBad(row, count);
      m.call('menuRebuildSummaries');
      assert.equal(m.w.ui.toasts[0].msg, s.tabs + ' tabs, ' + s.rows + ' rows. ' + want.text, where + ': the menu message says it');

      const c = withBad(row, count);
      assert.deepEqual(c.plain(c.call('runMonthClose', '2026-10')).summaries.leftOut, want, where + ': the month close says it');
      const d = withBad(row, count);
      assert.deepEqual(d.plain(d.call('dialogConfirmMonthClose', '2026-10')).leftOut, want, where + ': the dialog result says it');
    }
  }
});

// CLASS-TABLE: an ordinary sheet adds no key and no sentence anywhere
test('CLASS-TABLE: a sheet with no row left out adds no key and no sentence to any result or message', () => {
  const p = loadSeeded();
  assert.equal(p.plain(p.call('runClientReport', 'Summit Yoga', '2026-10')).leftOut, undefined);
  assert.equal(p.plain(p.call('buildClientSummaries')).leftOut, undefined);
  assert.equal(p.plain(p.call('runMonthClose', '2026-10')).summaries.leftOut, undefined);
  assert.equal(p.plain(p.call('dialogConfirmMonthClose', '2026-10')).leftOut, undefined);
  const q = loadSeeded();
  q.call('menuRebuildSummaries');
  assert.ok(!/left out of the totals/.test(q.w.ui.toasts[0].msg));
  assert.equal(p.plain(p.call('leftOutOf_', [])), null, 'no rejected row gives nothing');
});

// CLASS-TABLE: several reasons are listed in a fixed order with their own counts, and a reason the list does not know is still named
test('CLASS-TABLE: several reasons are listed in a fixed order, and an unknown reason is named', () => {
  const p = loadSeeded();
  p.append('Campaigns', [
    ['Summit Yoga', 'search', '2026-10-01', -5, 10, 1, 'USD'],
    ['Summit Yoga', 'search', '2026-10-02', 100, 10, 1, 'JPY'],
    ['Summit Yoga', 'search', '2026-10-03', 100, 10, 1, 'JPY'],
    ['Summit Yoga', 'search', 'later', 100, 10, 1, 'USD']
  ]);
  const r = p.plain(p.call('buildClientSummaries'));
  assert.deepEqual(r.leftOut.reasons, { bad_spend: 1, no_rate: 2, bad_date: 1 });
  assert.equal(r.leftOut.text, sentence(4, ['2 with ' + NO_RATE, '1 with no usable date', '1 with a spend that is below zero or not a number']));
  const odd = p.plain(p.call('leftOutOf_', [{ row: 2, reason: 'weird' }, { row: 3, reason: 'weird' }, { row: 4, reason: 'bad_clicks' }]));
  assert.equal(odd.text, sentence(3, ['1 with clicks that are not a whole number', '2 with the problem weird']));
});

/** A client whose only rows are in a currency with no rate: every row is left out. */
function allLeftOut() {
  const p = loadProject();
  p.fill('Clients', HEADERS.clients, [['Berlin Bikes', 'Jan', 'jan@berlinbikes.example.com', 'a', 'search', 1000, 'active', '', '']]);
  const rows = [];
  for (let d = 1; d <= 31; d++) rows.push(['Berlin Bikes', 'search', '2026-10-' + String(d).padStart(2, '0'), 100, 10, 1, 'EUR']);
  p.fill('Campaigns', HEADERS.campaigns, rows);
  return p;
}

// CLASS-TABLE: a month where every row was left out never reads as no data
test('CLASS-TABLE: a month where every row was left out says so on the sidebar, the dialog and the menu message and not "No data"', () => {
  const p = allLeftOut();
  const result = p.plain(p.call('sidebarRunReport', 'Berlin Bikes', '2026-10', false));
  assert.equal(result.status, 'no_data');
  assert.equal(result.leftOut.rows, 31);
  assert.equal(p.w.sent.length, 0);
  const page = openPage('Sidebar.html', { sidebarGetOptions: { clients: [], months: [] }, sidebarRunReport: result });
  page.click('run-report');
  assert.equal(page.status(), 'No report for that month. ' + sentence(31, ['31 with ' + NO_RATE]));
  assert.ok(!/No data/.test(page.status()));

  const q = allLeftOut();
  const d = q.plain(q.call('dialogConfirmMonthClose', '2026-10'));
  assert.equal(d.done, 1, 'the client counts as done, with nothing to send');
  assert.equal(d.emailed, 0);
  const closePage = openPage('Dialog.html', { dialogConfirmMonthClose: d });
  closePage.click('confirm');
  assert.ok(closePage.status().endsWith(' ' + sentence(31, ['31 with ' + NO_RATE])), closePage.status());

  const m = allLeftOut();
  m.call('menuRebuildSummaries');
  assert.equal(m.w.ui.toasts[0].msg, '0 tabs, 0 rows. ' + sentence(31, ['31 with ' + NO_RATE]));

  // a month with no rows at all is still plain no data
  const empty = openPage('Sidebar.html', { sidebarGetOptions: { clients: [], months: [] }, sidebarRunReport: { status: 'no_data', client: 'Berlin Bikes', month: '2026-09', pdfName: '', pdfId: '', replaced: 0, email: 'not_sent', spend: '' } });
  empty.click('run-report');
  assert.equal(empty.status(), 'No data for that month.');
});

// CLASS-TABLE: the sidebar and the dialog page print what the server said, once, and nothing extra on an ordinary run
test('CLASS-TABLE: the sidebar and the month close dialog print the left out sentence after the other messages', () => {
  const left = { rows: 2, reasons: { no_rate: 2 }, text: 'TWO ROWS ARE LEFT OUT.' };
  const unmatched = { rows: 1, clients: ['sumit yoga'] };
  for (const status of ['ok', 'no_data']) {
    for (const withUnmatched of [false, true]) {
      const result = { status, client: 'Summit Yoga', month: '2026-10', pdfName: 'summit-yoga-2026-10.pdf', pdfId: 'f1', replaced: 0, email: 'sent', spend: 'USD 1.00', leftOut: left };
      let want = status === 'no_data' ? 'No report for that month.' : 'Report ready: summit-yoga-2026-10.pdf. Email: sent to the client.';
      if (withUnmatched) {
        result.unmatched = unmatched;
        want += ' 1 Campaigns row(s) name a client that is not in the Clients tab (sumit yoga) and are in no report.';
      }
      const page = openPage('Sidebar.html', { sidebarGetOptions: { clients: [], months: [] }, sidebarRunReport: result });
      page.click('run-report');
      assert.equal(page.status(), want + ' TWO ROWS ARE LEFT OUT.', status + ' ' + withUnmatched);
    }
  }
  const line = '8 done, 0 failed, 0 waiting, 8 emailed, 0 not emailed (mail refused; the next close sends them).';
  const reply = { month: '2026-10', done: 8, errors: 0, pending: 0, emailed: 8, emailFailed: 0, leftOut: left };
  const page = openPage('Dialog.html', { dialogConfirmMonthClose: reply });
  page.click('confirm');
  assert.equal(page.status(), line + ' TWO ROWS ARE LEFT OUT.');
  const plain = openPage('Dialog.html', { dialogConfirmMonthClose: Object.assign({}, reply, { leftOut: undefined }) });
  plain.click('confirm');
  assert.equal(plain.status(), line);
});

/** Stretches of euro days: [label, first day, last day]. */
const SPREADS = [
  ['one day', '2026-10-15', '2026-10-15'],
  ['a month', '2026-10-01', '2026-10-31'],
  ['three months', '2026-08-20', '2026-10-31'],
  ['a year', '2025-12-10', '2026-10-31'],
  ['a month that ended long ago', '2026-01-05', '2026-01-20']
];

/** A project whose only Campaigns rows are euro rows from `first` to `last`, with no rates yet. */
function euroSheet(first, last, extra) {
  const p = loadProject();
  p.fx = require('./helpers/load').loadFixtures();
  p.fill('Clients', HEADERS.clients, [['Summit Yoga', 'Priya', 'priya@example.com', 'a', 'social', 4000, 'active', '', '']]);
  p.fill('Campaigns', HEADERS.campaigns, []);
  const start = Date.parse(first + 'T00:00:00Z');
  const days = (Date.parse(last + 'T00:00:00Z') - start) / 86400000;
  const rows = [];
  for (let i = 0; i <= days; i += Math.max(1, Math.floor(days / 6))) rows.push(['Summit Yoga', 'search', new Date(start + i * 86400000).toISOString().slice(0, 10), 50, 5, 1, 'EUR']);
  rows.push(['Summit Yoga', 'search', last, 50, 5, 1, 'EUR']);
  p.fill('Campaigns', HEADERS.campaigns, rows.concat(extra || []));
  return p;
}

const addDays = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);

// CLASS-TABLE: the rate pull covers every month the euro rows are in, in pieces of at most 92 days
test('CLASS-TABLE: Pull currency rates asks for every day from the first day of the earliest month with a foreign row, in pieces of at most 92 days', () => {
  for (const [label, first, last] of SPREADS) {
    const p = euroSheet(first, last);
    const hits = installFrankfurter(p.w, p.fx.rates);
    p.call('menuSyncRates');
    const asked = hits.requests.map((r) => {
      const q = new URL(r.url).searchParams;
      return [q.get('from'), q.get('to')];
    });
    const from = first.slice(0, 7) + '-01';
    assert.equal(asked[0][0], from, label + ': starts on the first day of the earliest month');
    assert.equal(asked[asked.length - 1][1], '2026-11-10', label + ': ends today');
    asked.forEach(([a, b], i) => {
      assert.ok(Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z') <= 91 * 86400000, label + ': piece ' + i + ' is at most 92 days');
      if (i > 0) assert.equal(a, addDays(asked[i - 1][1], 1), label + ': piece ' + i + ' follows the one before with no gap and no overlap');
    });
    const total = (Date.parse('2026-11-10T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000 + 1;
    assert.equal(asked.length, Math.ceil(total / 92), label + ': as few pieces as the range needs');
    assert.equal(p.rows('Rates').length > 1, true, label + ': rates were written');
  }
});

// CLASS-TABLE: after the pull the euro rows have a rate for the days they were typed on, so nothing is left out
test('CLASS-TABLE: after Pull currency rates a month of euro rows is in the report and nothing is left out', () => {
  const p = loadProject();
  const fx = require('./helpers/load').loadFixtures();
  p.fill('Clients', HEADERS.clients, [['Berlin Bikes', 'Jan', 'jan@berlinbikes.example.com', 'a', 'search', 1000, 'active', '', '']]);
  const rows = [];
  for (let d = 1; d <= 31; d++) rows.push(['Berlin Bikes', 'search', '2026-10-' + String(d).padStart(2, '0'), 100, 10, 1, 'EUR']);
  p.fill('Campaigns', HEADERS.campaigns, rows);
  installFrankfurter(p.w, fx.rates);
  assert.equal(p.plain(p.call('buildClientSummaries')).rejected, 31, 'before the pull every row is left out');
  p.call('menuSyncRates');
  const r = p.plain(p.call('sidebarRunReport', 'Berlin Bikes', '2026-10', false));
  assert.equal(r.status, 'ok');
  assert.equal(r.leftOut, undefined, 'no row is left out any more');
  assert.equal(p.plain(p.call('buildClientSummaries')).rejected, 0);
});

/** The range the pull asks for: [label, rows to add to a project with only USD rows, clock, sheet zone, wanted range]. */
const RANGES = [
  ['no foreign row', [['Summit Yoga', 'search', '2026-10-05', 5, 1, 0, 'USD']], null, null, { from: '2026-10-11', to: '2026-11-10' }],
  ['USD in lower case and a blank currency are not foreign', [['Summit Yoga', 'search', '2026-01-05', 5, 1, 0, 'usd'], ['Summit Yoga', 'search', '2026-01-06', 5, 1, 0, '']], null, null, { from: '2026-10-11', to: '2026-11-10' }],
  ['one euro day', [['Summit Yoga', 'search', '2026-10-05', 5, 1, 0, 'EUR']], null, null, { from: '2026-10-01', to: '2026-11-10' }],
  ['the earliest month wins', [['Summit Yoga', 'search', '2026-10-05', 5, 1, 0, 'GBP'], ['Summit Yoga', 'search', '2026-08-20', 5, 1, 0, 'eur']], null, null, { from: '2026-08-01', to: '2026-11-10' }],
  ['a row with a text date is ignored', [['Summit Yoga', 'search', 'soon', 5, 1, 0, 'EUR']], null, null, { from: '2026-10-11', to: '2026-11-10' }],
  ['a row older than three years starts three years back', [['Summit Yoga', 'search', '2020-02-03', 5, 1, 0, 'EUR']], null, null, { from: '2023-11-10', to: '2026-11-10' }],
  ['a row dated after today reaches its own day', [['Summit Yoga', 'search', '2026-12-20', 5, 1, 0, 'EUR']], null, null, { from: '2026-12-01', to: '2026-12-20' }],
  ['the day is the day in the Sheet zone', [['Summit Yoga', 'search', '2026-11-01', 5, 1, 0, 'EUR']], Date.UTC(2026, 10, 1, 1, 0, 0), 'Asia/Manila', { from: '2026-11-01', to: '2026-11-01' }],
  ['the same clock in Chicago is still the day before', [['Summit Yoga', 'search', '2026-10-31', 5, 1, 0, 'EUR']], Date.UTC(2026, 10, 1, 1, 0, 0), 'America/Chicago', { from: '2026-10-01', to: '2026-10-31' }]
];

// CLASS-TABLE: the range of the rate pull for each shape of Campaigns sheet
test('CLASS-TABLE: the rate pull range follows the foreign rows of the Campaigns sheet and the Sheet time zone', () => {
  for (const [label, rows, now, zone, want] of RANGES) {
    const p = loadProject();
    if (now) p.w.now = now;
    if (zone) p.w.run(() => p.w.globals.SpreadsheetApp.getActiveSpreadsheet().setSpreadsheetTimeZone(zone));
    p.fill('Campaigns', HEADERS.campaigns, rows);
    assert.deepEqual(p.plain(p.call('ratePullRange_')), want, label);
  }
  const bare = loadProject();
  assert.deepEqual(bare.plain(bare.call('ratePullRange_')), { from: '2026-10-11', to: '2026-11-10' }, 'no Campaigns tab: the last 30 days');
});

// CLASS-TABLE: one piece or many, a bad range is refused before any request and the counts add up
test('CLASS-TABLE: syncRatesInPieces_ refuses a bad range and adds the counts of its pieces', () => {
  const p = euroSheet('2026-08-20', '2026-10-31');
  const hits = installFrankfurter(p.w, p.fx.rates);
  for (const [a, b] of [['2026-10-31', '2026-10-01'], ['soon', '2026-10-01'], ['2026-10-01', '2026-13-01']]) {
    assert.throws(() => p.call('syncRatesInPieces_', a, b), /valid date range/, a + ' ' + b);
  }
  assert.equal(hits.requests.length, 0);
  const r = p.plain(p.call('syncRatesInPieces_', '2026-08-01', '2026-11-10'));
  assert.equal(r.pieces, 2);
  assert.equal(r.fetched, r.inserted + r.updated);
  assert.deepEqual(r.currencies, ['EUR']);
  const again = p.plain(p.call('syncRatesInPieces_', '2026-08-01', '2026-11-10'));
  assert.deepEqual([again.inserted, again.updated], [0, 0], 'a rerun changes nothing');
  assert.equal(again.fetched, r.fetched);
  const one = p.plain(p.call('syncRatesInPieces_', '2026-11-01', '2026-11-01'));
  assert.equal(one.pieces, 1);
});

/** Campaigns tab shapes for the rate pull: grids as loose as a new sheet, and as tight as one the owner trimmed to its data. */
const GRIDS = ['loose', 'tight'];
const permutations = (xs) => (xs.length < 2 ? [xs] : xs.flatMap((x, i) => permutations(xs.slice(0, i).concat(xs.slice(i + 1))).map((rest) => [x].concat(rest))));

// CLASS-TABLE: every order of the dates on the tab and every grid size against the range of the rate pull
test('CLASS-TABLE: the rate pull range ignores row order and spare grid, and an empty tab pulls 30 days', () => {
  for (const grid of GRIDS) {
    for (const order of permutations(['2026-12-20', '2026-11-25', '2026-10-05'])) {
      const p = loadProject();
      p.fill('Campaigns', HEADERS.campaigns, order.map((d) => ['Summit Yoga', 'search', d, 5, 1, 0, 'EUR']));
      if (grid === 'tight') {
        const sheet = p.sheet('Campaigns');
        sheet._maxRows = p.rows('Campaigns').length;
        sheet._maxCols = HEADERS.campaigns.length;
      }
      assert.deepEqual(p.plain(p.call('ratePullRange_')), { from: '2026-10-01', to: '2026-12-20' }, grid + ' ' + order.join(' '));
    }
    const empty = loadProject();
    empty.fill('Campaigns', HEADERS.campaigns, []);
    if (grid === 'tight') {
      const sheet = empty.sheet('Campaigns');
      sheet._maxRows = 1;
      sheet._maxCols = HEADERS.campaigns.length;
    }
    assert.deepEqual(empty.plain(empty.call('ratePullRange_')), { from: '2026-10-11', to: '2026-11-10' }, grid + ' headers only');
  }
});

/** The euro rates the stand-in holds, as Rates rows, for the days from `from` to `to`. */
const eurRows = (p, from, to) => p.fx.rates.filter((r) => r.quote === 'EUR' && r.date >= from && r.date <= to).map((r) => [r.date, r.quote, r.rate]);

// CLASS-TABLE: how many rates were on the Rates tab and how many of those had another value, against the words the owner reads
test('CLASS-TABLE: the Pull currency rates message gives the new and changed counts under the title Rates', () => {
  for (const have of [0, 3, 10]) {
    for (const changed of [0, 1, 3]) {
      if (changed > have) continue;
      const p = euroSheet('2026-10-05', '2026-10-31');
      installFrankfurter(p.w, p.fx.rates);
      const all = eurRows(p, '2026-10-01', '2026-11-10');
      assert.ok(all.length > 12, 'the stand-in holds enough euro days');
      const stored = all.slice(0, have).map((r, i) => (i < changed ? [r[0], r[1], r[2] + 0.5] : r));
      if (stored.length) p.fill('Rates', HEADERS.rates, stored);
      p.call('menuSyncRates');
      const t = p.w.ui.toasts;
      assert.equal(t.length, 1, 'one message');
      assert.equal(t[0].title, 'Rates');
      const m = /^(\d+) new, (\d+) changed$/.exec(t[0].msg);
      assert.ok(m, 'the message reads "N new, M changed": ' + t[0].msg);
      assert.deepEqual([Number(m[1]), Number(m[2])], [all.length - have, changed], 'have ' + have + ', changed ' + changed);
    }
  }
});

// CLASS-TABLE: changed rates in the first piece, the second piece or both, against the total the pieces add up to
test('CLASS-TABLE: syncRatesInPieces_ adds the changed counts of every piece into one total', () => {
  for (const inFirst of [0, 1, 2]) {
    for (const inSecond of [0, 1]) {
      const p = euroSheet('2026-08-20', '2026-10-31');
      installFrankfurter(p.w, p.fx.rates);
      const all = eurRows(p, '2026-08-01', '2026-11-10');
      const first = all.filter((r) => r[0] <= '2026-10-31');
      const second = all.filter((r) => r[0] > '2026-10-31');
      assert.ok(first.length > 3 && second.length > 0, 'both pieces hold rates');
      const bump = new Set(first.slice(0, inFirst).concat(second.slice(0, inSecond)).map((r) => r[0]));
      p.fill('Rates', HEADERS.rates, all.map((r) => (bump.has(r[0]) ? [r[0], r[1], r[2] + 0.5] : r)));
      const r = p.plain(p.call('syncRatesInPieces_', '2026-08-01', '2026-11-10'));
      assert.equal(r.pieces, 2);
      assert.deepEqual([r.fetched, r.inserted, r.updated], [all.length, 0, inFirst + inSecond], 'first ' + inFirst + ', second ' + inSecond);
    }
  }
});
