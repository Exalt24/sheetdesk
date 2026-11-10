'use strict';
/**
 * A month close emails clients, so what it does must be stated and guarded.
 * Found by the final blind recall (round 4): F2, Close month ignored the "Send to
 * me first" box and never said it emails clients, and the sidebar started on the
 * newest month, which may still be running, so a partial report went to a client
 * and a second one followed at month end; F4, a month close reported "done" for
 * clients whose address was a list or had no dot, which got no email, and
 * nothing named them.
 *
 * The tables are built by code: each clock and Sheet time zone around a month
 * boundary against every entry point of the close, each month list against the
 * month the sidebar starts on, then each kind of unusable address against each
 * status a close can return for a client.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadSeeded, loadProject, HEADERS } = require('./helpers/load');
const { openPage } = require('./helpers/page');

const setZone = (p, zone) => p.w.run(() => p.w.globals.SpreadsheetApp.getActiveSpreadsheet().setSpreadsheetTimeZone(zone));

/** The clock, zone and month of each case: [label, zone, instant, month, may be closed, today there, first day it may be closed]. */
const CLOCKS = [
  ['Manila, the last second of October 31', 'Asia/Manila', '2026-10-31T15:59:59Z', '2026-10', false, '2026-10-31', '2026-11-01'],
  ['Manila, the first second of November 1', 'Asia/Manila', '2026-10-31T16:00:00Z', '2026-10', true],
  ['Manila on November 1 while Chicago is still October 31', 'Asia/Manila', '2026-11-01T01:00:00Z', '2026-11', false, '2026-11-01', '2026-12-01'],
  ['Chicago on the evening of October 31 while UTC is November 1', 'America/Chicago', '2026-11-01T01:00:00Z', '2026-10', false, '2026-10-31', '2026-11-01'],
  ['Chicago after midnight', 'America/Chicago', '2026-11-01T06:00:00Z', '2026-10', true],
  ['Manila, the last hour of December 31', 'Asia/Manila', '2026-12-31T15:00:00Z', '2026-12', false, '2026-12-31', '2027-01-01'],
  ['Manila, the first second of January 1', 'Asia/Manila', '2026-12-31T16:00:00Z', '2026-12', true],
  ['Kiritimati, ahead of UTC, just after midnight', 'Pacific/Kiritimati', '2026-10-31T10:00:00Z', '2026-10', true],
  ['Kiritimati, one second before midnight', 'Pacific/Kiritimati', '2026-10-31T09:59:59Z', '2026-10', false, '2026-10-31', '2026-11-01'],
  ['Pago Pago, behind UTC, when UTC is already November', 'Pacific/Pago_Pago', '2026-11-01T10:00:00Z', '2026-10', false, '2026-10-31', '2026-11-01'],
  ['a month that ended long ago', 'Asia/Manila', '2026-11-10T15:00:00Z', '2026-08', true],
  ['the running month on its last evening', 'Asia/Manila', '2026-11-30T15:59:59Z', '2026-11', false, '2026-11-30', '2026-12-01'],
  ['a leap day', 'Asia/Manila', '2028-02-29T15:00:00Z', '2028-02', false, '2028-02-29', '2028-03-01'],
  ['a month that has not started', 'Asia/Manila', '2026-11-10T15:00:00Z', '2027-03', false, '2026-11-10', '2027-04-01']
];

const refusal = (month, today, zone, next) => 'The month ' + month + ' has not ended yet: it is ' + today + ' in the Sheet time zone (' + zone +
  '), and a month close emails every client. Close it on or after ' + next + '.';

function at(zone, instant) {
  const p = loadSeeded();
  setZone(p, zone);
  p.w.now = Date.parse(instant);
  return p;
}

// CLASS-TABLE: every clock and zone around a month boundary against every entry point that can email a client for a month
test('CLASS-TABLE: a month that has not ended in the Sheet time zone is refused with the reason by every entry point of the close', () => {
  for (const [label, zone, instant, month, allowed, today, next] of CLOCKS) {
    const entries = [
      ['runMonthClose', (p) => p.call('runMonthClose', month)],
      ['dialogConfirmMonthClose', (p) => p.call('dialogConfirmMonthClose', month)],
      ['sidebarRequestMonthClose', (p) => p.call('sidebarRequestMonthClose', month)]
    ];
    for (const [name, run] of entries) {
      const where = label + ', ' + name;
      const p = at(zone, instant);
      if (allowed) {
        const r = p.plain(run(p));
        if (name === 'sidebarRequestMonthClose') {
          assert.deepEqual(r, { opened: true }, where);
          assert.match(p.w.ui.dialog.content, new RegExp('value="' + month + '"'), where + ': the dialog holds the month');
        } else {
          assert.equal(r.month, month, where);
        }
      } else {
        assert.throws(() => run(p), (e) => {
          assert.equal(e.message, refusal(month, today, zone, next), where);
          return true;
        });
        assert.equal(p.w.sent.length, 0, where + ': no email');
        assert.equal(p.w.allFiles().length, 0, where + ': no file');
        assert.equal(p.w.ui.dialog, null, where + ': no dialog');
        assert.equal(p.sheet('Job Log'), undefined, where + ': nothing logged');
      }
    }
  }
});

