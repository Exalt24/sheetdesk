'use strict';
/**
 * Two timing rules: dates in menu items follow the spreadsheet time zone (the
 * zone the data is dated in), and the bulk job's time budget starts before it
 * clears the Clean sheet and grows the grid.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadProject, loadSeeded, HEADERS } = require('./helpers/load');
const { generateScaleRows, generateRates } = require('../scripts/seed');

test('the menu uses the spreadsheet time zone: near a month end, last month depends on the zone', () => {
  // 2026-11-30 20:00 UTC is Nov 30 in Chicago (script zone) and Dec 1 in Auckland (spreadsheet zone).
  const p = loadSeeded();
  p.w.now = Date.UTC(2026, 10, 30, 20, 0, 0);
  p.call('openMonthCloseDialog');
  assert.match(p.w.ui.dialog.content, /value="2026-10"/, 'Chicago: last month is October');
  p.ss.setSpreadsheetTimeZone('Pacific/Auckland');
  p.call('openMonthCloseDialog');
  assert.match(p.w.ui.dialog.content, /value="2026-11"/, 'Auckland is already in December, so last month is November');
});

test('the pull ranges use the spreadsheet time zone too', () => {
  const p = loadSeeded();
  p.w.now = Date.UTC(2026, 10, 30, 20, 0, 0);
  assert.equal(p.w.run(() => p.ctx.daysAgoIso_(0)), '2026-11-30');
  p.ss.setSpreadsheetTimeZone('Pacific/Auckland');
  assert.equal(p.w.run(() => p.ctx.daysAgoIso_(0)), '2026-12-01');
  assert.equal(p.w.run(() => p.ctx.daysAgoIso_(30)), '2026-11-01');
});

test('the script time zone of the project is not what the menu reads', () => {
  const p = loadProject();
  p.ss.setSpreadsheetTimeZone('Asia/Manila');
  p.w.now = Date.UTC(2026, 10, 30, 17, 0, 0); // Dec 1, 01:00 in Manila, Nov 30 in Chicago
  assert.equal(p.w.run(() => p.ctx.previousMonth_()), '2026-11');
});

test('bulk: the time budget counts the clear and the grid growth that happen before the first chunk', () => {
  const rates = generateRates('2024-12-20', '2026-11-02', 7);
  const data = generateScaleRows(1500, 7);
  const make = () => {
    const p = loadProject();
    p.fill('Rates', HEADERS.rates, rates.map((r) => [r.date, r.quote, r.rate]));
    p.fill('Campaigns', HEADERS.campaigns, data.rows);
    p.get('SD').CHUNK_ROWS = 500;
    return p;
  };
  // Without a slow start the first run finishes all three chunks and the rollup.
  const quick = make();
  assert.equal(quick.call('startBulkNormalize').status, 'done');
  // Now clearing the Clean sheet takes almost the whole 4.5 minute budget, so only one chunk fits in this run.
  const slow = make();
  let slowed = false;
  slow.w.hook = ({ name }) => {
    if (name === 'Sheet.clearContents' && !slowed) {
      slowed = true;
      slow.w.now += slow.get('SD.BUDGET_MS') - 10;
    }
  };
  const first = slow.call('startBulkNormalize');
  assert.equal(first.status, 'continuing');
  assert.equal(first.rowsDone, 500, 'one chunk, then it stopped for the time budget');
  slow.w.hook = null;
  let guard = 0;
  while (slow.w.triggers.length && guard++ < 10) slow.w.fireNextClockTrigger();
  assert.equal(slow.rows('Clean').length, 1501, 'the job still finishes on the next runs');
  assert.equal(slow.w.triggers.length, 0);
});

test('bulk: rows added to Campaigns while a job runs are left for the next job', () => {
  const rates = generateRates('2024-12-20', '2026-11-02', 7);
  const data = generateScaleRows(1500, 7);
  const p = loadProject();
  p.fill('Rates', HEADERS.rates, rates.map((r) => [r.date, r.quote, r.rate]));
  p.fill('Campaigns', HEADERS.campaigns, data.rows);
  p.get('SD').CHUNK_ROWS = 500;
  Object.assign(p.w.cost, { readCellMs: 0.02, writeCellMs: 55 }); // a slow service: each run does one chunk
  const first = p.call('startBulkNormalize');
  assert.equal(first.status, 'continuing');
  p.append('Campaigns', [['Harbor Lane Bakery', 'search', '2026-10-05', 10, 5, 1, 'USD'], ['Harbor Lane Bakery', 'search', '2026-10-06', 11, 5, 1, 'USD']]);
  Object.assign(p.w.cost, { readCellMs: 0.002, writeCellMs: 0.01 });
  let guard = 0;
  while (p.w.triggers.length && guard++ < 20) p.w.fireNextClockTrigger();
  assert.equal(p.rows('Clean').length, 1501, 'this job cleaned the 1,500 rows it saw at the start');
  assert.equal(p.rows('Job Log').filter((r) => r[0] === 'bulk normalize').length, 1);
  assert.equal(p.call('startBulkNormalize').status, 'done');
  assert.equal(p.rows('Clean').length, 1503, 'the next job also cleans the two new rows');
});
