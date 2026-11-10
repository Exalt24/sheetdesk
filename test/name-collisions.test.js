'use strict';
/**
 * One colliding client name must stop only the clients that collide. Found by
 * the blind adversary pass (test/corpus/corpus_sheetdesk_blind_2.jsonl, lines
 * 31 to 34): a second intake row for Harbor Lane Bakery, or one Campaigns row
 * typed in lower case, made Run report, Rebuild summaries and the month close
 * throw for every client, and the intake form had already emailed a
 * confirmation for a name the reports would refuse.
 *
 * The tables are built by code: each kind of collision against each entry
 * point (report, summaries, month close, intake), then each kind of Campaigns
 * row that matches no client against the places that must say so.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadSeeded } = require('./helpers/load');

const T = {
  CLIENT: 'Client name', CONTACT: 'Contact name', EMAIL: 'Contact email',
  CHANNEL: 'Primary channel', BUDGET: 'Monthly budget (USD)', NOTES: 'Notes'
};

const FIXTURE_ACTIVE = ['Harbor Lane Bakery', 'Pinecrest Physio', 'Orchard & Vine', 'Summit Yoga', 'Copperline Plumbing', 'Lumen Opticals', 'Tidewater Tutors', 'Foxglove Florist'];
const LONG = 'x'.repeat(80);

/** Collision kinds: [label, a name that is (or becomes) a client, a second name that shares its report file name or summary tab, which of the two]. */
const KINDS = [
  ['other case', 'Harbor Lane Bakery', 'harbor lane bakery', 'report file name'],
  ['upper case', 'Harbor Lane Bakery', 'HARBOR LANE BAKERY', 'report file name'],
  ['trailing period', 'Harbor Lane Bakery', 'Harbor Lane Bakery.', 'report file name'],
  ['trailing comma', 'Harbor Lane Bakery', 'Harbor Lane Bakery,', 'report file name'],
  ['double spaces', 'Harbor Lane Bakery', 'Harbor  Lane   Bakery', 'report file name'],
  ['hyphen for a space', 'Harbor Lane Bakery', 'Harbor-Lane Bakery', 'report file name'],
  ['ampersand left out', 'Orchard & Vine', 'Orchard Vine', 'report file name'],
  ['slash and dash in the tab name', 'A/B Co', 'A-B Co', 'report file name'],
  ['two names equal in their first 80 characters', LONG + '1', LONG + '2', 'summary tab name']
];

const clientRow = (name, status) => [name, 'Casey Contact', 'casey@' + name.toLowerCase().replace(/[^a-z]+/g, '') .slice(0, 20) + '.example.com', '', 'search', 100, status, '', ''];
const campaignRow = (name) => [name, 'search', '2026-10-10', 100, 10, 1, 'USD'];

/** The seeded project with both names present as clients (the second with `status`) and with one October Campaigns row each. */
function build(a, b, status) {
  const p = loadSeeded();
  const have = new Set(p.fx.clients.map((r) => r[0]));
  const clients = [];
  const campaigns = [];
  [[a, 'active'], [b, status]].forEach(([n, st]) => {
    if (!have.has(n) || n === b) {
      clients.push(clientRow(n, st));
      campaigns.push(campaignRow(n));
    }
  });
  p.append('Clients', clients);
  p.append('Campaigns', campaigns);
  return p;
}

const quoted = (n) => '"' + n + '"';

/** The exact message for a clash of two names: the file name is named first when both are shared. */
function assertNamesBoth(message, a, b, where, what) {
  assert.equal(message, 'Clients ' + quoted(a) + ' and ' + quoted(b) + ' would share one ' + what + '.', where);
}

function reference() {
  const p = loadSeeded();
  p.call('buildClientSummaries');
  return p;
}

const SUMMARY_KEYS = ['tabs', 'rows', 'rejected'];

// CLASS-TABLE: every collision kind against Run report
test('CLASS-TABLE: Run report refuses the clients that collide, names both, and builds every other client', () => {
  for (const [label, a, b, what] of KINDS) {
    for (const status of ['needs_review', 'active']) {
      const p = build(a, b, status);
      const where = label + ', second name ' + status;
      for (const name of [a, b]) {
        assert.throws(() => p.call('runClientReport', name, '2026-10'), (e) => {
          assertNamesBoth(e.message, a, b, where + ', ' + name, what);
          return true;
        });
      }
      assert.equal(p.w.sent.length, 0, where + ': nothing was sent for the colliding pair');
      for (const name of FIXTURE_ACTIVE.filter((n) => n !== a && n !== b)) {
        const r = p.plain(p.call('runClientReport', name, '2026-10'));
        assert.equal(r.status, 'ok', where + ': ' + name);
        assert.equal(r.email, 'sent', where + ': ' + name);
        assert.deepEqual(Object.keys(r).filter((k) => !['status', 'client', 'month', 'pdfName', 'pdfId', 'replaced', 'email', 'spend'].includes(k)), [], where + ': an ordinary result gains no key');
      }
    }
  }
});

