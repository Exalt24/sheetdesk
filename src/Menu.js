/**
 * Custom menu, sidebar and dialog. Every function the HTML calls through
 * google.script.run is public (no trailing underscore) and checks its own
 * arguments, because a browser can call it with anything.
 */

/**
 * Simple trigger: builds the menu when the spreadsheet opens. A simple trigger
 * cannot use services that need authorisation, so it only builds the menu.
 * Google passes an event object that this function does not need.
 */
function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('sheetdesk')
    .addItem('Open desk', 'openDesk')
    .addItem('Close a month', 'openMonthCloseDialog')
    .addSeparator()
    .addItem('Rebuild summaries', 'menuRebuildSummaries')
    .addSubMenu(ui.createMenu('Data')
      .addItem('Pull ad costs', 'menuSyncAdCosts')
      .addItem('Pull currency rates', 'menuSyncRates'))
    .addSeparator()
    .addItem('Set up', 'menuSetUp')
    .addToUi();
}

/** Opens the sidebar. */
function openDesk() {
  const html = HtmlService.createHtmlOutputFromFile('Sidebar').setTitle('sheetdesk');
  SpreadsheetApp.getUi().showSidebar(html);
}

/**
 * The month before today in the spreadsheet time zone, as yyyy-MM. The data
 * is dated in that zone, which can differ from the script's zone.
 * @return {string}
 */
function previousMonth_() {
  const now = new Date();
  const tz = spreadsheet_().getSpreadsheetTimeZone();
  const y = Number(Utilities.formatDate(now, tz, 'yyyy'));
  const m = Number(Utilities.formatDate(now, tz, 'MM'));
  const py = m === 1 ? y - 1 : y;
  const pm = m === 1 ? 12 : m - 1;
  return py + '-' + String(pm).padStart(2, '0');
}

/**
 * Shows the month close dialog.
 * @param {string} month
 */
function showMonthCloseDialog_(month) {
  const t = HtmlService.createTemplateFromFile('Dialog');
  t.month = month;
  SpreadsheetApp.getUi().showModalDialog(t.evaluate().setWidth(340).setHeight(250), 'Close a month');
}

/** Menu item: month close dialog with last month filled in. */
function openMonthCloseDialog() {
  showMonthCloseDialog_(previousMonth_());
}

/** Menu item. */
function menuRebuildSummaries() {
  const r = buildClientSummaries();
  SpreadsheetApp.getActiveSpreadsheet().toast(summariesMessage_(r), 'Summaries');
}

/**
 * The toast text for Rebuild summaries: the counts, then every name clash
 * that left clients out, every Campaigns row that matches no client, every
 * Campaigns row that was left out of the totals, with the reason, and every
 * summary tab that was emptied because its client has no row left.
 * @param {{tabs: number, rows: number, skipped: (string[]|undefined), unmatched: ({rows: number, clients: string[]}|undefined),
 *   leftOut: ({text: string}|undefined), emptied: ({text: string}|undefined)}} r
 * @return {string}
 */
function summariesMessage_(r) {
  const more = [];
  if (r.skipped) more.push('Left out: ' + r.skipped.join(' '));
  if (r.unmatched) more.push(unmatchedText_(r.unmatched));
  if (r.leftOut) more.push(r.leftOut.text);
  if (r.emptied) more.push(r.emptied.text);
  return r.tabs + ' tabs, ' + r.rows + ' rows' + (more.length ? '. ' + more.join(' ') : '');
}

/**
 * The toast text for Pull ad costs: how many rows are new and changed, then, only when a record from
 * the ad platform did not become its own Campaigns row, how many and why.
 * @param {{inserted: number, updated: number, dropped: ({text: string}|undefined)}} r result of syncAdCosts
 * @return {string}
 */
function adSyncMessage_(r) {
  return r.inserted + ' new, ' + r.updated + ' changed' + (r.dropped ? '. ' + r.dropped.text : '');
}

/** Menu item: last 30 days of ad costs. */
function menuSyncAdCosts() {
  const r = syncAdCosts(daysAgoIso_(30), daysAgoIso_(0));
  SpreadsheetApp.getActiveSpreadsheet().toast(adSyncMessage_(r), 'Ad costs');
}

/**
 * Menu item: currency rates for every month the Campaigns rows in another
 * currency cover, from the first day of the earliest month to today (the last 30
 * days when there is no such row). A report needs the rate of each row's own day.
 */
