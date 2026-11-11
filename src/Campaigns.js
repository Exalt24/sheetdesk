/**
 * Campaign rows: parsing one row, currency conversion and upsert.
 * The Campaigns sheet is the single source for reports, the ad cost sync and
 * the bulk job.
 */

/**
 * Builds a rate lookup from the Rates sheet rows.
 * @param {Array<Array<*>>} rows rows of [date, currency, per_usd]
 * @param {string} tz spreadsheet time zone
 * @return {Object} table used by perUsdFor_
 */
function buildRateTable_(rows, tz) {
  const fmt = makeDateFormatter_(tz, 'yyyy-MM-dd');
  const byCcy = {};
  rows.forEach(function (r) {
    const ccy = String(r[1]).trim().toUpperCase();
    const rate = parseNumber_(r[2]);
    if (!isDate_(r[0]) || !ccy || rate === null || rate <= 0) return;
    if (!byCcy[ccy]) byCcy[ccy] = { map: {}, dates: [] };
    const iso = fmt(r[0]);
    byCcy[ccy].map[iso] = rate;
  });
  Object.keys(byCcy).forEach(function (ccy) {
    byCcy[ccy].dates = Object.keys(byCcy[ccy].map).sort();
  });
  return byCcy;
}

/**
 * Reads the Rates sheet (one getValues call) into a lookup table.
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @return {Object}
 */
function loadRateTable_(ss) {
  const sheet = ss.getSheetByName(SD.SHEETS.RATES);
  if (!sheet) return {};
  return buildRateTable_(readRows_(sheet, SD.HEADERS.RATES.length), ss.getSpreadsheetTimeZone());
}

/**
 * Units of a currency per 1 USD on a day. A day with no stored rate (a feed
 * that publishes weekdays only leaves weekend gaps) uses the latest earlier
 * day within 7 days.
 * @param {Object} table
 * @param {string} ccy upper case ISO code
 * @param {string} iso yyyy-MM-dd
 * @return {?number}
 */
function perUsdFor_(table, ccy, iso) {
  if (ccy === 'USD') return 1;
  const entry = table[ccy];
  if (!entry) return null;
  let lo = 0;
  let hi = entry.dates.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (entry.dates[mid] <= iso) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (found < 0) return null;
  const usedIso = entry.dates[found];
  const gapDays = (Date.parse(iso + 'T00:00:00Z') - Date.parse(usedIso + 'T00:00:00Z')) / 86400000;
  return gapDays <= 7 ? entry.map[usedIso] : null;
}

/**
 * Validates and normalises one Campaigns row.
 * @param {Array<*>} row [client, channel, date, spend, clicks, conversions, currency]
 * @param {function(Date): string} fmtDay formats a Date as yyyy-MM-dd in the sheet time zone
 * @param {Object} rateTable from buildRateTable_
 * @return {{ok: boolean, reason: (string|undefined), client: string, channel: string, iso: string,
 *   month: string, spendUsd: number, clicks: number, conversions: number}}
 */
function parseCampaignRow_(row, fmtDay, rateTable) {
  const client = String(row[0]).trim();
  const channel = String(row[1]).trim().toLowerCase();
  if (!client) return { ok: false, reason: 'no_client' };
  if (!channel) return { ok: false, reason: 'no_channel' };
  if (!isDate_(row[2])) return { ok: false, reason: 'bad_date' };
  const spend = parseNumber_(row[3]);
  if (spend === null || spend < 0) return { ok: false, reason: 'bad_spend' };
  // Only spend and the date must be there. A blank clicks or conversions cell counts as 0 (an email
  // channel has no clicks, an awareness campaign no conversions), and conversions may be fractional.
  const clicks = isBlankCell_(row[4]) ? 0 : parseCount_(row[4]);
  const conversionsNumber = isBlankCell_(row[5]) ? 0 : parseNumber_(row[5]);
  const conversions = conversionsNumber !== null && conversionsNumber >= 0 ? conversionsNumber : null;
  if (clicks === null) return { ok: false, reason: 'bad_clicks' };
  if (conversions === null) return { ok: false, reason: 'bad_conversions' };
  const ccy = String(row[6]).trim().toUpperCase() || 'USD';
  const iso = fmtDay(row[2]);
  const perUsd = perUsdFor_(rateTable, ccy, iso);
  if (perUsd === null) return { ok: false, reason: 'no_rate' };
  return {
    ok: true,
    client: client,
    channel: channel,
    iso: iso,
    month: iso.slice(0, 7),
    spendUsd: round2_(spend / perUsd),
    clicks: clicks,
    conversions: conversions
  };
}

