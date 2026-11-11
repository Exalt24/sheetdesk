/**
 * Pulls daily ad costs from a stand-in ad platform API into the Campaigns
 * sheet, and daily currency rates from the Frankfurter API into the Rates
 * sheet. The stand-in host is example.test: it exists only in the test fake.
 */

/** Why an ad platform record does not become its own Campaigns row, by reason code, in the order a sentence lists them. */
const AD_DROP_WORDS_ = [
  ['not_an_object', 'a record that is not an object'],
  ['bad_date', 'no usable date'],
  ['bad_account_id', 'no account id'],
  ['bad_channel', 'no channel'],
  ['bad_cost_micros', 'a cost that is not a whole number of micros'],
  ['bad_currency', 'a currency that is not three capital letters'],
  ['bad_clicks', 'clicks that are not a whole number'],
  ['bad_conversions', 'conversions that are below zero or not a number'],
  ['unknown_account', 'an account id that no client has in the Clients tab'],
  ['duplicate', 'the same client, channel and day as a later record, which replaced it']
];

/**
 * Checks one record. Conversions may be fractional (Google Ads gives 2.5 with data driven attribution);
 * clicks and the cost stay whole numbers.
 * @param {*} item one record from the ad platform
 * @return {?string} a reason code of AD_DROP_WORDS_, or null when the record is usable
 */
function checkAdItem_(item) {
  if (!item || typeof item !== 'object') return 'not_an_object';
  if (!isIsoDate_(item.date)) return 'bad_date';
  if (typeof item.account_id !== 'string' || !item.account_id) return 'bad_account_id';
  if (typeof item.channel !== 'string' || !item.channel.trim()) return 'bad_channel';
  if (parseCount_(item.cost_micros) === null) return 'bad_cost_micros';
  if (!/^[A-Z]{3}$/.test(String(item.currency))) return 'bad_currency';
  if (parseCount_(item.clicks) === null) return 'bad_clicks';
  const conversions = parseNumber_(item.conversions);
  if (conversions === null || conversions < 0) return 'bad_conversions';
  return null;
}

/**
 * Counts the records of a pull that did not become their own Campaigns row and says why, in one
 * sentence, so a record that goes missing is a number and a reason and not silence.
 * @param {Object} reasons reason code to count (codes of AD_DROP_WORDS_)
 * @param {string[]} accounts the account ids no client has, in the order met
 * @return {({records: number, reasons: Object, text: string}|undefined)} nothing when every record became a row
 */
function adDroppedOf_(reasons, accounts) {
  const known = AD_DROP_WORDS_.map(function (w) { return w[0]; });
  const parts = [];
  let records = 0;
  AD_DROP_WORDS_.forEach(function (w) {
    const n = reasons[w[0]];
    if (!n) return;
    records += n;
    parts.push(n + ' with ' + w[1] + (w[0] === 'unknown_account' && accounts.length ? ' (' + accounts.slice(0, 5).join(', ') + (accounts.length > 5 ? ' and ' + (accounts.length - 5) + ' more' : '') + ')' : ''));
  });
  Object.keys(reasons).forEach(function (k) {
    if (known.indexOf(k) !== -1 || !reasons[k]) return;
    records += reasons[k];
    parts.push(reasons[k] + ' with the problem ' + k);
  });
  if (!records) return;
  return {
    records: records,
    reasons: reasons,
    text: records + (records === 1 ? ' record from the ad platform is' : ' records from the ad platform are') + ' not in Campaigns as its own row: ' + parts.join(', ') + '.'
  };
}

/**
 * Pulls daily costs between two dates (inclusive) and upserts them into
 * Campaigns. A rerun for the same days changes nothing.
 * @param {string} fromIso yyyy-MM-dd
 * @param {string} toIso yyyy-MM-dd, at most 92 days after fromIso
 * @return {{fetched: number, pages: number, inserted: number, updated: number, unchanged: number,
 *   unknownAccount: number, invalid: number, duplicates: number,
 *   dropped: ({records: number, reasons: Object, text: string}|undefined)}} dropped is present only when a record
 *   did not become its own row, with the count of each reason (an unusable record, an account no client has,
 *   a record replaced by a later one for the same client, channel and day)
 */
