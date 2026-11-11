'use strict';
/**
 * Nothing reaches a client before the guards. Found by the final blind recall
 * (round 5): R5-1, a month close emailed every client and only afterwards said
 * that Campaigns rows (no currency rate, a text date, a client name that is not
 * in the Clients tab) were left out of the figures, and a rerun emailed again
 * with different figures; R5-3, Run report with "Send to me first" unticked
 * emailed a client the report of a month that was still running, which the
 * month close refuses.
 *
 * The class is "a report that can reach a client". Mail is sent in two places
 * only (the report send in src/Reporting.js and the intake confirmation in
 * src/Forms.js) and the report send is reached only through buildReport_, so
 * the two guards (the month has ended, no row is left out without being said)
 * sit in buildReport_ and in the month close that calls it. The tables are
 * built by code: every entry that can mail a report against every state of the
 * month and of the sheet, then a call graph read from src/ that fails when a
 * new caller of the report send is not in the table.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadSeeded } = require('./helpers/load');
const { openPage } = require('./helpers/page');

const SRC = path.join(__dirname, '..', 'src');
const NO_RATE = 'no currency rate for the day (sheetdesk, Data, Pull currency rates fetches them)';
const GOOD = 'priya@summityoga.example.com';

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
const STRANGER = ['Sumit Yoga', 'search', '2026-10-06', 100, 10, 1, 'USD'];

const leftSentence = (n, parts) => n + (n === 1 ? ' Campaigns row is' : ' Campaigns rows are') + ' left out of the totals: ' + parts.join(', ') + '.';
const strangerSentence = (n, names) => n + (n === 1 ? ' Campaigns row names' : ' Campaigns rows name') + ' a client that is not in the Clients tab (' + names.join(', ') +
  '), so ' + (n === 1 ? 'it is' : 'they are') + ' in no report.';

/** Sheets with rows that are left out: [label, rows to add, what the held answer must be]. */
const DIRTY = REASONS.map(([code, row, words]) => {
  const text = leftSentence(1, ['1 with ' + words]);
  return [code, [row], { rows: 1, leftOut: { rows: 1, reasons: { [code]: 1 }, text }, text }];
}).concat([
  ['a client name that is not in the Clients tab', [STRANGER], { rows: 1, unmatched: { rows: 1, clients: ['Sumit Yoga'] }, text: strangerSentence(1, ['Sumit Yoga']) }],
  ['two reasons and a stranger together', [REASONS[0][1], REASONS[1][1], STRANGER, STRANGER], {
    rows: 4,
    leftOut: { rows: 2, reasons: { no_rate: 1, bad_date: 1 }, text: leftSentence(2, ['1 with ' + NO_RATE, '1 with no usable date']) },
    unmatched: { rows: 2, clients: ['Sumit Yoga'] },
    text: leftSentence(2, ['1 with ' + NO_RATE, '1 with no usable date']) + ' ' + strangerSentence(2, ['Sumit Yoga'])
  }]
]);

function dirty(rows) {
  const p = loadSeeded();
  p.append('Campaigns', rows);
  return p;
}

/** The report send called with no other code around it: the guards must hold here too. */
function direct(p, month, opts) {
  return p.w.run(() => {
    const c = p.ctx;
    const ss = c.spreadsheet_();
    const client = c.assertClient_(c.loadClients_(ss), 'Summit Yoga');
    return c.buildReport_(ss, client, month, c.aggregate_(c.readCampaigns_(ss).rows), opts);
  });
}