// CLASS-TABLE: a report for one client is a preview or a deliberate send, and is never refused for a running month
test('CLASS-TABLE: Run report still works for the running month, and a month close still emails every client for a finished one', () => {
  const p = loadSeeded();
  const r = p.plain(p.call('sidebarRunReport', 'Summit Yoga', '2026-11', true));
  assert.equal(r.status, 'no_data');
  const q = loadSeeded();
  const close = q.plain(q.call('dialogConfirmMonthClose', '2026-10'));
  assert.deepEqual([close.done, close.emailed, close.errors], [8, 8, 0]);
  assert.equal(q.w.sent.length, 8);
  assert.ok(q.w.sent.every((m) => !/^\[Preview\]/.test(m.subject)), 'a close sends to the clients, never as a preview');
});

// CLASS-TABLE: the dialog says what it does before anyone presses the button
test('CLASS-TABLE: the dialog says that clients will be emailed and that the Send to me first box does not apply, and holds the month', () => {
  for (const month of ['2026-10', '2026-09']) {
    const p = loadSeeded();
    p.call('sidebarRequestMonthClose', month);
    const d = p.w.ui.dialog;
    assert.equal(d.title, 'Close a month');
    assert.match(d.content, /This builds a report for every active client and emails each client the PDF\. Send to me first does not apply here\./);
    assert.match(d.content, new RegExp('<input id="month" value="' + month + '">'));
    assert.equal(d.height, 250, 'tall enough for the text');
    assert.ok(d.content.indexOf('emails each client') < d.content.indexOf('id="confirm"'), 'the text comes before the button');
  }
  const m = loadSeeded();
  m.call('openMonthCloseDialog');
  assert.match(m.w.ui.dialog.content, /emails each client the PDF/);
  assert.match(m.w.ui.dialog.content, /value="2026-10"/);
});

/** Month lists: [label, project, zone, instant, extra rows, wanted months, wanted default]. */
const PICKS = [
  ['the seeded months on November 10', 'seeded', 'America/Chicago', '2026-11-10T15:00:00Z', [], ['2026-10', '2026-09', '2026-08'], '2026-10'],
  ['a running month in the list', 'seeded', 'America/Chicago', '2026-11-10T15:00:00Z', [['2026-11-03']], ['2026-11', '2026-10', '2026-09', '2026-08'], '2026-10'],
  ['only the running month has rows', 'bare', 'America/Chicago', '2026-11-10T15:00:00Z', [['2026-11-03']], ['2026-11'], undefined],
  ['no rows at all', 'bare', 'America/Chicago', '2026-11-10T15:00:00Z', [], [], undefined],
  ['rows only in a future month', 'bare', 'America/Chicago', '2026-11-10T15:00:00Z', [['2027-02-03']], ['2027-02'], undefined],
  ['Manila just after midnight on November 1', 'seeded', 'Asia/Manila', '2026-10-31T16:30:00Z', [], ['2026-10', '2026-09', '2026-08'], '2026-10'],
  ['the same instant in Chicago', 'seeded', 'America/Chicago', '2026-10-31T16:30:00Z', [], ['2026-10', '2026-09', '2026-08'], '2026-09'],
  ['January with December and January rows', 'seeded', 'America/Chicago', '2027-01-05T15:00:00Z', [['2026-12-10'], ['2027-01-02']], ['2027-01', '2026-12', '2026-10', '2026-09', '2026-08'], '2026-12'],
  ['a gap: the last finished month has no rows', 'bare', 'America/Chicago', '2026-11-10T15:00:00Z', [['2026-08-03'], ['2026-11-03']], ['2026-11', '2026-08'], '2026-08']
];

// CLASS-TABLE: every month list against the month the sidebar starts on
test('CLASS-TABLE: the sidebar starts on the newest month that has ended, and never on a month the close refuses', () => {
  for (const [label, kind, zone, instant, extra, months, start] of PICKS) {
    const p = kind === 'seeded' ? loadSeeded() : loadProject();
    setZone(p, zone);
    p.w.now = Date.parse(instant);
    const rows = extra.map(([day]) => ['Summit Yoga', 'search', day, 10, 1, 0, 'USD']);
    if (kind === 'bare') p.fill('Campaigns', HEADERS.campaigns, rows);
    else if (rows.length) p.append('Campaigns', rows);
    const options = p.plain(p.call('sidebarGetOptions'));
    assert.deepEqual(options.months, months, label + ': months');
    assert.equal(options.defaultMonth, start, label + ': the month it starts on');
    assert.deepEqual(Object.keys(options), start ? ['clients', 'months', 'defaultMonth'] : ['clients', 'months'], label + ': keys');
    if (start) assert.deepEqual(p.plain(p.call('sidebarRequestMonthClose', start)), { opened: true }, label + ': the start month can be closed');
    const page = openPage('Sidebar.html', { sidebarGetOptions: options });
    assert.equal(page.value('month'), start || '', label + ': the page picks it');
  }
});