function syncAdCosts(fromIso, toIso) {
  if (!isIsoDate_(fromIso) || !isIsoDate_(toIso)) throw new Error('Dates must look like 2026-10-31.');
  if (fromIso > toIso) throw new Error('The start date is after the end date.');
  const days = (Date.parse(toIso + 'T00:00:00Z') - Date.parse(fromIso + 'T00:00:00Z')) / 86400000;
  if (days > 92) throw new Error('Ask for at most 92 days at a time.');
  const props = PropertiesService.getScriptProperties();
  const key = props.getProperty(SD.PROPS.AD_API_KEY);
  if (!key) throw new Error('Set the AD_API_KEY script property first.');
  const base = props.getProperty(SD.PROPS.AD_API_BASE) || SD.AD_API_DEFAULT_BASE;
  const ss = spreadsheet_();
  const clients = loadClients_(ss);
  const byAccount = {};
  clients.forEach(function (c) { if (c.ad_account_id) byAccount[c.ad_account_id] = c.client; });

  const result = fetchAllPages_(function (token) {
    return base + '/v1/costs?from=' + fromIso + '&to=' + toIso + (token ? '&page_token=' + encodeURIComponent(token) : '');
  }, { headers: { Authorization: 'Bearer ' + key }, deadlineMs: Date.now() + SD.BUDGET_MS },
  { itemsKey: 'data', nextKey: 'next_page_token' });

  const out = [];
  const seenKeys = {};
  let unknownAccount = 0;
  let invalid = 0;
  let duplicates = 0;
  const reasons = {};
  const unknownIds = [];
  result.items.forEach(function (it) {
    const problem = checkAdItem_(it);
    if (problem) {
      invalid++;
      reasons[problem] = (reasons[problem] || 0) + 1;
      return;
    }
    const client = byAccount[it.account_id];
    if (!client) {
      unknownAccount++;
      reasons.unknown_account = (reasons.unknown_account || 0) + 1;
      if (unknownIds.indexOf(it.account_id) === -1) unknownIds.push(it.account_id);
      return;
    }
    // Two records with one client, channel and day: the later one replaces the earlier, because the Campaigns row is keyed by those three.
    // Counted, so the replacement shows in the sync result instead of going unnoticed.
    const key = client + '|' + it.channel.trim().toLowerCase() + '|' + it.date;
    if (Object.prototype.hasOwnProperty.call(seenKeys, key)) {
      duplicates++;
      reasons.duplicate = (reasons.duplicate || 0) + 1;
    }
    seenKeys[key] = true;
    // Conversions may be fractional and may arrive as text; addCount_ with 0 rounds them to the 4 decimals every other count uses.
    out.push([client, it.channel.trim().toLowerCase(), it.date, Math.round(it.cost_micros / 10000) / 100,
      it.clicks, addCount_(parseNumber_(it.conversions), 0), it.currency]);
  });
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('Another run is writing to Campaigns. Try again in a minute.');
  let counts;
  try {
    counts = upsertCampaigns_(ss, out);
  } finally {
    releaseLock_(lock);
  }
  const summary = {
    fetched: result.items.length,
    pages: result.pages,
    inserted: counts.inserted,
    updated: counts.updated,
    unchanged: counts.unchanged,
    unknownAccount: unknownAccount,
    invalid: invalid,
    duplicates: duplicates
  };
  const dropped = adDroppedOf_(reasons, unknownIds);
  if (dropped) summary.dropped = dropped;
  return summary;
}

/**
 * Checks the Frankfurter v2 rates array: [{date, base, quote, rate}].
 * @param {*} body
 * @param {string[]} quotes
 * @return {?string}
 */
function checkRatesBody_(body, quotes) {
  if (!Array.isArray(body)) return 'not an array';
  for (let i = 0; i < body.length; i++) {
    const r = body[i];
    if (!r || !isIsoDate_(r.date) || r.base !== 'USD' || quotes.indexOf(r.quote) === -1 ||
      typeof r.rate !== 'number' || !(r.rate > 0)) {
      return 'bad rate record at index ' + i;
    }
  }
  return null;
}

/**
 * Pulls rates for a long range in pieces of at most RATE_PULL_PIECE_DAYS days,
 * the size of one ad cost pull, and adds the counts up.
 * @param {string} fromIso
 * @param {string} toIso
 * @return {{currencies: string[], fetched: number, inserted: number, updated: number, pieces: number, invalid: Array<{value: string, rows: number[]}>}}
 */
