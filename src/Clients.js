/**
 * The Clients sheet: reading it, the cached name list used by the webhook,
 * and adding a row.
 */

/**
 * @typedef {Object} Client
 * @property {string} client
 * @property {string} contact_name
 * @property {string} contact_email
 * @property {string} ad_account_id
 * @property {string} primary_channel
 * @property {number} monthly_budget
 * @property {string} status
 * @property {string} intake_response_id
 */

/**
 * Reads the Clients sheet in one call.
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @return {Client[]}
 */
function loadClients_(ss) {
  const sheet = getOrCreateSheet_(ss, SD.SHEETS.CLIENTS, SD.HEADERS.CLIENTS);
  return readRows_(sheet, SD.HEADERS.CLIENTS.length)
    .map(function (r) {
      return {
        client: String(r[0]).trim(),
        contact_name: String(r[1]).trim(),
        contact_email: String(r[2]).trim(),
        ad_account_id: String(r[3]).trim(),
        primary_channel: String(r[4]).trim(),
        monthly_budget: parseNumber_(r[5]) || 0,
        status: String(r[6]).trim().toLowerCase(),
        intake_response_id: String(r[7]).trim()
      };
    })
    .filter(function (c) { return c.client !== ''; });
}

/**
 * Makes sure the Clients tab has the notes and review_reason columns after
 * created_at. They are added when both header cells are empty. A tab that has
 * its own text in either cell is left alone.
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @return {boolean} true when the two columns are there
 */
function ensureClientExtras_(sheet) {
  const extra = SD.CLIENT_EXTRA_HEADERS;
  const first = SD.HEADERS.CLIENTS.length + 1;
  ensureGrid_(sheet, 1, first + extra.length - 1);
  const cells = sheet.getRange(1, first, 1, extra.length);
  const have = cells.getValues()[0].map(function (h) { return String(h).trim(); });
  if (have.join('|') === extra.join('|')) return true;
  if (have.join('') !== '') return false;
  cells.setValues([extra]);
  return true;
}

/**
 * Client names for the webhook. Cached for 5 minutes so a busy Zap does not
 * read the sheet on every call. Adding a client clears the cache.
 * @return {string[]}
 */
function cachedClientNames_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get(SD.CACHE_CLIENTS_KEY);
  if (hit) {
    try {
      const list = JSON.parse(hit);
      if (Array.isArray(list)) return list;
    } catch (e) {
      // a damaged cache entry is treated as a miss
    }
  }
  const names = loadClients_(spreadsheet_()).map(function (c) { return c.client; });
  cache.put(SD.CACHE_CLIENTS_KEY, JSON.stringify(names), SD.CACHE_CLIENTS_SECONDS);
  return names;
}

/** Drops the cached client list. */
function invalidateClientCache_() {
  CacheService.getScriptCache().remove(SD.CACHE_CLIENTS_KEY);
}

/**
 * Finds the stored spelling of a client name, ignoring case and outer spaces.
 * @param {string[]} names
 * @param {string} wanted
 * @return {?string}
 */
function canonicalClient_(names, wanted) {
  const w = String(wanted).trim().toLowerCase();
  for (let i = 0; i < names.length; i++) {
    if (names[i].toLowerCase() === w) return names[i];
  }
  return null;
}
