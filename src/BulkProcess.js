/**
 * Scale: clean and roll up a large Campaigns sheet inside the 6 minute limit.
 *
 * The job reads the sheet in chunks, writes each cleaned chunk to the same row
 * numbers in the Clean sheet (so doing a chunk twice changes nothing), and
 * saves a cursor after every chunk. Before each chunk it checks the time
 * budget. When the budget is nearly used it stops and a time trigger created
 * through ScriptApp starts the next run from the cursor. A safety trigger is
 * created at the start of each run, so a run that is killed still gets resumed.
 *
 * Phases: normalize (chunked) then rollup (one pass over Clean) then done.
 */

const BULK_CONTINUE_HANDLER = 'continueBulkJob';
/** The read time per row is only learned from a batch of at least this many rows. */
const BULK_MIN_RATE_ROWS = 100;

/**
 * Cleans one Campaigns row into a Clean row.
 * @param {Array<*>} row
 * @param {number} rowNumber the 1 based row in Campaigns
 * @param {function(Date): string} fmtDay
 * @param {Object} rateTable
 * @return {Array<*>} a row in the Clean column order
 */
function cleanRow_(row, rowNumber, fmtDay, rateTable) {
  const p = parseCampaignRow_(row, fmtDay, rateTable);
  if (!p.ok) return [rowNumber, sheetText_(String(row[0]).trim()), '', '', '', 0, 0, 0, 'bad:' + p.reason];
  return [rowNumber, sheetText_(p.client), sheetText_(p.channel), sheetText_(p.month), p.iso, p.spendUsd, p.clicks, p.conversions, 'ok'];
}

/** @return {?Object} the saved cursor */
function loadCursor_() {
  const raw = PropertiesService.getScriptProperties().getProperty(SD.PROPS.BULK_CURSOR);
  return raw ? JSON.parse(raw) : null;
}

/** @param {Object} cursor */
function saveCursor_(cursor) {
  PropertiesService.getScriptProperties().setProperty(SD.PROPS.BULK_CURSOR, JSON.stringify(cursor));
}

/** Deletes every continuation trigger, so they never pile up toward the 20 trigger limit. */
function deleteContinuationTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === BULK_CONTINUE_HANDLER) ScriptApp.deleteTrigger(t);
  });
}

/**
 * Creates the next continuation trigger first and only then deletes the old
 * ones, so there is no moment without a trigger while a job exists.
 * @param {number} afterMs
 */
function replaceContinuationTrigger_(afterMs) {
  const old = ScriptApp.getProjectTriggers().filter(function (t) {
    return t.getHandlerFunction() === BULK_CONTINUE_HANDLER;
  });
  ScriptApp.newTrigger(BULK_CONTINUE_HANDLER).timeBased().after(afterMs).create();
  old.forEach(function (t) { ScriptApp.deleteTrigger(t); });
}

/**
 * Starts the job. Refuses when a job is already in progress.
 * @param {{restart: (boolean|undefined)}} [options] restart true drops an unfinished job
 * @return {Object} status after the first run
 */
function startBulkNormalize(options) {
  const t0 = Date.now(); // the budget counts the clear and the grid growth below, which can take long on a big sheet
  const opts = options || {};
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) throw new Error('Another run holds the lock. Try again in a minute.');
  try {
    const existing = loadCursor_();
    if (existing && !opts.restart) throw new Error('A bulk job is already running at row ' + existing.next + '. Pass restart to drop it.');
    const ss = spreadsheet_();
    const campaigns = getOrCreateSheet_(ss, SD.SHEETS.CAMPAIGNS, SD.HEADERS.CAMPAIGNS);
    const total = Math.max(0, campaigns.getLastRow() - 1);
    const clean = getOrCreateSheet_(ss, SD.SHEETS.CLEAN, SD.HEADERS.CLEAN);
    clean.clearContents();
    ensureGrid_(clean, total + 1, SD.HEADERS.CLEAN.length);
    clean.getRange(1, 1, 1, SD.HEADERS.CLEAN.length).setValues([SD.HEADERS.CLEAN]);
    // The safety trigger comes before the cursor: a job that exists always has a trigger that resumes it.
    replaceContinuationTrigger_(SD.SAFETY_NET_MS);
    saveCursor_({
      phase: 'normalize', next: 2, total: total, rowsDone: 0, runs: 0, lastChunkMs: 0,
      readMsPerRow: 0, startedAt: Date.now()
    });
  } finally {
    releaseLock_(lock);
  }
  return runBulkSlice_(t0);
}

/**
 * Time trigger handler: continues the saved job.
 * @return {Object}
 */
function continueBulkJob() {
  return runBulkSlice_();
}

/** @return {?Object} the cursor, or null when no job is running */
function bulkJobStatus() {
  return loadCursor_();
}

/**
 * One execution of the job: as many chunks as the time budget allows.
 * @param {number} [startedMs] when this execution began, if before this call
 * @return {{status: string, next: (number|undefined), rowsDone: (number|undefined), runs: (number|undefined)}}
 */
