'use strict';
/**
 * A client or a tab that is skipped must be counted and named, with the reason.
 * Found by the final blind recall (round 5): R5-4, a client whose status is a
 * blank cell or a typo ("yes", "actve") was skipped by the month close and the
 * report picker without being named anywhere, while the webhook still took its
 * leads; R5-5, docs/summaries-and-pdfs.md said a rerun rewrites the summary tab
 * so old rows do not stay behind, but a client whose Campaigns rows were all
 * gone kept last month's Summary tab.
 *
 * The skip points of a month close are: a status that is not active (inactive,
 * paused and needs_review are on purpose and need no mention; every other value
 * is named), a name that clashes (named since round 3), a month with no rows
 * (the no_data status), no usable address (named since round 4), the time budget
 * (pending) and the hold for rows left out (R5-1, send-gate.test.js). The skip
 * points of Rebuild summaries are a clash (skipped), a client name that is not in
 * the Clients tab (unmatched), a row left out (leftOut) and a stale tab (emptied).
 * The tables are built by code: every value of the status cell against the month
 * close, its dialog and the picker, then every shape of stale tab.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadProject, loadSeeded, HEADERS } = require('./helpers/load');

const HEADER = ['month', 'channel', 'spend_usd', 'clicks', 'conversions', 'cpc', 'cpa', 'conv_rate'];
const clientRow = (name, status, email) => [name, 'Casey Contact', email || name.toLowerCase().replace(/\W+/g, '') + '@example.com', '', 'search', 100, status, '', ''];
const octoberRows = (name) => [[name, 'search', '2026-10-10', 100, 10, 1, 'USD'], [name, 'social', '2026-10-11', 50, 5, 1, 'USD']];

/** Replaces every row of the Campaigns tab: fill alone leaves the old rows below the new ones. */
function setCampaigns(p, rows) {
  p.w.run(() => p.sheet('Campaigns') && p.sheet('Campaigns').clearContents());
  p.fill('Campaigns', HEADERS.campaigns, rows);
}

function project(clients) {
  const p = loadProject();
  p.fill('Clients', HEADERS.clients, clients);
  setCampaigns(p, clients.flatMap((c) => octoberRows(c[0])));
  return p;
}

const unknownText = (shown, total) => {
  const n = total || shown.length;
  return n + (n === 1 ? ' client has a status that is' : ' clients have a status that is') + ' none of active, inactive, paused or needs_review, so ' +
    (n === 1 ? 'it gets' : 'they get') + ' no report and no email: ' + shown.join(', ') + (n > shown.length ? ' and ' + (n - shown.length) + ' more' : '') + '.';
};

/** Status cells: [label, the cell, emailed, how the status reads in the sentence (undefined when it is not named)]. */
const STATUSES = [
  ['active', 'active', true],
  ['active with capitals and spaces', '  Active ', true],
  ['all capitals', 'ACTIVE', true],
  ['inactive', 'inactive', false],
  ['paused', 'paused', false],
  ['needs_review', 'needs_review', false],
  ['needs review with a capital', 'Needs_Review', false],
  ['a blank cell', '', false, 'blank'],
  ['spaces only', '   ', false, 'blank'],
  ['yes', 'yes', false, '"yes"'],
  ['a typo', 'actve', false, '"actve"'],
  ['a typo with a capital', 'Actve', false, '"actve"'],
  ['TRUE, as a checkbox gives it', true, false, '"true"'],
  ['a number', 5, false, '"5"'],
  ['two words', 'On Hold', false, '"on hold"'],
  ['closed', 'closed', false, '"closed"']
];

