/**
 * Web app: a lead webhook for Zapier or Make (doPost) and a small status or
 * dashboard page (doGet).
 *
 * Apps Script web apps cannot read request headers and cannot set an HTTP
 * status code. The shared secret therefore travels in the body or in the URL
 * (as the "secret" field or parameter), and every reply is HTTP 200 with the
 * result in the JSON body. Callers must check "ok".
 */

const WEBHOOK_FIELDS = ['secret', 'lead_id', 'client', 'name', 'email', 'phone', 'source', 'campaign', 'message'];
const WEBHOOK_MAX_BODY = 10000;
const WEBHOOK_LIMITS = { client: 120, name: 120, phone: 40, source: 60, campaign: 120, message: 2000 };

/**
 * Builds an error reply.
 * @param {string} code short machine readable code
 * @param {Object} [extra]
 * @return {GoogleAppsScript.Content.TextOutput}
 */
function webhookError_(code, extra) {
  return jsonOut_(Object.assign({ ok: false, error: code }, extra || {}));
}

/**
 * Pulls the fields out of the request: a JSON body, or form fields.
 * @param {Object} e the doPost event
 * @return {{fields: ?Object, error: ?string}}
 */
function webhookParse_(e) {
  if (!e || !e.postData || typeof e.postData.contents !== 'string') return { fields: null, error: 'no_body' };
  if (e.postData.contents.length > WEBHOOK_MAX_BODY) return { fields: null, error: 'too_large' };
  const type = String(e.postData.type || '').toLowerCase();
  if (type.indexOf('json') !== -1) {
    let parsed;
    try {
      parsed = JSON.parse(e.postData.contents);
    } catch (err) {
      return { fields: null, error: 'bad_json' };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { fields: null, error: 'bad_json' };
    return { fields: parsed, error: null };
  }
  const form = {};
  Object.keys(e.parameter || {}).forEach(function (k) { form[k] = e.parameter[k]; });
  return { fields: form, error: null };
}

/**
 * Checks and normalises the lead fields. Every value is a string, a number or
 * null. Anything else (object, array, boolean) is rejected.
 * @param {Object} fields
 * @param {string[]} clientNames
 * @return {{lead: ?Object, error: ?string, detail: ?Object}}
 */
function webhookValidate_(fields, clientNames) {
  const unknown = Object.keys(fields).filter(function (k) { return WEBHOOK_FIELDS.indexOf(k) === -1; });
  if (unknown.length) return { lead: null, error: 'unknown_field', detail: { fields: unknown.slice(0, 10) } };
  const clean = {};
  for (let i = 0; i < WEBHOOK_FIELDS.length; i++) {
    const k = WEBHOOK_FIELDS[i];
    if (k === 'secret') continue;
    const v = fields[k];
    if (v === undefined || v === null) {
      clean[k] = '';
    } else if (typeof v === 'string' || (typeof v === 'number' && isFinite(v))) {
      clean[k] = String(v).trim();
    } else {
      return { lead: null, error: 'invalid_field', detail: { field: k } };
    }
  }
  if (!clean.lead_id) return { lead: null, error: 'missing_field', detail: { field: 'lead_id' } };
  if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(clean.lead_id)) return { lead: null, error: 'invalid_field', detail: { field: 'lead_id' } };
  if (!clean.client) return { lead: null, error: 'missing_field', detail: { field: 'client' } };
  const limited = Object.keys(WEBHOOK_LIMITS);
  for (let i = 0; i < limited.length; i++) {
    if (clean[limited[i]].length > WEBHOOK_LIMITS[limited[i]]) {
      return { lead: null, error: 'invalid_field', detail: { field: limited[i] } };
    }
  }
  if (clean.email && !isEmail_(clean.email)) return { lead: null, error: 'invalid_field', detail: { field: 'email' } };
  const canonical = canonicalClient_(clientNames, clean.client);
  if (!canonical) return { lead: null, error: 'unknown_client' };
  clean.client = canonical;
  return { lead: clean, error: null, detail: null };
}