function runBulkSlice_(startedMs) {
  const t0 = startedMs === undefined ? Date.now() : startedMs;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    // The trigger that fired is used up. Re-arm it, or a job that is still running is left with nothing to resume it.
    if (loadCursor_()) replaceContinuationTrigger_(SD.CONTINUE_AFTER_MS);
    return { status: 'locked' };
  }
  try {
    const cursor = loadCursor_();
    if (!cursor) {
      deleteContinuationTriggers_();
      return { status: 'idle' };
    }
    // Safety net first: if this run is killed, this trigger resumes the job.
    replaceContinuationTrigger_(SD.SAFETY_NET_MS);

    const ss = spreadsheet_();
    const campaigns = ss.getSheetByName(SD.SHEETS.CAMPAIGNS);
    const clean = ss.getSheetByName(SD.SHEETS.CLEAN);
    const width = SD.HEADERS.CAMPAIGNS.length;
    const fmtDay = makeDateFormatter_(ss.getSpreadsheetTimeZone(), 'yyyy-MM-dd');
    const rates = loadRateTable_(ss);
    const lastRow = cursor.total + 1;

    if (cursor.phase === 'normalize') {
      let didChunk = false;
      while (cursor.next <= lastRow) {
        // always do one chunk per run, so a slow chunk cannot stall the job
        if (didChunk && Date.now() - t0 + cursor.lastChunkMs * 1.25 > SD.BUDGET_MS) break;
        const c0 = Date.now();
        const n = Math.min(SD.CHUNK_ROWS, lastRow - cursor.next + 1);
        const values = campaigns.getRange(cursor.next, 1, n, width).getValues();
        const readMs = Date.now() - c0;
        const out = new Array(n);
        for (let i = 0; i < n; i++) out[i] = cleanRow_(values[i], cursor.next + i, fmtDay, rates);
        clean.getRange(cursor.next, 1, n, SD.HEADERS.CLEAN.length).setValues(out);
        cursor.next += n;
        cursor.rowsDone += n;
        cursor.lastChunkMs = Date.now() - c0;
        // A short batch (the last one) is mostly the fixed cost of the call, so it says nothing about the rate per row.
        if (n >= BULK_MIN_RATE_ROWS) cursor.readMsPerRow = Math.max(cursor.readMsPerRow, readMs / n);
        saveCursor_(cursor);
        didChunk = true;
      }
      if (cursor.next > lastRow) {
        cursor.phase = 'rollup';
        saveCursor_(cursor);
      }
    }

    if (cursor.phase === 'rollup') {
      const estimate = cursor.readMsPerRow * cursor.total * 1.5 + 2000;
      if (Date.now() - t0 + estimate <= SD.BUDGET_MS) {
        writeRollup_(ss, cursor.total);
        cursor.phase = 'done';
      }
    }

    cursor.runs += 1;
    if (cursor.phase === 'done') {
      // Order matters if the run is killed here: log, then drop the cursor, then the triggers.
      // A leftover trigger only finds no cursor and removes itself.
      writeJobLog_(ss, ['bulk normalize', 'job-' + cursor.startedAt, new Date(cursor.startedAt), new Date(),
        cursor.rowsDone, 'finished in ' + cursor.runs + ' run(s)']);
      SpreadsheetApp.flush();
      PropertiesService.getScriptProperties().deleteProperty(SD.PROPS.BULK_CURSOR);
      deleteContinuationTriggers_();
      return { status: 'done', rowsDone: cursor.rowsDone, runs: cursor.runs };
    }
    saveCursor_(cursor);
    replaceContinuationTrigger_(SD.CONTINUE_AFTER_MS);
    return { status: 'continuing', next: cursor.next, rowsDone: cursor.rowsDone, runs: cursor.runs };
  } finally {
    releaseLock_(lock);
  }
}

/**
 * Sums the Clean sheet by client and month into the Rollup sheet. Rewrites the
 * whole sheet, so running it again gives the same result.
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {number} total number of data rows in Clean
 */
function writeRollup_(ss, total) {
  const clean = ss.getSheetByName(SD.SHEETS.CLEAN);
  const rollup = getOrCreateSheet_(ss, SD.SHEETS.ROLLUP, SD.HEADERS.ROLLUP);
  const sums = {};
  if (total > 0) {
    // columns 2..9: client, channel, month, date, spend_usd, clicks, conversions, status
    const data = clean.getRange(2, 2, total, 8).getValues();
    for (let i = 0; i < data.length; i++) {
      const r = data[i];
      if (r[7] !== 'ok') continue;
      const key = r[0] + '\u0001' + r[2];
      const s = sums[key] || (sums[key] = { client: r[0], month: r[2], cents: 0, clicks: 0, conversions: 0, rows: 0 });
      s.cents += toCents_(r[4]);
      s.clicks += r[5];
      s.conversions = addCount_(s.conversions, r[6]);
      s.rows += 1;
    }
  }
  const out = Object.keys(sums).sort().map(function (k) {
    const s = sums[k];
    return [sheetText_(s.client), sheetText_(s.month), s.cents / 100, s.clicks, s.conversions, s.rows];
  });
  rollup.clearContents();
  rollup.getRange(1, 1, 1, SD.HEADERS.ROLLUP.length).setValues([SD.HEADERS.ROLLUP]);
  if (out.length) {
    ensureGrid_(rollup, out.length + 1, SD.HEADERS.ROLLUP.length);
    rollup.getRange(2, 1, out.length, SD.HEADERS.ROLLUP.length).setValues(out);
  }
}