const GOOD = 'ines@foxglove.example.com';
/** Addresses: [label, address, usable]. */
const ADDRESSES = [
  ['empty', '', false],
  ['blank', '   ', false],
  ['no dot after the @', 'ana@lumen', false],
  ['a comma list', GOOD + ', owner@foxglove.example.com', false],
  ['a semicolon list', GOOD + '; owner@foxglove.example.com', false],
  ['a name and an angle address', 'Ines <' + GOOD + '>', false],
  ['a space inside', 'ines @foxglove.example.com', false],
  ['no @', 'ines.foxglove.example.com', false],
  ['a plain address', GOOD, true],
  ['a tagged address with two dots', 'ines+reports@foxglove.example.co.uk', true]
];

const clientRow = (name, email, status) => [name, 'Casey Contact', email, '', 'search', 100, status || 'active', '', ''];
const octoberRows = (name) => [[name, 'search', '2026-10-10', 100, 10, 1, 'USD'], [name, 'social', '2026-10-11', 50, 5, 1, 'USD']];

/** A project of `rows` clients, each with October rows (the ones named in `without` have September rows instead). */
function closeProject(rows, without) {
  const p = loadProject();
  p.fill('Clients', HEADERS.clients, rows);
  const campaigns = [];
  rows.forEach((r) => {
    if ((without || []).includes(r[0])) campaigns.push([r[0], 'search', '2026-09-10', 100, 10, 1, 'USD']);
    else octoberRows(r[0]).forEach((x) => campaigns.push(x));
  });
  p.fill('Campaigns', HEADERS.campaigns, campaigns);
  return p;
}

const missing = (names) => names.length + (names.length === 1 ? ' client has' : ' clients have') + ' no usable email address, so ' + (names.length === 1 ? 'it was' : 'they were') +
  ' not emailed: ' + names.join(', ') + '.';

// CLASS-TABLE: every kind of unusable address against a first close (ok) and a second one (current)
test('CLASS-TABLE: a client with no usable address is counted and named by the month close and its dialog, on every close', () => {
  for (const [label, address, usable] of ADDRESSES) {
    const rows = [clientRow('Summit Yoga', 'priya@summityoga.example.com'), clientRow('Foxglove Florist', address), clientRow('Lumen Opticals', 'ana@lumen.example.com')];
    const wanted = usable ? undefined : { count: 1, clients: ['Foxglove Florist'], text: missing(['Foxglove Florist']) };
    const p = closeProject(rows);
    const first = p.plain(p.call('runMonthClose', '2026-10'));
    assert.deepEqual(first.noAddress, wanted, label + ': first close');
    assert.deepEqual(first.results.map((r) => r.status), ['ok', 'ok', 'ok'], label);
    assert.equal(p.w.sent.length, usable ? 3 : 2, label + ': a client with no usable address gets no email');
    assert.ok(!p.w.sent.some((m) => m.to === address && !usable), label + ': nothing went to the odd address');
    const second = p.plain(p.call('runMonthClose', '2026-10'));
    assert.deepEqual(second.results.map((r) => r.status), ['current', 'current', 'current'], label);
    assert.deepEqual(second.noAddress, wanted, label + ': second close names it again');

    const q = closeProject(rows);
    const d = q.plain(q.call('dialogConfirmMonthClose', '2026-10'));
    assert.deepEqual(d.noAddress, wanted, label + ': the dialog result');
    assert.equal(d.done, 3, label + ': done counts the three');
    assert.equal(d.emailed, usable ? 3 : 2, label + ': emailed counts the ones that got mail');
    assert.deepEqual(Object.keys(d).includes('noAddress'), !usable, label);
  }
});

