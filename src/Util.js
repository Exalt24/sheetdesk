/**
 * Small helpers shared by every module. A trailing underscore marks a private
 * function: Apps Script hides those from google.script.run and the Run menu.
 */

/**
 * The spreadsheet the script works on. A container bound script has an active
 * spreadsheet. A standalone script (or a trigger without one) falls back to the
 * SPREADSHEET_ID script property.
 * @return {GoogleAppsScript.Spreadsheet.Spreadsheet}
 */
function spreadsheet_() {
  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) return active;
  const id = PropertiesService.getScriptProperties().getProperty(SD.PROPS.SPREADSHEET_ID);
  if (!id) throw new Error('No active spreadsheet and the SPREADSHEET_ID script property is not set.');
  return SpreadsheetApp.openById(id);
}

/**
 * True for a valid Date object. Uses toString so it also works across realms.
 * @param {*} v
 * @return {boolean}
 */
function isDate_(v) {
  return Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v.getTime());
}

/**
 * True for a month key such as 2026-10.
 * @param {*} s
 * @return {boolean}
 */
function isMonth_(s) {
  return typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
}

/**
 * True for a calendar date such as 2026-10-03 (the day must exist).
 * @param {*} s
 * @return {boolean}
 */
function isIsoDate_(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * Returns a function that formats a Date as yyyy-MM-dd or yyyy-MM in a time
 * zone, caching by timestamp. Utilities.formatDate is slow when called 50,000
 * times and a sheet only holds a few hundred distinct days.
 * @param {string} tz
 * @param {string} pattern
 * @return {function(Date): string}
 */
function makeDateFormatter_(tz, pattern) {
  const cache = {};
  return function (d) {
    const k = d.getTime();
    if (cache[k] === undefined) cache[k] = Utilities.formatDate(d, tz, pattern);
    return cache[k];
  };
}

/**
 * A finite number from a number or a plain numeric string, else null.
 * @param {*} v
 * @return {?number}
 */
function parseNumber_(v) {
  if (typeof v === 'number') return isFinite(v) ? v : null;
  if (typeof v === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(v)) return Number(v);
  return null;
}

/**
 * A whole number >= 0 from a number or numeric string, else null.
 * @param {*} v
 * @return {?number}
 */
function parseCount_(v) {
  const n = parseNumber_(v);
  return n !== null && n >= 0 && Math.floor(n) === n ? n : null;
}

/**
 * True for an empty cell: no value, or text with nothing but spaces.
 * @param {*} v
 * @return {boolean}
 */
function isBlankCell_(v) {
  return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
}

/**
 * Adds two counts and rounds to 4 decimals, so fractional conversions such as
 * 0.1 and 0.2 add up to 0.3 and not 0.30000000000000004. Whole numbers are
 * unchanged.
 * @param {number} a
 * @param {number} b
 * @return {number}
 */
function addCount_(a, b) {
  return Math.round((a + b) * 10000) / 10000;
}

/**
 * Money as whole cents. Sums are kept in cents so totals do not drift.
 * @param {number} amount
 * @return {number}
 */
function toCents_(amount) {
  return Math.round(amount * 100);
}

/**
 * Formats whole cents as 1,234.56.
 * @param {number} cents
 * @return {string}
 */
function centsToText_(cents) {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const whole = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return sign + whole + '.' + String(abs % 100).padStart(2, '0');
}

/**
 * Rounds to 2 decimals.
 * @param {number} n
 * @return {number}
 */
function round2_(n) {
  return Math.round(n * 100) / 100;
}

const SHEET_MONTH_WORD_ = '(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|june?|july?|aug(ust)?|sep(t(ember)?)?|oct(ober)?|nov(ember)?|dec(ember)?)\\.?';

/**
 * Makes untrusted text safe to write into a cell. Sheets treats a leading =, +,
 * -, @ as a formula when it is typed, and turns text that looks like a number
 * or a date into a number or a date: 007, 1,000, 1e5, 50%, $5, 10:30, 2026-10,
 * 2026-10-03, 3/4, Oct 5. A leading apostrophe stores the text as it is, and
 * Sheets does not keep the apostrophe in the value. The dates and the
 * thousands separators follow the US English reading, other locales read a few
 * of them differently, so the guard covers the union.
 * @param {*} value
 * @return {string}
 */
function sheetText_(value) {
  const s = value === null || value === undefined ? '' : String(value);
  if (s === '') return s;
  const risky = /^[=+\-@\t\r']/.test(s) ||
    /^(\d{1,3}(,\d{3})+(\.\d+)?|\d+(\.\d+)?|\.\d+)([eE][-+]?\d+)?%?$/.test(s) ||
    /^[$\u20ac\u00a3\u00a5\u20b1]\s*\d[\d,]*(\.\d+)?$/.test(s) ||
    /^\d{1,2}:\d{2}(:\d{2})?(\s?[AaPp][Mm])?$/.test(s) ||
    /^\d{4}-\d{2}-\d{2}/.test(s) ||
    /^\d{4}-(0[1-9]|1[0-2])$/.test(s) ||
    /^\d{1,4}\/\d{1,2}(\/\d{1,4})?$/.test(s) ||
    /^\d{1,2}-\d{1,2}(-\d{2,4})?$/.test(s) ||
    new RegExp('^' + SHEET_MONTH_WORD_ + '\\s+\\d{1,4}(,?\\s+\\d{4})?$', 'i').test(s) ||
    new RegExp('^\\d{1,2}\\s+' + SHEET_MONTH_WORD_ + '(,?\\s+\\d{4})?$', 'i').test(s) ||
    /^(true|false)$/i.test(s);
  return risky ? "'" + s : s;
}

/**
 * Tab name for a client summary. Sheet names are limited to 100 characters and
 * a few characters are not allowed.
 * @param {string} client
 * @return {string}
 */
function summaryTabName_(client) {
  const clean = String(client).replace(/[[\]*/\\?:]/g, '-').trim().slice(0, 80);
  return SD.SHEETS.SUMMARY_PREFIX + clean;
}

/**
 * Makes sure the sheet has at least rows x cols cells. setValues beyond the
 * grid fails, so a big write grows the sheet first.
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {number} rows
 * @param {number} cols
 */
function ensureGrid_(sheet, rows, cols) {
  const maxRows = sheet.getMaxRows();
  if (maxRows < rows) sheet.insertRowsAfter(maxRows, rows - maxRows);
  const maxCols = sheet.getMaxColumns();
  if (maxCols < cols) sheet.insertColumnsAfter(maxCols, cols - maxCols);
}

/**
 * Gets a sheet, creating it with its header row when missing. When it exists
 * the header must match, so a renamed column fails loudly instead of shifting
 * every value one column.
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {string} name
 * @param {string[]} headers
 * @return {GoogleAppsScript.Spreadsheet.Sheet}
 */
function getOrCreateSheet_(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    ensureGrid_(sheet, 2, headers.length);
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
    return sheet;
  }
  if (sheet.getLastRow() === 0) {
    ensureGrid_(sheet, 2, headers.length);
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
    return sheet;
  }
  const found = sheet.getRange(1, 1, 1, headers.length).getValues()[0].map(function (h) {
    return String(h).trim();
  });
  if (found.join('|') !== headers.join('|')) {
    throw new Error('Sheet "' + name + '" has unexpected headers. Expected: ' + headers.join(', ') +
      '. Found: ' + found.join(', '));
  }
  return sheet;
}

/**
 * Reads all data rows (without the header) in one call.
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {number} width number of columns
 * @return {Array<Array<*>>}
 */
function readRows_(sheet, width) {
  const last = sheet.getLastRow();
  if (last < 2) return [];
  return sheet.getRange(2, 1, last - 1, width).getValues();
}

/**
 * Wraps an object as a JSON web app response.
 * @param {Object} obj
 * @return {GoogleAppsScript.Content.TextOutput}
 */
function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Compares two strings without returning early at the first difference.
 * @param {*} a
 * @param {*} b
 * @return {boolean}
 */
function safeEquals_(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

/**
 * A simple email shape check. The service is the real judge.
 * @param {*} s
 * @return {boolean}
 */
function isEmail_(s) {
  return typeof s === 'string' && s.length <= 254 && /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(s);
}

/**
 * Releases a lock after flushing pending spreadsheet writes. Google asks for
 * the flush first, so the next execution sees what this one wrote.
 * @param {GoogleAppsScript.Lock.Lock} lock
 */
function releaseLock_(lock) {
  try {
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
}

/**
 * Writes a Job Log row, replacing an earlier row with the same job and run
 * id. A job that finishes twice (a kill after the log write) leaves one row.
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {Array<*>} row [job, run, started_at, ended_at, rows_done, note]
 */
function writeJobLog_(ss, row) {
  const sheet = getOrCreateSheet_(ss, SD.SHEETS.JOB_LOG, SD.HEADERS.JOB_LOG);
  const data = readRows_(sheet, SD.HEADERS.JOB_LOG.length);
  // The run id can be a month such as 2026-10. Sheets would turn it into a date and the match below would miss it.
  const stored = row.slice();
  stored[1] = sheetText_(row[1]);
  for (let i = 0; i < data.length; i++) {
    if (String(data[i][0]) === row[0] && String(data[i][1]) === String(row[1])) {
      sheet.getRange(i + 2, 1, 1, row.length).setValues([stored]);
      return;
    }
  }
  sheet.appendRow(stored);
}