/** Every way a report can reach a client: [function reached, label, call(project, month, acknowledged)]. */
const TO_CLIENT = [
  ['runClientReport', 'runClientReport', (p, m, ack) => p.call('runClientReport', 'Summit Yoga', m, ack ? { acknowledgeLeftOut: true } : undefined)],
  ['runClientReport', 'runClientReport with force', (p, m, ack) => p.call('runClientReport', 'Summit Yoga', m, { force: true, acknowledgeLeftOut: ack })],
  ['runClientReport', 'runClientReport with preview false', (p, m, ack) => p.call('runClientReport', 'Summit Yoga', m, { preview: false, acknowledgeLeftOut: ack })],
  ['sidebarRunReport', 'sidebarRunReport with the box unticked', (p, m, ack) => p.call('sidebarRunReport', 'Summit Yoga', m, false, ack)],
  ['buildReport_', 'buildReport_ called directly with no options', (p, m, ack) => direct(p, m, ack ? { acknowledgeLeftOut: true } : {})],
  ['buildReport_', 'buildReport_ called directly with the check of another month', (p, m, ack) => direct(p, m, { gate: { month: '2020-01', held: undefined }, acknowledgeLeftOut: ack })]
];
const CLOSES = [
  ['runMonthClose', 'runMonthClose', (p, m, ack) => p.call('runMonthClose', m, ack ? { acknowledgeLeftOut: true } : undefined)],
  ['dialogConfirmMonthClose', 'dialogConfirmMonthClose', (p, m, ack) => p.call('dialogConfirmMonthClose', m, ack)]
];
/** Ways that never mail a client, whatever the month and the sheet: [label, call(project, month)]. */
const NEVER = [
  ['runClientReport preview', (p, m) => p.call('runClientReport', 'Summit Yoga', m, { preview: true }), 'preview'],
  ['sidebarRunReport with the box ticked', (p, m) => p.call('sidebarRunReport', 'Summit Yoga', m, true), 'preview'],
  ['sidebarRunReport with no value for the box', (p, m) => p.call('sidebarRunReport', 'Summit Yoga', m), 'preview'],
  ['buildReport_ called directly as a preview', (p, m) => direct(p, m, { preview: true }), 'preview'],
  ['runClientReport with sendEmail false', (p, m) => p.call('runClientReport', 'Summit Yoga', m, { sendEmail: false }), 'none'],
  ['buildReport_ called directly with sendEmail false', (p, m) => direct(p, m, { sendEmail: false }), 'none']
];

const quiet = (p, where) => {
  assert.equal(p.w.sent.length, 0, where + ': no email');
  assert.equal(p.w.allFiles().length, 0, where + ': no file in Drive');
  assert.equal(p.sheet('Report Log'), undefined, where + ': nothing in the Report Log');
  assert.equal(p.sheet('Job Log'), undefined, where + ': nothing in the Job Log');
};

// CLASS-TABLE: every entry that can mail a report to a client against an ordinary finished month
test('CLASS-TABLE: on a finished month with nothing left out every entry sends, to the client and never as a preview', () => {
  for (const [, label, run] of TO_CLIENT) {
    const p = loadSeeded();
    const r = p.plain(run(p, '2026-10', false));
    assert.equal(r.status, 'ok', label);
    assert.equal(r.email, 'sent', label);
    assert.equal(r.held, undefined, label);
    assert.deepEqual(p.w.sent.map((m) => m.to), [GOOD], label);
    assert.ok(!/^\[Preview\]/.test(p.w.sent[0].subject), label);
  }
  for (const [, label, run] of CLOSES) {
    const p = loadSeeded();
    const r = p.plain(run(p, '2026-10', false));
    assert.equal(r.held, undefined, label);
    assert.equal(p.w.sent.length, 8, label + ': every active client is emailed');
    assert.ok(p.w.sent.every((m) => !/^\[Preview\]/.test(m.subject)), label);
  }
});

