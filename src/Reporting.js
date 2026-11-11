/**
 * Reporting: per client monthly summary tabs, a Google Doc report built from
 * a template, a PDF in Drive with a stable name, and an email with the PDF.
 */

/**
 * Throws unless the value is a month key like 2026-10.
 * @param {*} month
 */
function assertMonth_(month) {
  if (!isMonth_(month)) throw new Error('Invalid month: ' + String(month).slice(0, 40) + '. Use the form 2026-10.');
}

/**
 * The current month as yyyy-MM in the Sheet time zone, the zone the data is dated in.
 * @return {string}
 */
function currentMonth_() {
  return Utilities.formatDate(new Date(), spreadsheet_().getSpreadsheetTimeZone(), 'yyyy-MM');
}

/**
 * Throws unless the month is over. Anything that emails a client for a month is
 * refused while the month is still running (or has not started), judged in the
 * Sheet time zone: a month ends when the first of the next month begins there.
 * @param {string} month a valid month key
 * @param {boolean} [forReport] true for a single report to a client, which gets its own wording
 *   (a month close, the default, says that it emails every client)
 */
function assertMonthEnded_(month, forReport) {
  if (month < currentMonth_()) return;
  const tz = spreadsheet_().getSpreadsheetTimeZone();
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  const next = (m === 12 ? y + 1 : y) + '-' + String(m === 12 ? 1 : m + 1).padStart(2, '0') + '-01';
  const today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  if (forReport) {
    throw new Error('The month ' + month + ' has not ended yet: it is ' + today + ' in the Sheet time zone (' + tz +
      '), and a report emailed to the client now would hold only part of the month. Tick Send to me first to preview it, or send it on or after ' + next + '.');
  }
  throw new Error('The month ' + month + ' has not ended yet: it is ' + today +
    ' in the Sheet time zone (' + tz + '), and a month close emails every client. Close it on or after ' + next + '.');
}

/**
 * Throws unless the name is an existing client. Returns the stored client.
 * @param {Client[]} clients
 * @param {*} name
 * @return {Client}
 */
function assertClient_(clients, name) {
  if (typeof name !== 'string' || !name.trim()) throw new Error('Pick a client.');
  const named = clients.filter(function (c) { return c.client === name; });
  // The same name on two rows (a returning client who filled the form again): the active row is the client.
  const hit = named.filter(function (c) { return c.status === 'active'; })[0] || named[0];
  if (!hit) throw new Error('Unknown client: ' + name.slice(0, 60));
  return hit;
}

/**
 * Groups parsed campaign rows into client, month, channel totals (cents).
 * @param {Object[]} rows from readCampaigns_
 * @return {Object}
 */
function aggregate_(rows) {
  const out = {};
  rows.forEach(function (r) {
    const byMonth = out[r.client] || (out[r.client] = {});
    const byChannel = byMonth[r.month] || (byMonth[r.month] = {});
    const t = byChannel[r.channel] || (byChannel[r.channel] = { cents: 0, clicks: 0, conversions: 0 });
    t.cents += toCents_(r.spendUsd);
    t.clicks += r.clicks;
    t.conversions = addCount_(t.conversions, r.conversions);
  });
  return out;
}

/** Why a Campaigns row is left out of the totals, by reason code, in the order a sentence lists them. */
const REJECT_WORDS_ = [
  ['no_rate', 'no currency rate for the day (sheetdesk, Data, Pull currency rates fetches them)'],
  ['no_currency', 'an empty currency cell on a client whose other rows are in another currency'],
  ['bad_date', 'no usable date'],
  ['no_client', 'no client name'],
  ['no_channel', 'no channel'],
  ['bad_spend', 'a spend that is below zero or not a number'],
  ['bad_clicks', 'clicks that are not a whole number'],
  ['bad_conversions', 'conversions that are below zero or not a number']
];

/**
 * Counts the Campaigns rows that were left out of the totals and says why, in
 * one sentence. A month whose rows were all left out has no figures, so this
 * is what keeps it from reading as "no data".
 * @param {Array<{row: number, reason: string}>} rejected from readCampaigns_
 * @return {({rows: number, reasons: Object, text: string}|undefined)} nothing when no row was left out
 */
function leftOutOf_(rejected) {
  if (!rejected.length) return;
  const reasons = {};
  rejected.forEach(function (r) { reasons[r.reason] = (reasons[r.reason] || 0) + 1; });
  const known = REJECT_WORDS_.map(function (w) { return w[0]; });
  const parts = [];
  REJECT_WORDS_.forEach(function (w) {
    if (reasons[w[0]]) parts.push(reasons[w[0]] + ' with ' + w[1]);
  });
  Object.keys(reasons).forEach(function (k) {
    if (known.indexOf(k) === -1) parts.push(reasons[k] + ' with the problem ' + k);
  });
  const n = rejected.length;
  return {
    rows: n,
    reasons: reasons,
    text: n + (n === 1 ? ' Campaigns row is' : ' Campaigns rows are') + ' left out of the totals: ' + parts.join(', ') + '.'
  };
}

