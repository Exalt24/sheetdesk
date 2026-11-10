'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadProject, loadSeeded, HEADERS } = require('./helpers/load');
const { referenceRollup } = require('../scripts/seed');

function countCalls(w) {
  const counts = {};
  w.hook = ({ name }) => { counts[name] = (counts[name] || 0) + 1; };
  return counts;
}

function reference(p, client, month) {
  const rows = p.fx.campaigns.filter((r) => r[0] === client && r[2].startsWith(month));
  return referenceRollup(rows, p.fx.rates).sums.get(client + '|' + month);
}

function pdfFiles(p, name) {
  return p.w.allFiles().filter((f) => f.getName() === name && f.getMimeType() === 'application/pdf');
}

function folderId(p) {
  return p.prop('REPORT_FOLDER_ID');
}

test('summary tabs: one per client, totals equal an independent calculation', () => {
  const p = loadSeeded();
  const r = p.plain(p.call('buildClientSummaries'));
  assert.equal(r.tabs, 9);
  assert.equal(r.rejected, 0);
  const clients = [...new Set(p.fx.campaigns.map((x) => x[0]))];
  for (const client of clients) {
    const rows = p.rows('Summary - ' + client);
    assert.ok(rows, 'tab for ' + client);
    assert.deepEqual(rows[0], ['month', 'channel', 'spend_usd', 'clicks', 'conversions', 'cpc', 'cpa', 'conv_rate']);
    for (const month of ['2026-08', '2026-09', '2026-10']) {
      const all = rows.find((x) => x[0] === month && x[1] === 'ALL');
      const ref = reference(p, client, month);
      assert.equal(Math.round(all[2] * 100), ref.cents, client + ' ' + month + ' spend');
      assert.equal(all[3], ref.clicks, client + ' ' + month + ' clicks');
      assert.equal(all[4], ref.conversions, client + ' ' + month + ' conversions');
    }
  }
});

test('summary tabs: batch reads and writes, never cell by cell', () => {
  const p = loadSeeded();
  const counts = countCalls(p.w);
  p.call('buildClientSummaries');
  assert.equal(counts['Range.getValue'], undefined);
  assert.equal(counts['Range.setValue'], undefined);
  assert.ok(counts['Range.getValues'] <= 5, 'getValues calls (one more than before: the Clients read for the unmatched Campaigns rows): ' + counts['Range.getValues']);
  assert.equal(counts['Range.setValues'], 9, 'one setValues per tab');
  assert.ok(p.w.calls < 400, 'service calls stay small for 2,000 rows');
});

test('summary tabs: a rerun gives the same tab and drops stale rows', () => {
  const p = loadSeeded();
  p.call('buildClientSummaries');
  const before = p.rows('Summary - Summit Yoga');
  p.w.run(() => {
    const sh = p.ss.getSheetByName('Summary - Summit Yoga');
    sh.getRange(40, 1, 1, 2).setValues([['stale', 'row']]);
  });
  p.call('buildClientSummaries');
  assert.deepEqual(p.rows('Summary - Summit Yoga'), before);
});

test('bad campaign rows are counted and left out of the totals', () => {
  const p = loadSeeded();
  p.call('buildClientSummaries');
  const clean = p.rows('Summary - Summit Yoga').find((x) => x[0] === '2026-10' && x[1] === 'ALL');
  p.append('Campaigns', [
    ['', 'search', '2026-10-05', 10, 1, 0, 'USD'],
    ['Summit Yoga', 'social', '2026-10-05', 'n/a', 1, 0, 'USD'],
    ['Summit Yoga', 'social', '2026-10-05', -4, 1, 0, 'USD'],
    ['Summit Yoga', 'social', '2026-10-05', 4, -1, 0, 'USD'],
    ['Summit Yoga', 'social', '2026-10-05', 4, 1, 0, 'XYZ']
  ]);
  const r = p.plain(p.call('buildClientSummaries'));
  assert.equal(r.rejected, 5);
  assert.deepEqual(p.rows('Summary - Summit Yoga').find((x) => x[0] === '2026-10' && x[1] === 'ALL'), clean);
});