// CLASS-TABLE: every entry against every kind of row that is left out, without and with the confirmation
test('CLASS-TABLE: a report that can reach a client is held, with the count and the reason and nothing sent, while a row is left out, and goes when it is confirmed', () => {
  DIRTY.forEach(([dirtyLabel, rows, want], at) => {
    // the guard is one piece of code, so every entry runs against the first and the last sheet and the others run against the first entry and the dialog
    for (const [, label, run] of at === 0 || at === DIRTY.length - 1 ? TO_CLIENT : TO_CLIENT.slice(0, 1)) {
      const where = dirtyLabel + ', ' + label;
      const p = dirty(rows);
      const r = p.plain(run(p, '2026-10', false));
      assert.equal(r.status, 'held', where);
      assert.deepEqual(r.held, want, where);
      assert.equal(r.email, 'not_sent', where);
      assert.deepEqual(r, { status: 'held', client: 'Summit Yoga', month: '2026-10', pdfName: '', pdfId: '', replaced: 0, email: 'not_sent', spend: '', held: want }, where + ': only the hold is reported');
      quiet(p, where);
      const q = dirty(rows);
      const sent = q.plain(run(q, '2026-10', true));
      assert.equal(sent.status, 'ok', where + ': confirmed');
      assert.equal(sent.email, 'sent', where + ': confirmed');
      assert.deepEqual(q.w.sent.map((m) => m.to), [GOOD], where + ': confirmed');
    }
    for (const [, label, run] of at === 0 || at === DIRTY.length - 1 ? CLOSES : CLOSES.slice(1)) {
      const where = dirtyLabel + ', ' + label;
      const p = dirty(rows);
      const r = p.plain(run(p, '2026-10', false));
      assert.deepEqual(r.held, want, where);
      assert.equal(r.month, '2026-10', where);
      if (label === 'runMonthClose') assert.deepEqual([r.results, r.pending, r.summaries], [[], [], {}], where);
      else assert.deepEqual(Object.keys(r), ['month', 'held'], where);
      quiet(p, where);
      assert.equal(p.sheet('Summary - Summit Yoga'), undefined, where + ': the first press builds nothing');
      const q = dirty(rows);
      const closed = q.plain(run(q, '2026-10', true));
      assert.equal(closed.held, undefined, where + ': confirmed');
      assert.equal(q.w.sent.length, 8, where + ': confirmed, every active client is emailed');
    }
  });
});

// CLASS-TABLE: the hold is the same for a sheet with a row left out and for a client who has no rows that month
test('CLASS-TABLE: a client with no rows in the month gets no report and no hold, and a preview or a report that sends nothing is never held', () => {
  const p = dirty([REASONS[0][1]]);
  const none = p.plain(p.call('runClientReport', 'Summit Yoga', '2025-01'));
  assert.equal(none.status, 'no_data');
  assert.equal(none.held, undefined);
  for (const [label, run, kind] of NEVER) {
    const q = dirty([REASONS[0][1]]);
    const r = q.plain(run(q, '2026-10'));
    assert.equal(r.status, 'ok', label);
    assert.equal(r.held, undefined, label + ': nothing goes to a client, so nothing is held');
    if (kind === 'preview') {
      assert.equal(q.w.sent.length, 1, label);
      assert.match(q.w.sent[0].subject, /^\[Preview\]/, label);
      assert.equal(q.w.sent[0].to, 'owner@example.test', label + ': it goes to the person running the script');
    } else {
      assert.equal(q.w.sent.length, 0, label);
    }
  }
});

/** A finished month is allowed; a running or future one is refused. [label, zone, instant, month, may be sent, today there, first day it may be sent]. */
const CLOCKS = [
  ['Manila, the last second of October 31', 'Asia/Manila', '2026-10-31T15:59:59Z', '2026-10', false, '2026-10-31', '2026-11-01'],
  ['Manila, the first second of November 1', 'Asia/Manila', '2026-10-31T16:00:00Z', '2026-10', true],
  ['Chicago on the evening of October 31 while UTC is November 1', 'America/Chicago', '2026-11-01T01:00:00Z', '2026-10', false, '2026-10-31', '2026-11-01'],
  ['Chicago after midnight', 'America/Chicago', '2026-11-01T06:00:00Z', '2026-10', true],
  ['the running month in the middle', 'America/Chicago', '2026-11-10T15:00:00Z', '2026-11', false, '2026-11-10', '2026-12-01'],
  ['the last hour of December 31', 'Asia/Manila', '2026-12-31T15:00:00Z', '2026-12', false, '2026-12-31', '2027-01-01'],
  ['the first second of January 1', 'Asia/Manila', '2026-12-31T16:00:00Z', '2026-12', true],
  ['Pago Pago, behind UTC, when UTC is already November', 'Pacific/Pago_Pago', '2026-11-01T10:00:00Z', '2026-10', false, '2026-10-31', '2026-11-01'],
  ['a leap day', 'Asia/Manila', '2028-02-29T15:00:00Z', '2028-02', false, '2028-02-29', '2028-03-01'],
  ['a month that has not started', 'Asia/Manila', '2026-11-10T15:00:00Z', '2027-03', false, '2026-11-10', '2027-04-01'],
  ['a month that ended long ago', 'Asia/Manila', '2026-11-10T15:00:00Z', '2026-08', true]
];
const refusal = (month, today, zone, next) => 'The month ' + month + ' has not ended yet: it is ' + today + ' in the Sheet time zone (' + zone +
  '), and a report emailed to the client now would hold only part of the month. Tick Send to me first to preview it, or send it on or after ' + next + '.';