/**
 * The active clients whose report could not be emailed because the address is
 * empty or not one address (a comma or semicolon list, no dot after the @).
 * @param {string[]} names
 * @return {({count: number, clients: string[], text: string}|undefined)} nothing when there are none
 */
function noAddressOf_(names) {
  if (!names.length) return;
  const n = names.length;
  const shown = names.slice(0, 10);
  return {
    count: n,
    clients: shown,
    text: n + (n === 1 ? ' client has' : ' clients have') + ' no usable email address, so ' + (n === 1 ? 'it was' : 'they were') +
      ' not emailed: ' + shown.join(', ') + (n > shown.length ? ' and ' + (n - shown.length) + ' more' : '') + '.'
  };
}

/** The statuses a Clients row can hold on purpose. Only `active` gets a report; the rest are left alone and need no mention. */
const KNOWN_STATUSES_ = ['active', 'inactive', 'paused', 'needs_review'];

/**
 * The clients whose status is none of the known ones (a blank cell, "yes", "actve"). A month close and
 * the report picker use only the `active` clients, so such a client gets no report and no email. This
 * names it with the status it has, so a typo does not read as a client that has nothing to report. A
 * name that also has an active row is reported through that row and is not named.
 * @param {Client[]} clients
 * @return {({count: number, clients: string[], text: string}|undefined)} nothing when every status is known
 */
function unknownStatusOf_(clients) {
  const active = clients.filter(function (c) { return c.status === 'active'; }).map(function (c) { return c.client; });
  const names = [];
  const shown = [];
  clients.forEach(function (c) {
    if (KNOWN_STATUSES_.indexOf(c.status) !== -1 || active.indexOf(c.client) !== -1 || names.indexOf(c.client) !== -1) return;
    names.push(c.client);
    shown.push(c.client + ' (' + (c.status === '' ? 'blank' : '"' + c.status + '"') + ')');
  });
  if (!names.length) return;
  const n = names.length;
  const list = shown.slice(0, 10);
  return {
    count: n,
    clients: names.slice(0, 10),
    text: n + (n === 1 ? ' client has a status that is' : ' clients have a status that is') + ' none of active, inactive, paused or needs_review, so ' +
      (n === 1 ? 'it gets' : 'they get') + ' no report and no email: ' + list.join(', ') + (n > list.length ? ' and ' + (n - list.length) + ' more' : '') + '.'
  };
}

/**
 * What a report emailed to a client now would leave out, said before any email goes: the Campaigns rows
 * that are left out of the totals (leftOutOf_) and the rows that name a client that is not in the Clients
 * tab (unmatchedRows_). Both are in no client's figures, so a report built over them is too low.
 * @param {{rows: Object[], rejected: Array<{row: number, reason: string}>}} parsed from readCampaigns_
 * @param {Client[]} clients
 * @return {({rows: number, text: string, leftOut: (Object|undefined), unmatched: (Object|undefined)}|undefined)}
 *   nothing when no row is left out
 */
function sendPreCheck_(parsed, clients) {
  const leftOut = leftOutOf_(parsed.rejected);
  const unmatched = unmatchedRows_(parsed.rows, clients);
  if (!leftOut && !unmatched) return;
  const parts = [];
  const held = { rows: 0 };
  if (leftOut) {
    held.rows += leftOut.rows;
    held.leftOut = leftOut;
    parts.push(leftOut.text);
  }
  if (unmatched) {
    held.rows += unmatched.rows;
    held.unmatched = unmatched;
    parts.push(unmatchedText_(unmatched));
  }
  held.text = parts.join(' ');
  return held;
}

/**
 * One output line for a total: cost per click, cost per conversion and
 * conversion rate. Blank when the divisor is zero.
 * @param {{cents: number, clicks: number, conversions: number}} t
 * @return {Array<*>} [spend, clicks, conversions, cpc, cpa, conv_rate]
 */
function metricsOf_(t) {
  return [
    t.cents / 100,
    t.clicks,
    t.conversions,
    t.clicks > 0 ? round2_(t.cents / 100 / t.clicks) : '',
    t.conversions > 0 ? round2_(t.cents / 100 / t.conversions) : '',
    t.clicks > 0 ? Math.round(t.conversions / t.clicks * 10000) / 10000 : ''
  ];
}

/**
 * Sum of channel totals.
 * @param {Object} byChannel
 * @return {{cents: number, clicks: number, conversions: number}}
 */
