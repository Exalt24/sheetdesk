'use strict';
/**
 * What a client writes in the intake form must be kept or answered. Found by the
 * final blind recall (round 4): F5, the Notes answer was dropped, and a budget
 * written as $2,500, 2500 USD or 2.5k made the client needs_review with budget 0,
 * no email and no record of which check failed; F6, a row held as needs_review
 * stopped the active client of the same name (that part is in
 * test/name-collisions.test.js, this file holds the intake side).
 *
 * The tables are built by code: each way of writing a budget, each Notes answer,
 * each set of failed checks, each state of the Clients tab's own columns and each
 * status of an existing row with the same name.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadProject, loadSeeded, HEADERS } = require('./helpers/load');

const T = {
  CLIENT: 'Client name', CONTACT: 'Contact name', EMAIL: 'Contact email',
  CHANNEL: 'Primary channel', BUDGET: 'Monthly budget (USD)', NOTES: 'Notes'
};

function answers(over = {}) {
  return Object.assign({
    [T.CLIENT]: 'Bluebell Bikes', [T.CONTACT]: 'Rae Delgado', [T.EMAIL]: 'rae@bluebellbikes.example.com',
    [T.CHANNEL]: 'social', [T.BUDGET]: '2,500', [T.NOTES]: ''
  }, over);
}

function submit(p, over) {
  const form = p.w.forms.get(p.plain(p.call('installIntakeTrigger')).formId);
  return submitTo(p, form, over);
}

function submitTo(p, form, over) {
  const [res] = p.w.submitForm(form, answers(over));
  return p.plain(res);
}

/** The last row of the Clients tab, nine columns plus notes and review_reason. */
const lastRow = (p) => { const r = p.rows('Clients'); return r[r.length - 1]; };

/** Budgets people write: [text, the number kept]. */
const GOOD_BUDGETS = [
  ['2500', 2500], ['2,500', 2500], ['2500.50', 2500.5], ['0', 0], ['  2500  ', 2500], ['1,2,3', 123],
  ['$2,500', 2500], ['$2500', 2500], ['$ 2,500', 2500], ['USD 2,500', 2500], ['usd2500', 2500], ['US$2,500', 2500],
  ['2500 USD', 2500], ['2,500 usd', 2500], ['2.5k', 2500], ['2.5K', 2500], ['$2.5k', 2500], ['10k', 10000], ['1.1k', 1100], ['0.5k', 500], ['2 k', 2000]
];
const BAD_BUDGETS = ['abc', '-5', '$-5', '-2k', 'k', '2.5kk', '$', 'USD', 'about 2500', '2500 dollars', '1e3', '€2,500', '2 500', '2.5.0', 'k2'];

// CLASS-TABLE: every way of writing a budget against the intake form
test('CLASS-TABLE: the budget is read in the forms people write it, and a budget that is not a number holds the client with the check named', () => {
  for (const [text, want] of GOOD_BUDGETS) {
    const p = loadProject();
    const res = submit(p, { [T.BUDGET]: text });
    assert.deepEqual(res, { status: 'active', client: 'Bluebell Bikes', emailed: true }, JSON.stringify(text));
    const row = lastRow(p);
    assert.equal(row[5], want, JSON.stringify(text) + ': budget');
    assert.equal(row[6], 'active', JSON.stringify(text));
    assert.equal(row[10], '', JSON.stringify(text) + ': no reason');
    assert.equal(p.w.sent.length, 1, JSON.stringify(text) + ': confirmed');
  }
  for (const text of BAD_BUDGETS) {
    const p = loadProject();
    const res = submit(p, { [T.BUDGET]: text });
    assert.deepEqual(res, { status: 'needs_review', client: 'Bluebell Bikes', emailed: false, reason: 'Check failed: monthly budget.' }, JSON.stringify(text));
    const row = lastRow(p);
    assert.equal(row[5], 0, JSON.stringify(text) + ': budget');
    assert.equal(row[6], 'needs_review');
    assert.equal(row[10], 'Check failed: monthly budget.', JSON.stringify(text) + ': the cell says which check failed');
    assert.equal(p.w.sent.length, 0, JSON.stringify(text) + ': no email');
  }
  const blank = loadProject();
  assert.deepEqual(submit(blank, { [T.BUDGET]: '' }), { status: 'active', client: 'Bluebell Bikes', emailed: true }, 'a blank budget is fine');
  assert.equal(lastRow(blank)[5], 0);
});

