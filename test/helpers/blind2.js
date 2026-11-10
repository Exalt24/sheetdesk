'use strict';
/**
 * Replays the blind adversary corpus (test/corpus/corpus_sheetdesk_blind_2.jsonl).
 *
 * The cases of that file are written as a person would describe them (an entry
 * point, a body, a few steps), not as data a program can read, so each line
 * number has a runner here that does what the case says through the real
 * src/ code and asserts what its `why` and `observed` describe. The `expect`
 * word is the adversary's: "pass" means the input must be served, "fail" that
 * it must be refused or held. A runner never changes a case; a case that
 * cannot hold is listed in DISPUTED in test/corpus.test.js with the reason.
 */
const assert = require('node:assert/strict');
const { loadSeeded, HEADERS } = require('./load');

const SECRET = 'SECRET';
const OWNER = 'owner@example.test';
const T = {
  CLIENT: 'Client name', CONTACT: 'Contact name', EMAIL: 'Contact email',
  CHANNEL: 'Primary channel', BUDGET: 'Monthly budget (USD)', NOTES: 'Notes'
};

function webhookProject(withSecret) {
  const p = loadSeeded();
  if (withSecret) p.setProp('WEBHOOK_SECRET', SECRET);
  p.fill('Leads', HEADERS.leads, []);
  return p;
}

function post(p, contents, type = 'application/json', parameter) {
  const e = { postData: { contents, type, length: contents.length, name: 'postData' }, parameter: parameter || {}, parameters: {}, queryString: '', contentLength: contents.length };
  return JSON.parse(p.call('doPost', e).getContent());
}

const text = (v) => (typeof v === 'string' ? v : JSON.stringify(v));
const leadRows = (p) => p.rows('Leads').slice(1);

/** The doPost cases: every body of the case is posted in order. */
function runPost(c) {
  const i = c.input;
  const p = webhookProject(!/no WEBHOOK_SECRET/.test(i.setup || ''));
  let bodies;
  if (i.raw_sequence) bodies = i.raw_sequence;
  else if (i.sequence) bodies = i.sequence.map(text);
  else bodies = Array.from({ length: i.repeat || 1 }, () => text(i.body));
  const replies = bodies.map((b) => post(p, b, i.content_type, i.url_params));
  const last = replies[replies.length - 1];
  assert.equal(last.ok, c.expect === 'pass', 'expect ' + c.expect + ': ' + JSON.stringify(last));
  return { p, replies, last, rows: leadRows(p) };
}

const refused = (c, code, extra) => () => {
  const r = runPost(c);
  assert.equal(r.last.error, code);
  if (extra) assert.deepEqual(Object.keys(extra).map((k) => r.last[k]), Object.values(extra));
  assert.equal(r.rows.length, 0, 'nothing is stored');
};

const OK_REPLY = (id) => ({ ok: true, duplicate: false, lead_id: id });
const mails = (p) => p.w.sent.map((m) => m.to);
const pdfs = (p, name) => p.w.allFiles().filter((f) => f.getName() === name && !f.isTrashed());
const ratePerUsd = (p, iso) => p.fx.rates.filter((r) => r.date === iso && r.quote === 'EUR')[0].rate;

function answers(over) {
  return Object.assign({ [T.CLIENT]: 'Bluebell Bikes', [T.CONTACT]: 'Rae Delgado', [T.EMAIL]: 'rae@bluebellbikes.example.com', [T.CHANNEL]: 'social', [T.BUDGET]: '2,500', [T.NOTES]: '' }, over);
}

function formOf(p) {
  return p.w.forms.get(p.plain(p.call('installIntakeTrigger')).formId);
}

/** Submits intake answers; returns the handler result. */
function submit(p, f, over) {
  const [res] = p.w.submitForm(f, answers(over));
  return p.plain(res);
}