function sumChannels_(byChannel) {
  const all = { cents: 0, clicks: 0, conversions: 0 };
  Object.keys(byChannel).forEach(function (ch) {
    all.cents += byChannel[ch].cents;
    all.clicks += byChannel[ch].clicks;
    all.conversions = addCount_(all.conversions, byChannel[ch].conversions);
  });
  return all;
}

/**
 * The full summary table for one client: header, then each month by channel
 * and an ALL line per month.
 * @param {Object} byMonth month -> channel -> totals
 * @return {Array<Array<*>>}
 */
function summaryTable_(byMonth) {
  const table = [['month', 'channel', 'spend_usd', 'clicks', 'conversions', 'cpc', 'cpa', 'conv_rate']];
  Object.keys(byMonth).sort().forEach(function (month) {
    const byChannel = byMonth[month];
    // month is text on purpose: 2026-10 typed into a cell would become a date
    Object.keys(byChannel).sort().forEach(function (ch) {
      table.push([sheetText_(month), sheetText_(ch)].concat(metricsOf_(byChannel[ch])));
    });
    table.push([sheetText_(month), 'ALL'].concat(metricsOf_(sumChannels_(byChannel))));
  });
  return table;
}

/**
 * Rebuilds one summary tab per client from the Campaigns sheet. Reads the
 * sheet once, writes each tab with one setValues call. Safe to rerun.
 * Two names that would share a tab or a PDF name are both left out and named
 * in `skipped`; every other client is rebuilt. A Campaigns row whose client is
 * no client in the Clients tab is counted and named in `unmatched`. A row that
 * was left out of every total (no currency rate for its day, no usable date, a
 * spend that is not a number) is counted in `rejected` and, with the reasons and
 * one sentence, in `leftOut`. A summary tab whose client has no row left in the
 * totals is emptied to its header and named in `emptied`, so an old figure does
 * not stay behind. The keys skipped, unmatched, leftOut and emptied are present
 * only when there is something to say.
 * @return {{tabs: number, rows: number, rejected: number, skipped: (string[]|undefined),
 *   unmatched: ({rows: number, clients: string[]}|undefined),
 *   leftOut: ({rows: number, reasons: Object, text: string}|undefined),
 *   emptied: ({count: number, tabs: string[], text: string}|undefined)}}
 */
function buildClientSummaries() {
  const ss = spreadsheet_();
  return summariesFrom_(ss, readCampaigns_(ss));
}

/**
 * The work of buildClientSummaries on rows that are already read, so a month close reads the
 * Campaigns sheet once for the check before any email, the summaries and the reports.
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {{rows: Object[], rejected: Array<{row: number, reason: string}>}} parsed from readCampaigns_
 * @return {Object} as buildClientSummaries
 */
function summariesFrom_(ss, parsed) {
  const agg = aggregate_(parsed.rows);
  const clashes = nameClashes_(Object.keys(agg));
  const names = Object.keys(agg).sort().filter(function (n) { return clashes[n] === undefined; });
  let rowCount = 0;
  names.forEach(function (client) {
    const table = summaryTable_(agg[client]);
    const tab = summaryTabName_(client);
    const sheet = ss.getSheetByName(tab) || ss.insertSheet(tab);
    sheet.clearContents();
    ensureGrid_(sheet, table.length, table[0].length);
    sheet.getRange(1, 1, table.length, table[0].length).setValues(table);
    sheet.setFrozenRows(1);
    rowCount += table.length - 1;
  });
  const result = { tabs: names.length, rows: rowCount, rejected: parsed.rejected.length };
  const skipped = clashMessages_(clashes);
  if (skipped.length) result.skipped = skipped;
  const unmatched = unmatchedRows_(parsed.rows, ss.getSheetByName(SD.SHEETS.CLIENTS) ? loadClients_(ss) : undefined);
  if (unmatched) result.unmatched = unmatched;
  const leftOut = leftOutOf_(parsed.rejected);
  if (leftOut) result.leftOut = leftOut;
  const emptied = emptyStaleSummaries_(ss, names, clashes);
  if (emptied) result.emptied = emptied;
  return result;
}

/**
 * Empties the summary tabs that no client was written to this run: a client whose Campaigns rows were
 * all deleted, or are all left out of the totals, would otherwise keep last month's figures. A tab keeps
 * only its header row. A tab that holds nothing below its header is left as it is and not named, so a
 * rerun is quiet, and the tabs of the names that clash are left alone because the result already names them.
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {string[]} written client names whose tab was just written
 * @param {Object} clashes from nameClashes_
 * @return {({count: number, tabs: string[], text: string}|undefined)} nothing when no tab was stale
 */
