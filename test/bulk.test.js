'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadProject, HEADERS } = require('./helpers/load');
const { ExecutionKilled, MAX_EXEC_MS } = require('./fake/gas');
const { generateScaleRows, generateRates, referenceRollup, rng } = require('../scripts/seed');

/** A project with n generated campaign rows and rates, then a slow clock. */
function setupScale(n, seed, { chunk, cost } = {}) {
  const p = loadProject();
  const rates = generateRates('2024-12-20', '2026-11-02', seed);
  const data = generateScaleRows(n, seed);
  p.fill('Rates', HEADERS.rates, rates.map((r) => [r.date, r.quote, r.rate]));
  p.fill('Campaigns', HEADERS.campaigns, data.rows);
  if (chunk) p.get('SD').CHUNK_ROWS = chunk;
  if (cost) Object.assign(p.w.cost, cost);
  return { p, rates, data };
}

/** Starts the job and lets the time triggers run it until none is left. */
function runToEnd(p, { maxRuns = 60 } = {}) {
  const statuses = [];
  let maxTriggers = 0;
  statuses.push(p.call('startBulkNormalize').status);
  maxTriggers = Math.max(maxTriggers, p.w.triggers.length);
  for (let i = 0; i < maxRuns; i++) {
    if (!p.w.triggers.length) break;
    const fired = p.w.fireNextClockTrigger();
    statuses.push(fired.result.status);
    maxTriggers = Math.max(maxTriggers, p.w.triggers.length);
  }
  return { statuses, maxTriggers };
}

function checkResult(p, n, data, rates) {
  const clean = p.sheet('Clean');
  const sources = new Set();
  let ok = 0;
  for (let i = 0; i < n; i++) {
    const row = clean._rows[i + 1];
    assert.ok(row, 'Clean has row ' + (i + 2));
    assert.equal(row[0], i + 2, 'row ' + (i + 2) + ' sits at its own row number');
    assert.ok(!sources.has(row[0]), 'source row ' + row[0] + ' appears once');
    sources.add(row[0]);
    if (row[8] === 'ok') ok++;
    else assert.match(row[8], /^bad:/);
  }
  assert.equal(clean._rows.length, n + 1, 'no row beyond the input');
  const ref = referenceRollup(data.rows, rates);
  assert.equal(ok, ref.counted, 'valid rows counted once');
  assert.equal(ok, data.valid, 'the reference agrees with the generator');
  const rollup = p.sheet('Rollup')._rows.slice(1);
  assert.equal(rollup.length, ref.sums.size, 'one rollup row per client and month');
  let rows = 0;
  for (const r of rollup) {
    const want = ref.sums.get(r[0] + '|' + r[1]);
    assert.ok(want, 'rollup key ' + r[0] + ' ' + r[1]);
    assert.equal(Math.round(r[2] * 100), want.cents, r[0] + ' ' + r[1] + ' spend');
    assert.equal(r[3], want.clicks);
    assert.equal(r[4], want.conversions);
    assert.equal(r[5], want.rows);
    rows += r[5];
  }
  assert.equal(rows, ok, 'rollup rows add up to the valid rows');
}

test('small job: one run, every row cleaned in place, rollup matches the reference', () => {
  const { p, rates, data } = setupScale(1200, 11);
  const r = runToEnd(p);
  assert.deepEqual(r.statuses, ['done']);
  checkResult(p, 1200, data, rates);
  assert.equal(p.w.triggers.length, 0);
  assert.equal(p.prop('BULK_CURSOR'), undefined);
  const log = p.rows('Job Log');
  assert.equal(log[1][0], 'bulk normalize');
  assert.equal(log[1][4], 1200);
  assert.deepEqual(p.w.violations, []);
});

test('chunks of 500: the cursor moves through 1,200 rows and the result is the same', () => {
  const { p, rates, data } = setupScale(1200, 12, { chunk: 500 });
  const writes = [];
  p.w.hook = ({ name }) => { if (name === 'Range.setValues') writes.push(1); };
  runToEnd(p);
  checkResult(p, 1200, data, rates);
  assert.ok(writes.length >= 3 + 3, 'three chunks, header, rollup');
});

test('50,000 rows finish across several runs: no row lost, none counted twice, never past 6 minutes', () => {
  const { p, rates, data } = setupScale(50000, 21, { cost: { readCellMs: 0.3, writeCellMs: 0.85 } });
  const t0 = p.w.now;
  const r = runToEnd(p);
  assert.ok(r.statuses.length >= 3, 'runs: ' + r.statuses.join(','));
  assert.deepEqual(r.statuses.slice(0, -1).every((s) => s === 'continuing'), true);
  assert.equal(r.statuses[r.statuses.length - 1], 'done');
  assert.ok(r.maxTriggers <= 1, 'at most one continuation trigger exists at a time: ' + r.maxTriggers);
  checkResult(p, 50000, data, rates);
  assert.equal(p.w.triggers.length, 0, 'no trigger is left behind');
  assert.equal(p.prop('BULK_CURSOR'), undefined);
  assert.deepEqual(p.w.violations, []);
  const log = p.rows('Job Log');
  assert.equal(log[1][4], 50000, 'rows_done is the row count, not more');
  assert.equal(log[1][5], 'finished in ' + r.statuses.length + ' run(s)');
  assert.ok(p.w.now - t0 > MAX_EXEC_MS, 'the simulated work took more than one 6 minute run');
});