test('euro spend is converted with the rate of the day, weekends use the last weekday', () => {
  const p = loadProject();
  p.fill('Clients', HEADERS.clients, [['Euro Co', 'A', 'a@example.com', 'acct-1', 'search', 1, 'active', '', '']]);
  p.fill('Rates', HEADERS.rates, [['2026-10-02', 'EUR', 0.9], ['2026-10-05', 'EUR', 0.8]]);
  p.fill('Campaigns', HEADERS.campaigns, [
    ['Euro Co', 'search', '2026-10-02', 90, 10, 1, 'EUR'],
    ['Euro Co', 'search', '2026-10-03', 90, 10, 1, 'EUR'],
    ['Euro Co', 'search', '2026-10-05', 80, 10, 1, 'EUR'],
    ['Euro Co', 'search', '2026-10-01', 50, 10, 1, 'EUR']
  ]);
  const r = p.plain(p.call('buildClientSummaries'));
  assert.equal(r.rejected, 1, 'a day before the first rate has no rate');
  const all = p.rows('Summary - Euro Co').find((x) => x[1] === 'ALL');
  assert.equal(all[2], 100 + 100 + 100);
});

test('a rate older than 7 days is not used', () => {
  const p = loadProject();
  p.fill('Clients', HEADERS.clients, [['Euro Co', 'A', 'a@example.com', 'acct-1', 'search', 1, 'active', '', '']]);
  p.fill('Rates', HEADERS.rates, [['2026-10-01', 'EUR', 0.9]]);
  p.fill('Campaigns', HEADERS.campaigns, [
    ['Euro Co', 'search', '2026-10-08', 90, 10, 1, 'EUR'],
    ['Euro Co', 'search', '2026-10-09', 90, 10, 1, 'EUR']
  ]);
  assert.equal(p.plain(p.call('buildClientSummaries')).rejected, 1);
});

test('two clients whose names clean to one tab name are both skipped and named, not thrown', () => {
  const p = loadProject();
  p.fill('Campaigns', HEADERS.campaigns, [
    ['A/B Co', 'search', '2026-10-02', 9, 1, 1, 'USD'],
    ['A-B Co', 'search', '2026-10-02', 9, 1, 1, 'USD']
  ]);
  const r = p.plain(p.call('buildClientSummaries'));
  assert.equal(r.tabs, 0, 'neither of the two is written');
  assert.deepEqual(r.skipped, ['Clients "A/B Co" and "A-B Co" would share one report file name.']);

  const long = 'x'.repeat(80);
  const q = loadProject();
  q.fill('Campaigns', HEADERS.campaigns, [[long + '1', 'search', '2026-10-02', 9, 1, 1, 'USD'], [long + '2', 'search', '2026-10-02', 9, 1, 1, 'USD']]);
  assert.match(q.plain(q.call('buildClientSummaries')).skipped[0], /share one summary tab name/);
});

test('a client name with a slash gets a safe tab name', () => {
  const p = loadProject();
  p.fill('Campaigns', HEADERS.campaigns, [['A/B Co', 'search', '2026-10-02', 9, 1, 1, 'USD']]);
  p.call('buildClientSummaries');
  assert.ok(p.sheet('Summary - A-B Co'));
});

test('report: PDF has a stable name, the numbers and the channel table', () => {
  const p = loadSeeded();
  const r = p.plain(p.call('runClientReport', 'Harbor Lane Bakery', '2026-10'));
  const ref = reference(p, 'Harbor Lane Bakery', '2026-10');
  assert.equal(r.status, 'ok');
  assert.equal(r.pdfName, 'harbor-lane-bakery-2026-10.pdf');
  const files = pdfFiles(p, r.pdfName);
  assert.equal(files.length, 1);
  const text = p.fileText(files[0]);
  assert.match(text, /Harbor Lane Bakery, 2026-10/);
  const money = 'USD ' + (ref.cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 });
  assert.ok(text.includes('Spend: ' + money), 'spend line ' + money);
  assert.ok(text.includes('Clicks: ' + ref.clicks));
  assert.match(text, /^search\tUSD [\d,.]+\t\d+\t\d+\t[\d.]+\t[\d.]+$/m, 'a table row for search');
  assert.match(text, /^ALL\t/m);
  assert.ok(!text.includes('{{'), 'no placeholder left');
  assert.equal(files[0].getMimeType(), 'application/pdf');
});