function emptyStaleSummaries_(ss, written, clashes) {
  const keep = Object.create(null);
  written.concat(Object.keys(clashes)).forEach(function (n) { keep[summaryTabName_(n)] = true; });
  const header = summaryTable_({});
  const emptied = [];
  ss.getSheets().forEach(function (sheet) {
    const tab = sheet.getName();
    if (tab.indexOf(SD.SHEETS.SUMMARY_PREFIX) !== 0 || keep[tab] || sheet.getLastRow() < 2) return;
    sheet.clearContents();
    ensureGrid_(sheet, header.length, header[0].length);
    sheet.getRange(1, 1, header.length, header[0].length).setValues(header);
    sheet.setFrozenRows(1);
    emptied.push(tab);
  });
  if (!emptied.length) return;
  const n = emptied.length;
  const shown = emptied.slice(0, 10);
  return {
    count: n,
    tabs: shown,
    text: n + (n === 1 ? ' summary tab has' : ' summary tabs have') + ' no Campaigns rows left in the totals (the rows were deleted or are all left out), so ' +
      (n === 1 ? 'it was' : 'they were') + ' emptied: ' + shown.join(', ') + (n > shown.length ? ' and ' + (n - shown.length) + ' more' : '') + '.'
  };
}

/**
 * A file name that is the same for a client and month on every run.
 * @param {string} client
 * @param {string} month
 * @return {string}
 */
function reportPdfName_(client, month) {
  return reportSlug_(client) + '-' + month + '.pdf';
}

/**
 * The part of a report file name that comes from the client name.
 * @param {string} client
 * @return {string}
 */
function reportSlug_(client) {
  const slug = client.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'client';
}

/**
 * Finds the client names that would share a PDF file name or a summary tab
 * name with another name, because the second would silently overwrite the
 * first. Every name of a clash is listed, with the message that names the
 * names it clashes with. The same name twice is one name.
 * @param {string[]} names client names
 * @return {Object} name to message; a name that is clear of the others is not a key
 */
function nameClashes_(names) {
  const byPdf = Object.create(null);
  const byTab = Object.create(null);
  const add = function (map, key, n) {
    const list = map[key] || (map[key] = []);
    if (list.indexOf(n) === -1) list.push(n);
  };
  names.forEach(function (n) {
    add(byPdf, reportSlug_(n), n);
    add(byTab, summaryTabName_(n), n);
  });
  const out = Object.create(null);
  const mark = function (map, what) {
    Object.keys(map).forEach(function (key) {
      const group = map[key];
      if (group.length < 2) return;
      const quoted = group.map(function (n) { return '"' + n + '"'; });
      const list = quoted.slice(0, -1).join(', ') + ' and ' + quoted[quoted.length - 1];
      group.forEach(function (n) {
        if (out[n] === undefined) out[n] = 'Clients ' + list + ' would share one ' + what + '.';
      });
    });
  };
  mark(byPdf, 'report file name');
  mark(byTab, 'summary tab name');
  return out;
}

/**
 * The distinct messages of a nameClashes_ result, in the order of the names.
 * @param {Object} clashes from nameClashes_
 * @return {string[]}
 */
function clashMessages_(clashes) {
  const out = [];
  Object.keys(clashes).forEach(function (n) {
    if (out.indexOf(clashes[n]) === -1) out.push(clashes[n]);
  });
  return out;
}

/**
 * True when two client names would share a PDF file name or a summary tab
 * name. The intake form uses it so a name the reports would refuse is held
 * for review and not confirmed.
 * @param {string} a
 * @param {string} b
 * @return {boolean}
 */
function namesClash_(a, b) {
  return reportSlug_(a) === reportSlug_(b) || summaryTabName_(a) === summaryTabName_(b);
}

/**
 * Campaigns rows whose client is not the exact name of any client. They are
 * in no client's report, so they are counted and named instead of dropped.
 * @param {Object[]} rows parsed rows from readCampaigns_
 * @param {(Client[]|undefined)} clients nothing when there is no Clients tab to compare with
 * @return {({rows: number, clients: string[]}|undefined)} nothing when every row has a client
 */
function unmatchedRows_(rows, clients) {
  if (!clients) return;
  const known = clients.map(function (c) { return c.client; });
  const names = [];
  let count = 0;
  rows.forEach(function (r) {
    if (known.indexOf(r.client) !== -1) return;
    count++;
    if (names.indexOf(r.client) === -1) names.push(r.client);
  });
  if (count === 0) return;
  return { rows: count, clients: names.sort().slice(0, 10) };
}

/**
 * One sentence for a result of unmatchedRows_.
 * @param {{rows: number, clients: string[]}} u
 * @return {string}
 */