// CLASS-TABLE: every collision kind against Rebuild summaries
test('CLASS-TABLE: Rebuild summaries leaves out the names that collide, names both, and rebuilds the rest the same as without them', () => {
  const ref = reference();
  for (const [label, a, b, what] of KINDS) {
    const p = build(a, b, 'needs_review');
    const r = p.plain(p.call('buildClientSummaries'));
    const clashing = new Set([a, b]);
    assert.equal(r.skipped.length, 1, label + ': one clash');
    assertNamesBoth(r.skipped[0], a, b, label, what);
    // the Campaigns names are the nine fixture clients plus b, and a when it is not one of them; a and b are both left out
    const campaignNames = 9 + 1 + (FIXTURE_ACTIVE.includes(a) ? 0 : 1);
    assert.equal(r.tabs, campaignNames - 2, label + ': tabs');
    for (const name of clashing) assert.equal(p.sheet('Summary - ' + name.replace(/[[\]*/\\?:]/g, '-').trim().slice(0, 80)), undefined, label + ': no tab for ' + name);
    for (const name of [...FIXTURE_ACTIVE, 'Granite Ridge Climbing'].filter((n) => !clashing.has(n))) {
      assert.deepEqual(p.rows('Summary - ' + name), ref.rows('Summary - ' + name), label + ': the tab of ' + name + ' is as without the clash');
    }
    const menu = p.w;
    p.call('menuRebuildSummaries');
    assert.equal(menu.ui.toasts[0].msg, r.tabs + ' tabs, ' + r.rows + ' rows. Left out: ' + r.skipped[0], label + ': the menu message names both');
  }
});

// CLASS-TABLE: every collision kind against the month close and its dialog
test('CLASS-TABLE: the month close reports every other client and lists the colliding ones as errors that name both', () => {
  for (const [label, a, b, what] of KINDS) {
    for (const status of ['needs_review', 'active']) {
      const where = label + ', second name ' + status;
      const p = build(a, b, status);
      const r = p.plain(p.call('runMonthClose', '2026-10'));
      const clashing = [a, b].filter((n) => n === a || status === 'active');
      const others = FIXTURE_ACTIVE.filter((n) => n !== a && n !== b);
      assert.deepEqual(r.results.filter((x) => x.status === 'ok').map((x) => x.client).sort(), others.slice().sort(), where + ': every other client has its report');
      assert.ok(r.results.filter((x) => x.status === 'ok').every((x) => x.email === 'sent'), where + ': and its email');
      const errors = r.results.filter((x) => x.status === 'error');
      assert.deepEqual(errors.map((x) => x.client).sort(), clashing.slice().sort(), where + ': the colliding active clients are the errors');
      for (const x of errors) assertNamesBoth(x.error, a, b, where + ', ' + x.client, what);
      assert.equal(r.clashes.length, 1, where);
      assert.equal(r.pending.length, 0, where);
      assert.equal(p.w.sent.length, others.length, where + ': one email per other client');
      assert.equal(p.rows('Job Log')[1][4], others.length + errors.length, where + ': the job log counts what was run');

      const q = build(a, b, status);
      const d = q.plain(q.call('dialogConfirmMonthClose', '2026-10'));
      assert.equal(d.done, others.length, where + ': dialog done');
      assert.equal(d.errors, errors.length, where + ': dialog failed');
      assert.equal(d.emailed, others.length, where + ': dialog emailed');
      assertNamesBoth(d.clashes[0], a, b, where + ': the dialog names both', what);
    }
  }
});

function formAnswers(name) {
  return { [T.CLIENT]: name, [T.CONTACT]: 'Rae Delgado', [T.EMAIL]: 'rae@example.com', [T.CHANNEL]: 'social', [T.BUDGET]: '2,500', [T.NOTES]: '' };
}

