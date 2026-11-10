'use strict';
/**
 * A small mutation harness. Each mutant removes or flips one guard in src/.
 * The suite must fail for every one. A mutant the tests miss is a guard
 * nobody checks.
 *
 *   node scripts/mutation.js              run every mutant, 4 at a time
 *   node scripts/mutation.js secret       run the mutants whose id contains "secret"
 *   node scripts/mutation.js --ast        run only the mutants derived from the syntax tree
 *
 * The mutants in M are typed as old text and new text and run against the
 * whole suite. The mutants of scripts/mutation-ast.js are derived from the
 * syntax tree of the corpus round fixes, and run only against the corpus
 * replay and the tests named CLASS-TABLE, so a fix is judged by the class
 * test and not by a test written for one mutant.
 *
 * How it works: the mutant is written to a temp JSON file and its path is
 * passed in SHEETDESK_MUTANT. test/helpers/load.js applies it to the source
 * text when it loads the Apps Script files, and refuses to start when the
 * text to change is not found exactly once (a mutant that changed nothing
 * would pass for the wrong reason). This script also compiles the changed
 * file first, so a mutant that is only a syntax error is reported as invalid.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawn } = require('node:child_process');
const { astMutants } = require('./mutation-ast');

const ROOT = path.join(__dirname, '..');
const TIMEOUT_MS = 120000;
const PARALLEL = 4;

/** [id, file, text to find (exactly once), replacement, what it breaks] */
const M = [
  // ---- guards added after the second review (ad sync duplicates, bulk trigger re-arm, emailed time, month close dialog)
  ['sync-counts-duplicates', 'AdPlatform.js', "    if (Object.prototype.hasOwnProperty.call(seenKeys, key)) duplicates++;\n", '', 'two ad records for one client, channel and day replace each other with no count in the sync result'],
  ['bulk-lock-rearms-trigger', 'BulkProcess.js', "    if (loadCursor_()) replaceContinuationTrigger_(SD.CONTINUE_AFTER_MS);\n", '', 'a continuation that finds the lock held leaves the running job with no trigger to resume it'],
  ['emailed-time-follows-figures', 'Reporting.js', "  let emailedAt = prior && String(prior[4]) === figures ? prior[5] : '';\n", "  let emailedAt = prior ? prior[5] : '';\n", 'changed figures keep the old emailed time, so a preview or a failed send marks them as already sent'],
  ['dialog-counts-failed-email', 'Menu.js', "    emailFailed: r.results.filter(function (x) { return /^failed/.test(String(x.email)); }).length\n", "    emailFailed: 0\n", 'the month close dialog reads a refused email as done'],
  // ---- webhook
  ['setup-pins-time-zone', 'Menu.js', "  if (ss.getSpreadsheetTimeZone() !== zone) ss.setSpreadsheetTimeZone(zone);\n", '', 'Set up leaves the Sheet time zone as it was, so dates can be read a day early'],
  ['secret-check', 'Webhook.js', "  if (!safeEquals_(typeof given === 'string' ? given : '', expected)) return webhookError_('unauthorized');\n", '', 'the shared secret is not checked on POST'],
  ['secret-fail-closed', 'Webhook.js', "  if (!expected) return webhookError_('not_configured');\n  const given", '  const given', 'POST works when no secret is configured'],
  ['secret-get-check', 'Webhook.js', "  if (!safeEquals_(typeof p.secret === 'string' ? p.secret : '', expected)) return webhookError_('unauthorized');\n", '', 'the dashboard and status views need no secret'],
  ['safe-equals-true', 'Util.js', '  return diff === 0;', '  return true;', 'the secret comparison accepts anything'],
  ['idempotency', 'Webhook.js', "      if (String(known[i][0]) === lead.lead_id) return jsonOut_({ ok: true, duplicate: true, lead_id: lead.lead_id });\n", '', 'a repeated lead_id adds a second row'],
  ['idempotency-lock', 'Webhook.js', "  if (!lock.tryLock(10000)) return webhookError_('busy', { retry: true });\n", '', 'the webhook takes no lock'],
  ['unknown-field', 'Webhook.js', "  if (unknown.length) return { lead: null, error: 'unknown_field', detail: { fields: unknown.slice(0, 10) } };\n", '', 'unknown fields are accepted'],
  ['bad-json-shape', 'Webhook.js', "    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { fields: null, error: 'bad_json' };\n", '', 'a JSON array or string passes as a lead'],
  ['body-size', 'Webhook.js', "  if (e.postData.contents.length > WEBHOOK_MAX_BODY) return { fields: null, error: 'too_large' };\n", '', 'there is no body size limit'],
  ['value-types', 'Webhook.js', "      return { lead: null, error: 'invalid_field', detail: { field: k } };", '      clean[k] = String(v);', 'objects and arrays are stored as text'],
  ['lead-id-shape', 'Webhook.js', "  if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(clean.lead_id)) return { lead: null, error: 'invalid_field', detail: { field: 'lead_id' } };\n", '', 'lead_id can hold any characters'],
  ['email-shape', 'Webhook.js', "  if (clean.email && !isEmail_(clean.email)) warnings.push({ field: 'email', issue: 'not_an_email' });\n", '', 'an email that is not an address is stored with no warning'],
  ['warnings-reply', 'Webhook.js', '    if (checked.warnings.length) reply.warnings = checked.warnings;\n', '', 'the reply does not list the odd fields'],
  ['unknown-client', 'Webhook.js', "  if (!canonical) return { lead: null, error: 'unknown_client' };\n", '', 'a lead for a client that does not exist is stored'],
  ['field-limits', 'Webhook.js', '    if (clean[k].length <= WEBHOOK_LIMITS[k]) continue;', '    continue;', 'no limit is checked: a client over 120 characters is looked up and a long text is not reported'],
  ['blank-count-zero', 'Campaigns.js', '  const clicks = isBlankCell_(row[4]) ? 0 : parseCount_(row[4]);', '  const clicks = parseCount_(row[4]);', 'a blank clicks cell rejects the row and its spend'],
  ['fractional-conversions', 'Campaigns.js', '  const conversionsNumber = isBlankCell_(row[5]) ? 0 : parseNumber_(row[5]);', '  const conversionsNumber = isBlankCell_(row[5]) ? 0 : parseCount_(row[5]);', 'a fractional conversions value rejects the row and its spend'],
  ['bulk-rate-tiny-batch', 'BulkProcess.js', '        if (n >= BULK_MIN_RATE_ROWS) cursor.readMsPerRow', '        cursor.readMsPerRow', 'a last batch of one row makes the rollup look too slow'],
  ['formula-guard', 'Util.js', '  return risky ? "\'" + s : s;', '  return s;', 'text from outside is written as typed, so =IMPORTXML runs'],
  ['text-numbers-guard', 'Util.js', '(,\\d{3})+(\\.\\d+)?|\\d+(\\.\\d+)?|\\.\\d+)', '(,\\d{3})+(\\.\\d+)?|\\.\\d+)', 'lead ids like 007 turn into numbers'],
  ['text-thousands', 'Util.js', '(\\d{1,3}(,\\d{3})+(\\.\\d+)?|\\d+(\\.\\d+)?|\\.\\d+)', '(\\d+(\\.\\d+)?|\\.\\d+)', 'the text 1,000 turns into a number'],
  ['text-leading-dot', 'Util.js', '|\\d+(\\.\\d+)?|\\.\\d+)(', '|\\d+(\\.\\d+)?)(', 'the text .5 turns into a number'],
  ['text-scientific', 'Util.js', '|\\.\\d+)([eE][-+]?\\d+)?%?$/', '|\\.\\d+)%?$/', 'the text 1e5 turns into a number'],
  ['text-percent', 'Util.js', '([eE][-+]?\\d+)?%?$/.test(s)', '([eE][-+]?\\d+)?$/.test(s)', 'the text 50% turns into a number'],
  ['text-currency', 'Util.js', '    /^[$\\u20ac\\u00a3\\u00a5\\u20b1]\\s*\\d[\\d,]*(\\.\\d+)?$/.test(s) ||\n', '', 'the text $5 turns into a number'],
  ['text-time', 'Util.js', '    /^\\d{1,2}:\\d{2}(:\\d{2})?(\\s?[AaPp][Mm])?$/.test(s) ||\n', '', 'the text 10:30 turns into a time'],
  ['text-iso-date', 'Util.js', '    /^\\d{4}-\\d{2}-\\d{2}/.test(s) ||\n', '', 'the text 2026-10-03 turns into a date'],
  ['text-year-month', 'Util.js', '    /^\\d{4}-(0[1-9]|1[0-2])$/.test(s) ||\n', '', 'the text 2026-10 turns into a date'],
  ['text-slash-date', 'Util.js', '    /^\\d{1,4}\\/\\d{1,2}(\\/\\d{1,4})?$/.test(s) ||\n', '', 'the text 3/4 turns into a date'],
  ['text-dash-date', 'Util.js', '    /^\\d{1,2}-\\d{1,2}(-\\d{2,4})?$/.test(s) ||\n', '', 'the text 3-4 turns into a date in some locales'],
  ['text-month-first', 'Util.js', "    new RegExp('^' + SHEET_MONTH_WORD_ + '\\\\s+\\\\d{1,4}(,?\\\\s+\\\\d{4})?$', 'i').test(s) ||\n", '', 'the text Oct 5 turns into a date'],
  ['text-day-first', 'Util.js', "    new RegExp('^\\\\d{1,2}\\\\s+' + SHEET_MONTH_WORD_ + '(,?\\\\s+\\\\d{4})?$', 'i').test(s) ||\n", '', 'the text 5 Oct turns into a date'],
  ['text-boolean', 'Util.js', '    /^(true|false)$/i.test(s);', '    false;', 'the text true turns into a boolean'],
  ['release-flush', 'Util.js', '  try {\n    SpreadsheetApp.flush();\n  } finally {\n    lock.releaseLock();\n  }', '  lock.releaseLock();', 'the lock is released before the writes are flushed'],
  ['release-finally', 'Util.js', '  try {\n    SpreadsheetApp.flush();\n  } finally {\n    lock.releaseLock();\n  }', '  SpreadsheetApp.flush();\n  lock.releaseLock();', 'a failing flush leaves the lock held'],
  ['client-cache-fill', 'Clients.js', '  cache.put(SD.CACHE_CLIENTS_KEY, JSON.stringify(names), SD.CACHE_CLIENTS_SECONDS);\n', '', 'the client list is never cached'],
  ['client-cache-clear', 'Forms.js', '    invalidateClientCache_();\n', '', 'a new client is unknown to the webhook for 5 minutes'],
  ['dashboard-escape', 'Dashboard.html', '<td><?= c.client ?></td>', '<td><?!= c.client ?></td>', 'client names are put into the dashboard unescaped'],
  // ---- forms
  ['form-lock', 'Forms.js', '  lock.waitLock(30000);\n', '', 'two form deliveries can write at once'],
  ['form-response-id', 'Forms.js', "      if (String(rows[i][7]) === responseId) return { status: 'duplicate', client: String(rows[i][0]), emailed: false };\n", '', 'a repeated response adds a second client'],
  ['form-needs-review', 'Forms.js', "    status = parsed.ok && !nameTaken ? 'active' : 'needs_review';", "    status = 'active';", 'bad or duplicate intake is marked active'],
  ['form-email-check', 'Forms.js', "  if (!isEmail_(email)) problems.push('contact email');\n", '', 'a bad contact email is accepted'],
  ['form-one-trigger', 'Forms.js', "    if (t.getHandlerFunction() === 'onIntakeSubmit') ScriptApp.deleteTrigger(t);\n", '', 'installing again adds another trigger'],
  ['form-link-log', 'Forms.js', "  Logger.log('Intake form link: ' + form.getPublishedUrl());\n", '', 'the form link is not shown anywhere'],
  ['form-reuse', 'Forms.js', '      return FormApp.openById(id);', '      FormApp.openById(id);', 'installing again creates another form'],
  // ---- reporting
  ['pdf-replace', 'Reporting.js', '    replaced = trashOthersNamed_(folder, pdfName, pdf.getId());', '    replaced = 0;', 'a rerun leaves two PDFs with the same name'],
  ['pdf-save', 'Reporting.js', '    doc.saveAndClose();\n    pdf = ', '    pdf = ', 'the PDF is made before the Doc is saved'],
  ['pdf-table', 'Reporting.js', '  body.insertTable(index, cells);\n', '', 'the table is left out of the report'],
  ['pdf-working-copy', 'Reporting.js', '    copy.setTrashed(true);\n  }', '  }', 'the working copy stays in Drive'],
  ['dollar-guard', 'Reporting.js', "    if (text.indexOf('$') !== -1) {", '    if (false) {', 'a dollar sign in a value reaches replaceText'],
  ['email-once', 'Reporting.js', "  } else if (alreadySent && !opts.force) {\n    email = 'already_sent';\n", "  } else if (false) {\n    email = 'already_sent';\n", 'a rerun emails the client again'],
  ['email-on-change', 'Reporting.js', "  const alreadySent = prior && String(prior[4]) === figures && prior[5] !== '';", "  const alreadySent = prior && prior[5] !== '';", 'changed figures are not emailed'],
  ['report-month-check', 'Reporting.js', 'function runClientReport(clientName, month, options) {\n  assertMonth_(month);', 'function runClientReport(clientName, month, options) {', 'a bad month reaches the report'],
  ['report-client-check', 'Reporting.js', '  const client = assertClient_(clients, clientName);', "  const client = clients.filter(function (c) { return c.client === clientName; })[0] || { client: clientName, contact_email: '' };", 'an unknown client gets a report'],
  ['close-month-check', 'Reporting.js', 'function runMonthClose(month) {\n  assertMonth_(month);', 'function runMonthClose(month) {', 'a bad month reaches the month close'],
  ['distinct-names', 'Reporting.js', '  assertDistinctNames_(clients.map(function (c) { return c.client; }));\n  const agg', '  const agg', 'two clients can overwrite each other PDF'],
  ['summary-tab-names', 'Reporting.js', '  assertDistinctNames_(names);\n', '', 'two clients can share a summary tab'],
  ['summary-clear', 'Reporting.js', '    sheet.clearContents();\n    ensureGrid_(sheet, table.length, table[0].length);', '    ensureGrid_(sheet, table.length, table[0].length);', 'old rows stay in a rebuilt summary'],
  ['close-skip-current', 'Reporting.js', '  if (opts.skipIfCurrent && prior && String(prior[4]) === figures && clientMailed && pdfStillExists_(String(prior[3]))) {', '  if (false) {', 'a month close rebuilds every report again'],
  ['close-skip-needs-mail', 'Reporting.js', "prior && (prior[5] !== '' || !client.contact_email || !isEmail_(client.contact_email));", 'prior;', 'a report that was only previewed or failed to send is skipped as current'],
  ['close-skip-no-address', 'Reporting.js', "(prior[5] !== '' || !client.contact_email || !isEmail_(client.contact_email))", "(prior[5] !== '')", 'a client with no address is rebuilt on every month close'],
  ['close-time-budget', 'Reporting.js', '    if (Date.now() - started + slowest * 1.5 > SD.BUDGET_MS) {', '    if (false) {', 'month close has no time budget'],
  ['close-active-only', 'Reporting.js', "  const clients = allClients.filter(function (c) { return c.status === 'active'; });", '  const clients = allClients;', 'paused clients get a report'],
  ['cents', 'Util.js', '  return Math.round(amount * 100);', '  return Math.floor(amount * 100);', 'money sums drift by a cent'],
  // ---- menu and sidebar
  ['sidebar-month-check', 'Menu.js', '  assertMonth_(month);\n  showMonthCloseDialog_(month);', '  showMonthCloseDialog_(month);', 'the dialog opens for any text'],
  ['menu-handler-name', 'Menu.js', ".addItem('Open desk', 'openDesk')", ".addItem('Open desk', 'openDeskNow')", 'a menu item runs a function that does not exist'],
  ['sidebar-call-name', 'Sidebar.html', '.sidebarRunReport(\n', '.sidebarRunReportNow(\n', 'the sidebar calls a function that does not exist'],
  ['setup-secret-kept', 'Menu.js', '  if (!props.getProperty(SD.PROPS.WEBHOOK_SECRET)) {', '  if (true) {', 'set up replaces the webhook secret every time'],
  ['sidebar-active-only', 'Menu.js', "    .filter(function (c) { return c.status === 'active'; })", '    .filter(function () { return true; })', 'the picker lists paused clients'],
  ['previous-month-year', 'Menu.js', '  const py = m === 1 ? y - 1 : y;', '  const py = y;', 'last month in January is a month in the future'],
  ['header-check', 'Util.js', "  if (found.join('|') !== headers.join('|')) {", '  if (false) {', 'a renamed column is not noticed'],
  ['month-shape', 'Util.js', "'string' && /^\\d{4}-(0[1-9]|1[0-2])$/", "'string' && /^\\d{4}-\\d{2}$/", 'month 13 is accepted'],
  // ---- campaigns, rates, upsert
  ['row-negative-spend', 'Campaigns.js', '  if (spend === null || spend < 0) return', '  if (spend === null) return', 'negative spend counts'],
  ['row-clicks', 'Campaigns.js', "  if (clicks === null) return { ok: false, reason: 'bad_clicks' };\n", '', 'bad clicks count'],
  ['row-date', 'Campaigns.js', "  if (!isDate_(row[2])) return { ok: false, reason: 'bad_date' };\n", '', 'a row with no date is kept'],
  ['rate-window', 'Campaigns.js', '  return gapDays <= 7 ? entry.map[usedIso] : null;', '  return entry.map[usedIso];', 'a rate from months ago is used'],
  ['rate-search', 'Campaigns.js', '    if (entry.dates[mid] <= iso) {', '    if (entry.dates[mid] < iso) {', 'the rate of the exact day is skipped'],
  ['upsert-runs', 'Campaigns.js', '    while (j + 1 < ids.length && ids[j + 1] === ids[j] + 1) j++;\n', '', 'changed rows are written one call each'],
  ['upsert-unchanged', 'Campaigns.js', '      if (same) unchanged++;', '      if (false) unchanged++;', 'unchanged rows are rewritten'],
  ['upsert-channel-case', 'Campaigns.js', "    return String(client).trim() + '|' + String(channel).trim().toLowerCase() + '|' + iso;", "    return String(client).trim() + '|' + String(channel).trim() + '|' + iso;", 'Search and search are two rows'],
  // ---- http client, ad platform, rates sync
  ['retry-429', 'HttpClient.js', '      if (code !== 429 && code < 500) {', '      if (code < 500) {', '429 is not retried'],
  ['retry-5xx', 'HttpClient.js', '      if (code !== 429 && code < 500) {', '      if (code !== 429 && code < 600) {', '5xx is not retried'],
  ['retry-4xx', 'HttpClient.js', '      if (code !== 429 && code < 500) {', '      if (false) {', 'every error is retried, even 401'],
  ['backoff-exponent', 'HttpClient.js', '  const delay = Math.min(maxMs, baseMs * Math.pow(2, attempt - 1));', '  const delay = Math.min(maxMs, baseMs);', 'the wait does not grow'],
  ['backoff-cap', 'HttpClient.js', '  const delay = Math.min(maxMs, baseMs * Math.pow(2, attempt - 1));', '  const delay = baseMs * Math.pow(2, attempt - 1);', 'the wait has no cap'],
  ['retry-after', 'HttpClient.js', '        ? Math.min(o.maxDelayMs, retryAfter * 1000)', '        ? Math.min(o.maxDelayMs, retryAfter)', 'Retry-After is read as milliseconds'],
  ['retry-sleep', 'HttpClient.js', '    Utilities.sleep(waitMs);\n', '', 'retries do not wait'],
  ['retry-count', 'HttpClient.js', '  for (let attempt = 1; attempt <= o.maxAttempts; attempt++) {', '  for (let attempt = 1; attempt < o.maxAttempts; attempt++) {', 'one attempt too few'],
  ['retry-deadline', 'HttpClient.js', '    if (o.deadlineMs !== null && Date.now() + waitMs > o.deadlineMs) {', '    if (false) {', 'a retry can run past the time budget'],
  ['content-type', 'HttpClient.js', "  if (type.toLowerCase().indexOf('json') === -1) {", '  if (false) {', 'an HTML page with status 200 is parsed as data'],
  ['validate-body', 'HttpClient.js', "    if (problem) throw httpError_('Unexpected response: ' + problem, code, attempt);\n", '', 'the response shape is not checked'],
  ['pagination-token', 'HttpClient.js', '    token = body[shape.nextKey] || null;', '    token = null;', 'only the first page is read'],
  ['pagination-loop', 'HttpClient.js', "      if (seen[token]) throw new Error('Pagination loop: token \"' + token + '\" came back.');\n", '', 'a repeated page token loops'],
  ['pagination-max', 'HttpClient.js', "    if (pages >= maxPages) throw new Error('Pagination did not end after ' + maxPages + ' pages.');\n", '', 'pagination has no page limit'],
  ['ads-dates', 'AdPlatform.js', "  if (!isIsoDate_(fromIso) || !isIsoDate_(toIso)) throw new Error('Dates must look like 2026-10-31.');\n", '', 'the ad sync takes any date text'],
  ['ads-range', 'AdPlatform.js', "  if (days > 92) throw new Error('Ask for at most 92 days at a time.');\n", '', 'the ad sync takes any range'],
  ['ads-key', 'AdPlatform.js', "  if (!key) throw new Error('Set the AD_API_KEY script property first.');\n", '', 'the ad sync runs with no key'],
  ['ads-unknown-account', 'AdPlatform.js', '    if (!client) {\n      unknownAccount++;\n      return;\n    }\n', '', 'costs of an unknown account are written'],
  ['ads-cost-check', 'AdPlatform.js', "  if (parseCount_(item.cost_micros) === null) return 'bad cost_micros';\n", '', 'a negative cost is written'],
  ['ads-lock', 'AdPlatform.js', "  if (!lock.tryLock(30000)) throw new Error('Another run is writing to Campaigns. Try again in a minute.');\n", '', 'the ad sync writes without the lock'],
  ['fx-rate-check', 'AdPlatform.js', "      typeof r.rate !== 'number' || !(r.rate > 0)) {", "      typeof r.rate !== 'number') {", 'a zero or negative rate is accepted'],
  ['fx-usd-quote', 'AdPlatform.js', "/^[A-Z]{3}$/.test(c) || c === 'USD'", '/^[A-Z]{3}$/.test(c)', 'USD can be asked for as a quote currency'],
  ['fx-lock', 'AdPlatform.js', "  if (!lock.tryLock(30000)) throw new Error('Another run is writing rates. Try again in a minute.');\n", '', 'the rate sync writes without the lock'],
  // ---- bulk job
  ['bulk-budget-check', 'BulkProcess.js', '        if (didChunk && Date.now() - t0 + cursor.lastChunkMs * 1.25 > SD.BUDGET_MS) break;\n', '', 'the job never stops for the time limit'],
  ['bulk-budget-value', 'Config.js', '  BUDGET_MS: 4.5 * 60 * 1000,', '  BUDGET_MS: 10 * 60 * 1000,', 'the budget is longer than the limit'],
  ['bulk-one-chunk', 'BulkProcess.js', '        if (didChunk && Date.now()', '        if (Date.now()', 'a slow chunk can stall the job'],
  ['bulk-cursor-step', 'BulkProcess.js', '        cursor.next += n;', '        cursor.next += n - 1;', 'the cursor moves one row too little'],
  ['bulk-cursor-save', 'BulkProcess.js', '        saveCursor_(cursor);\n        didChunk = true;', '        didChunk = true;', 'the cursor is saved only at the end of a run'],
  ['bulk-row-position', 'BulkProcess.js', '        clean.getRange(cursor.next, 1, n, SD.HEADERS.CLEAN.length).setValues(out);', '        clean.getRange(cursor.next + 1, 1, n, SD.HEADERS.CLEAN.length).setValues(out);', 'cleaned rows land one row down'],
  ['bulk-trigger-create', 'BulkProcess.js', '  ScriptApp.newTrigger(BULK_CONTINUE_HANDLER).timeBased().after(afterMs).create();\n', '', 'no continuation trigger is created'],
  ['bulk-trigger-cleanup', 'BulkProcess.js', '  old.forEach(function (t) { ScriptApp.deleteTrigger(t); });\n', '', 'old continuation triggers pile up'],
  ['bulk-trigger-final', 'BulkProcess.js', "      deleteContinuationTriggers_();\n      return { status: 'done'", "      return { status: 'done'", 'a trigger is left after the job is done'],
  ['bulk-trigger-idle', 'BulkProcess.js', '    if (!cursor) {\n      deleteContinuationTriggers_();\n', '    if (!cursor) {\n', 'a late trigger stays after the job is gone'],
  ['bulk-lock', 'BulkProcess.js', "  if (!lock.tryLock(5000)) return { status: 'locked' };\n", '', 'two runs can work on the job at once'],
  ['bulk-restart-guard', 'BulkProcess.js', "    if (existing && !opts.restart) throw new Error('A bulk job is already running at row ' + existing.next + '. Pass restart to drop it.');\n", '', 'a second start overwrites a running job'],
  ['bulk-rollup-bad-rows', 'BulkProcess.js', "      if (r[7] !== 'ok') continue;\n", '', 'bad rows are added to the rollup'],
  ['bulk-rollup-estimate', 'BulkProcess.js', '      if (Date.now() - t0 + estimate <= SD.BUDGET_MS) {', '      if (true) {', 'the rollup starts without enough time left'],
  ['bulk-rollup-clear', 'BulkProcess.js', '  rollup.clearContents();\n', '', 'an old rollup keeps its extra rows'],
  ['bulk-clean-clear', 'BulkProcess.js', '    clean.clearContents();\n', '', 'an old Clean sheet keeps its extra rows'],
  ['bulk-grid', 'Util.js', '  if (maxRows < rows) sheet.insertRowsAfter(maxRows, rows - maxRows);', '', 'a big write does not grow the sheet first'],
  ['bulk-log-once', 'Util.js', '    if (String(data[i][0]) === row[0] && String(data[i][1]) === String(row[1])) {', '    if (false) {', 'a job that finishes twice logs twice'],
  ['bulk-start-clock', 'BulkProcess.js', '  return runBulkSlice_(t0);', '  return runBulkSlice_();', 'the time budget starts after the clear and the grid growth'],
  // ---- months and dates kept as text
  ['clean-month-text', 'BulkProcess.js', 'sheetText_(p.channel), sheetText_(p.month), p.iso', 'sheetText_(p.channel), p.month, p.iso', 'the month in Clean can turn into a date and the rollup misses it'],
  ['rollup-month-text', 'BulkProcess.js', '[sheetText_(s.client), sheetText_(s.month), s.cents', '[sheetText_(s.client), s.month, s.cents', 'the month in Rollup can turn into a date'],
  ['summary-month-text', 'Reporting.js', "table.push([sheetText_(month), sheetText_(ch)].concat(", 'table.push([month, sheetText_(ch)].concat(', 'the month in a summary tab can turn into a date'],
  ['summary-all-month-text', 'Reporting.js', "table.push([sheetText_(month), 'ALL']", "table.push([month, 'ALL']", 'the month of an ALL line can turn into a date'],
  ['report-log-text', 'Reporting.js', 'for (let i = 0; i < 4; i++) stored[i] = sheetText_(row[i]);', 'for (let i = 0; i < 0; i++) stored[i] = sheetText_(row[i]);', 'the month in the Report Log can turn into a date'],
  ['job-log-text', 'Util.js', '  stored[1] = sheetText_(row[1]);', '  stored[1] = row[1];', 'a month close logs a second row each time it runs'],
  // ---- mail and scopes
  ['forms-uses-gmail', 'Forms.js', '      MailApp.sendEmail(', '      GmailApp.sendEmail(', 'the confirmation needs the full Gmail scope'],
  ['report-uses-gmail', 'Reporting.js', '  MailApp.sendEmail(to, subject, body, mail);', '  GmailApp.sendEmail(to, subject, body, mail);', 'the report email needs the full Gmail scope'],
  // ---- send to me first
  ['preview-branch', 'Reporting.js', '  } else if (opts.preview) {', '  } else if (false) {', 'a preview is sent to the client'],
  ['preview-counts-as-sent', 'Reporting.js', "      return 'preview_sent';", "      emailedAt = now;\n      return 'preview_sent';", 'a preview counts as the email to the client'],
  ['preview-copy', 'Reporting.js', "body, pdf, '');", 'body, pdf, PropertiesService.getScriptProperties().getProperty(SD.PROPS.REPORT_CC));', 'a preview is copied to the REPORT_CC address'],
  ['preview-fallback', 'Reporting.js', "  return cc && isEmail_(cc) ? cc : '';", "  return '';", 'with no address from Google a preview has nowhere to go'],
  ['preview-user', 'Reporting.js', '  if (isEmail_(mine)) return mine;\n', '', 'a preview ignores the person running the script'],
  ['sidebar-preview-default', 'Menu.js', '{ preview: sendToMe !== false }', '{ preview: sendToMe === true }', 'a missing or odd value emails the client'],
  ['sidebar-box-ticked', 'Sidebar.html', 'id="send-to-me" checked>', 'id="send-to-me">', '"Send to me first" starts unticked'],
  ['sidebar-box-passed', 'Sidebar.html', "        document.getElementById('send-to-me').checked\n", '        false\n', 'the box is not passed to the server'],
  ['prop-notes', 'Config.js', "    AD_API_BASE: 'Optional. The base URL", "    AD_API_BASE_X: 'Optional. The base URL", 'a script property has no explanation'],
  // ---- time zones of the menu
  ['month-zone', 'Menu.js', '  const tz = spreadsheet_().getSpreadsheetTimeZone();', '  const tz = Session.getScriptTimeZone();', 'last month is read in the script zone, not the data zone'],
  ['days-ago-zone', 'Menu.js', "spreadsheet_().getSpreadsheetTimeZone(), 'yyyy-MM-dd');", "Session.getScriptTimeZone(), 'yyyy-MM-dd');", 'the pull range is read in the script zone'],
  // ---- web app failures
  ['post-wrapper', 'Webhook.js', "    return webhookFailure_('doPost', err);", '    throw err;', 'an exception in doPost reaches the caller as an HTML error page'],
  ['get-wrapper', 'Webhook.js', "    return webhookFailure_('doGet', err);", '    throw err;', 'an exception in doGet reaches the caller as an HTML error page'],
  ['failure-detail', 'Webhook.js', "  return webhookError_('server_error');", "  return webhookError_('server_error', { detail: String(err && err.message ? err.message : err) });", 'the error reply carries the internal message'],
  ['failure-log', 'Webhook.js', "  Logger.log(where + ' failed: ' + String(err && err.message ? err.message : err).slice(0, 300));\n", '', 'the cause of a failure is not logged'],
  ['failure-log-cut', 'Webhook.js', 'String(err && err.message ? err.message : err).slice(0, 300)', 'String(err && err.message ? err.message : err)', 'a long message is logged whole']
];