function unmatchedText_(u) {
  return u.rows + (u.rows === 1 ? ' Campaigns row names' : ' Campaigns rows name') + ' a client that is not in the Clients tab (' +
    u.clients.join(', ') + '), so ' + (u.rows === 1 ? 'it is' : 'they are') + ' in no report.';
}

/**
 * The Drive folder that holds the PDFs. Created on first use.
 * @return {GoogleAppsScript.Drive.Folder}
 */
function reportFolder_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty(SD.PROPS.REPORT_FOLDER_ID);
  if (id) return DriveApp.getFolderById(id);
  const folder = DriveApp.createFolder(SD.AGENCY_NAME + ' reports');
  props.setProperty(SD.PROPS.REPORT_FOLDER_ID, folder.getId());
  return folder;
}

/**
 * The report template Doc. Created on first use with every placeholder in it.
 * @return {GoogleAppsScript.Drive.File}
 */
function reportTemplateFile_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty(SD.PROPS.REPORT_TEMPLATE_ID);
  if (id) return DriveApp.getFileById(id);
  const doc = DocumentApp.create(SD.AGENCY_NAME + ' report template');
  const body = doc.getBody();
  body.appendParagraph('{{client}}, {{month}}');
  body.appendParagraph('Spend: {{spend}}');
  body.appendParagraph('Clicks: {{clicks}}');
  body.appendParagraph('Conversions: {{conversions}}');
  body.appendParagraph('Cost per click: {{cpc}}');
  body.appendParagraph('Cost per conversion: {{cpa}}');
  body.appendParagraph('{{table}}');
  body.appendParagraph('Made on {{generated}}');
  doc.saveAndClose();
  props.setProperty(SD.PROPS.REPORT_TEMPLATE_ID, doc.getId());
  return DriveApp.getFileById(doc.getId());
}

/**
 * Money text for the report. Uses the code, not a dollar sign, because the
 * replacement text of Document.replaceText gives $ a special meaning.
 * @param {number} cents
 * @return {string}
 */
function moneyText_(cents) {
  return 'USD ' + centsToText_(cents);
}

/**
 * Fills a template copy: placeholders first, then the table.
 * @param {GoogleAppsScript.Document.Document} doc
 * @param {Object} values placeholder name -> text
 * @param {string[][]} cells table cells
 */