/**
 * Lead webhook. Expects JSON like
 * {"secret": "...", "lead_id": "z-1001", "client": "Harbor Lane Bakery", "name": "...", "email": "..."}.
 * Order of checks: size, parse, secret, fields. A repeat of a lead_id is a
 * success with duplicate:true, so a Zap that retries never adds a second row.
 * @param {Object} e
 * @return {GoogleAppsScript.Content.TextOutput}
 */
function doPost(e) {
  const parsed = webhookParse_(e);
  if (parsed.error) return webhookError_(parsed.error);

  const expected = PropertiesService.getScriptProperties().getProperty(SD.PROPS.WEBHOOK_SECRET);
  if (!expected) return webhookError_('not_configured');
  const given = parsed.fields.secret !== undefined ? parsed.fields.secret : (e.parameter || {}).secret;
  if (!safeEquals_(typeof given === 'string' ? given : '', expected)) return webhookError_('unauthorized');

  const checked = webhookValidate_(parsed.fields, cachedClientNames_());
  if (checked.error) return webhookError_(checked.error, checked.detail || {});
  const lead = checked.lead;

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return webhookError_('busy', { retry: true });
  try {
    const ss = spreadsheet_();
    const sheet = getOrCreateSheet_(ss, SD.SHEETS.LEADS, SD.HEADERS.LEADS);
    const known = readRows_(sheet, 1);
    for (let i = 0; i < known.length; i++) {
      if (String(known[i][0]) === lead.lead_id) return jsonOut_({ ok: true, duplicate: true, lead_id: lead.lead_id });
    }
    sheet.appendRow([
      sheetText_(lead.lead_id),
      new Date(),
      sheetText_(lead.client),
      sheetText_(lead.name),
      sheetText_(lead.email),
      sheetText_(lead.phone),
      sheetText_(lead.source),
      sheetText_(lead.campaign),
      sheetText_(lead.message)
    ]);
    return jsonOut_({ ok: true, duplicate: false, lead_id: lead.lead_id });
  } finally {
    releaseLock_(lock);
  }
}

/**
 * Leads per client, for the status JSON and the dashboard.
 * @return {{total: number, clients: Array<{client: string, leads: number, last7: number}>}}
 */
function leadCounts_() {
  const ss = spreadsheet_();
  const sheet = getOrCreateSheet_(ss, SD.SHEETS.LEADS, SD.HEADERS.LEADS);
  const rows = readRows_(sheet, SD.HEADERS.LEADS.length);
  const weekAgo = Date.now() - 7 * 86400000;
  const byClient = {};
  rows.forEach(function (r) {
    const name = String(r[2]);
    const c = byClient[name] || (byClient[name] = { client: name, leads: 0, last7: 0 });
    c.leads++;
    if (isDate_(r[1]) && r[1].getTime() >= weekAgo) c.last7++;
  });
  const clients = Object.keys(byClient).sort().map(function (k) { return byClient[k]; });
  return { total: rows.length, clients: clients };
}

/**
 * Status page. Without the secret it only says the service is up. With the
 * secret, view=status returns lead counts as JSON and view=dashboard returns
 * an HTML table. The secret is in the URL, so treat that URL as private.
 * @param {Object} e
 * @return {GoogleAppsScript.Content.TextOutput|GoogleAppsScript.HTML.HtmlOutput}
 */
function doGet(e) {
  const p = (e && e.parameter) || {};
  const expected = PropertiesService.getScriptProperties().getProperty(SD.PROPS.WEBHOOK_SECRET);
  if (!p.view) return jsonOut_({ ok: true, service: 'sheetdesk' });
  if (!expected) return webhookError_('not_configured');
  if (!safeEquals_(typeof p.secret === 'string' ? p.secret : '', expected)) return webhookError_('unauthorized');
  const counts = leadCounts_();
  if (p.view === 'status') return jsonOut_({ ok: true, service: 'sheetdesk', leads_total: counts.total, clients: counts.clients });
  if (p.view === 'dashboard') {
    const t = HtmlService.createTemplateFromFile('Dashboard');
    t.counts = counts;
    t.agency = SD.AGENCY_NAME;
    return t.evaluate().setTitle('Leads by client');
  }
  return webhookError_('unknown_view');
}