/** Notes answers: [label, what was typed, what the cell keeps]. */
const NOTES = [
  ['nothing', '', ''],
  ['a line', 'Starts in March', 'Starts in March'],
  ['two lines', 'Send reports to my accountant too.\nNever on Fridays.', 'Send reports to my accountant too.\nNever on Fridays.'],
  ['outer spaces', '  padded  ', 'padded'],
  ['a formula', '=HYPERLINK("http://example.test","click")', '=HYPERLINK("http://example.test","click")'],
  ['a number', '007', '007'],
  ['a percent', '50%', '50%'],
  ['a month', '2026-10', '2026-10'],
  ['a very long text', 'x'.repeat(60000), 'x'.repeat(50000)]
];

// CLASS-TABLE: every Notes answer against the Clients row
test('CLASS-TABLE: the Notes answer is kept in the notes column as text, for an active row and a held row alike', () => {
  for (const [label, typed, kept] of NOTES) {
    for (const email of ['rae@bluebellbikes.example.com', 'rae@bluebell']) {
      const p = loadProject();
      const res = submit(p, { [T.NOTES]: typed, [T.EMAIL]: email });
      assert.equal(res.status, email.includes('.') ? 'active' : 'needs_review', label);
      const row = lastRow(p);
      assert.equal(row[9], kept, label + ' ' + email + ': notes');
      assert.deepEqual(p.w.formulas, [], label + ': no formula was made');
      assert.deepEqual(p.rows('Clients')[0].slice(9), ['notes', 'review_reason'], label + ': the header');
    }
  }
});

/** Failed checks: [label, answer changes, the reason cell]. */
const SHARES = 'The name would share a report file name or summary tab with the active client "Harbor Lane Bakery".';
const REASONS = [
  ['a bad email', { [T.EMAIL]: 'rae@bluebell' }, 'Check failed: contact email.'],
  ['a bad budget', { [T.BUDGET]: 'lots' }, 'Check failed: monthly budget.'],
  ['a bad email and budget', { [T.EMAIL]: 'rae', [T.BUDGET]: 'lots' }, 'Check failed: contact email, monthly budget.'],
  ['a name over 120 characters', { [T.CLIENT]: 'N'.repeat(121) }, 'Check failed: client name.'],
  ['every check', { [T.CLIENT]: 'N'.repeat(121), [T.EMAIL]: 'x', [T.BUDGET]: 'lots' }, 'Check failed: client name, contact email, monthly budget.'],
  ['a name that clashes with an active client', { [T.CLIENT]: 'harbor lane bakery' }, SHARES],
  ['a clash and a bad email', { [T.CLIENT]: 'Harbor Lane Bakery.', [T.EMAIL]: 'rae' }, 'Check failed: contact email. ' + SHARES]
];

// CLASS-TABLE: every set of failed checks against the review_reason cell and the return value
test('CLASS-TABLE: a held row records which checks failed, in the cell and in the return value, and an active row records none', () => {
  for (const [label, over, reason] of REASONS) {
    const p = loadSeeded();
    const res = submit(p, over);
    assert.deepEqual(res, { status: 'needs_review', client: over[T.CLIENT] || 'Bluebell Bikes', emailed: false, reason }, label);
    const row = lastRow(p);
    assert.equal(row[6], 'needs_review', label);
    assert.equal(row[10], reason, label + ': the cell');
    assert.equal(p.w.sent.length, 0, label + ': no email');
  }
  const ok = loadSeeded();
  assert.deepEqual(Object.keys(submit(ok, {})), ['status', 'client', 'emailed'], 'an active row has no reason key');
  assert.equal(lastRow(ok)[10], '');
});

function withClients(extraHeaders, build) {
  const p = loadProject();
  p.fill('Clients', HEADERS.clients.concat(extraHeaders), [['Harbor Lane Bakery', 'Mira', 'mira@harbor.example.com', 'a', 'search', 8900, 'active', '', ''].concat(extraHeaders.map(() => ''))]);
  if (build) build(p);
  return p;
}