function fillReportDoc_(doc, values, cells) {
  const body = doc.getBody();
  Object.keys(values).forEach(function (key) {
    const text = String(values[key]);
    if (text.indexOf('$') !== -1) {
      throw new Error('The value for ' + key + ' has a dollar sign, which replaceText would read as a group reference.');
    }
    body.replaceText('\\{\\{' + key + '\\}\\}', text.replace(/\{\{/g, '{ {'));
  });
  const hit = body.findText('\\{\\{table\\}\\}');
  if (!hit) throw new Error('The template has no table placeholder.');
  const index = body.getChildIndex(hit.getElement().getParent());
  body.insertTable(index, cells);
  body.replaceText('\\{\\{table\\}\\}', '');
}

/**
 * Trashes every non-trashed file in the folder with this name except `keepId`.
 * @param {GoogleAppsScript.Drive.Folder} folder
 * @param {string} name
 * @param {string} keepId
 * @return {number} how many were trashed
 */
function trashOthersNamed_(folder, name, keepId) {
  const old = folder.getFilesByName(name);
  let n = 0;
  while (old.hasNext()) {
    const f = old.next();
    if (f.getId() !== keepId) {
      f.setTrashed(true);
      n++;
    }
  }
  return n;
}

/**
 * Upserts the row in the Report Log for a client and month.
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {Array<*>} row
 */
function writeReportLog_(ss, row) {
  const sheet = getOrCreateSheet_(ss, SD.SHEETS.REPORT_LOG, SD.HEADERS.REPORT_LOG);
  const data = readRows_(sheet, SD.HEADERS.REPORT_LOG.length);
  // The month (2026-10) would be read as a date and the file id as a number if it looked like one. The
  // lookups below compare text, so the log keeps these four columns as text.
  const stored = row.slice();
  for (let i = 0; i < 4; i++) stored[i] = sheetText_(row[i]);
  for (let i = 0; i < data.length; i++) {
    if (String(data[i][0]) === row[0] && String(data[i][1]) === row[1]) {
      sheet.getRange(i + 2, 1, 1, row.length).setValues([stored]);
      return;
    }
  }
  sheet.appendRow(stored);
}

/**
 * The log row for a client and month, or null.
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {string} client
 * @param {string} month
 * @return {?Array<*>}
 */
function findReportLog_(ss, client, month) {
  const sheet = ss.getSheetByName(SD.SHEETS.REPORT_LOG);
  if (!sheet) return null;
  const data = readRows_(sheet, SD.HEADERS.REPORT_LOG.length);
  for (let i = 0; i < data.length; i++) {
    if (String(data[i][0]) === client && String(data[i][1]) === month) return data[i];
  }
  return null;
}

/**
 * Builds, exports and emails the report for one client and month.
 * A rerun replaces the PDF (same name) and emails again only when the figures
 * changed since the last email, or when options.force is true.
 * @param {string} clientName
 * @param {string} month yyyy-MM
 * @param {{force: (boolean|undefined), sendEmail: (boolean|undefined), preview: (boolean|undefined),
 *   acknowledgeLeftOut: (boolean|undefined)}} [options]
 *   preview true sends the PDF to the person running the script (or to the
 *   REPORT_CC property when Google gives no address) and never to the client.
 *   A preview does not count as the client's email: the next real run sends it.
 *   A report that would reach the client is refused for a month that has not ended, and is held
 *   (status "held", nothing built or sent, the sentence in `held`) while Campaigns rows are left
 *   out of the totals, until acknowledgeLeftOut is true.
 * @return {{status: string, client: string, month: string, pdfName: string, pdfId: string,
 *   replaced: number, email: string, spend: string, unmatched: (Object|undefined), leftOut: (Object|undefined),
 *   held: (Object|undefined)}}
 */
function runClientReport(clientName, month, options) {
  assertMonth_(month);
  const ss = spreadsheet_();
  const clients = loadClients_(ss);
  const client = assertClient_(clients, clientName);
  // Only the active clients and this one count: a parked row (needs_review) never stops an active client's report.
  const live = clients.filter(function (c) { return c.status === 'active' || c === client; });
  const clash = nameClashes_(live.map(function (c) { return c.client; }))[client.client];
  if (clash !== undefined) throw new Error(clash);
  const parsed = readCampaigns_(ss);
  const gate = { month: month, held: sendPreCheck_(parsed, clients) };
  const result = buildReport_(ss, client, month, aggregate_(parsed.rows), Object.assign({}, options, { gate: gate }));
  if (result.status === 'held') return result;
  const unmatched = unmatchedRows_(parsed.rows, clients);
  if (unmatched) result.unmatched = unmatched;
  const leftOut = leftOutOf_(parsed.rejected);
  if (leftOut) result.leftOut = leftOut;
  return result;
}

/**
 * Report for one client from rows that are already read and grouped.
 * options.skipIfCurrent returns status "current" without touching Drive when
 * the last report was built from the same figures and its PDF still exists.
 *
 * This is the only place a report is mailed to a client, so it is where the two guards sit. A report
 * that can reach the client (not a preview, not sendEmail false) is refused for a month that has not
 * ended, and returns status "held" with nothing built or sent while Campaigns rows are left out of the
 * totals, unless opts.acknowledgeLeftOut is true. opts.gate is the check of runClientReport or
 * runMonthClose, so a close checks the sheet once and not once per client; with no gate the check is
 * made here.
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {Client} client
 * @param {string} month
 * @param {Object} agg from aggregate_
 * @param {{force: (boolean|undefined), sendEmail: (boolean|undefined), skipIfCurrent: (boolean|undefined),
 *   preview: (boolean|undefined), acknowledgeLeftOut: (boolean|undefined),
 *   gate: ({month: string, held: (Object|undefined)}|undefined)}} opts
 * @return {Object}
 */
function buildReport_(ss, client, month, agg, opts) {
  const mailsClient = opts.sendEmail !== false && !opts.preview;
  if (mailsClient) assertMonthEnded_(month, true);
  const byChannel = (agg[client.client] || {})[month];
  if (!byChannel) {
    return { status: 'no_data', client: client.client, month: month, pdfName: '', pdfId: '', replaced: 0, email: 'not_sent', spend: '' };
  }
  const total = sumChannels_(byChannel);
  const figures = [total.cents, total.clicks, total.conversions].join('|');
  const prior = findReportLog_(ss, client.client, month);
  // A report that was only previewed, or whose email failed, is not finished: the client still has to get it.
  const clientMailed = prior && (prior[5] !== '' || !client.contact_email || !isEmail_(client.contact_email));
  if (opts.skipIfCurrent && prior && String(prior[4]) === figures && clientMailed && pdfStillExists_(String(prior[3]))) {
    return {
      status: 'current', client: client.client, month: month, pdfName: String(prior[2]),
      pdfId: String(prior[3]), replaced: 0, email: 'not_sent', spend: moneyText_(total.cents)
    };
  }
  if (mailsClient && opts.acknowledgeLeftOut !== true) {
    const gate = opts.gate && opts.gate.month === month ? opts.gate : { held: sendPreCheck_(readCampaigns_(ss), loadClients_(ss)) };
    if (gate.held) {
      return { status: 'held', client: client.client, month: month, pdfName: '', pdfId: '', replaced: 0, email: 'not_sent', spend: '', held: gate.held };
    }
  }
  const m = metricsOf_(total);
  const channels = Object.keys(byChannel).sort();
  const cells = [['Channel', 'Spend', 'Clicks', 'Conversions', 'Cost per click', 'Cost per conversion']];
  channels.concat(['ALL']).forEach(function (ch) {
    const t = ch === 'ALL' ? total : byChannel[ch];
    const x = metricsOf_(t);
    cells.push([ch, moneyText_(t.cents), String(x[1]), String(x[2]),
      x[3] === '' ? '-' : x[3].toFixed(2), x[4] === '' ? '-' : x[4].toFixed(2)]);
  });

  const folder = reportFolder_();
  const pdfName = reportPdfName_(client.client, month);
  const copy = reportTemplateFile_().makeCopy(client.client + ' ' + month + ' (working copy)', folder);
  let pdf;
  let replaced;
  try {
    const doc = DocumentApp.openById(copy.getId());
    fillReportDoc_(doc, {
      client: client.client,
      month: month,
      spend: moneyText_(total.cents),
      clicks: String(total.clicks),
      conversions: String(total.conversions),
      cpc: m[3] === '' ? '-' : m[3].toFixed(2),
      cpa: m[4] === '' ? '-' : m[4].toFixed(2),
      generated: Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), 'yyyy-MM-dd')
    }, cells);
    doc.saveAndClose();
    pdf = folder.createFile(copy.getAs(MimeType.PDF).setName(pdfName));
    replaced = trashOthersNamed_(folder, pdfName, pdf.getId());
  } finally {
    copy.setTrashed(true);
  }

  const alreadySent = prior && String(prior[4]) === figures && prior[5] !== '';
  const now = new Date();
  let email;
  // The emailed time belongs to the figures that were emailed. Changed figures start with none, so a preview or a failed send cannot mark them as sent.
  let emailedAt = prior && String(prior[4]) === figures ? prior[5] : '';
  const subject = client.client + ' marketing report, ' + month;
  const body = 'Hello ' + (client.contact_name || 'there') + ',\n\nThe ' + month + ' report is attached. ' +
    'Spend was ' + moneyText_(total.cents) + ', with ' + total.clicks + ' clicks and ' +
    total.conversions + ' conversions.\n\n' + SD.AGENCY_NAME;
  if (opts.sendEmail === false) {
    email = 'not_sent';
  } else if (opts.preview) {
    // A preview goes to the person running the script. It is not a send to the client, so emailed_at stays as it was.
    email = attemptMail_(function () {
      const to = previewAddress_();
      if (!to) return 'no_preview_address';
      sendReportMail_(to, '[Preview] ' + subject,
        'This copy came only to you. ' + client.client + ' has not been emailed.\n\n' + body, pdf, '');
      return 'preview_sent';
    });
  } else if (!client.contact_email || !isEmail_(client.contact_email)) {
    email = 'no_address';
  } else if (alreadySent && !opts.force) {
    email = 'already_sent';
  } else {
    email = attemptMail_(function () {
      sendReportMail_(client.contact_email, subject, body, pdf,
        PropertiesService.getScriptProperties().getProperty(SD.PROPS.REPORT_CC));
      return 'sent';
    });
    if (email === 'sent') emailedAt = now;
  }
  writeReportLog_(ss, [client.client, month, pdfName, pdf.getId(), figures, emailedAt, now]);
  SpreadsheetApp.flush();
  return {
    status: 'ok', client: client.client, month: month, pdfName: pdfName, pdfId: pdf.getId(),
    replaced: replaced, email: email, spend: moneyText_(total.cents)
  };
}