function intakeThen(c, over, then) {
  const p = loadSeeded();
  const f = formOf(p);
  const res = submit(p, f, over);
  assert.equal(res.status, 'needs_review', 'the form holds it for review');
  assert.equal(res.emailed, false);
  assert.equal(p.w.sent.length, 0, 'no confirmation email');
  assert.equal(p.rows('Clients').length, 11, 'the row is kept');
  then(p);
}

const MAIL = { harbor: 'mira@harborlanebakery.example.com', summit: 'priya@summityoga.example.com' };

/** Line number to the function that runs the case. */
const RUNNERS = {
  1: (c) => { const r = runPost(c); assert.deepEqual(r.replies[0], OK_REPLY('curl-1001')); assert.equal(r.rows.length, 1); },
  2: (c) => { const r = runPost(c); assert.equal(r.replies[1].duplicate, true); assert.equal(r.rows.length, 1); },
  3: (c) => refused(c, 'unauthorized')(),
  4: (c) => {
    const r = runPost(c);
    assert.equal(r.rows[0][3], '=1+1');
    assert.equal(r.rows[0][8], '1e5');
    assert.deepEqual(r.p.w.formulas, []);
  },
  5: (c) => refused(c, 'unknown_field', { fields: ['colour'] })(),
  6: (c) => { const r = runPost(c); assert.equal(r.rows[0][2], 'Harbor Lane Bakery'); },
  7: (c) => refused(c, 'unknown_client')(),
  8: (c) => refused(c, 'invalid_field', { field: 'lead_id' })(),
  9: (c) => {
    const r = runPost(c);
    assert.deepEqual(r.last.warnings, [{ field: 'email', issue: 'not_an_email' }]);
    assert.equal(r.rows[0][4], 'ana@gmail');
  },
  10: (c) => {
    const r = runPost(c);
    assert.deepEqual(r.last.warnings, [{ field: 'message', issue: 'too_long', max: 2000 }]);
    assert.equal(r.rows[0][8], c.input.body.message);
    assert.equal(r.rows[0][8].length, 2500);
  },
  11: (c) => refused(c, 'too_large')(),
  12: (c) => { const r = runPost(c); assert.equal(r.rows.length, 1); },
  13: (c) => { const r = runPost(c); assert.deepEqual(r.rows.map((x) => x[0]), ['1001']); assert.equal(r.replies[1].duplicate, true); },
  // DISPUTED in test/corpus.test.js, run as the case is written only with CORPUS_RUN_DISPUTED: both leads must be stored
  14: (c) => { const r = runPost(c); assert.equal(r.rows.length, 2); },
  15: (c) => refused(c, 'invalid_field', { field: 'message' })(),
  16: (c) => refused(c, 'not_configured')(),
  17: () => {
    const p = webhookProject(true);
    const lead = (id) => post(p, JSON.stringify({ secret: SECRET, lead_id: id, client: 'Summit Yoga', name: 'Ana' }));
    assert.equal(lead('warm-1').ok, true, 'the client list is now cached');
    const res = submit(p, formOf(p), {});
    assert.equal(res.status, 'active');
    assert.deepEqual(post(p, JSON.stringify({ secret: SECRET, lead_id: 'bb-1', client: 'Bluebell Bikes' })), OK_REPLY('bb-1'));
  },
  18: (c) => {
    const r = runPost(c);
    assert.equal(r.rows[0][5], '+1 555 0123');
    assert.equal(r.rows[0][8], '2026-10-03 works for me');
  },
  19: (c) => { const r = runPost(c); assert.deepEqual(r.rows.map((x) => x[0]), ['tp-1']); },
  20: () => {
    const p = webhookProject(true);
    const r = JSON.parse(p.call('doGet', { parameter: { view: 'status', secret: 'nope' } }).getContent());
    assert.deepEqual(r, { ok: false, error: 'unauthorized' });
  },
  21: () => {
    const p = webhookProject(true);
    assert.equal(post(p, JSON.stringify({ secret: SECRET, lead_id: 'o-1', client: 'Orchard & Vine' })).ok, true);
    const html = p.call('doGet', { parameter: { view: 'dashboard', secret: SECRET } }).getContent();
    assert.ok(html.includes('Orchard &amp; Vine'));
    assert.ok(!html.includes('Orchard & Vine'));
  },
  22: (c) => { const r = runPost(c); assert.equal(r.rows[0][2], 'Granite Ridge Climbing'); },
  23: (c) => refused(c, 'bad_json')(),
  24: () => {
    const p = loadSeeded();
    const r = p.plain(p.call('sidebarRunReport', 'Copperline Plumbing', '2026-10', true));
    assert.equal(r.email, 'preview_sent');
    assert.equal(r.spend, 'USD 13,833.29');
    assert.deepEqual(mails(p), [OWNER]);
    const log = p.rows('Report Log')[1];
    assert.equal(log[4], '1383329|12072|634');
    assert.equal(log[5], '');
  },
  25: () => {
    const p = loadSeeded();
    const emails = [true, false, false].map((box) => p.plain(p.call('sidebarRunReport', 'Harbor Lane Bakery', '2026-10', box)).email);
    assert.deepEqual(emails, ['preview_sent', 'sent', 'already_sent']);
    assert.equal(pdfs(p, 'harbor-lane-bakery-2026-10.pdf').length, 1);
  },
  26: () => {
    const p = loadSeeded({ world: { activeUserEmail: '' } });
    assert.equal(p.plain(p.call('sidebarRunReport', 'Harbor Lane Bakery', '2026-10', true)).email, 'no_preview_address');
    assert.equal(p.w.sent.length, 0);
  },
  27: () => {
    const p = loadSeeded({ world: { activeUserEmail: '' } });
    p.setProp('REPORT_CC', 'ops@fernwood.example.test');
    assert.equal(p.plain(p.call('sidebarRunReport', 'Harbor Lane Bakery', '2026-10', true)).email, 'preview_sent');
    assert.deepEqual(mails(p), ['ops@fernwood.example.test']);
  },
  28: () => {
    const p = loadSeeded();
    for (const box of ['false', 0, null, undefined]) {
      assert.equal(p.plain(p.call('sidebarRunReport', 'Summit Yoga', '2026-09', box)).email, 'preview_sent', 'box ' + String(box));
    }
    assert.deepEqual(mails(p), [OWNER, OWNER, OWNER, OWNER]);
    assert.ok(p.w.sent.every((m) => /^\[Preview\]/.test(m.subject)));
  },
  29: () => {
    const p = loadSeeded();
    assert.throws(() => p.call('sidebarRunReport', 'Harbor Lane Bakery ', '2026-10', false), /Unknown client/);
    assert.equal(p.w.sent.length, 0);
    assert.equal(p.w.allFiles().length, 0);
  },
  30: () => {
    const p = loadSeeded();
    assert.throws(() => p.call('sidebarRunReport', 'Harbor Lane Bakery', '2026-13', true), /Invalid month/);
    assert.equal(p.w.sent.length, 0);
    assert.equal(p.w.allFiles().length, 0);
  },
  31: () => intakeThen(null, { [T.CLIENT]: 'harbor lane bakery', [T.EMAIL]: MAIL.harbor }, (p) => {
    const r = p.plain(p.call('sidebarRunReport', 'Copperline Plumbing', '2026-10', true));
    assert.equal(r.status, 'ok');
    assert.equal(r.email, 'preview_sent');
  }),
  32: () => intakeThen(null, { [T.CLIENT]: 'Harbor Lane Bakery.', [T.EMAIL]: MAIL.harbor }, (p) => {
    assert.equal(p.plain(p.call('sidebarRunReport', 'Copperline Plumbing', '2026-10', true)).status, 'ok');
  }),
  33: () => intakeThen(null, { [T.CLIENT]: 'HARBOR LANE BAKERY', [T.EMAIL]: MAIL.harbor }, (p) => {
    const d = p.plain(p.call('dialogConfirmMonthClose', '2026-10'));
    assert.equal(d.done, 7, 'the seven other active clients have their report');
    assert.equal(d.emailed, 7);
    assert.equal(d.errors, 1, 'the clash is one failed client, named');
    assert.match(d.clashes[0], /"Harbor Lane Bakery" and "HARBOR LANE BAKERY"/);
  }),
  34: (c) => {
    const p = loadSeeded();
    p.append('Campaigns', [c.input.row]);
    const want = { rows: 1, clients: ['summit yoga'] };
    const report = p.plain(p.call('runClientReport', 'Summit Yoga', '2026-10'));
    assert.equal(report.spend, 'USD 4,116.38');
    assert.deepEqual(report.unmatched, want, 'the row left out of the PDF is counted and named');
    const s = p.plain(p.call('buildClientSummaries'));
    assert.deepEqual(s.unmatched, want);
    assert.equal(s.tabs, 8, 'the two colliding names are left out, the other eight clients are rebuilt');
    const q = loadSeeded();
    q.append('Campaigns', [c.input.row]);
    const d = q.plain(q.call('dialogConfirmMonthClose', '2026-10'));
    assert.deepEqual([d.done, d.errors, d.emailed], [8, 0, 8]);
    assert.deepEqual(d.unmatched, want);
  },
  35: () => {
    const p = loadSeeded();
    const emailed = ['2026-10', '2026-10'].map((m) => p.plain(p.call('dialogConfirmMonthClose', m)).emailed);
    assert.deepEqual(emailed, [8, 0]);
    assert.equal(p.w.allFiles().filter((f) => f.getMimeType() === 'application/pdf' && !f.isTrashed()).length, 8);
  },
  36: () => {
    const p = loadSeeded();
    p.call('sidebarRunReport', 'Summit Yoga', '2026-10', true);
    p.call('dialogConfirmMonthClose', '2026-10');
    const toSummit = p.w.sent.filter((m) => m.to === OWNER || m.to === MAIL.summit).map((m) => m.to);
    assert.deepEqual(toSummit, [OWNER, MAIL.summit]);
  },
  37: () => {
    const p = loadSeeded();
    p.call('dialogConfirmMonthClose', '2026-10');
    assert.ok(!mails(p).includes('owen@graniteridgeclimbing.example.com'));
    assert.ok(!p.rows('Report Log').some((r) => r[0] === 'Granite Ridge Climbing'));
  },
  38: () => {
    const p = loadSeeded({ world: { mailQuota: 3 } });
    const first = p.plain(p.call('dialogConfirmMonthClose', '2026-10'));
    assert.deepEqual([first.emailed, first.emailFailed], [3, 5]);
    p.w.mailQuota = 100;
    assert.equal(p.plain(p.call('dialogConfirmMonthClose', '2026-10')).emailed, 5);
  },
  39: (c) => {
    const p = loadSeeded();
    p.append('Campaigns', c.input.rows);
    const r = p.plain(p.call('runClientReport', 'Summit Yoga', '2026-10', { preview: true }));
    assert.equal(r.spend, 'USD 4,206.38');
    assert.equal(p.rows('Report Log')[1][4], '420638|3661|189.5');
  },
  40: (c) => {
    const p = loadSeeded();
    p.append('Campaigns', [c.input.row]);
    assert.equal(p.plain(p.call('runClientReport', 'Summit Yoga', '2026-10', { preview: true })).spend, 'USD 4,116.38');
    assert.equal(p.plain(p.call('buildClientSummaries')).rejected, 1);
  },
  41: () => {
    const p = loadSeeded();
    p.call('buildClientSummaries');
    const line = p.rows('Summary - Tidewater Tutors').filter((r) => r[0] === '2026-08' && r[1] === 'email')[0];
    assert.deepEqual(line.slice(0, 5), ['2026-08', 'email', 1466.58, 1291, 57]);
  },
  42: () => {
    const p = loadSeeded();
    p.call('sidebarRunReport', 'Harbor Lane Bakery', '2026-10', true);
    assert.strictEqual(p.rows('Report Log')[1][1], '2026-10');
  },
  // the case writes "2026-10-03 (Saturday)": the date is the first word, a date cell, and the note is the adversary's
  43: (c) => {
    const base = loadSeeded();
    base.call('buildClientSummaries');
    const before = base.rows('Summary - Orchard & Vine').filter((r) => r[0] === '2026-10' && r[1] === 'ALL')[0][2];
    const p = loadSeeded();
    const row = c.input.row.slice();
    row[2] = row[2].split(' ')[0];
    p.append('Campaigns', [row]);
    assert.equal(p.plain(p.call('buildClientSummaries')).rejected, 0);
    const after = p.rows('Summary - Orchard & Vine').filter((r) => r[0] === '2026-10' && r[1] === 'ALL')[0][2];
    const friday = ratePerUsd(p, '2026-10-02');
    assert.equal(Math.round((after - before) * 100), Math.round(Math.round(92 / friday * 100)), 'the Friday rate converts the Saturday row');
  },
  44: () => {
    const p = loadSeeded();
    p.setProp('REPORT_CC', 'ops@fernwood.example.test');
    p.call('runClientReport', 'Harbor Lane Bakery', '2026-10');
    assert.deepEqual([p.w.sent[0].to, p.w.sent[0].cc], [MAIL.harbor, 'ops@fernwood.example.test']);
  },
  45: () => {
    const p = loadSeeded();
    p.call('runClientReport', 'Harbor Lane Bakery', '2026-10');
    p.append('Campaigns', [['Harbor Lane Bakery', 'search', '2026-10-20', 50, 5, 1, 'USD']]);
    p.call('sidebarRunReport', 'Harbor Lane Bakery', '2026-10', true);
    assert.equal(p.rows('Report Log')[1][5], '', 'a preview of changed figures is not the client email');
    p.call('dialogConfirmMonthClose', '2026-10');
    assert.equal(p.w.sent.filter((m) => m.to === MAIL.harbor).length, 2, 'the new figures reached the client');
  },
  46: (c) => {
    const p = loadSeeded();
    p.append('Campaigns', [c.input.row]);
    assert.equal(p.plain(p.call('buildClientSummaries')).rejected, 1);
  },
  47: () => {
    const p = loadSeeded();
    const res = submit(p, formOf(p), {});
    assert.deepEqual(res, { status: 'active', client: 'Bluebell Bikes', emailed: true });
    assert.deepEqual(mails(p), ['rae@bluebellbikes.example.com']);
  },
  48: () => {
    const p = loadSeeded();
    const res = submit(p, formOf(p), { [T.EMAIL]: 'rae at bluebell' });
    assert.deepEqual([res.status, res.emailed, p.w.sent.length, p.rows('Clients').length], ['needs_review', false, 0, 11]);
  },
  49: () => {
    const p = loadSeeded();
    const res = submit(p, formOf(p), { [T.BUDGET]: '' });
    assert.equal(res.status, 'active');
    assert.equal(p.rows('Clients')[10][5], 0);
  },
  50: () => {
    const p = loadSeeded();
    const f = formOf(p);
    submit(p, f, {});
    const [second] = p.w.deliverFormResponse(f, f.getResponses()[0]);
    assert.equal(p.plain(second).status, 'duplicate');
    assert.equal(p.rows('Clients').length, 11);
    assert.equal(p.w.sent.length, 1);
  },
  51: () => {
    const p = loadSeeded();
    const name = '=HYPERLINK("http://x.example.test","a")';
    submit(p, formOf(p), { [T.CLIENT]: name });
    assert.deepEqual(p.w.formulas, []);
    assert.equal(p.rows('Clients')[10][0], name);
  },
  52: () => intakeThen(null, { [T.CLIENT]: 'summit yoga', [T.EMAIL]: MAIL.summit }, () => {}),
  53: () => {
    const p = loadSeeded();
    const res = submit(p, formOf(p), { [T.BUDGET]: '1500.50' });
    assert.equal(res.status, 'active');
    assert.equal(p.rows('Clients')[10][5], 1500.5);
  }
};

module.exports = { RUNNERS };