/**
 * Reads every Campaigns row in one call and parses it. Bad rows are listed,
 * not thrown, so one typo does not stop a month close.
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @return {{rows: Object[], rejected: Array<{row: number, reason: string}>}}
 */
function readCampaigns_(ss) {
  const sheet = getOrCreateSheet_(ss, SD.SHEETS.CAMPAIGNS, SD.HEADERS.CAMPAIGNS);
  const data = readRows_(sheet, SD.HEADERS.CAMPAIGNS.length);
  const fmtDay = makeDateFormatter_(ss.getSpreadsheetTimeZone(), 'yyyy-MM-dd');
  const rates = loadRateTable_(ss);
  // A blank currency cell means dollars. On a client whose other rows are in another currency it is far more
  // likely a pasted row that lost its column, and a euro month reported as dollars goes out about 12 percent low
  // with nothing to warn of it, so such a row is left out and named instead.
  const foreign = {};
  data.forEach(function (r) {
    const code = String(r[6]).trim().toUpperCase();
    if (code && code !== 'USD') foreign[String(r[0]).trim()] = true;
  });
  const rows = [];
  const rejected = [];
  for (let i = 0; i < data.length; i++) {
    const p = parseCampaignRow_(data[i], fmtDay, rates);
    if (!p.ok) rejected.push({ row: i + 2, reason: p.reason });
    else if (isBlankCell_(data[i][6]) && foreign[p.client]) rejected.push({ row: i + 2, reason: 'no_currency' });
    else rows.push(p);
  }
  return { rows: rows, rejected: rejected };
}

/**
 * Inserts or replaces campaign rows keyed by client, channel and day. Replaced
 * rows are written back in contiguous runs and new rows in one block, so the
 * number of write calls does not grow with the number of rows.
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {Array<Array<*>>} incoming rows in the Campaigns column order, date as yyyy-MM-dd text
 * @return {{inserted: number, updated: number, unchanged: number}}
 */
function upsertCampaigns_(ss, incoming) {
  const sheet = getOrCreateSheet_(ss, SD.SHEETS.CAMPAIGNS, SD.HEADERS.CAMPAIGNS);
  const width = SD.HEADERS.CAMPAIGNS.length;
  const existing = readRows_(sheet, width);
  const fmtDay = makeDateFormatter_(ss.getSpreadsheetTimeZone(), 'yyyy-MM-dd');
  const keyOf = function (client, channel, iso) {
    return String(client).trim() + '|' + String(channel).trim().toLowerCase() + '|' + iso;
  };
  const index = {};
  existing.forEach(function (r, i) {
    if (isDate_(r[2])) index[keyOf(r[0], r[1], fmtDay(r[2]))] = i;
  });
  const updates = {};
  const fresh = [];
  let unchanged = 0;
  const seenNew = {};
  incoming.forEach(function (r) {
    const key = keyOf(r[0], r[1], r[2]);
    if (Object.prototype.hasOwnProperty.call(index, key)) {
      const old = existing[index[key]];
      const same = Number(old[3]) === Number(r[3]) && Number(old[4]) === Number(r[4]) &&
        Number(old[5]) === Number(r[5]) && String(old[6]).trim().toUpperCase() === String(r[6]).toUpperCase();
      if (same) unchanged++;
      else updates[index[key]] = r;
    } else if (Object.prototype.hasOwnProperty.call(seenNew, key)) {
      fresh[seenNew[key]] = r;
    } else {
      seenNew[key] = fresh.length;
      fresh.push(r);
    }
  });
  const ids = Object.keys(updates).map(Number).sort(function (a, b) { return a - b; });
  let i = 0;
  while (i < ids.length) {
    let j = i;
    while (j + 1 < ids.length && ids[j + 1] === ids[j] + 1) j++;
    const block = [];
    for (let k = i; k <= j; k++) block.push(updates[ids[k]]);
    sheet.getRange(ids[i] + 2, 1, block.length, width).setValues(block);
    i = j + 1;
  }
  if (fresh.length) {
    const start = sheet.getLastRow() + 1;
    ensureGrid_(sheet, start + fresh.length - 1, width);
    sheet.getRange(start, 1, fresh.length, width).setValues(fresh);
  }
  return { inserted: fresh.length, updated: ids.length, unchanged: unchanged };
}
