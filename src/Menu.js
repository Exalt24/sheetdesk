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
  SpreadsheetApp.getUi().showModalDialog(t.evaluate().setWidth(340).setHeight(190), 'Close a month');
}

/** Menu item: month close dialog with last month filled in. */
function openMonthCloseDialog() {
  showMonthCloseDialog_(previousMonth_());
}

/** Menu item. */
function menuRebuildSummaries() {
  const r = buildClientSummaries();
  SpreadsheetApp.getActiveSpreadsheet().toast(r.tabs + ' tabs, ' + r.rows + ' rows', 'Summaries');
}

/** Menu item: last 30 days of ad costs. */
function menuSyncAdCosts() {
  const r = syncAdCosts(daysAgoIso_(30), daysAgoIso_(0));
  SpreadsheetApp.getActiveSpreadsheet().toast(r.inserted + ' new, ' + r.updated + ' changed', 'Ad costs');
}

/** Menu item: last 30 days of currency rates. */
function menuSyncRates() {
  const r = syncCurrencyRates(daysAgoIso_(30), daysAgoIso_(0));
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
 * @return {{clients: string[], months: string[]}}
 */
function sidebarGetOptions() {
  const ss = spreadsheet_();
  const clients = loadClients_(ss)
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
  return { clients: clients, months: Object.keys(months).sort().reverse() };
}

/**
 * Sidebar button: report for one client and month.
 * @param {string} clientName
 * @param {string} month
 * @param {boolean} [sendToMe] the "Send to me first" box. Only an explicit false
 *   emails the client. Anything else, including a missing value, sends the PDF
 *   to the person running the script.
 * @return {Object} result of runClientReport
 */
function sidebarRunReport(clientName, month, sendToMe) {
  // runClientReport checks the month and that the client exists before it touches Drive or mail.
  return runClientReport(clientName, month, { preview: sendToMe !== false });
}

/**
 * Sidebar button: opens the confirmation dialog for a month close.
 * @param {string} month
 * @return {{opened: boolean}}
 */
function sidebarRequestMonthClose(month) {
  assertMonth_(month);
  showMonthCloseDialog_(month);
  return { opened: true };
}

/**
 * Dialog button: runs the month close.
 * @param {string} month
 * @return {{month: string, done: number, errors: number, pending: number, emailed: number}}
 */
function dialogConfirmMonthClose(month) {
  // runMonthClose checks the month first.
  const r = runMonthClose(month);
  return {
    month: r.month,
    done: r.results.filter(function (x) { return x.status === 'ok' || x.status === 'no_data'; }).length,
    errors: r.results.filter(function (x) { return x.status === 'error'; }).length,
    pending: r.pending.length,
    emailed: r.results.filter(function (x) { return x.email === 'sent'; }).length
  };
}