test('report: the working copy and the template are not left as files to clean up', () => {
  const p = loadSeeded();
  p.call('runClientReport', 'Harbor Lane Bakery', '2026-10');
  const live = p.w.allFiles().filter((f) => !f.isTrashed());
  const names = live.map((f) => f.getName()).sort();
  assert.deepEqual(names, ['Fernwood Digital report template', 'harbor-lane-bakery-2026-10.pdf']);
});

test('report: a rerun replaces the PDF and does not leave two', () => {
  const p = loadSeeded();
  const first = p.plain(p.call('runClientReport', 'Harbor Lane Bakery', '2026-10'));
  const second = p.plain(p.call('runClientReport', 'Harbor Lane Bakery', '2026-10'));
  assert.equal(second.replaced, 1);
  assert.notEqual(first.pdfId, second.pdfId);
  const live = p.w.folderFiles(folderId(p)).filter((f) => f.getName() === first.pdfName);
  assert.equal(live.length, 1);
  assert.equal(live[0].getId(), second.pdfId);
  assert.equal(p.w.folderFiles(folderId(p), { trashed: true }).filter((f) => f.getName() === first.pdfName).length, 1, 'the older one is in the trash');
});

test('report: the figures changed, so the rerun carries the new numbers', () => {
  const p = loadSeeded();
  p.call('runClientReport', 'Harbor Lane Bakery', '2026-10');
  p.append('Campaigns', [['Harbor Lane Bakery', 'video', '2026-10-31', 1000, 5, 1, 'USD']]);
  const r = p.plain(p.call('runClientReport', 'Harbor Lane Bakery', '2026-10'));
  const text = p.fileText(p.w.folderFiles(folderId(p)).find((f) => f.getName() === r.pdfName));
  assert.match(text, /^video\tUSD 1,000\.00\t5\t1\t/m);
});

test('report: email carries the PDF; a rerun with the same figures does not email again', () => {
  const p = loadSeeded();
  const first = p.plain(p.call('runClientReport', 'Harbor Lane Bakery', '2026-10'));
  assert.equal(first.email, 'sent');
  assert.equal(p.w.sent.length, 1);
  const mail = p.w.sent[0];
  assert.equal(mail.to, 'mira@harborlanebakery.example.com');
  assert.equal(mail.subject, 'Harbor Lane Bakery marketing report, 2026-10');
  assert.equal(mail.attachments.length, 1);
  assert.equal(mail.attachments[0].name, 'harbor-lane-bakery-2026-10.pdf');
  assert.equal(mail.attachments[0].type, 'application/pdf');
  assert.match(mail.attachments[0].text, /Harbor Lane Bakery, 2026-10/);
  const second = p.plain(p.call('runClientReport', 'Harbor Lane Bakery', '2026-10'));
  assert.equal(second.email, 'already_sent');
  assert.equal(p.w.sent.length, 1);
  const forced = p.plain(p.call('runClientReport', 'Harbor Lane Bakery', '2026-10', { force: true }));
  assert.equal(forced.email, 'sent');
  assert.equal(p.w.sent.length, 2);
});

test('report: changed figures are emailed again', () => {
  const p = loadSeeded();
  p.call('runClientReport', 'Harbor Lane Bakery', '2026-10');
  p.append('Campaigns', [['Harbor Lane Bakery', 'video', '2026-10-31', 10, 5, 1, 'USD']]);
  assert.equal(p.plain(p.call('runClientReport', 'Harbor Lane Bakery', '2026-10')).email, 'sent');
  assert.equal(p.w.sent.length, 2);
});

test('report: no mail quota left, the PDF is still made and the next run sends', () => {
  const p = loadSeeded({ world: { mailQuota: 0 } });
  const r = p.plain(p.call('runClientReport', 'Harbor Lane Bakery', '2026-10'));
  assert.match(r.email, /^failed: Service invoked too many times for one day: email\./);
  assert.equal(pdfFiles(p, r.pdfName).length, 1);
  assert.equal(p.w.sent.length, 0);
  p.w.mailQuota = 5;
  assert.equal(p.plain(p.call('runClientReport', 'Harbor Lane Bakery', '2026-10')).email, 'sent');
});