// CLASS-TABLE: a client that has no report, no run or is not a client this month is not named
test('CLASS-TABLE: a client with no usable address is named only when its report was built, and not for no data, a clash, a wait or a pause', () => {
  const odd = 'ines@foxglove';
  const cases = [
    ['no October rows', () => closeProject([clientRow('Summit Yoga', 'priya@summityoga.example.com'), clientRow('Foxglove Florist', odd)], ['Foxglove Florist']), (p) => p],
    ['paused', () => closeProject([clientRow('Summit Yoga', 'priya@summityoga.example.com'), clientRow('Foxglove Florist', odd, 'paused')]), (p) => p],
    ['a name clash with another active client', () => closeProject([clientRow('Summit Yoga', 'priya@summityoga.example.com'), clientRow('Foxglove Florist', odd), clientRow('foxglove florist', odd)]), (p) => p],
    ['waiting for the next call', () => closeProject([clientRow('Summit Yoga', 'priya@summityoga.example.com'), clientRow('Foxglove Florist', odd)]), (p) => { p.get('SD').BUDGET_MS = -1; return p; }]
  ];
  for (const [label, build, tweak] of cases) {
    const p = tweak(build());
    const r = p.plain(p.call('runMonthClose', '2026-10'));
    assert.equal(r.noAddress, undefined, label);
  }
  const p = closeProject([clientRow('Summit Yoga', 'priya@summityoga.example.com'), clientRow('Foxglove Florist', odd)], ['Foxglove Florist']);
  assert.deepEqual(p.plain(p.call('runMonthClose', '2026-10')).results.map((r) => r.status), ['ok', 'no_data']);
});

// CLASS-TABLE: how many are named, and how the sentence reads, for one, two, ten, eleven and twelve clients
test('CLASS-TABLE: the list of clients with no address is cut at ten, the count is whole, and the sentence agrees with the count', () => {
  for (const n of [1, 2, 9, 10, 11, 12]) {
    const names = Array.from({ length: n }, (_, i) => 'Client ' + String.fromCharCode(65 + i));
    const p = closeProject(names.map((x) => clientRow(x, 'nobody@nowhere')));
    const r = p.plain(p.call('runMonthClose', '2026-10'));
    const shown = names.slice(0, 10);
    assert.equal(r.noAddress.count, n, n);
    assert.deepEqual(r.noAddress.clients, shown, n);
    assert.equal(r.noAddress.text, n + (n === 1 ? ' client has' : ' clients have') + ' no usable email address, so ' + (n === 1 ? 'it was' : 'they were') + ' not emailed: ' +
      shown.join(', ') + (n > 10 ? ' and ' + (n - 10) + ' more' : '') + '.', n);
    assert.equal(p.w.sent.length, 0);
  }
  assert.equal(loadSeeded().plain(loadSeeded().call('noAddressOf_', [])), null);
});

// CLASS-TABLE: the dialog page prints the sentence after the others
test('CLASS-TABLE: the month close dialog prints the no address sentence after the left out sentence, and nothing on an ordinary close', () => {
  const line = '2 done, 0 failed, 0 waiting, 1 emailed, 0 not emailed (mail refused; the next close sends them).';
  const reply = { month: '2026-10', done: 2, errors: 0, pending: 0, emailed: 1, emailFailed: 0 };
  const plain = openPage('Dialog.html', { dialogConfirmMonthClose: reply });
  plain.click('confirm');
  assert.equal(plain.status(), line);
  const withBoth = Object.assign({}, reply, { leftOut: { rows: 1, reasons: {}, text: 'LEFT OUT.' }, noAddress: { count: 1, clients: ['A'], text: 'NO ADDRESS.' } });
  const page = openPage('Dialog.html', { dialogConfirmMonthClose: withBoth });
  page.click('confirm');
  assert.equal(page.status(), line + ' LEFT OUT. NO ADDRESS.');
  const only = openPage('Dialog.html', { dialogConfirmMonthClose: Object.assign({}, reply, { noAddress: withBoth.noAddress }) });
  only.click('confirm');
  assert.equal(only.status(), line + ' NO ADDRESS.');
});

// CLASS-TABLE: every text that is not a month, long gone or not, against the button that opens the close dialog
test('CLASS-TABLE: the sidebar refuses a value that is not a month before it opens the dialog', () => {
  for (const year of ['2020', '2026', '1999']) {
    for (const tail of ['-13', '-00', '-1', '-10-01', '/10', ' 10', '-10 ', '10']) {
      const month = year + tail;
      const p = loadSeeded();
      assert.throws(() => p.call('sidebarRequestMonthClose', month), /Invalid month/, JSON.stringify(month));
      assert.equal(p.w.ui.dialog, null, JSON.stringify(month) + ': no dialog');
    }
    const ok = loadSeeded();
    const month = year + '-01';
    assert.deepEqual(ok.plain(ok.call('sidebarRequestMonthClose', month)), { opened: true }, month + ': a finished month still opens');
    assert.match(ok.w.ui.dialog.content, new RegExp('value="' + month + '"'));
  }
  for (const value of [null, undefined, '', 202010, {}]) {
    const p = loadSeeded();
    assert.throws(() => p.call('sidebarRequestMonthClose', value), /Invalid month/, String(value));
    assert.equal(p.w.ui.dialog, null);
  }
});