// CLASS-TABLE: every state of the two columns after created_at against the intake form and Set up
test('CLASS-TABLE: the notes and review_reason headers are added when both cells are empty, kept when present, and never written over text of the tab\'s own', () => {
  const cases = [
    ['no Clients tab', () => loadProject(), true],
    ['nine columns, as imported from the fixture', () => loadSeeded(), true],
    ['both headers present', () => withClients(['notes', 'review_reason']), true],
    ['J1 holds a column of its own', () => withClients(['owner_notes']), false],
    ['K1 holds a column of its own', () => withClients(['', 'owner_flag']), false],
    ['both hold columns of their own', () => withClients(['a', 'b']), false],
    ['J1 is notes but K1 is something else', () => withClients(['notes', 'x']), false]
  ];
  for (const [label, build, extras] of cases) {
    const p = build();
    const before = p.rows('Clients') ? p.rows('Clients')[0].slice(9) : [];
    const res = submit(p, { [T.NOTES]: 'Never on Fridays' });
    assert.equal(res.status, 'active', label);
    const head = p.rows('Clients')[0].slice(9);
    const row = lastRow(p);
    if (extras) {
      assert.deepEqual(head, ['notes', 'review_reason'], label + ': header');
      assert.equal(row[9], 'Never on Fridays', label + ': notes kept');
      assert.deepEqual(p.w.logs.filter((l) => /own text in J1 or K1/.test(l)), [], label + ': nothing to log');
      const again = submit(p, { [T.CLIENT]: 'Second Bikes', [T.NOTES]: 'Two' });
      assert.equal(again.status, 'active', label + ': a second client');
      assert.deepEqual(p.rows('Clients')[0].slice(9), ['notes', 'review_reason'], label + ': the header is not added twice');
      assert.equal(lastRow(p)[9], 'Two', label);
    } else {
      assert.deepEqual(head, before.map(String), label + ': the tab\'s own header is left alone');
      assert.equal(row.length, 9, label + ': the row keeps its nine columns');
      assert.equal(row[6], 'active', label);
      assert.equal(p.w.logs.filter((l) => /own text in J1 or K1/.test(l)).length, 1, label + ': logged, so it is not silent');
    }
  }
  for (const [label, build, extras] of cases.filter((c) => c[0] !== 'no Clients tab')) {
    const p = build();
    const before = p.rows('Clients')[0].slice(9);
    p.call('setUp');
    p.call('setUp');
    assert.deepEqual(p.rows('Clients')[0].slice(9), extras ? ['notes', 'review_reason'] : before.map(String), 'Set up, ' + label);
  }
  const fresh = loadProject();
  fresh.call('setUp');
  assert.deepEqual(fresh.rows('Clients')[0], [...HEADERS.clients, 'notes', 'review_reason'], 'Set up on a new Sheet writes the full header');
});

// CLASS-TABLE: the extra columns change nothing for the code that reads Clients
test('CLASS-TABLE: a Clients tab with the notes and review_reason columns is read the same as one without them', () => {
  const plain = loadSeeded();
  const withCols = loadSeeded();
  submit(withCols, { [T.CLIENT]: 'Pinecrest Physio.', [T.NOTES]: 'a note' });
  const a = plain.plain(plain.call('runMonthClose', '2026-10'));
  const b = withCols.plain(withCols.call('runMonthClose', '2026-10'));
  assert.deepEqual(b.results.map((r) => [r.client, r.status, r.email]), a.results.map((r) => [r.client, r.status, r.email]));
  assert.equal(withCols.plain(withCols.call('cachedClientNames_')).length, 10);
});

/** Statuses of an existing row with the same name: [label, status as typed, whether it holds the new name back]. */
const STATUSES = [
  ['active', 'active', true], ['Active with a space', 'Active ', true], ['upper case', 'ACTIVE', true],
  ['needs_review', 'needs_review', false], ['paused', 'paused', false], ['blank', '', false], ['inactive', 'inactive', false], ['review', 'review', false]
];