test('report: a client with no address gets a PDF and no email', () => {
  const p = loadSeeded();
  p.w.run(() => p.ss.getSheetByName('Clients').getRange(2, 3).setValue(''));
  const r = p.plain(p.call('runClientReport', 'Harbor Lane Bakery', '2026-10'));
  assert.equal(r.email, 'no_address');
  assert.equal(p.w.sent.length, 0);
});

test('report: the Report Log has one row per client and month, updated on a rerun', () => {
  const p = loadSeeded();
  p.call('runClientReport', 'Harbor Lane Bakery', '2026-10');
  p.call('runClientReport', 'Harbor Lane Bakery', '2026-10');
  p.call('runClientReport', 'Harbor Lane Bakery', '2026-09');
  const rows = p.rows('Report Log');
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.slice(1).map((r) => r[1]).sort(), ['2026-09', '2026-10']);
});

test('report: bad input is refused before anything is created', () => {
  const p = loadSeeded();
  for (const [client, month] of [['Harbor Lane Bakery', '2026-13'], ['Harbor Lane Bakery', 'October'], ['Harbor Lane Bakery', null],
    ['Nobody Ltd', '2026-10'], ['', '2026-10'], [42, '2026-10'], ['harbor lane bakery', '2026-10']]) {
    assert.throws(() => p.call('runClientReport', client, month), /Invalid month|Unknown client|Pick a client/, JSON.stringify([client, month]));
  }
  assert.equal(p.w.allFiles().length, 0);
  assert.equal(p.w.sent.length, 0);
});

test('report: a month with no rows is reported as no data, not as an empty PDF', () => {
  const p = loadSeeded();
  const r = p.plain(p.call('runClientReport', 'Harbor Lane Bakery', '2025-01'));
  assert.equal(r.status, 'no_data');
  assert.equal(p.w.allFiles().length, 0);
});

test('report: a client name with a dollar sign is refused and leaves no working copy', () => {
  const p = loadProject();
  p.fill('Clients', HEADERS.clients, [['Cash$ Co', 'A', 'a@example.com', 'acct-1', 'search', 1, 'active', '', '']]);
  p.fill('Campaigns', HEADERS.campaigns, [['Cash$ Co', 'search', '2026-10-02', 9, 1, 1, 'USD']]);
  assert.throws(() => p.call('runClientReport', 'Cash$ Co', '2026-10'), /would read as a group reference/);
  const live = p.w.allFiles().filter((f) => !f.isTrashed()).map((f) => f.getName());
  assert.deepEqual(live, ['Fernwood Digital report template']);
});

test('report: two clients that would share a PDF name are refused', () => {
  const p = loadProject();
  p.fill('Clients', HEADERS.clients, [
    ['Fish & Chips', 'A', 'a@example.com', 'a1', 'search', 1, 'active', '', ''],
    ['Fish Chips', 'B', 'b@example.com', 'a2', 'search', 1, 'active', '', '']
  ]);
  p.fill('Campaigns', HEADERS.campaigns, [['Fish & Chips', 'search', '2026-10-02', 9, 1, 1, 'USD']]);
  assert.throws(() => p.call('runClientReport', 'Fish & Chips', '2026-10'), /share one report file name/);
});