// CLASS-TABLE: every collision kind against the intake form
test('CLASS-TABLE: the intake form holds a name that would share a file name or tab as needs_review and sends nothing', () => {
  for (const [label, a, b] of KINDS) {
    const p = loadSeeded();
    const r = p.plain(p.call('installIntakeTrigger'));
    const f = p.w.forms.get(r.formId);
    if (!FIXTURE_ACTIVE.includes(a)) {
      const [first] = p.w.submitForm(f, formAnswers(a));
      assert.deepEqual(p.plain(first), { status: 'active', client: a, emailed: true }, label + ': the first name is active');
    }
    const before = p.w.sent.length;
    const [second] = p.w.submitForm(f, formAnswers(b));
    assert.deepEqual(p.plain(second), { status: 'needs_review', client: b, emailed: false }, label + ': the second name is held');
    assert.equal(p.w.sent.length, before, label + ': no email for the held name');
    const row = p.rows('Clients').filter((x) => x[0] === b)[0];
    assert.equal(row[6], 'needs_review', label + ': the row is kept for a person to look at');
    // a name that clashes with nothing is still confirmed
    const [clear] = p.w.submitForm(f, formAnswers('Bluebell Bikes'));
    assert.deepEqual(p.plain(clear), { status: 'active', client: 'Bluebell Bikes', emailed: true }, label + ': a clear name is confirmed');
  }
});

// CLASS-TABLE: a held intake row does not stop the reports of the clients that do not collide
test('CLASS-TABLE: after a held intake row every other client still gets a report, a summary and a month close', () => {
  for (const [label, a, b] of KINDS.filter((k) => FIXTURE_ACTIVE.includes(k[1]))) {
    const p = loadSeeded();
    const f = p.w.forms.get(p.plain(p.call('installIntakeTrigger')).formId);
    p.w.submitForm(f, formAnswers(b));
    const others = FIXTURE_ACTIVE.filter((n) => n !== a);
    const single = p.plain(p.call('runClientReport', 'Copperline Plumbing', '2026-10'));
    assert.equal(single.status, 'ok', label);
    const summaries = p.plain(p.call('buildClientSummaries'));
    assert.equal(summaries.tabs, 9, label + ': the Campaigns names do not collide, so every tab is rebuilt');
    const close = p.plain(p.call('runMonthClose', '2026-10'));
    assert.equal(close.results.filter((x) => x.status === 'ok' || x.status === 'current').length, others.length, label);
  }
});

// CLASS-TABLE: names that do not collide change nothing
test('CLASS-TABLE: distinct names, a clean Campaigns sheet and an ordinary run add no key to any result', () => {
  const p = loadSeeded();
  const s = p.plain(p.call('buildClientSummaries'));
  assert.deepEqual(Object.keys(s), SUMMARY_KEYS);
  const close = p.plain(p.call('runMonthClose', '2026-10'));
  assert.deepEqual(Object.keys(close).sort(), ['month', 'pending', 'results', 'summaries']);
  assert.deepEqual(Object.keys(close.summaries), SUMMARY_KEYS);
  const q = loadSeeded();
  const d = q.plain(q.call('dialogConfirmMonthClose', '2026-10'));
  assert.deepEqual(Object.keys(d).sort(), ['done', 'emailFailed', 'emailed', 'errors', 'month', 'pending']);
  const r = loadSeeded();
  r.call('menuRebuildSummaries');
  assert.equal(r.w.ui.toasts[0].msg, '9 tabs, ' + s.rows + ' rows');
});

/** Campaigns rows that match no client: [label, the client as typed, how many rows, whether it also shares a name with a real client]. */
const UNMATCHED = [
  ['lower case', 'summit yoga', 1, true],
  ['upper case', 'SUMMIT YOGA', 1, true],
  ['a typo', 'Sumit Yoga', 1, false],
  ['double space inside', 'Summit  Yoga', 1, true],
  ['a client that does not exist', 'Nobody Ltd', 1, false],
  ['the same typo on three days', 'Sumit Yoga', 3, false]
];

function withRows(name, count) {
  const p = loadSeeded();
  const rows = [];
  for (let i = 0; i < count; i++) rows.push([name, 'search', '2026-10-2' + i, 100, 10, 1, 'USD']);
  p.append('Campaigns', rows);
  return p;
}