/**
 * Mutants whose derivation is known to leave the behaviour unchanged, with the reason. They are
 * skipped, not counted. An entry that matches no mutant any more is an error.
 */
const EQUIVALENT = {};

/** Tests that judge the syntax tree mutants: the corpus replay and every test named CLASS-TABLE. */
const TEST_PATTERN = '^(CLASS-TABLE|corpus_sheetdesk_1)';
const TEST_DIR = path.join(ROOT, 'test');
function classTestFiles() {
  return fs.readdirSync(TEST_DIR).filter((f) => f.endsWith('.test.js'))
    .filter((f) => f === 'corpus.test.js' || fs.readFileSync(path.join(TEST_DIR, f), 'utf8').includes('CLASS-TABLE'))
    .map((f) => 'test/' + f);
}

const HAND = M.map(([id, file, find, replace, breaks]) => ({ id, file, find, replace, breaks }));
const AST = astMutants().filter((m) => !(m.id in EQUIVALENT));
const MUTANTS = HAND.concat(AST);

function validate(m) {
  const full = path.join(ROOT, 'src', m.file);
  const text = fs.readFileSync(full, 'utf8');
  let mutated;
  if (m.start !== undefined) {
    if (text.slice(m.start, m.end) !== m.find) return 'the text at the position is not the text the mutant expects';
    mutated = text.slice(0, m.start) + m.replace + text.slice(m.end);
  } else {
    const parts = text.split(m.find);
    if (parts.length !== 2) return 'the text to change was found ' + (parts.length - 1) + ' times, not once';
    mutated = parts.join(m.replace);
  }
  if (m.file.endsWith('.js')) {
    try { new vm.Script(mutated, { filename: m.file }); } catch (e) { return 'the mutated file does not compile: ' + e.message; }
  }
  return null;
}