// CLASS-TABLE: every value of the status cell against every place that must name a skipped client
test('CLASS-TABLE: a client whose status is none of the known ones is named, with that status, by the month close, its dialog and the picker, and every other status is not', () => {
  for (const [label, cell, emailed, shown] of STATUSES) {
    const clients = [clientRow('Summit Yoga', 'active'), clientRow('Odd Client', cell)];
    const want = shown ? { count: 1, clients: ['Odd Client'], text: unknownText(['Odd Client (' + shown + ')']) } : undefined;

    const p = project(clients);
    const close = p.plain(p.call('runMonthClose', '2026-10'));
    assert.deepEqual(close.unknownStatus, want, label + ': the month close');
    assert.deepEqual(p.w.sent.map((m) => m.to).sort(), emailed ? ['oddclient@example.com', 'summityoga@example.com'] : ['summityoga@example.com'], label + ': who is emailed');
    assert.equal(close.results.length, emailed ? 2 : 1, label + ': a client that is not active has no result');

    const q = project(clients);
    const dialog = q.plain(q.call('dialogConfirmMonthClose', '2026-10'));
    assert.deepEqual(dialog.unknownStatus, want, label + ': the dialog');
    assert.equal(Object.keys(dialog).includes('unknownStatus'), Boolean(shown), label + ': the key is there only when there is something to say');

    const r = project(clients);
    const picker = r.plain(r.call('sidebarGetOptions'));
    assert.deepEqual(picker.unknownStatus, want, label + ': the picker');
    assert.deepEqual(picker.clients, emailed ? ['Odd Client', 'Summit Yoga'] : ['Summit Yoga'], label + ': who is in the picker');
    assert.equal(Object.keys(picker).includes('unknownStatus'), Boolean(shown), label);
  }
});

// CLASS-TABLE: how many are named, how the sentence reads, and which rows count
test('CLASS-TABLE: the list of clients with an unknown status is cut at ten, counts the whole, reads for one and many, and skips a name that also has an active row', () => {
  for (const n of [1, 2, 10, 11, 12]) {
    const names = Array.from({ length: n }, (_, i) => 'Odd ' + String.fromCharCode(65 + i));
    const p = project([clientRow('Summit Yoga', 'active')].concat(names.map((x, i) => clientRow(x, i % 2 ? 'yes' : '', 'x@example.com'))));
    const r = p.plain(p.call('runMonthClose', '2026-10'));
    const shown = names.slice(0, 10).map((x, i) => x + ' (' + (i % 2 ? '"yes"' : 'blank') + ')');
    assert.equal(r.unknownStatus.count, n, n);
    assert.deepEqual(r.unknownStatus.clients, names.slice(0, 10), n);
    assert.equal(r.unknownStatus.text, unknownText(shown, n), n);
    assert.equal(p.plain(p.call('sidebarGetOptions')).unknownStatus.count, n, n);
  }
  // the same name twice is one client, and a name with an active row is reported through it
  const twice = project([clientRow('Summit Yoga', 'active'), clientRow('Odd Client', 'yes'), clientRow('Odd Client', 'yes')]);
  assert.equal(twice.plain(twice.call('runMonthClose', '2026-10')).unknownStatus.count, 1);
  const both = project([clientRow('Summit Yoga', 'active'), clientRow('Summit Yoga', 'actve')]);
  assert.equal(both.plain(both.call('runMonthClose', '2026-10')).unknownStatus, undefined);
  assert.equal(both.plain(both.call('sidebarGetOptions')).unknownStatus, undefined);
  assert.equal(both.plain(both.call('unknownStatusOf_', [])), null);
});

// CLASS-TABLE: the seeded agency has a paused client and no other odd status, so an ordinary close adds no key
test('CLASS-TABLE: the seeded agency, with one paused client, names nobody and adds no key to the close, the dialog or the picker', () => {
  const p = loadSeeded();
  assert.equal(p.plain(p.call('sidebarGetOptions')).unknownStatus, undefined);
  const d = p.plain(p.call('dialogConfirmMonthClose', '2026-10'));
  assert.equal(d.unknownStatus, undefined);
  assert.equal(p.plain(p.call('runMonthClose', '2026-10')).unknownStatus, undefined);
});

// ---- stale summary tabs

const expectedEmptied = (tabs, total) => {
  const n = total || tabs.length;
  return n + (n === 1 ? ' summary tab has' : ' summary tabs have') + ' no Campaigns rows left in the totals (the rows were deleted or are all left out), so ' +
    (n === 1 ? 'it was' : 'they were') + ' emptied: ' + tabs.join(', ') + (n > tabs.length ? ' and ' + (n - tabs.length) + ' more' : '') + '.';
};
const tabOf = (name) => 'Summary - ' + name;
const twoClients = () => project([clientRow('Summit Yoga', 'active'), clientRow('Foxglove Florist', 'active')]);