function syncRatesInPieces_(fromIso, toIso) {
  if (!isIsoDate_(fromIso) || !isIsoDate_(toIso) || fromIso > toIso) throw new Error('Give a valid date range.');
  const total = { currencies: [], fetched: 0, inserted: 0, updated: 0, pieces: 0, invalid: [] };
  let start = fromIso;
  while (start <= toIso) {
    const stop = new Date(Date.parse(start + 'T00:00:00Z') + (SD.RATE_PULL_PIECE_DAYS - 1) * 86400000).toISOString().slice(0, 10);
    const r = syncCurrencyRates(start, stop < toIso ? stop : toIso);
    total.currencies = r.currencies;
    total.invalid = r.invalid;
    total.fetched += r.fetched;
    total.inserted += r.inserted;
    total.updated += r.updated;
    total.pieces++;
    start = new Date(Date.parse(start + 'T00:00:00Z') + SD.RATE_PULL_PIECE_DAYS * 86400000).toISOString().slice(0, 10);
  }
  return total;
}

/**
 * Pulls daily USD based rates for the currencies used in Campaigns (or the
 * ones given) and upserts them into the Rates sheet.
 * Not called against the live API by this repo: see docs/ad-and-fx.md.
 * @param {string} fromIso
 * @param {string} toIso
 * @param {string[]} [currencies] upper case codes, default every non USD code in Campaigns
 * @return {{currencies: string[], fetched: number, inserted: number, updated: number, invalid: Array<{value: string, rows: number[]}>}} invalid lists Campaigns currency cells that are not a 3 letter code, with their sheet rows; they are skipped, not allowed to stop the other currencies
 */
function syncCurrencyRates(fromIso, toIso, currencies) {
  if (!isIsoDate_(fromIso) || !isIsoDate_(toIso) || fromIso > toIso) throw new Error('Give a valid date range.');
  const ss = spreadsheet_();
  let quotes = currencies;
  let invalid = [];
  if (!quotes) {
    const sheet = getOrCreateSheet_(ss, SD.SHEETS.CAMPAIGNS, SD.HEADERS.CAMPAIGNS);
    const seen = {};
    const bad = {};
    readRows_(sheet, SD.HEADERS.CAMPAIGNS.length).forEach(function (r, i) {
      const c = String(r[6]).trim().toUpperCase();
      if (!c || c === 'USD') return;
      if (/^[A-Z]{3}$/.test(c)) seen[c] = true;
      else (bad[c] = bad[c] || []).push(i + 2);
    });
    quotes = Object.keys(seen).sort();
    invalid = Object.keys(bad).sort().map(function (v) { return { value: v, rows: bad[v] }; });
  }
  if (!Array.isArray(quotes) || quotes.some(function (c) { return !/^[A-Z]{3}$/.test(c) || c === 'USD'; })) {
    throw new Error('Currencies must be 3 letter upper case codes other than USD.');
  }
  if (!quotes.length) return { currencies: [], fetched: 0, inserted: 0, updated: 0, invalid: invalid };
  const url = SD.FRANKFURTER_BASE + '?base=USD&quotes=' + quotes.join(',') + '&from=' + fromIso + '&to=' + toIso;
  const res = httpJson_(url, { validate: function (b) { return checkRatesBody_(b, quotes); } });

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('Another run is writing rates. Try again in a minute.');
  let inserted = 0;
  let updated = 0;
  try {
    const sheet = getOrCreateSheet_(ss, SD.SHEETS.RATES, SD.HEADERS.RATES);
    const fmt = makeDateFormatter_(ss.getSpreadsheetTimeZone(), 'yyyy-MM-dd');
    const existing = readRows_(sheet, 3);
    const index = {};
    existing.forEach(function (r, i) {
      if (isDate_(r[0])) index[fmt(r[0]) + '|' + String(r[1]).toUpperCase()] = i;
    });
    const fresh = [];
    res.json.forEach(function (r) {
      const k = r.date + '|' + r.quote;
      if (Object.prototype.hasOwnProperty.call(index, k)) {
        const i = index[k];
        if (Number(existing[i][2]) !== r.rate) {
          sheet.getRange(i + 2, 1, 1, 3).setValues([[r.date, r.quote, r.rate]]);
          updated++;
        }
      } else {
        fresh.push([r.date, r.quote, r.rate]);
      }
    });
    if (fresh.length) {
      const start = sheet.getLastRow() + 1;
      ensureGrid_(sheet, start + fresh.length - 1, 3);
      sheet.getRange(start, 1, fresh.length, 3).setValues(fresh);
      inserted = fresh.length;
    }
  } finally {
    releaseLock_(lock);
  }
  return { currencies: quotes, fetched: res.json.length, inserted: inserted, updated: updated, invalid: invalid };
}