function runOne(m) {
  return new Promise((resolve) => {
    const file = path.join(os.tmpdir(), 'sheetdesk-mutant-' + process.pid + '-' + m.id.replace(/[^A-Za-z0-9_-]/g, '_') + '.json');
    fs.writeFileSync(file, JSON.stringify(m));
    const args = m.id.startsWith('ast:') || m.id === 'baseline-ast'
      ? ['--test', '--test-name-pattern=' + TEST_PATTERN, ...classTestFiles()]
      : ['--test', 'test/*.test.js'];
    const child = spawn(process.execPath, args, {
      cwd: ROOT, env: Object.assign({}, process.env, { SHEETDESK_MUTANT: file }), stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => { child.kill(); }, TIMEOUT_MS);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      fs.rmSync(file, { force: true });
      const failed = [...new Set([...out.matchAll(/^\s*✖ (.+?) \(\d/gm)].map((x) => x[1]))].filter((n) => !/^test$/.test(n));
      if (signal || code === null) resolve({ m, code, caught: true, how: 'timed out (an endless loop counts as caught)', failed });
      else if (/MUTANT_NOT_APPLIED/.test(out)) resolve({ m, code, caught: false, invalid: true, how: 'the loader could not apply it', failed });
      else resolve({ m, code, caught: code !== 0 && failed.length > 0, how: failed.length + ' test(s) failed', failed });
    });
  });
}