// CLASS-TABLE: every kind of Campaigns row that matches no client against every place that must say so
test('CLASS-TABLE: a Campaigns row whose client matches no client is counted and named in the report, the summaries, the menu message and the month close', () => {
  for (const [label, name, count, shares] of UNMATCHED) {
    const want = { rows: count, clients: [name] };
    const base = loadSeeded();
    const baseline = base.plain(base.call('runClientReport', 'Summit Yoga', '2026-10')).spend;

    const p = withRows(name, count);
    const report = p.plain(p.call('runClientReport', 'Summit Yoga', '2026-10'));
    assert.deepEqual(report.unmatched, want, label + ': the report names it');
    assert.equal(report.spend, baseline, label + ': and the row is not in the figures');

    const q = withRows(name, count);
    const s = q.plain(q.call('buildClientSummaries'));
    assert.deepEqual(s.unmatched, want, label + ': the summaries name it');
    assert.equal(Boolean(s.skipped), shares, label + ': a clash with a real client is listed only when there is one');

    const m = withRows(name, count);
    m.call('menuRebuildSummaries');
    const toast = m.w.ui.toasts[0].msg;
    const sentence = count + (count === 1 ? ' Campaigns row names' : ' Campaigns rows name') + ' a client that is not in the Clients tab (' + name + '), so ' +
      (count === 1 ? 'it is' : 'they are') + ' in no report.';
    const counts = s.tabs + ' tabs, ' + s.rows + ' rows' + (s.skipped ? '. Left out: ' + s.skipped.join(' ') : '');
    assert.equal(toast, counts + '. ' + sentence, label + ': the menu message names it');

    const c = withRows(name, count);
    const close = c.plain(c.call('runMonthClose', '2026-10'));
    assert.deepEqual(close.summaries.unmatched, want, label + ': the month close names it');
    const d = withRows(name, count);
    assert.deepEqual(d.plain(d.call('dialogConfirmMonthClose', '2026-10')).unmatched, want, label + ': the dialog names it');
  }
});

// CLASS-TABLE: a row that does match is never reported as unmatched, and a long list is cut
test('CLASS-TABLE: a name with outer spaces matches its client, and a long list of unmatched names is cut at ten', () => {
  const p = withRows('Summit Yoga ', 2);
  const r = p.plain(p.call('buildClientSummaries'));
  assert.equal(r.unmatched, undefined, 'outer spaces are trimmed before the match');
  const q = loadSeeded();
  const rows = [];
  for (let i = 0; i < 12; i++) rows.push(['Stranger ' + String.fromCharCode(97 + i), 'search', '2026-10-05', 5, 1, 0, 'USD']);
  q.append('Campaigns', rows);
  const u = q.plain(q.call('buildClientSummaries')).unmatched;
  assert.equal(u.rows, 12);
  assert.equal(u.clients.length, 10);
  assert.deepEqual(u.clients, [...u.clients].sort());
});

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/** Runs the script of a sidebar or dialog page against a small fake page; `replies` maps a server function to what it returns. */
function pageScript(file) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', file), 'utf8');
  return /<script>([\s\S]*)<\/script>/.exec(html)[1];
}

function openPage(file, replies) {
  const elements = {};
  const el = (id) => elements[id] || (elements[id] = { id, value: '', checked: true, disabled: false, textContent: '', className: '', appendChild() {}, onclick: null });
  const make = (s, f) => new Proxy({}, {
    get(_, k) {
      if (k === 'withSuccessHandler') return (fn) => make(fn, f);
      if (k === 'withFailureHandler') return (fn) => make(s, fn);
      return () => { if (s && replies[k] !== undefined) s(replies[k]); };
    }
  });
  const sandbox = { document: { getElementById: el, createElement: () => ({}) }, google: { script: { run: make(null, null), host: { close() {} } } } };
  vm.runInNewContext(pageScript(file), sandbox);
  return { click: (id) => el(id).onclick(), status: () => el('status').textContent };
}