/** Ways a client ends with no row in the totals: [label, what to do to the Campaigns tab of a project of two clients, tabs written]. */
const GONE = [
  ['its rows were deleted', (p) => setCampaigns(p, octoberRows('Summit Yoga')), 1],
  ['every row of it has no currency rate', (p) => setCampaigns(p, octoberRows('Summit Yoga').concat([['Foxglove Florist', 'search', '2026-10-10', 100, 10, 1, 'JPY']])), 1],
  ['every row of it has a text date', (p) => setCampaigns(p, octoberRows('Summit Yoga').concat([['Foxglove Florist', 'search', 'in October', 100, 10, 1, 'USD']])), 1],
  ['its rows now carry another spelling of the name', (p) => setCampaigns(p, octoberRows('Summit Yoga').concat(octoberRows('foxglove'))), 2]
];

// CLASS-TABLE: every way a client loses its rows against the tab it had
test('CLASS-TABLE: a summary tab whose client has no row left is emptied to its header and named, and the other tabs are rebuilt as before', () => {
  for (const [label, change, tabs] of GONE) {
    const p = twoClients();
    const first = p.plain(p.call('buildClientSummaries'));
    assert.equal(first.emptied, undefined, label + ': the first run has nothing stale');
    assert.equal(p.rows(tabOf('Foxglove Florist')).length, 4, label + ': the tab had figures');
    change(p);
    const r = p.plain(p.call('buildClientSummaries'));
    assert.deepEqual(r.emptied, { count: 1, tabs: [tabOf('Foxglove Florist')], text: expectedEmptied([tabOf('Foxglove Florist')]) }, label);
    assert.deepEqual(p.rows(tabOf('Foxglove Florist')), [HEADER], label + ': only the header is left');
    assert.equal(p.w.run(() => p.sheet(tabOf('Foxglove Florist')).getFrozenRows()), 1, label + ': the header row is frozen');
    assert.equal(p.rows(tabOf('Summit Yoga')).length, 4, label + ': the other client keeps its tab');
    assert.equal(r.tabs, tabs, label);
    // a rerun finds nothing stale: the tab is already empty, so nothing is named and nothing is written to it
    let writes = 0;
    p.w.hook = ({ name }) => { if (name === 'Range.setValues') writes++; };
    const again = p.plain(p.call('buildClientSummaries'));
    p.w.hook = null;
    assert.equal(again.emptied, undefined, label + ': a rerun is quiet');
    assert.equal(writes, tabs, label + ': only the tabs of clients with rows are written');
    assert.deepEqual(p.rows(tabOf('Foxglove Florist')), [HEADER], label);
  }
});

// CLASS-TABLE: a tab that must be left alone is left alone, and a tab that is not the client of any row is stale too
test('CLASS-TABLE: a tab of a client that is not in the Clients tab is emptied, and a tab of a name that clashes, a tab with nothing below its header and a tab that is not a summary are left alone', () => {
  const p = twoClients();
  p.call('buildClientSummaries');
  p.fill(tabOf('Old Client'), HEADER, [['2026-01', 'ALL', 10, 1, 1, 10, 10, 1]]);
  p.fill(tabOf('Header Only'), HEADER, []);
  p.fill(tabOf('Blank'), ['', '', '', '', '', '', '', ''], []);
  p.fill('Notes', ['a', 'b'], [['keep', 'me']]);
  p.fill('Summaryish', ['a', 'b'], [['keep', 'me']]);
  const r = p.plain(p.call('buildClientSummaries'));
  assert.deepEqual(r.emptied, { count: 1, tabs: [tabOf('Old Client')], text: expectedEmptied([tabOf('Old Client')]) });
  assert.deepEqual(p.rows(tabOf('Old Client')), [HEADER]);
  assert.equal(p.w.run(() => p.sheet(tabOf('Old Client')).getFrozenRows()), 1, 'a tab that was not frozen gets its header row frozen like every summary tab');
  assert.deepEqual(p.rows(tabOf('Header Only')), [HEADER]);
  assert.deepEqual(p.rows('Notes'), [['a', 'b'], ['keep', 'me']]);
  assert.deepEqual(p.rows('Summaryish'), [['a', 'b'], ['keep', 'me']]);

  const clash = twoClients();
  clash.call('buildClientSummaries');
  clash.append('Campaigns', [['summit yoga', 'search', '2026-10-12', 5, 1, 0, 'USD']]);
  const c = clash.plain(clash.call('buildClientSummaries'));
  assert.ok(c.skipped, 'the clash is named');
  assert.equal(c.emptied, undefined, 'a tab of a name that clashes is not emptied: the result already names the clash');
  assert.equal(clash.rows(tabOf('Summit Yoga')).length, 4, 'and it keeps what it had');
});

