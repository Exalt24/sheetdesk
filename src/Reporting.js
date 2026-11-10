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
 * Throws unless the name is an existing client. Returns the stored client.
 * @param {Client[]} clients
 * @param {*} name
 * @return {Client}
 */
function assertClient_(clients, name) {
  if (typeof name !== 'string' || !name.trim()) throw new Error('Pick a client.');
  const hit = clients.filter(function (c) { return c.client === name; })[0];
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
    t.conversions += r.conversions;
  });
  return out;
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
    all.conversions += byChannel[ch].conversions;
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
 * @return {{tabs: number, rows: number, rejected: number}}
 */
function buildClientSummaries() {
  const ss = spreadsheet_();
  const parsed = readCampaigns_(ss);
  const agg = aggregate_(parsed.rows);
  const names = Object.keys(agg).sort();
  assertDistinctNames_(names);
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
  return { tabs: names.length, rows: rowCount, rejected: parsed.rejected.length };
}

/**
 * A file name that is the same for a client and month on every run.
 * @param {string} client
 * @param {string} month
 * @return {string}
 */
function reportPdfName_(client, month) {
  const slug = client.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return (slug || 'client') + '-' + month + '.pdf';
}

/**
 * Throws when two client names would share a PDF file name or a summary tab
 * name, because the second would silently overwrite the first.
 * @param {string[]} names client names
 */
function assertDistinctNames_(names) {
  const pdf = {};
  const tab = {};
  names.forEach(function (n) {
    const p = reportPdfName_(n, '2000-01');
    const t = summaryTabName_(n);
    if (pdf[p] !== undefined && pdf[p] !== n) {
      throw new Error('Clients "' + pdf[p] + '" and "' + n + '" would share one report file name.');
    }
    if (tab[t] !== undefined && tab[t] !== n) {
      throw new Error('Clients "' + tab[t] + '" and "' + n + '" would share one summary tab name.');
    }
    pdf[p] = n;
    tab[t] = n;
  });
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
 * @param {{force: (boolean|undefined), sendEmail: (boolean|undefined), preview: (boolean|undefined)}} [options]
 *   preview true sends the PDF to the person running the script (or to the
 *   REPORT_CC property when Google gives no address) and never to the client.
 *   A preview does not count as the client's email: the next real run sends it.
 * @return {{status: string, client: string, month: string, pdfName: string, pdfId: string,
 *   replaced: number, email: string, spend: string}}
 */
function runClientReport(clientName, month, options) {
  assertMonth_(month);
  const ss = spreadsheet_();
  const clients = loadClients_(ss);
  const client = assertClient_(clients, clientName);
  assertDistinctNames_(clients.map(function (c) { return c.client; }));
  const agg = aggregate_(readCampaigns_(ss).rows);
  return buildReport_(ss, client, month, agg, options || {});
}

/**
 * Report for one client from rows that are already read and grouped.
 * options.skipIfCurrent returns status "current" without touching Drive when
 * the last report was built from the same figures and its PDF still exists.
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} ss
 * @param {Client} client
 * @param {string} month
 * @param {Object} agg from aggregate_
 * @param {{force: (boolean|undefined), sendEmail: (boolean|undefined), skipIfCurrent: (boolean|undefined),
 *   preview: (boolean|undefined)}} opts
 * @return {Object}
 */
function buildReport_(ss, client, month, agg, opts) {
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
  let emailedAt = prior ? prior[5] : '';
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
 * @param {string} month yyyy-MM
 * @return {{month: string, results: Object[], pending: string[], summaries: Object}}
 */
function runMonthClose(month) {
  assertMonth_(month);
  const started = Date.now();
  const ss = spreadsheet_();
  const allClients = loadClients_(ss);
  const clients = allClients.filter(function (c) { return c.status === 'active'; });
  assertDistinctNames_(allClients.map(function (c) { return c.client; }));
  const summaries = buildClientSummaries();
  const agg = aggregate_(readCampaigns_(ss).rows);
  const results = [];
  const pending = [];
  let slowest = 0;
  clients.forEach(function (c) {
    if (Date.now() - started + slowest * 1.5 > SD.BUDGET_MS) {
      pending.push(c.client);
      return;
    }
    const t0 = Date.now();
    try {
      results.push(buildReport_(ss, c, month, agg, { skipIfCurrent: true }));
    } catch (err) {
      results.push({ status: 'error', client: c.client, month: month, error: String(err && err.message ? err.message : err).slice(0, 200) });
    }
    slowest = Math.max(slowest, Date.now() - t0);
  });
  writeJobLog_(ss, ['month close', month, new Date(started), new Date(), results.length,
    pending.length ? 'pending: ' + pending.join('; ') : 'complete']);
  SpreadsheetApp.flush();
  return { month: month, results: results, pending: pending, summaries: summaries };
}