// CLASS-TABLE: every status of the existing row against a new row that shares its name
test('CLASS-TABLE: a new row is held for a name clash only with an active row, and the reason names that row', () => {
  for (const [label, status, holds] of STATUSES) {
    for (const typed of ['harbor lane bakery', 'Harbor Lane Bakery', 'HARBOR LANE BAKERY.']) {
      const p = loadProject();
      p.fill('Clients', HEADERS.clients, [['  Harbor Lane Bakery ', 'Mira', 'mira@harbor.example.com', 'a', 'search', 8900, status, '', '']]);
      const res = submit(p, { [T.CLIENT]: typed });
      const where = label + ', ' + typed;
      if (holds) {
        assert.deepEqual(res, { status: 'needs_review', client: typed, emailed: false, reason: SHARES }, where);
        assert.equal(p.w.sent.length, 0, where);
      } else {
        assert.deepEqual(res, { status: 'active', client: typed, emailed: true }, where + ': a row that is not a client holds nothing back');
        assert.equal(p.w.sent.length, 1, where);
      }
      assert.equal(p.rows('Clients').length, 3, where + ': the new row is kept either way');
    }
  }
});

// CLASS-TABLE: a returning client with the same name as a paused row is reported from the active row
test('CLASS-TABLE: when a paused row and an active row have the same name the report goes to the active row, whichever comes first', () => {
  for (const order of [['paused', 'active'], ['active', 'paused'], ['needs_review', 'active']]) {
    const p = loadSeeded();
    const rows = order.map((status, i) => ['Summit Yoga', 'Priya', (status === 'active' ? 'new' : 'old') + i + '@summityoga.example.com', 'acct-9', 'social', 4000, status, '', '']);
    p.fill('Clients', HEADERS.clients, rows.concat(p.fx.clients.filter((c) => c[0] !== 'Summit Yoga')));
    const r = p.plain(p.call('runClientReport', 'Summit Yoga', '2026-10'));
    assert.equal(r.status, 'ok', order.join());
    assert.match(p.w.sent[0].to, /^new/, order.join() + ': the active row\'s address');
  }
});

// CLASS-TABLE: the width of the Clients grid against the two extra columns: a grid that is too narrow grows to eleven columns and no more, a wide one is left as it is
test('CLASS-TABLE: ensureClientExtras_ grows a Clients grid narrower than eleven columns to exactly eleven and never shrinks or over-grows one', () => {
  for (const width of [9, 10, 11, 12, 26]) {
    for (const rowsBefore of [1, 2, 5]) {
      const p = loadProject();
      p.fill('Clients', HEADERS.clients, Array.from({ length: rowsBefore - 1 }, (_, i) => ['Client ' + i, 'C', 'c' + i + '@example.com', 'a', 'search', 100, 'active', '', '']));
      const rowsMax = p.w.run(() => {
        const sheet = p.w.globals.SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Clients');
        sheet._maxCols = width;
        sheet._maxRows = Math.max(rowsBefore, 1);
        return sheet.getMaxRows();
      });
      const sheetNow = p.w.run(() => p.w.globals.SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Clients'));
      const ok = p.call('ensureClientExtras_', sheetNow);
      assert.equal(ok, true, 'width ' + width + ': the two columns are there');
      const after = p.w.run(() => {
        const sheet = p.w.globals.SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Clients');
        return [sheet.getMaxColumns(), sheet.getMaxRows()];
      });
      assert.deepEqual(after, [Math.max(width, 11), rowsMax], 'width ' + width + ' with ' + rowsBefore + ' rows: the grid is exactly as wide as it needs to be and no taller');
      assert.deepEqual(p.rows('Clients')[0].slice(9), ['notes', 'review_reason'], 'width ' + width + ': the headers');
    }
  }
});

// CLASS-TABLE: the placeholder column of a new Clients row, for every way a row is written
test('CLASS-TABLE: the fourth column of a new client row is written empty for an active row and a held row, and the columns around it keep their values', () => {
  for (const [label, over, status] of [['active', {}, 'active'], ['held for a bad budget', { [T.BUDGET]: 'abc' }, 'held']]) {
    const p = loadProject();
    submit(p, over);
    const row = lastRow(p);
    assert.equal(row[3], '', label + ': the fourth column stays empty');
    assert.equal(row[0], 'Bluebell Bikes', label + ': client');
    assert.equal(row[2] === '' || typeof row[2] === 'string', true, label + ': email column');
    assert.notEqual(row[4], '', label + ': channel column');
    assert.equal(typeof row[6], 'string', label + ': status column');
    if (status === 'active') assert.equal(row[6], 'active', label);
  }
});