test('report: needs the Docs and Drive scopes in the manifest', () => {
  const p = loadSeeded({ scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/gmail.send'] });
  assert.throws(() => p.call('runClientReport', 'Harbor Lane Bakery', '2026-10'), /Specified permissions are not sufficient to call DriveApp/);
});

test('month close: every active client gets one PDF, the paused one gets none', () => {
  const p = loadSeeded();
  const r = p.plain(p.call('runMonthClose', '2026-10'));
  assert.equal(r.results.length, 8);
  assert.equal(r.pending.length, 0);
  assert.ok(r.results.every((x) => x.status === 'ok' && x.email === 'sent'));
  assert.equal(p.w.sent.length, 8);
  assert.equal(p.w.folderFiles(folderId(p)).length, 8);
  assert.ok(!r.results.some((x) => x.client === 'Granite Ridge Climbing'));
  const jobLog = p.rows('Job Log');
  assert.equal(jobLog.length, 2);
  assert.equal(jobLog[1][0], 'month close');
  assert.equal(jobLog[1][5], 'complete');
});

test('month close: running it again changes nothing and sends nothing', () => {
  const p = loadSeeded();
  p.call('runMonthClose', '2026-10');
  const ids = p.w.folderFiles(folderId(p)).map((f) => f.getId()).sort();
  const r = p.plain(p.call('runMonthClose', '2026-10'));
  assert.ok(r.results.every((x) => x.status === 'current'));
  assert.equal(p.w.sent.length, 8);
  assert.deepEqual(p.w.folderFiles(folderId(p)).map((f) => f.getId()).sort(), ids);
});

test('month close: stops at the time budget and the next call finishes the rest', () => {
  const p = loadSeeded({ world: { cost: { callMs: 700 } } });
  let finished = null;
  let calls = 0;
  for (; calls < 6; calls++) {
    const r = p.plain(p.call('runMonthClose', '2026-10'));
    if (calls === 0) assert.ok(r.pending.length > 0 && r.results.length > 0, 'first call is partial');
    if (r.pending.length === 0) { finished = r; break; }
  }
  assert.ok(finished, 'finished within 6 calls');
  assert.ok(calls >= 1, 'it needed more than one call');
  assert.equal(p.w.folderFiles(folderId(p)).length, 8);
  assert.equal(p.w.sent.length, 8, 'no client emailed twice');
});

test('month close: one broken client does not stop the others', () => {
  const p = loadSeeded();
  p.w.run(() => p.ss.getSheetByName('Clients').getRange(2, 1).setValue('Cash$ Bakery'));
  p.w.run(() => {
    const sh = p.ss.getSheetByName('Campaigns');
    const v = sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues().map((r) => [r[0] === 'Harbor Lane Bakery' ? 'Cash$ Bakery' : r[0]]);
    sh.getRange(2, 1, v.length, 1).setValues(v);
  });
  const r = p.plain(p.call('runMonthClose', '2026-10'));
  assert.equal(r.results.filter((x) => x.status === 'error').length, 1);
  assert.equal(r.results.filter((x) => x.status === 'ok').length, 7);
});

test('month close: refuses a bad month before doing any work', () => {
  const p = loadSeeded();
  assert.throws(() => p.call('runMonthClose', '2026-1'), /Invalid month/);
  assert.equal(p.w.allFiles().length, 0);
  assert.equal(p.rows('Summary - Summit Yoga'), null);
});

test('month close: no deletions of anyone else files in the folder', () => {
  const p = loadSeeded();
  p.call('runMonthClose', '2026-10');
  const other = p.w.run(() => {
    const folder = p.w.globals.DriveApp.getFolderById(folderId(p));
    return folder.createFile('notes.txt', 'keep me', 'text/plain').getId();
  });
  p.call('runMonthClose', '2026-10');
  p.call('runClientReport', 'Summit Yoga', '2026-10');
  assert.equal(p.w.files.get(other).isTrashed(), false);
});

test('report: changed figures whose email failed on quota are sent by the next run, not reported as already sent', () => {
  const p = loadSeeded();
  p.call('runClientReport', 'Harbor Lane Bakery', '2026-10');
  p.append('Campaigns', [['Harbor Lane Bakery', 'video', '2026-10-31', 10, 5, 1, 'USD']]);
  p.w.mailQuota = 0;
  const failed = p.plain(p.call('runClientReport', 'Harbor Lane Bakery', '2026-10'));
  assert.match(failed.email, /^failed:/);
  assert.equal(p.rows('Report Log')[1][5], '', 'a failed send leaves no emailed time for the new figures');
  p.w.mailQuota = 5;
  assert.equal(p.plain(p.call('runClientReport', 'Harbor Lane Bakery', '2026-10')).email, 'sent');
});