function menuSyncRates() {
  const range = ratePullRange_();
  const r = syncRatesInPieces_(range.from, range.to);
  SpreadsheetApp.getActiveSpreadsheet().toast(r.inserted + ' new, ' + r.updated + ' changed', 'Rates');
}

/** Menu item: first run set up. */
function menuSetUp() {
  const r = setUp();
  SpreadsheetApp.getUi().alert('sheetdesk', r.secretCreated
    ? 'Sheets are ready. A webhook secret is saved in the script properties.'
    : 'Sheets are ready.', SpreadsheetApp.getUi().ButtonSet.OK);
}

/**
 * Today minus n days as yyyy-MM-dd in the spreadsheet time zone.
 * @param {number} n
 * @return {string}
 */
function daysAgoIso_(n) {
  return Utilities.formatDate(new Date(Date.now() - n * 86400000), spreadsheet_().getSpreadsheetTimeZone(), 'yyyy-MM-dd');
}

/**
 * The days to pull rates for: the first day of the earliest month with a
 * Campaigns row in a currency other than USD, up to today (or the latest such
 * day when that is later). Never more than 3 years back. With no such row, the
 * last 30 days.
 * @return {{from: string, to: string}} yyyy-MM-dd
 */
function ratePullRange_() {
  const ss = spreadsheet_();
  const today = daysAgoIso_(0);
  const sheet = ss.getSheetByName(SD.SHEETS.CAMPAIGNS);
  let first = '';
  let last = '';
  if (sheet && sheet.getLastRow() > 1) {
    const fmt = makeDateFormatter_(ss.getSpreadsheetTimeZone(), 'yyyy-MM-dd');
    sheet.getRange(2, 1, sheet.getLastRow() - 1, 7).getValues().forEach(function (r) {
      const ccy = String(r[6]).trim().toUpperCase();
      if (!isDate_(r[2]) || !ccy || ccy === 'USD') return;
      const iso = fmt(r[2]);
      if (first === '' || iso < first) first = iso;
      if (iso > last) last = iso;
    });
  }
  if (first === '') return { from: daysAgoIso_(30), to: today };
  const earliest = daysAgoIso_(SD.RATE_PULL_MAX_DAYS);
  const from = first.slice(0, 7) + '-01';
  return { from: from < earliest ? earliest : from, to: last > today ? last : today };
}

/**
 * Creates the data sheets with their headers and, if missing, a random
 * webhook secret, and pins the Sheet's time zone to the script's. Safe to run
 * again.
 *
 * The pin matters: on 2026-11-10 a Sheet made by clasp held the zone Etc/GMT
 * in the Sheets API while getSpreadsheetTimeZone() answered America/Los_Angeles,
 * so every date was formatted a day early. Setting the zone here makes the two
 * agree and keeps the month and day keys the code builds from date cells right.
 * @return {{sheets: string[], secretCreated: boolean, timeZone: string}}
 */
function setUp() {
  const ss = spreadsheet_();
  const zone = Session.getScriptTimeZone();
  if (ss.getSpreadsheetTimeZone() !== zone) ss.setSpreadsheetTimeZone(zone);
  const names = ['CAMPAIGNS', 'CLIENTS', 'LEADS', 'RATES'];
  names.forEach(function (k) { getOrCreateSheet_(ss, SD.SHEETS[k], SD.HEADERS[k]); });
  ensureClientExtras_(ss.getSheetByName(SD.SHEETS.CLIENTS));
  const props = PropertiesService.getScriptProperties();
  let secretCreated = false;
  if (!props.getProperty(SD.PROPS.WEBHOOK_SECRET)) {
    props.setProperty(SD.PROPS.WEBHOOK_SECRET, Utilities.getUuid() + Utilities.getUuid());
    secretCreated = true;
  }
  return { sheets: names.map(function (k) { return SD.SHEETS[k]; }), secretCreated: secretCreated, timeZone: zone };
}

/**
 * Called by the sidebar on load. Returns plain data only: google.script.run
 * cannot return a Date.
 * @return {{clients: string[], months: string[], defaultMonth: (string|undefined),
 *   unknownStatus: ({count: number, clients: string[], text: string}|undefined)}} defaultMonth is the newest
 *   month in the list that has ended, left out when every month in the list is still running. unknownStatus
 *   names the clients that are not in the list because their status is none of the known ones.
 */
