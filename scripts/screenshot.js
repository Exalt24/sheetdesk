'use strict';
/* global document -- the waitForFunction callback runs inside the browser page */
/**
 * Renders the real sidebar and dashboard HTML in Chromium, with the data the
 * real server functions return against the local fake, and saves one picture
 * to docs/preview.png. It is not Google's iframe: a small stand-in for
 * google.script.run hands the page the values the fake produced.
 *
 * Needs Playwright, which is not a dependency of this repo:
 *   npm install --no-save playwright && npx playwright install chromium
 *   node scripts/screenshot.js
 */

const fs = require('node:fs');
const path = require('node:path');
const { loadSeeded } = require('../test/helpers/load');
const { installAdPlatform } = require('../test/fake/services');

async function main() {
  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch (e) {
    console.error('Playwright is not installed. See the comment at the top of this file.');
    process.exit(1);
  }

  const p = loadSeeded();
  installAdPlatform(p.w, { days: p.fx.adDays, apiKey: 'k' });
  p.setProp('WEBHOOK_SECRET', 'preview-secret');
  p.fill('Leads', ['lead_id', 'received_at', 'client', 'name', 'email', 'phone', 'source', 'campaign', 'message'], []);
  // Leads arrive through the real webhook, so the dashboard counts are real too.
  p.fx.leads.slice(0, 120).forEach((l, i) => {
    const body = JSON.stringify({ secret: 'preview-secret', lead_id: l[0], client: l[2], name: l[3], email: l[4], phone: l[5], source: l[6], campaign: l[7], message: l[8] });
    p.w.now += 3600000 * (i % 5);
    p.call('doPost', { postData: { contents: body, type: 'application/json' }, parameter: {} });
  });
  const options = p.plain(p.call('sidebarGetOptions'));
  const result = p.plain(p.call('sidebarRunReport', 'Harbor Lane Bakery', '2026-10'));
  const dashboard = p.call('doGet', { parameter: { view: 'dashboard', secret: 'preview-secret' } }).getContent();
  const sidebar = p.w.htmlFiles.Sidebar;

  const stub = '<script>window.google = { script: { host: { close: function () {} }, run: (function () {' +
    'var ok, fail; var api = {' +
    'withSuccessHandler: function (f) { ok = f; return api; }, withFailureHandler: function (f) { fail = f; return api; },' +
    'sidebarGetOptions: function () { var f = ok; setTimeout(function () { f(' + JSON.stringify(options) + '); }, 0); },' +
    'sidebarRunReport: function () { var f = ok; setTimeout(function () { f(' + JSON.stringify(result) + '); }, 0); },' +
    'sidebarRequestMonthClose: function () { var f = ok; setTimeout(function () { f({ opened: true }); }, 0); }' +
    '}; return api; })() } };</script>';

  const outDir = path.join(__dirname, '..', 'docs');
  const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'sheetdesk-shot-'));
  fs.writeFileSync(path.join(tmp, 'sidebar.html'), sidebar.replace('<head>', '<head>' + stub));
  fs.writeFileSync(path.join(tmp, 'dashboard.html'), dashboard);
  fs.writeFileSync(path.join(tmp, 'page.html'),
    '<!DOCTYPE html><html><head><style>body{margin:0;background:#f1f3f4;font-family:Arial,sans-serif}' +
    '.row{display:flex;gap:16px;padding:16px}.card{background:#fff;border:1px solid #dadce0}' +
    'h2{font-size:12px;margin:0;padding:6px 10px;background:#e8eaed;color:#3c4043;font-weight:normal}' +
    'iframe{border:0;display:block}</style></head><body><div class="row">' +
    '<div class="card"><h2>Sidebar</h2><iframe src="sidebar.html" width="300" height="440"></iframe></div>' +
    '<div class="card"><h2>Web app: doGet with view=dashboard</h2><iframe src="dashboard.html" width="640" height="440"></iframe></div>' +
    '</div></body></html>');

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1000, height: 520 } });
  await page.goto('file:///' + path.join(tmp, 'page.html').replace(/\\/g, '/'));
  const frame = page.frames().find((f) => f.url().endsWith('sidebar.html'));
  await frame.waitForSelector('#client option', { state: 'attached' });
  await frame.selectOption('#client', 'Harbor Lane Bakery');
  await frame.selectOption('#month', '2026-10');
  await frame.click('#run-report');
  await frame.waitForFunction(() => document.getElementById('status').textContent.length > 0);
  fs.mkdirSync(outDir, { recursive: true });
  await page.screenshot({ path: path.join(outDir, 'preview.png') });
  console.log('status shown: ' + await frame.textContent('#status'));
  await browser.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

main();