test('a slow chunk still moves the job forward: one chunk per run is enough', () => {
  const { p, rates, data } = setupScale(2000, 31, { chunk: 500, cost: { readCellMs: 0.02, writeCellMs: 55 } });
  const r = runToEnd(p);
  assert.deepEqual(r.statuses, ['continuing', 'continuing', 'continuing', 'done'], 'one chunk per run, four chunks');
  checkResult(p, 2000, data, rates);
});

test('a second job on a smaller sheet leaves nothing of the first one behind', () => {
  const { p, rates, data } = setupScale(1500, 45, { chunk: 500 });
  runToEnd(p);
  const small = generateScaleRows(300, 46);
  p.w.run(() => {
    const sh = p.ss.getSheetByName('Campaigns');
    sh.clearContents();
    sh.getRange(1, 1, 1, 7).setValues([HEADERS.campaigns]);
    sh.getRange(2, 1, 300, 7).setValues(small.rows);
  });
  runToEnd(p);
  checkResult(p, 300, small, rates);
  assert.ok(data.rows.length > small.rows.length);
  assert.equal(p.sheet('Clean')._rows.length, 301);
});

test('start refuses while a job is running, and restart drops it', () => {
  const { p, rates, data } = setupScale(1500, 41, { chunk: 500, cost: { writeCellMs: 30 } });
  assert.equal(p.call('startBulkNormalize').status, 'continuing');
  assert.throws(() => p.call('startBulkNormalize'), /already running/);
  assert.equal(p.plain(p.call('bulkJobStatus')).phase, 'normalize');
  p.w.cost.writeCellMs = 0.01;
  assert.equal(p.call('startBulkNormalize', { restart: true }).status, 'done');
  assert.equal(p.w.triggers.length, 0);
  checkResult(p, 1500, data, rates);
});

test('two runs at once: the second sees the lock and does nothing', () => {
  const { p, rates, data } = setupScale(1500, 51, { chunk: 500 });
  let inner = null;
  p.w.hook = ({ name }) => {
    if (name === 'Range.setValues' && inner === null) {
      inner = 'running';
      inner = p.call('continueBulkJob');
    }
  };
  runToEnd(p);
  assert.deepEqual(p.plain(inner), { status: 'locked' });
  checkResult(p, 1500, data, rates);
});

test('a continuation that fires after the job is done is harmless and removes itself', () => {
  const { p } = setupScale(300, 61);
  runToEnd(p);
  p.w.run(() => p.w.globals.ScriptApp.newTrigger('continueBulkJob').timeBased().after(1000).create());
  const fired = p.w.fireNextClockTrigger();
  assert.equal(fired.result.status, 'idle');
  assert.equal(p.w.triggers.length, 0);
});

test('re-doing a chunk (cursor moved back) writes the same rows, not new ones', () => {
  const { p, rates, data } = setupScale(1200, 71, { chunk: 400, cost: { writeCellMs: 40 } });
  p.call('startBulkNormalize');
  const cursor = JSON.parse(p.prop('BULK_CURSOR'));
  assert.ok(cursor.next > 2);
  p.setProp('BULK_CURSOR', JSON.stringify(Object.assign(cursor, { next: 2, rowsDone: 0 })));
  p.w.cost.writeCellMs = 0.01;
  for (let i = 0; i < 20 && p.w.triggers.length; i++) p.w.fireNextClockTrigger();
  checkResult(p, 1200, data, rates);
});

test('an empty Campaigns sheet finishes with headers only', () => {
  const p = loadProject();
  p.call('setUp');
  assert.equal(p.call('startBulkNormalize').status, 'done');
  assert.deepEqual(p.rows('Clean'), [['source_row', 'client', 'channel', 'month', 'date', 'spend_usd', 'clicks', 'conversions', 'status']]);
  assert.deepEqual(p.rows('Rollup'), [['client', 'month', 'spend_usd', 'clicks', 'conversions', 'rows']]);
});

test('bad rows are kept in place with the reason, and left out of the rollup', () => {
  const p = loadProject();
  p.fill('Rates', HEADERS.rates, [['2026-10-01', 'EUR', 0.9]]);
  p.fill('Campaigns', HEADERS.campaigns, [
    ['Ok Co', 'search', '2026-10-01', 10, 1, 0, 'USD'],
    ['', 'search', '2026-10-01', 10, 1, 0, 'USD'],
    ['Ok Co', 'search', '2026-10-01', 'n/a', 1, 0, 'USD'],
    ['Ok Co', 'search', 'soon', 10, 1, 0, 'USD'],
    ['Ok Co', 'search', '2026-10-01', 10, 1.5, 0, 'USD'],
    ['Ok Co', 'search', '2026-10-01', 10, 1, 0, 'JPY'],
    ['Ok Co', 'search', '2026-10-01', 9, 2, 1, 'EUR']
  ]);
  p.call('startBulkNormalize');
  const statuses = p.rows('Clean').slice(1).map((r) => r[8]);
  assert.deepEqual(statuses, ['ok', 'bad:no_client', 'bad:bad_spend', 'bad:bad_date', 'bad:bad_clicks', 'bad:no_rate', 'ok']);
  assert.deepEqual(p.rows('Rollup')[1], ['Ok Co', '2026-10', 20, 3, 1, 2]);
});