const closeRefusal = (month, today, zone, next) => 'The month ' + month + ' has not ended yet: it is ' + today + ' in the Sheet time zone (' + zone +
  '), and a month close emails every client. Close it on or after ' + next + '.';

function atClock(zone, instant) {
  const p = loadSeeded();
  p.w.run(() => p.w.globals.SpreadsheetApp.getActiveSpreadsheet().setSpreadsheetTimeZone(zone));
  p.w.now = Date.parse(instant);
  return p;
}

// CLASS-TABLE: every clock and zone around a month boundary against every entry that can mail a report or a close
test('CLASS-TABLE: a report that can reach a client is refused for a month that has not ended in the Sheet time zone, by every entry, with the reason', () => {
  CLOCKS.forEach(([clockLabel, zone, instant, month, allowed, today, next], at) => {
    // every entry runs at three clocks (the end of a month, its start and the running month), and one report entry and one close at the others
    const all = TO_CLIENT.concat(CLOSES);
    const entries = at === 0 || at === 1 || at === 4 ? all : [all[3], all[all.length - 1]];
    for (const [, label, run] of entries) {
      const where = clockLabel + ', ' + label;
      const p = atClock(zone, instant);
      if (allowed) {
        assert.doesNotThrow(() => run(p, month, true), where);
      } else {
        const closing = CLOSES.some((c) => c[1] === label);
        assert.throws(() => run(p, month, true), (e) => {
          assert.equal(e.message, (closing ? closeRefusal : refusal)(month, today, zone, next), where);
          return true;
        });
        quiet(p, where);
        assert.equal(p.w.ui.dialog, null, where);
      }
    }
    // a preview and a report that sends nothing are allowed for any month, so a running month can still be looked at
    for (const [label, run] of at === 0 || at === 4 ? NEVER : NEVER.slice(1, 2)) {
      const p = atClock(zone, instant);
      assert.doesNotThrow(() => run(p, month), clockLabel + ', ' + label);
    }
  });
});

// CLASS-TABLE: only an explicit true confirms
test('CLASS-TABLE: only an explicit true confirms, for the sidebar, the dialog and both server functions', () => {
  for (const value of [false, undefined, null, 0, 1, 'true', 'yes', {}, [], [true]]) {
    const p = dirty([REASONS[0][1]]);
    const where = JSON.stringify(value) + ' (' + typeof value + ')';
    assert.equal(p.plain(p.call('sidebarRunReport', 'Summit Yoga', '2026-10', false, value)).status, 'held', 'sidebar ' + where);
    assert.ok(p.plain(p.call('dialogConfirmMonthClose', '2026-10', value)).held, 'dialog ' + where);
    assert.equal(p.plain(p.call('runClientReport', 'Summit Yoga', '2026-10', { acknowledgeLeftOut: value })).status, 'held', 'report ' + where);
    assert.ok(p.plain(p.call('runMonthClose', '2026-10', { acknowledgeLeftOut: value })).held, 'close ' + where);
    quiet(p, where);
  }
  const p = dirty([REASONS[0][1]]);
  assert.equal(p.plain(p.call('sidebarRunReport', 'Summit Yoga', '2026-10', false, true)).email, 'sent');
});