/**
 * Runs a mail step and returns its status word, or "failed: <reason>" when
 * the mail service refuses (for example when the daily quota is used).
 * @param {function(): string} step
 * @return {string}
 */
function attemptMail_(step) {
  try {
    return step();
  } catch (err) {
    return 'failed: ' + String(err && err.message ? err.message : err).slice(0, 120);
  }
}

/**
 * Sends the report PDF. MailApp needs only the send mail scope.
 * @param {string} to
 * @param {string} subject
 * @param {string} body
 * @param {GoogleAppsScript.Drive.File} pdf
 * @param {?string} cc one address, used when it is valid
 */
function sendReportMail_(to, subject, body, pdf, cc) {
  const mail = { attachments: [pdf.getBlob()], name: SD.AGENCY_NAME };
  if (cc && isEmail_(cc)) mail.cc = cc;
  MailApp.sendEmail(to, subject, body, mail);
}

/**
 * Where a preview goes: the address of the person running the script, else
 * the REPORT_CC script property, else nothing. Session.getActiveUser returns a
 * blank address for some accounts and contexts, which is why the property is
 * the fallback.
 * @return {string} an address, or '' when there is none
 */
function previewAddress_() {
  const mine = String(Session.getActiveUser().getEmail() || '');
  if (isEmail_(mine)) return mine;
  const cc = PropertiesService.getScriptProperties().getProperty(SD.PROPS.REPORT_CC);
  return cc && isEmail_(cc) ? cc : '';
}