async function main() {
  const flags = process.argv.slice(2).filter((a) => a.startsWith('--'));
  const filter = process.argv.slice(2).find((a) => !a.startsWith('--'));
  const pool = flags.includes('--ast') ? AST : MUTANTS;
  const list = pool.filter((m) => !filter || m.id.includes(filter));
  const ids = new Set();
  for (const m of MUTANTS) {
    if (ids.has(m.id)) throw new Error('duplicate mutant id ' + m.id);
    ids.add(m.id);
  }
  const bad = list.map((m) => [m, validate(m)]).filter(([, why]) => why);
  if (bad.length) {
    for (const [m, why] of bad) console.log('INVALID  ' + m.id + ': ' + why);
    process.exit(2);
  }
  // The suite must pass with no mutant, or every mutant would look caught.
  for (const id of ['baseline', 'baseline-ast']) {
    const base = await runOne({ id, file: 'Config.js', find: 'const SD = {', replace: 'const SD = {' });
    if (base.code !== 0) {
      console.log('The suite fails with no mutant (' + id + '): ' + base.failed.join('; '));
      process.exit(2);
    }
  }
  const results = [];
  let next = 0;
  async function worker() {
    while (next < list.length) {
      const m = list[next++];
      const r = await runOne(m);
      results.push(r);
      console.log((r.caught ? 'caught   ' : 'SURVIVED ') + m.id.padEnd(24) + ' ' + m.breaks + (r.caught ? '  [' + r.failed.slice(0, 2).join(' | ').slice(0, 110) + ']' : '  (' + r.how + ')'));
    }
  }
  await Promise.all(Array.from({ length: PARALLEL }, worker));
  const caught = results.filter((r) => r.caught).length;
  console.log('\nmutants: ' + results.length + ', caught: ' + caught + ', survived: ' + (results.length - caught));
  process.exit(caught === results.length ? 0 : 1);
}

main();