// CLASS-TABLE: the sidebar and the dialog say what the server found, and say nothing more on an ordinary run
test('CLASS-TABLE: the sidebar and the month close dialog show a name clash and unmatched Campaigns rows, and nothing extra on an ordinary run', () => {
  for (const status of ['ok', 'no_data']) {
    for (const unmatched of [null, { rows: 2, clients: ['sumit yoga', 'Nobody Ltd'] }]) {
      const result = { status, client: 'Summit Yoga', month: '2026-10', pdfName: 'summit-yoga-2026-10.pdf', pdfId: 'f1', replaced: 0, email: 'sent', spend: 'USD 1.00' };
      if (unmatched) result.unmatched = unmatched;
      const page = openPage('Sidebar.html', { sidebarGetOptions: { clients: [], months: [] }, sidebarRunReport: result });
      page.click('run-report');
      const base = status === 'no_data' ? 'No data for that month.' : 'Report ready: summit-yoga-2026-10.pdf. Email: sent to the client.';
      const extra = unmatched ? ' 2 Campaigns row(s) name a client that is not in the Clients tab (sumit yoga, Nobody Ltd) and are in no report.' : '';
      assert.equal(page.status(), base + extra, status + (unmatched ? ' with unmatched rows' : ''));
    }
  }
  const quiet = { month: '2026-10', done: 8, errors: 0, pending: 0, emailed: 8, emailFailed: 0 };
  const line = '8 done, 0 failed, 0 waiting, 8 emailed, 0 not emailed (mail refused; the next close sends them).';
  for (const withClash of [false, true]) {
    for (const withSkipped of [false, true]) {
      for (const withUnmatched of [false, true]) {
        const reply = Object.assign({}, quiet);
        let want = line;
        if (withClash) { reply.clashes = ['Clients "A" and "a" would share one report file name.']; want += ' Not reported: Clients "A" and "a" would share one report file name.'; }
        if (withSkipped) { reply.skipped = ['Clients "B" and "b" would share one report file name.']; want += ' Summaries left out: Clients "B" and "b" would share one report file name.'; }
        if (withUnmatched) { reply.unmatched = { rows: 3, clients: ['sumit yoga'] }; want += ' 3 Campaigns row(s) name a client that is not in the Clients tab (sumit yoga).'; }
        const page = openPage('Dialog.html', { dialogConfirmMonthClose: reply });
        page.click('confirm');
        assert.equal(page.status(), want, JSON.stringify([withClash, withSkipped, withUnmatched]));
      }
    }
  }
});

// CLASS-TABLE: the same name twice is not a clash, three names that clash are named together, and no Clients tab means nothing to compare
test('CLASS-TABLE: an identical name on two rows is one client, a three way clash names all three, and no Clients tab adds no key and no sheet', () => {
  const p = loadSeeded();
  p.append('Clients', [clientRow('Summit Yoga', 'active')]);
  assert.equal(p.plain(p.call('runClientReport', 'Summit Yoga', '2026-10')).status, 'ok');
  assert.equal(p.plain(p.call('buildClientSummaries')).skipped, undefined);

  const q = loadSeeded();
  const names = ['Harbor Lane Bakery', 'harbor lane bakery', 'HARBOR LANE BAKERY'];
  q.append('Clients', names.slice(1).map((n) => clientRow(n, 'needs_review')));
  q.append('Campaigns', names.slice(1).map(campaignRow));
  const want = 'Clients "Harbor Lane Bakery", "harbor lane bakery" and "HARBOR LANE BAKERY" would share one report file name.';
  assert.throws(() => q.call('runClientReport', 'Harbor Lane Bakery', '2026-10'), (e) => e.message === want);
  assert.deepEqual(q.plain(q.call('buildClientSummaries')).skipped, [want]);
  assert.deepEqual(q.plain(q.call('runMonthClose', '2026-10')).clashes, [want]);

  const { loadProject, HEADERS } = require('./helpers/load');
  const bare = loadProject();
  bare.fill('Campaigns', HEADERS.campaigns, [campaignRow('Anyone'), campaignRow('anyone')]);
  const r = bare.plain(bare.call('buildClientSummaries'));
  assert.deepEqual(Object.keys(r).sort(), ['rejected', 'rows', 'skipped', 'tabs']);
  assert.equal(bare.sheet('Clients'), undefined, 'the summaries do not create the Clients tab');
  const only = loadProject();
  only.fill('Campaigns', HEADERS.campaigns, [campaignRow('Anyone')]);
  assert.deepEqual(Object.keys(only.plain(only.call('buildClientSummaries'))), ['tabs', 'rows', 'rejected']);
  assert.equal(only.sheet('Clients'), undefined);
});

// CLASS-TABLE: two unmatched names are listed in order, in the result and in the menu message
test('CLASS-TABLE: several unmatched names are listed in order with commas', () => {
  const p = loadSeeded();
  p.append('Campaigns', [campaignRow('Sumit Yoga'), campaignRow('Nobody Ltd'), campaignRow('Sumit Yoga')]);
  const r = p.plain(p.call('buildClientSummaries'));
  assert.deepEqual(r.unmatched, { rows: 3, clients: ['Nobody Ltd', 'Sumit Yoga'] });
  p.call('menuRebuildSummaries');
  assert.equal(p.w.ui.toasts[0].msg, r.tabs + ' tabs, ' + r.rows + ' rows. 3 Campaigns rows name a client that is not in the Clients tab (Nobody Ltd, Sumit Yoga), so they are in no report.');
});