test('without the time budget check the fake kills the run at 6 minutes (the check is what saves it)', () => {
  const { p } = setupScale(2000, 81, { chunk: 500, cost: { writeCellMs: 55 } });
  p.get('SD').BUDGET_MS = 10 * 60 * 1000;
  assert.throws(() => p.call('startBulkNormalize'), /Exceeded maximum execution time/);
  assert.equal(p.w.dead, null, 'the fake clears its kill state when the execution ends');
});

test('property: runs killed at random points still end with every row once and a correct rollup', () => {
  let totalKills = 0;
  for (let seed = 1; seed <= 25; seed++) {
    const rand = rng(1000 + seed);
    const { p, rates, data } = setupScale(2500, 300 + seed, { chunk: 500, cost: { readCellMs: 0.05, writeCellMs: 8 } });
    let finished = false;
    let kills = 0;
    let started = false;
    let maxTriggers = 0;
    for (let step = 0; step < 80 && !finished; step++) {
      const killAt = rand() < 0.8 ? 1 + Math.floor(rand() * 60) : -1;
      p.w.killWhen = ({ n }) => n === killAt;
      try {
        if (!started) {
          p.call('startBulkNormalize');
          started = true;
        } else {
          const fired = p.w.fireNextClockTrigger();
          if (fired === null) {
            // No trigger left. Either the job is over, or a kill came before the job existed.
            assert.equal(p.prop('BULK_CURSOR'), undefined, 'seed ' + seed + ': a job with no trigger is stalled');
            if (p.sheet('Rollup') && p.rows('Job Log') && p.rows('Job Log').length > 1) finished = true;
            else started = false;
          }
        }
      } catch (e) {
        if (!(e instanceof ExecutionKilled)) throw e;
        kills++;
        if (!started && p.prop('BULK_CURSOR') !== undefined) started = true;
      }
      p.w.killWhen = null;
      maxTriggers = Math.max(maxTriggers, p.w.triggers.length);
      if (started && p.prop('BULK_CURSOR') === undefined && p.w.triggers.length === 0 && p.rows('Job Log') && p.rows('Job Log').length > 1) finished = true;
    }
    assert.ok(finished, 'seed ' + seed + ' finished');
    totalKills += kills;
    assert.ok(maxTriggers <= 2, 'seed ' + seed + ': triggers ' + maxTriggers);
    checkResult(p, 2500, data, rates);
    assert.equal(p.w.triggers.length, 0);
  }
  assert.ok(totalKills >= 40, 'the seeds killed ' + totalKills + ' runs in total');
});

test('a run killed just after the job is logged finishes again without a second log row', () => {
  const { p, rates, data } = setupScale(1200, 95, { chunk: 600 });
  p.w.killWhen = ({ name }) => name === 'Properties.deleteProperty';
  assert.throws(() => p.call('startBulkNormalize'), (e) => e instanceof ExecutionKilled);
  p.w.killWhen = null;
  assert.equal(p.rows('Job Log').length, 2, 'the log row is already there');
  assert.ok(p.prop('BULK_CURSOR') !== undefined, 'but the cursor is still saved');
  const fired = p.w.fireNextClockTrigger();
  assert.equal(fired.result.status, 'done');
  assert.equal(p.rows('Job Log').length, 2, 'one row for the job, not two');
  assert.equal(p.prop('BULK_CURSOR'), undefined);
  assert.equal(p.w.triggers.length, 0);
  checkResult(p, 1200, data, rates);
});

test('progress survives a kill: the cursor already holds the chunks that were written', () => {
  const { p } = setupScale(2500, 91, { chunk: 500, cost: { writeCellMs: 5 } });
  let setValuesCalls = 0;
  p.w.killWhen = ({ name }) => {
    if (name === 'Range.setValues') setValuesCalls++;
    // two header writes come first, then one setValues per chunk: kill as the fourth chunk is written
    return setValuesCalls === 6;
  };
  assert.throws(() => p.call('startBulkNormalize'), (e) => e instanceof ExecutionKilled);
  p.w.killWhen = null;
  const cursor = JSON.parse(p.prop('BULK_CURSOR'));
  assert.equal(cursor.next, 2 + 3 * 500, 'three chunks were done and saved');
  assert.equal(cursor.rowsDone, 1500);
  assert.equal(p.w.triggers.length, 1, 'the safety trigger is waiting');
});
