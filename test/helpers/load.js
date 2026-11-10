'use strict';
/**
 * Loads the Apps Script sources from src/ into one vm context, next to the
 * fake Google services. Apps Script puts every file in one global scope, so
 * this does the same.
 *
 * A mutation run sets SHEETDESK_MUTANT to a JSON file {file, find, replace}.
 * The loader applies it to the source text and refuses to continue when the
 * text to change is not found exactly once. A mutant derived from the syntax
 * tree also carries {start, end}: the exact position of the node, where the
 * text must still be `find`.
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createWorld } = require('../fake/gas');
const { parseCsv } = require('../../scripts/seed');

const SRC = path.join(__dirname, '..', '..', 'src');
const FIXTURES = path.join(__dirname, '..', '..', 'fixtures');

function sourceFiles() {
  const js = fs.readdirSync(SRC).filter((f) => f.endsWith('.js')).sort();
  const first = ['Config.js', 'Util.js'];
  return [...first, ...js.filter((f) => !first.includes(f))];
}

function activeMutant() {
  const m = process.env.SHEETDESK_MUTANT;
  return m ? JSON.parse(fs.readFileSync(m, 'utf8')) : null;
}

function readSource(file) {
  let text = fs.readFileSync(path.join(SRC, file), 'utf8');
  const mutant = activeMutant();
  if (mutant && mutant.file === file && mutant.start !== undefined) {
    if (text.slice(mutant.start, mutant.end) !== mutant.find) throw new Error('MUTANT_NOT_APPLIED: ' + mutant.id + ' is not at its position');
    text = text.slice(0, mutant.start) + mutant.replace + text.slice(mutant.end);
  } else if (mutant && mutant.file === file) {
    const parts = text.split(mutant.find);
    if (parts.length !== 2) throw new Error('MUTANT_NOT_APPLIED: ' + mutant.id + ' found ' + (parts.length - 1) + ' times');
    text = parts.join(mutant.replace);
  }
  return text;
}

function loadProject(opts = {}) {
  const w = createWorld(Object.assign({}, opts.world));
  w.manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'appsscript.json'), 'utf8'));
  if (opts.noScopes) delete w.manifest.oauthScopes;
  if (opts.scopes) w.manifest.oauthScopes = opts.scopes;
  w.tz = w.manifest.timeZone;
  for (const f of fs.readdirSync(SRC).filter((x) => x.endsWith('.html'))) {
    w.htmlFiles[f.replace(/\.html$/, '')] = readSource(f);
  }
  const ss = w.newSpreadsheet('sheetdesk test');
  const sandbox = Object.assign({ __now: () => Math.floor(w.now) }, w.globals);
  const ctx = vm.createContext(sandbox);
  w.ctx = ctx;
  vm.runInContext(
    '(function () { const Native = Date; class FakeDate extends Native {' +
    ' constructor(...a) { if (a.length === 0) super(__now()); else super(...a); }' +
    ' static now() { return __now(); } } globalThis.Date = FakeDate; })();',
    ctx
  );
  for (const f of sourceFiles()) vm.runInContext(readSource(f), ctx, { filename: f });

  const p = {
    w, ctx, ss,
    call: (name, ...args) => w.call(name, ...args),
    get: (expr) => vm.runInContext(expr, ctx),
    /** Plain JSON copy, so values from the vm realm compare with assert.deepStrictEqual. */
    plain: (x) => JSON.parse(JSON.stringify(x === undefined ? null : x)),
    prop: (k) => w.props.script.get(k),
    setProp: (k, v) => w.props.script.set(k, v),
    sheet: (name) => ss._sheets.find((s) => s._name === name),
    /** Sheet content as plain rows (dates as ISO text). */
    rows: (name) => {
      const s = ss._sheets.find((x) => x._name === name);
      if (!s) return null;
      const out = [];
      const last = s._lastRow();
      for (let i = 0; i < last; i++) {
        const r = s._rows[i] || [];
        out.push(Array.from({ length: r.length }, (_, j) => {
          const v = r[j];
          if (v === undefined) return '';
          return Object.prototype.toString.call(v) === '[object Date]' ? v.toISOString() : v;
        }));
      }
      return out;
    }
  };
  p.fill = (name, headers, rows) => fillSheet(p, name, headers, rows);
  p.append = (name, rows) => appendRows(p, name, rows);
  p.fileText = (file) => file._content.toString('utf8');
  return p;
}

function fillSheet(p, name, headers, rows) {
  return p.w.run(() => {
    const ss = p.w.globals.SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(name) || ss.insertSheet(name);
    const all = [headers, ...rows];
    if (sheet.getMaxRows() < all.length) sheet.insertRowsAfter(sheet.getMaxRows(), all.length - sheet.getMaxRows());
    if (sheet.getMaxColumns() < headers.length) sheet.insertColumnsAfter(sheet.getMaxColumns(), headers.length - sheet.getMaxColumns());
    sheet.getRange(1, 1, all.length, headers.length).setValues(all);
    return sheet;
  });
}

/** Adds rows below the last row of a sheet, growing the grid first. */
function appendRows(p, name, rows) {
  return p.w.run(() => {
    const sheet = p.w.globals.SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
    const start = sheet.getLastRow() + 1;
    const need = start + rows.length - 1;
    if (sheet.getMaxRows() < need) sheet.insertRowsAfter(sheet.getMaxRows(), need - sheet.getMaxRows());
    sheet.getRange(start, 1, rows.length, rows[0].length).setValues(rows);
  });
}

const HEADERS = {
  campaigns: ['client', 'channel', 'date', 'spend', 'clicks', 'conversions', 'currency'],
  clients: ['client', 'contact_name', 'contact_email', 'ad_account_id', 'primary_channel', 'monthly_budget', 'status', 'intake_response_id', 'created_at'],
  leads: ['lead_id', 'received_at', 'client', 'name', 'email', 'phone', 'source', 'campaign', 'message'],
  rates: ['date', 'currency', 'per_usd']
};

/** The committed fixtures, with numbers as numbers like the Sheets import would give. */
function loadFixtures() {
  const csv = (f) => parseCsv(fs.readFileSync(path.join(FIXTURES, f), 'utf8')).slice(1);
  const num = (v) => (v === '' ? '' : Number(v));
  return {
    clients: csv('clients.csv').map((r) => [r[0], r[1], r[2], r[3], r[4], num(r[5]), r[6], r[7], r[8]]),
    campaigns: csv('campaigns.csv').map((r) => [r[0], r[1], r[2], num(r[3]), num(r[4]), num(r[5]), r[6]]),
    leads: csv('leads.csv'),
    rates: JSON.parse(fs.readFileSync(path.join(FIXTURES, 'rates.json'), 'utf8')),
    adDays: JSON.parse(fs.readFileSync(path.join(FIXTURES, 'ad_platform_days.json'), 'utf8'))
  };
}

/** A project with clients, campaigns and rates already in the sheets. */
function loadSeeded(opts = {}) {
  const p = loadProject(opts);
  const fx = loadFixtures();
  p.fx = fx;
  p.fill('Clients', HEADERS.clients, fx.clients);
  p.fill('Campaigns', HEADERS.campaigns, fx.campaigns);
  p.fill('Rates', HEADERS.rates, fx.rates.map((r) => [r.date, r.quote, r.rate]));
  return p;
}

module.exports = { loadProject, loadSeeded, loadFixtures, fillSheet, sourceFiles, readSource, HEADERS };