/**
 * True when a Drive file exists and is not in the trash.
 * @param {string} id
 * @return {boolean}
 */
function pdfStillExists_(id) {
  if (!id) return false;
  try {
    return !DriveApp.getFileById(id).isTrashed();
  } catch (err) {
    return false;
  }
}

/**
 * Month close: rebuild summaries, then one report per active client. Stops
 * before the time budget runs out and lists the clients still waiting, so a
 * second call finishes the rest. Reports already done are replaced, not
 * duplicated, and not emailed again unless the figures changed.
 * A client whose name would share a PDF file name or a summary tab with another
 * is not reported: its result is an error that names both, the other clients
 * run, and the messages are also listed in `clashes` (present only when there
 * are any). Only active clients count for a clash: a parked row (needs_review)
 * never stops an active client.
 *
 * A month close emails every client, so it is refused for a month that has not
 * ended in the Sheet time zone. Before anything is built or emailed it checks the
 * Campaigns rows: when any is left out of the totals (no rate, no usable date, a
 * client name that is not in the Clients tab) it returns `held` with the sentence
 * and an empty `results`, and does nothing else, until it is called again with
 * options.acknowledgeLeftOut true. An active client whose address is empty or not
 * one address gets its report built but no email, and is named in `noAddress`. A client
 * whose status is none of the known ones is named in `unknownStatus`.
 * @param {string} month yyyy-MM
 * @param {{acknowledgeLeftOut: (boolean|undefined)}} [options]
 * @return {{month: string, results: Object[], pending: string[], summaries: Object, clashes: (string[]|undefined),
 *   noAddress: ({count: number, clients: string[], text: string}|undefined),
 *   unknownStatus: ({count: number, clients: string[], text: string}|undefined),
 *   held: ({rows: number, text: string}|undefined)}}
 */
function runMonthClose(month, options) {
  assertMonth_(month);
  assertMonthEnded_(month);
  const started = Date.now();
  const ss = spreadsheet_();
  const allClients = loadClients_(ss);
  const parsed = readCampaigns_(ss);
  const gate = { month: month, held: sendPreCheck_(parsed, allClients) };
  const acknowledged = !!options && options.acknowledgeLeftOut === true;
  if (gate.held && !acknowledged) return { month: month, held: gate.held, results: [], pending: [], summaries: {} };
  const clients = allClients.filter(function (c) { return c.status === 'active'; });
  const clashes = nameClashes_(clients.map(function (c) { return c.client; }));
  const summaries = summariesFrom_(ss, parsed);
  const agg = aggregate_(parsed.rows);
  const results = [];
  const pending = [];
  const noAddress = [];
  let slowest = 0;
  clients.forEach(function (c) {
    if (clashes[c.client] !== undefined) {
      results.push({ status: 'error', client: c.client, month: month, error: clashes[c.client] });
      return;
    }
    if (Date.now() - started + slowest * 1.5 > SD.BUDGET_MS) {
      pending.push(c.client);
      return;
    }
    const t0 = Date.now();
    try {
      const built = buildReport_(ss, c, month, agg, { skipIfCurrent: true, gate: gate, acknowledgeLeftOut: acknowledged });
      results.push(built);
      if ((built.status === 'ok' || built.status === 'current') && !isEmail_(c.contact_email)) noAddress.push(c.client);
    } catch (err) {
      results.push({ status: 'error', client: c.client, month: month, error: String(err && err.message ? err.message : err).slice(0, 200) });
    }
    slowest = Math.max(slowest, Date.now() - t0);
  });
  writeJobLog_(ss, ['month close', month, new Date(started), new Date(), results.length,
    pending.length ? 'pending: ' + pending.join('; ') : 'complete']);
  SpreadsheetApp.flush();
  const out = { month: month, results: results, pending: pending, summaries: summaries };
  const clashed = clashMessages_(clashes);
  if (clashed.length) out.clashes = clashed;
  const missing = noAddressOf_(noAddress);
  if (missing) out.noAddress = missing;
  const odd = unknownStatusOf_(allClients);
  if (odd) out.unknownStatus = odd;
  return out;
}