function sidebarGetOptions() {
  const ss = spreadsheet_();
  const everyone = loadClients_(ss);
  const clients = everyone
    .filter(function (c) { return c.status === 'active'; })
    .map(function (c) { return c.client; })
    .sort();
  const sheet = ss.getSheetByName(SD.SHEETS.CAMPAIGNS);
  const months = {};
  if (sheet && sheet.getLastRow() > 1) {
    const fmt = makeDateFormatter_(ss.getSpreadsheetTimeZone(), 'yyyy-MM');
    sheet.getRange(2, 3, sheet.getLastRow() - 1, 1).getValues().forEach(function (r) {
      if (isDate_(r[0])) months[fmt(r[0])] = true;
    });
  }
  const list = Object.keys(months).sort().reverse();
  const out = { clients: clients, months: list };
  const odd = unknownStatusOf_(everyone);
  if (odd) out.unknownStatus = odd;
  // The newest month may still be running. The picker starts on the last month that has ended.
  const finished = previousMonth_();
  const start = list.filter(function (m) { return m <= finished; })[0];
  if (start) out.defaultMonth = start;
  return out;
}

/**
 * Sidebar button: report for one client and month.
 * @param {string} clientName
 * @param {string} month
 * @param {boolean} [sendToMe] the "Send to me first" box. Only an explicit false
 *   emails the client. Anything else, including a missing value, sends the PDF
 *   to the person running the script.
 * @param {boolean} [acknowledgeLeftOut] true after the sidebar showed that Campaigns rows are left out
 *   of the totals and the user pressed Send anyway. Only an explicit true counts.
 * @return {Object} result of runClientReport
 */
function sidebarRunReport(clientName, month, sendToMe, acknowledgeLeftOut) {
  // runClientReport checks the month and that the client exists before it touches Drive or mail.
  return runClientReport(clientName, month, { preview: sendToMe !== false, acknowledgeLeftOut: acknowledgeLeftOut === true });
}

/**
 * Sidebar button: opens the confirmation dialog for a month close.
 * @param {string} month
 * @return {{opened: boolean}}
 */
function sidebarRequestMonthClose(month) {
  assertMonth_(month);
  assertMonthEnded_(month);
  showMonthCloseDialog_(month);
  return { opened: true };
}

/**
 * Dialog button: runs the month close. The first press only checks: when Campaigns rows are left out of
 * the totals it returns `held` (the count and the reasons) and emails nobody, and the dialog asks again.
 * @param {string} month
 * @param {boolean} [acknowledgeLeftOut] true on the second press, after the dialog said what is left out.
 *   Only an explicit true counts.
 * @return {{month: string, done: number, errors: number, pending: number, emailed: number, emailFailed: number,
 *   clashes: (string[]|undefined), skipped: (string[]|undefined), unmatched: ({rows: number, clients: string[]}|undefined),
 *   leftOut: ({rows: number, reasons: Object, text: string}|undefined),
 *   noAddress: ({count: number, clients: string[], text: string}|undefined),
 *   unknownStatus: ({count: number, clients: string[], text: string}|undefined),
 *   held: ({rows: number, text: string}|undefined)}}
 */
function dialogConfirmMonthClose(month, acknowledgeLeftOut) {
  // runMonthClose checks the month first.
  const r = runMonthClose(month, { acknowledgeLeftOut: acknowledgeLeftOut === true });
  if (r.held) return { month: r.month, held: r.held };
  const out = {
    month: r.month,
    done: r.results.filter(function (x) { return x.status === 'ok' || x.status === 'no_data'; }).length,
    errors: r.results.filter(function (x) { return x.status === 'error'; }).length,
    pending: r.pending.length,
    emailed: r.results.filter(function (x) { return x.email === 'sent'; }).length,
    // A report that was built but whose email the mail service refused (for example on quota). The next close sends it.
    emailFailed: r.results.filter(function (x) { return /^failed/.test(String(x.email)); }).length
  };
  if (r.clashes) out.clashes = r.clashes;
  if (r.summaries.skipped) out.skipped = r.summaries.skipped;
  if (r.summaries.unmatched) out.unmatched = r.summaries.unmatched;
  if (r.summaries.leftOut) out.leftOut = r.summaries.leftOut;
  if (r.noAddress) out.noAddress = r.noAddress;
  if (r.unknownStatus) out.unknownStatus = r.unknownStatus;
  return out;
}