// CLASS-TABLE: the count is whole, the list is cut at ten and the sentence agrees with the count
test('CLASS-TABLE: the list of emptied tabs is cut at ten, the count is whole and the sentence reads for one and many', () => {
  for (const n of [1, 2, 10, 11, 12]) {
    const p = loadProject();
    p.fill('Clients', HEADERS.clients, [clientRow('Summit Yoga', 'active')]);
    setCampaigns(p, octoberRows('Summit Yoga'));
    const names = Array.from({ length: n }, (_, i) => 'Old ' + String.fromCharCode(65 + i));
    names.forEach((x) => p.fill(tabOf(x), HEADER, [['2026-01', 'ALL', 10, 1, 1, 10, 10, 1]]));
    const r = p.plain(p.call('buildClientSummaries'));
    const shown = names.slice(0, 10).map(tabOf);
    assert.equal(r.emptied.count, n, n);
    assert.deepEqual(r.emptied.tabs, shown, n);
    assert.equal(r.emptied.text, expectedEmptied(shown, n), n);
  }
  const seeded = loadSeeded();
  assert.equal(seeded.plain(seeded.w.run(() => seeded.ctx.emptyStaleSummaries_(seeded.ctx.spreadsheet_(), [], {}))), null, 'no summary tab, nothing to empty');
});

// CLASS-TABLE: the menu message and the month close carry the emptied tabs
test('CLASS-TABLE: Rebuild summaries says which tabs were emptied in its message, and the month close carries them in its summaries', () => {
  const p = twoClients();
  p.call('buildClientSummaries');
  setCampaigns(p, octoberRows('Summit Yoga'));
  p.call('menuRebuildSummaries');
  assert.equal(p.w.ui.toasts[0].msg, '1 tabs, 3 rows. ' + expectedEmptied([tabOf('Foxglove Florist')]));
  const q = twoClients();
  q.call('buildClientSummaries');
  setCampaigns(q, octoberRows('Summit Yoga'));
  const close = q.plain(q.call('runMonthClose', '2026-10'));
  assert.deepEqual(close.summaries.emptied, { count: 1, tabs: [tabOf('Foxglove Florist')], text: expectedEmptied([tabOf('Foxglove Florist')]) });
  const clean = loadSeeded();
  clean.call('menuRebuildSummaries');
  assert.ok(!/emptied/.test(clean.w.ui.toasts[0].msg), 'an ordinary sheet adds no sentence');
});

// CLASS-TABLE: a stale tab the owner trimmed to a narrow grid still gets its header
test('CLASS-TABLE: a stale summary tab whose grid is narrower than the header is grown before the header is written', () => {
  const p = twoClients();
  p.call('buildClientSummaries');
  p.fill(tabOf('Narrow'), ['a', 'b', 'c'], [['x', 'y', 'z']]);
  const sheet = p.sheet(tabOf('Narrow'));
  sheet._maxRows = 2;
  sheet._maxCols = 3;
  const r = p.plain(p.call('buildClientSummaries'));
  assert.deepEqual(r.emptied.tabs, [tabOf('Narrow')]);
  assert.deepEqual(p.rows(tabOf('Narrow')), [HEADER]);
});