/** Counts the calls of some functions of src/ from here on, by wrapping them in the one global scope the sources share. */
function counting(p, names) {
  const counts = {};
  p.w.run(() => {
    for (const name of names) {
      const original = p.ctx[name];
      counts[name] = 0;
      p.ctx[name] = function (...args) {
        counts[name]++;
        return original.apply(this, args);
      };
    }
  });
  return counts;
}

// CLASS-TABLE: the check reads the Campaigns tab and the Clients tab once, whatever the number of clients
test('CLASS-TABLE: the check before a send is made once and handed down, so a close of eight clients and a single report each read Campaigns and Clients once', () => {
  for (const ack of [false, true]) {
    const p = ack ? dirty([REASONS[0][1]]) : loadSeeded();
    const close = counting(p, ['readCampaigns_', 'loadClients_', 'sendPreCheck_']);
    p.call('runMonthClose', '2026-10', ack ? { acknowledgeLeftOut: true } : undefined);
    assert.deepEqual(close, { readCampaigns_: 1, loadClients_: 2, sendPreCheck_: 1 }, 'close, confirmed ' + ack + ': the Clients tab is read for the check and again for the summaries, the Campaigns tab once');
    const q = loadSeeded();
    const report = counting(q, ['readCampaigns_', 'loadClients_', 'sendPreCheck_']);
    q.call('runClientReport', 'Summit Yoga', '2026-10');
    assert.deepEqual(report, { readCampaigns_: 1, loadClients_: 1, sendPreCheck_: 1 }, 'report');
  }
  // called with nothing around it, the report send makes the check itself
  const d = loadSeeded();
  const alone = counting(d, ['readCampaigns_', 'loadClients_', 'sendPreCheck_']);
  direct(d, '2026-10', {});
  assert.deepEqual(alone, { readCampaigns_: 2, loadClients_: 2, sendPreCheck_: 1 }, 'direct: one read of its own on top of the two the test makes');
});

// CLASS-TABLE: a rerun after a confirmed close is held again, because the rows are still left out, and says nothing new once they are fixed
test('CLASS-TABLE: the hold comes back on every close while a row is left out, and a confirmed close does not email the same figures twice', () => {
  const p = dirty([REASONS[0][1]]);
  assert.ok(p.plain(p.call('dialogConfirmMonthClose', '2026-10')).held);
  const first = p.plain(p.call('dialogConfirmMonthClose', '2026-10', true));
  assert.equal(first.emailed, 8);
  assert.ok(p.plain(p.call('dialogConfirmMonthClose', '2026-10')).held, 'still left out, so still held');
  const second = p.plain(p.call('dialogConfirmMonthClose', '2026-10', true));
  assert.equal(second.emailed, 0, 'the same figures are not emailed again');
  assert.equal(p.w.sent.length, 8);
});

// CLASS-TABLE: what a close answers while it is held
test('CLASS-TABLE: the sentence of the hold is built from the same counts the report shows, and a sheet with nothing left out has none', () => {
  const p = loadSeeded();
  assert.equal(p.plain(p.call('sendPreCheck_', { rows: [], rejected: [] }, [])), null);
  const rejected = [{ row: 2, reason: 'no_rate' }, { row: 3, reason: 'no_rate' }, { row: 4, reason: 'bad_date' }];
  const rows = [{ client: 'A' }, { client: 'B' }, { client: 'B' }];
  const both = p.plain(p.call('sendPreCheck_', { rows, rejected }, [{ client: 'A' }]));
  assert.deepEqual(both, {
    rows: 5,
    leftOut: { rows: 3, reasons: { no_rate: 2, bad_date: 1 }, text: leftSentence(3, ['2 with ' + NO_RATE, '1 with no usable date']) },
    unmatched: { rows: 2, clients: ['B'] },
    text: leftSentence(3, ['2 with ' + NO_RATE, '1 with no usable date']) + ' ' + strangerSentence(2, ['B'])
  });
  const onlyOut = p.plain(p.call('sendPreCheck_', { rows: [], rejected: [rejected[2]] }, []));
  assert.deepEqual(Object.keys(onlyOut).sort(), ['leftOut', 'rows', 'text']);
  const onlyStranger = p.plain(p.call('sendPreCheck_', { rows: [rows[1]], rejected: [] }, [{ client: 'A' }]));
  assert.deepEqual(Object.keys(onlyStranger).sort(), ['rows', 'text', 'unmatched']);
});

