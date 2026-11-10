'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadProject, loadSeeded } = require('./helpers/load');

const SRC = path.join(__dirname, '..', 'src');

/**
 * Names called through google.script.run in an HTML file. Walks each chain
 * .a(...).b(...).c(...) and skips balanced parentheses, so handlers with
 * semicolons inside do not end the chain early.
 */
function runCalls(html) {
  const names = new Set();
  let from = 0;
  for (;;) {
    const at = html.indexOf('google.script.run', from);
    if (at === -1) break;
    let i = at + 'google.script.run'.length;
    for (;;) {
      const m = /^\s*\.\s*(\w+)\s*\(/.exec(html.slice(i));
      if (!m) break;
      if (!['withSuccessHandler', 'withFailureHandler', 'withUserObject'].includes(m[1])) names.add(m[1]);
      i += m[0].length;
      let depth = 1;
      while (depth > 0 && i < html.length) {
        if (html[i] === '(') depth++;
        else if (html[i] === ')') depth--;
        i++;
      }
    }
    from = at + 1;
  }
  return [...names];
}

const htmlFiles = fs.readdirSync(SRC).filter((f) => f.endsWith('.html'));

test('onOpen builds the menu as a simple trigger, using no service that needs authorisation', () => {
  const p = loadSeeded();
  p.w.callSimple('onOpen', {});
  assert.equal(p.w.ui.menus.length, 1);
  const menu = p.w.ui.menus[0];
  assert.equal(menu.caption, 'sheetdesk');
  const fns = [];
  const walk = (items) => items.forEach((i) => { if (i.fn) fns.push(i.fn); if (i.sub) walk(i.sub); });
  walk(menu.items);
  assert.ok(fns.length >= 6, 'menu items: ' + fns.join(','));
  for (const fn of fns) {
    assert.equal(typeof p.ctx[fn], 'function', 'menu item runs a function that exists: ' + fn);
    assert.ok(!fn.endsWith('_'), 'private functions cannot run from a menu: ' + fn);
  }
  const sub = menu.items.find((i) => i.sub);
  assert.equal(sub.caption, 'Data');
});

test('a simple trigger that tried to open Drive would fail, so the fake does enforce the rule', () => {
  const p = loadSeeded();
  assert.throws(() => p.w.run(() => p.w.globals.DriveApp.getRootFolder(), { mode: 'simple' }), /You do not have permission to call DriveApp/);
});

test('every function the HTML calls exists, is public, and every HTML file was checked', () => {
  const p = loadProject();
  assert.ok(htmlFiles.length >= 3);
  assert.equal(Object.keys(p.w.htmlFiles).length, htmlFiles.length);
  const called = new Set();
  // the HTML as the loader sees it, so a mutated copy is read too
  for (const [f, html] of Object.entries(p.w.htmlFiles)) {
    for (const name of runCalls(html)) {
      called.add(name);
      assert.equal(typeof p.ctx[name], 'function', f + ' calls ' + name + ' which does not exist');
      assert.ok(!name.endsWith('_'), f + ' calls a private function: ' + name);
    }
  }
  assert.deepEqual([...called].sort(), ['dialogConfirmMonthClose', 'sidebarGetOptions', 'sidebarRequestMonthClose', 'sidebarRunReport']);
});

test('the sidebar and dialog write server data with textContent, not innerHTML', () => {
  for (const f of ['Sidebar.html', 'Dialog.html']) {
    const html = fs.readFileSync(path.join(SRC, f), 'utf8');
    assert.ok(!/innerHTML|document\.write|eval\(/.test(html), f);
  }
});

test('openDesk shows the sidebar', () => {
  const p = loadSeeded();
  p.call('openDesk');
  assert.equal(p.w.ui.sidebar.title, 'sheetdesk');
  assert.match(p.w.ui.sidebar.content, /Run report/);
  assert.match(p.w.ui.sidebar.content, /Close month/);
});

test('sidebarGetOptions returns plain data: active clients and months, newest first', () => {
  const p = loadSeeded();
  const raw = p.call('sidebarGetOptions');
  const plain = p.plain(raw);
  assert.deepEqual(plain, JSON.parse(JSON.stringify(raw)), 'survives JSON, so google.script.run can return it');
  assert.equal(plain.clients.length, 8);
  assert.ok(!plain.clients.includes('Granite Ridge Climbing'));
  assert.deepEqual(plain.months, ['2026-10', '2026-09', '2026-08']);
});

test('sidebarRunReport runs the report and returns data google.script.run can carry', () => {
  const p = loadSeeded();
  const raw = p.call('sidebarRunReport', 'Summit Yoga', '2026-10');
  assert.equal(raw.status, 'ok');
  assert.deepEqual(p.plain(raw), JSON.parse(JSON.stringify(raw)));
  for (const v of Object.values(raw)) assert.notEqual(Object.prototype.toString.call(v), '[object Date]');
});

test('sidebar functions refuse bad input and do nothing', () => {
  const p = loadSeeded();
  const bad = [undefined, null, 42, {}, [], '', '2026-1', '2026-13', '"><script>alert(1)</script>', '2026-10; DROP', ' 2026-10', '2026-10\n'];
  for (const v of bad) {
    assert.throws(() => p.call('sidebarRunReport', 'Summit Yoga', v), /Invalid month/, 'month ' + JSON.stringify(v));
    assert.throws(() => p.call('sidebarRequestMonthClose', v), /Invalid month/, 'close ' + JSON.stringify(v));
    assert.throws(() => p.call('dialogConfirmMonthClose', v), /Invalid month/, 'confirm ' + JSON.stringify(v));
  }
  for (const c of [undefined, null, 7, {}, ['Summit Yoga'], '', '  ', 'summit yoga', 'Summit Yoga ', 'Nobody']) {
    assert.throws(() => p.call('sidebarRunReport', c, '2026-10'), /Pick a client|Unknown client/, 'client ' + JSON.stringify(c));
  }
  assert.equal(p.w.ui.dialog, null, 'no dialog opened');
  assert.equal(p.w.allFiles().length, 0, 'nothing written to Drive');
  assert.equal(p.w.sent.length, 0, 'nothing emailed');
});

test('sidebarRequestMonthClose opens the dialog with that month', () => {
  const p = loadSeeded();
  assert.deepEqual(p.plain(p.call('sidebarRequestMonthClose', '2026-09')), { opened: true });
  assert.equal(p.w.ui.dialog.title, 'Close a month');
  assert.match(p.w.ui.dialog.content, /value="2026-09"/);
  assert.equal(p.w.ui.dialog.width, 340);
});

test('the menu item opens the dialog with last month, also across new year', () => {
  const p = loadSeeded();
  p.call('openMonthCloseDialog');
  assert.match(p.w.ui.dialog.content, /value="2026-10"/);
  p.w.now = Date.UTC(2027, 0, 15, 12);
  p.call('openMonthCloseDialog');
  assert.match(p.w.ui.dialog.content, /value="2026-12"/);
});

test('dialogConfirmMonthClose closes the month and returns counts', () => {
  const p = loadSeeded();
  const r = p.plain(p.call('dialogConfirmMonthClose', '2026-10'));
  assert.deepEqual(r, { month: '2026-10', done: 8, errors: 0, pending: 0, emailed: 8, emailFailed: 0 });
});

test('dialogConfirmMonthClose shows the reports that were built but not emailed when mail is refused', () => {
  const p = loadSeeded({ world: { mailQuota: 0 } });
  const r = p.plain(p.call('dialogConfirmMonthClose', '2026-10'));
  assert.equal(r.done, 8);
  assert.equal(r.emailed, 0);
  assert.equal(r.emailFailed, 8, 'every refused email is counted, not read as done');
});

test('setUp creates the data sheets and one secret, and keeps the secret on a rerun', () => {
  const p = loadProject();
  const first = p.plain(p.call('setUp'));
  assert.deepEqual(first.sheets, ['Campaigns', 'Clients', 'Leads', 'Rates']);
  assert.equal(first.secretCreated, true);
  const secret = p.prop('WEBHOOK_SECRET');
  assert.ok(secret.length >= 64);
  assert.deepEqual(p.rows('Campaigns')[0], ['client', 'channel', 'date', 'spend', 'clicks', 'conversions', 'currency']);
  const second = p.plain(p.call('setUp'));
  assert.equal(second.secretCreated, false);
  assert.equal(p.prop('WEBHOOK_SECRET'), secret);
});

test('setUp pins the Sheet time zone to the script time zone so date cells are read on the right day', () => {
  const p = loadProject();
  p.ss.setSpreadsheetTimeZone('Etc/GMT');
  const r = p.plain(p.call('setUp'));
  assert.equal(r.timeZone, 'America/Chicago');
  assert.equal(p.ss._tz, 'America/Chicago');
});

test('menuSetUp tells the user a secret exists without printing it', () => {
  const p = loadProject();
  p.call('menuSetUp');
  const shown = JSON.stringify(p.w.ui.alerts);
  assert.ok(!shown.includes(p.prop('WEBHOOK_SECRET')));
  assert.match(shown, /secret is saved/);
});

test('getOrCreateSheet_ fails loudly when a header was renamed', () => {
  const p = loadProject();
  p.fill('Campaigns', ['client', 'chan', 'date', 'spend', 'clicks', 'conversions', 'currency'], []);
  assert.throws(() => p.call('setUp'), /unexpected headers/);
});