// ---- the call graph: a new caller of the report send must be in the tables above

function sourceFunctions() {
  const out = {};
  for (const f of fs.readdirSync(SRC).filter((x) => x.endsWith('.js'))) {
    const text = fs.readFileSync(path.join(SRC, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const defs = [...text.matchAll(/^function (\w+)\(/gm)];
    defs.forEach((d, i) => { out[d[1]] = { file: f, body: text.slice(d.index, i + 1 < defs.length ? defs[i + 1].index : text.length) }; });
  }
  return out;
}

/** Every function that reaches `target` through calls or through its name written as text, the target included. */
function reaching(fns, target) {
  const hit = new Set([target]);
  for (let grew = true; grew;) {
    grew = false;
    for (const [name, { body }] of Object.entries(fns)) {
      if (hit.has(name)) continue;
      if ([...hit].some((h) => new RegExp('\\b' + h + '\\b').test(body))) {
        hit.add(name);
        grew = true;
      }
    }
  }
  return [...hit].sort();
}

// CLASS-TABLE: the report send has one caller, and every public function that reaches it is in the tables
test('CLASS-TABLE: the report send is reached only by the entries of the tables above, so a new caller fails here until it is added', () => {
  const fns = sourceFunctions();
  const reached = reaching(fns, 'sendReportMail_');
  const tabled = new Set(TO_CLIENT.concat(CLOSES).map((e) => e[0]));
  assert.deepEqual(reached, ['buildReport_', 'dialogConfirmMonthClose', 'runClientReport', 'runMonthClose', 'sendReportMail_', 'sidebarRunReport'],
    'a function that reaches the report send is not in the tables: add it to TO_CLIENT or CLOSES, with a test of the two guards');
  for (const name of reached.filter((n) => n !== 'sendReportMail_')) assert.ok(tabled.has(name), name + ' is in the tables');
  for (const name of reached) {
    for (const f of fs.readdirSync(SRC).filter((x) => /\.(js|html)$/.test(x))) {
      const text = fs.readFileSync(path.join(SRC, f), 'utf8');
      if (!name.endsWith('_')) assert.ok(!new RegExp("['\"]" + name + "['\"]").test(text), name + ' is named as text in ' + f + ' (a menu item or a trigger): add it to the tables');
    }
  }
  // the report send is called twice, both times in buildReport_, and buildReport_ is called by two functions only
  assert.equal(fns.sendReportMail_.file, 'Reporting.js');
  const calls = Object.entries(fns).filter(([n, v]) => n !== 'sendReportMail_' && /\bsendReportMail_\(/.test(v.body)).map(([n]) => n);
  assert.deepEqual(calls, ['buildReport_']);
  const builders = Object.entries(fns).filter(([n, v]) => n !== 'buildReport_' && /\bbuildReport_\(/.test(v.body)).map(([n]) => n).sort();
  assert.deepEqual(builders, ['runClientReport', 'runMonthClose']);
  for (const n of builders) assert.match(fns[n].body, /\bgate\b/, n + ' passes the check it made');
  // the guards sit before the send in buildReport_
  const body = fns.buildReport_.body;
  assert.ok(body.indexOf('assertMonthEnded_(month, true)') !== -1 && body.indexOf('assertMonthEnded_(month, true)') < body.indexOf('sendReportMail_('), 'the month check comes first');
  assert.ok(body.indexOf("status: 'held'") !== -1 && body.indexOf("status: 'held'") < body.indexOf('sendReportMail_('), 'the hold comes before any send');
});

// CLASS-TABLE: every MailApp call in src/ is one of the two known ones
test('CLASS-TABLE: MailApp.sendEmail is called twice in src, the report send and the intake confirmation, and the confirmation carries no report', () => {
  const found = [];
  for (const f of fs.readdirSync(SRC).filter((x) => x.endsWith('.js'))) {
    const code = fs.readFileSync(path.join(SRC, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const n = (code.match(/\b(MailApp|GmailApp)\b/g) || []).length;
    if (n) found.push(f + ':' + n);
  }
  assert.deepEqual(found, ['Forms.js:1', 'Reporting.js:1']);
  const p = loadSeeded();
  p.append('Campaigns', [REASONS[0][1], STRANGER]);
  const form = p.w.forms.get(p.plain(p.call('installIntakeTrigger')).formId);
  const [res] = p.w.submitForm(form, { 'Client name': 'Bluebell Bikes', 'Contact name': 'Rae Delgado', 'Contact email': 'rae@bluebellbikes.example.com', 'Primary channel': 'social', 'Monthly budget (USD)': '2,500', Notes: '' });
  assert.equal(p.plain(res).emailed, true);
  assert.equal(p.w.sent.length, 1);
  assert.equal(p.w.sent[0].subject, 'We received your details, Bluebell Bikes');
  assert.deepEqual(p.w.sent[0].attachments, [], 'no figures and no PDF');
});

// ---- the two pages

const HELD = { rows: 2, text: 'TWO ROWS ARE LEFT OUT.' };
const okLine = '8 done, 0 failed, 0 waiting, 8 emailed, 0 not emailed (mail refused; the next close sends them).';

// CLASS-TABLE: the dialog asks twice, and the second press is for the same month only
test('CLASS-TABLE: the month close dialog says what is left out and sends nothing on the first press, and closes on the second press for the same month', () => {
  const answers = [];
  const page = openPage('Dialog.html', {
    dialogConfirmMonthClose: (month, ack) => {
      answers.push(ack);
      return ack ? { month, done: 8, errors: 0, pending: 0, emailed: 8, emailFailed: 0 } : { month, held: HELD };
    }
  });
  page.set('month', '2026-10');
  page.click('confirm');
  assert.equal(page.status(), 'Nothing has been emailed yet. TWO ROWS ARE LEFT OUT. A report built now is too low by those rows. Press Close month anyway to email the clients with these rows left out, or Cancel and fix the rows first.');
  assert.equal(page.label('confirm'), 'Close month anyway');
  assert.equal(page.disabled('confirm'), false, 'the button can be pressed again');
  page.click('confirm');
  assert.equal(page.status(), okLine);
  assert.equal(page.label('confirm'), 'Close month');
  assert.deepEqual(page.calls.map((c) => c[1]), [['2026-10', false], ['2026-10', true]]);
  assert.deepEqual(answers, [false, true]);
  // a changed month starts again, whether or not the field told the page
  const other = openPage('Dialog.html', { dialogConfirmMonthClose: (month) => ({ month, held: HELD }) });
  other.set('month', '2026-10');
  other.click('confirm');
  other.set('month', '2026-09');
  other.click('confirm');
  assert.deepEqual(other.calls.map((c) => c[1]), [['2026-10', false], ['2026-09', false]], 'a different month is not confirmed');
  other.set('month', '2026-10');
  other.click('confirm');
  other.set('month', '2026-09');
  other.fire('month', 'oninput');
  assert.equal(other.label('confirm'), 'Close month', 'typing a month puts the button label back');
  other.click('confirm');
  assert.equal(other.calls[other.calls.length - 1][1][1], false, 'and the next press asks again');
});

// CLASS-TABLE: the dialog prints the statuses of clients after the other sentences
test('CLASS-TABLE: the month close dialog prints the client status sentence last, and nothing on an ordinary close', () => {
  const reply = { month: '2026-10', done: 8, errors: 0, pending: 0, emailed: 8, emailFailed: 0 };
  const odd = { count: 1, clients: ['A'], text: 'ODD STATUS.' };
  const page = openPage('Dialog.html', { dialogConfirmMonthClose: Object.assign({}, reply, { noAddress: { count: 1, clients: ['A'], text: 'NO ADDRESS.' }, unknownStatus: odd }) });
  page.click('confirm');
  assert.equal(page.status(), okLine + ' NO ADDRESS. ODD STATUS.');
  const plain = openPage('Dialog.html', { dialogConfirmMonthClose: reply });
  plain.click('confirm');
  assert.equal(plain.status(), okLine);
});

// CLASS-TABLE: the sidebar holds a report to a client the same way
test('CLASS-TABLE: the sidebar says what is left out and sends nothing on the first press of Run report, and sends on the second for the same client and month', () => {
  const heldResult = (client, month) => ({ status: 'held', client, month, pdfName: '', pdfId: '', replaced: 0, email: 'not_sent', spend: '', held: HELD });
  const page = openPage('Sidebar.html', {
    sidebarGetOptions: { clients: ['A', 'B'], months: ['2026-10'] },
    sidebarRunReport: (client, month, box, ack) => (ack
      ? { status: 'ok', client, month, pdfName: 'a-2026-10.pdf', pdfId: 'f1', replaced: 0, email: 'sent', spend: 'USD 1.00' }
      : heldResult(client, month))
  });
  page.set('client', 'A');
  page.set('month', '2026-10');
  page.fire('send-to-me', 'onchange');
  page.click('run-report');
  assert.equal(page.status(), 'Nothing was emailed. TWO ROWS ARE LEFT OUT. A report built now is too low by those rows. Press Send anyway to email the client with these rows left out, or fix the rows first.');
  assert.equal(page.label('run-report'), 'Send anyway');
  assert.equal(page.disabled('run-report'), false);
  page.click('run-report');
  assert.equal(page.status(), 'Report ready: a-2026-10.pdf. Email: sent to the client.');
  assert.equal(page.label('run-report'), 'Run report');
  assert.deepEqual(page.calls.filter((c) => c[0] === 'sidebarRunReport').map((c) => c[1]), [['A', '2026-10', true, false], ['A', '2026-10', true, true]]);
  // another client, another month, or the box, puts it back
  for (const change of [['client', 'B', 'onchange'], ['month', '2026-09', 'onchange'], ['send-to-me', null, 'onchange']]) {
    const q = openPage('Sidebar.html', { sidebarGetOptions: { clients: ['A'], months: ['2026-10'] }, sidebarRunReport: (client, month) => heldResult(client, month) });
    q.set('client', 'A');
    q.set('month', '2026-10');
    q.click('run-report');
    assert.equal(q.label('run-report'), 'Send anyway', change[0]);
    if (change[1]) q.set(change[0], change[1]);
    q.fire(change[0], change[2]);
    assert.equal(q.label('run-report'), 'Run report', change[0] + ' changed');
    q.click('run-report');
    assert.equal(q.calls.filter((c) => c[0] === 'sidebarRunReport').pop()[1][3], false, change[0] + ': asks again');
  }
  // pressing for a client the page did not hold is not a confirmation, even when the label was left
  const r = openPage('Sidebar.html', { sidebarGetOptions: { clients: ['A'], months: ['2026-10'] }, sidebarRunReport: (client, month) => heldResult(client, month) });
  r.set('client', 'A');
  r.set('month', '2026-10');
  r.click('run-report');
  r.set('month', '2026-09');
  r.click('run-report');
  assert.equal(r.calls.filter((c) => c[0] === 'sidebarRunReport').pop()[1][3], false, 'a month the page did not hold');
  r.set('client', 'B');
  r.click('run-report');
  assert.equal(r.calls.filter((c) => c[0] === 'sidebarRunReport').pop()[1][3], false, 'a client the page did not hold');
});

// CLASS-TABLE: the sidebar names clients whose status is none of the known ones when it opens
test('CLASS-TABLE: the sidebar prints the client status sentence when it opens, and nothing on an ordinary open', () => {
  const odd = { count: 1, clients: ['A'], text: 'ODD STATUS.' };
  const page = openPage('Sidebar.html', { sidebarGetOptions: { clients: ['B'], months: ['2026-10'], unknownStatus: odd } });
  assert.equal(page.status(), 'ODD STATUS.');
  const plain = openPage('Sidebar.html', { sidebarGetOptions: { clients: ['B'], months: ['2026-10'] } });
  assert.equal(plain.status(), '');
});
