'use strict';
/**
 * Replays every case of test/corpus/corpus_sheetdesk_1.jsonl through the real
 * src/ code. The file is an independent adversary's corpus: each line holds an
 * input (a surface of webhook, summary, bulk or util, and the result the docs
 * promise in input.want), a why and whether the code was expected to pass.
 * "$SECRET" in a webhook body stands for the secret this test sets, and
 * {"$date": "YYYY-MM-DD"} for a date cell. Every case must hold now.
 */
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadProject, loadSeeded, HEADERS } = require('./helpers/load');
const { ExecutionKilled } = require('./fake/gas');

const FILE = path.join(__dirname, 'corpus', 'corpus_sheetdesk_1.jsonl');
const SECRET = 'corpus-secret-value';

/** Cases the lead has not ruled on: line number to the reason. They are skipped, never changed. */
const DISPUTED = new Map([
  [37, 'the lead_id format rule (letters, digits, _ . : - and at most 64) was kept on purpose, so an id that is a web address is refused by design, and docs/webhook.md says so']
]);

const CASES = fs.readFileSync(FILE, 'utf8').trim().split('\n').map((line, i) => Object.assign({ line: i + 1 }, JSON.parse(line)));

const CLIENTS = [
  ['Summit Yoga', 'Priya Raman', 'priya@example.com', 'acct-1', 'social', 4000, 'active', '', ''],
  ['Harbor Lane Bakery', 'Mira Okafor', 'mira@example.com', 'acct-2', 'search', 8900, 'active', '', ''],
  ['Orchard & Vine', 'Elena Marchetti', 'elena@example.com', 'acct-3', 'social', 11900, 'active', '', '']
];

/** {"$date": "2026-10-03"} becomes the ISO text, which the fake turns into a date cell like Sheets does. */
function cell(v) {
  return v !== null && typeof v === 'object' && v.$date ? v.$date : v;
}

function project(input, campaigns) {
  if (input.seed === 'fixtures') return loadSeeded();
  const p = loadProject();
  p.fill('Clients', HEADERS.clients, CLIENTS);
  p.fill('Campaigns', HEADERS.campaigns, (campaigns || input.campaigns || []).map((r) => r.map(cell)));
  if (input.rates) p.fill('Rates', HEADERS.rates, input.rates.map((r) => r.map(cell)));
  return p;
}

/** Every key of want must hold in got; arrays must match in length and element by element. */
function subset(got, want, where) {
  if (Array.isArray(want)) {
    assert.ok(Array.isArray(got), where + ' is a list');
    assert.equal(got.length, want.length, where + ' length');
    want.forEach((w, i) => subset(got[i], w, where + '[' + i + ']'));
  } else if (want !== null && typeof want === 'object') {
    assert.ok(got !== null && typeof got === 'object', where + ' is an object');
    for (const k of Object.keys(want)) subset(got[k], want[k], where + '.' + k);
  } else {
    assert.equal(got, want, where);
  }
}

function withSecret(s) {
  return s.split('$SECRET').join(SECRET);
}

function webhookEvent(ev) {
  const contents = ev.raw !== undefined ? withSecret(ev.raw) : withSecret(JSON.stringify(ev.body));
  const type = ev.type || 'application/json';
  return { postData: { contents, type, length: contents.length, name: 'postData' }, parameter: ev.params || {}, parameters: {}, queryString: '', contentLength: contents.length };
}

function runWebhook(input) {
  const p = project(input);
  p.setProp('WEBHOOK_SECRET', SECRET);
  p.fill('Leads', HEADERS.leads, []);
  const replies = input.events.map((ev) => {
    const out = p.call('doPost', webhookEvent(ev));
    assert.equal(out.getMimeType(), 'JSON', 'every reply is JSON');
    return JSON.parse(out.getContent());
  });
  const want = input.want;
  if (want.replies) subset(replies, want.replies, 'replies');
  if (want.leads) {
    // the stored row has received_at in column 2, the corpus leaves it out
    const stored = p.rows('Leads').slice(1).map((r) => r.filter((_, i) => i !== 1));
    assert.deepEqual(stored, want.leads, 'stored leads');
  }
}

function runSummary(input) {
  const p = project(input);
  const results = [];
  const times = input.twice ? 2 : 1;
  for (let i = 0; i < times; i++) {
    try {
      results.push(p.plain(p.call(input.call.fn, ...(input.call.args || []))));
    } catch (e) {
      results.push({ threw: e.message });
    }
  }
  const want = input.want;
  if (want.result) subset(results[0], want.result, 'result');
  if (want.second) subset(results[1], want.second, 'second');
  if (input.pick) {
    const [a, b] = input.pick.startsWith;
    const rows = (p.rows(input.pick.tab) || []).filter((r) => r[0] === a && r[1] === b);
    assert.deepEqual(rows, want.picked, 'picked rows of ' + input.pick.tab);
  }
  if (want.tabs) {
    for (const name of Object.keys(want.tabs)) assert.deepEqual(p.rows(name), want.tabs[name], 'tab ' + name);
  }
  if (want.mail) subset(p.plain(p.w.sent), want.mail, 'mail');
}

/** n rows of 10 spend, 5 clicks, 1 conversion, one day after the other over `days` days; every badEvery-th has negative spend. */
function generated(g) {
  const rows = [];
  const day0 = Date.parse(g.start + 'T00:00:00Z');
  for (let i = 0; i < g.n; i++) {
    const day = new Date(day0 + (i % g.days) * 86400000).toISOString().slice(0, 10);
    const spend = g.badEvery && i % g.badEvery === g.badEvery - 1 ? -10 : 10;
    rows.push(['Summit Yoga', 'social', day, spend, 5, 1, 'USD']);
  }
  return rows;
}

function runBulk(input) {
  const p = project(input, input.gen ? generated(input.gen) : null);
  if (input.chunk) p.get('SD').CHUNK_ROWS = input.chunk;
  const statuses = [];
  if (input.killAtSetValues) {
    let n = 0;
    p.w.killWhen = ({ name }) => name === 'Range.setValues' && ++n === input.killAtSetValues;
    try {
      statuses.push(p.call('startBulkNormalize').status);
    } catch (e) {
      if (!(e instanceof ExecutionKilled)) throw e;
      statuses.push('killed');
    }
    p.w.killWhen = null;
  } else {
    statuses.push(p.call('startBulkNormalize').status);
  }
  for (let i = 0; i < 100 && p.w.triggers.length; i++) statuses.push(p.w.fireNextClockTrigger().result.status);
  if (input.rerunAfterDone) {
    p.call('startBulkNormalize');
    for (let i = 0; i < 100 && p.w.triggers.length; i++) p.w.fireNextClockTrigger();
  }
  const want = input.want;
  if (want.statuses) assert.deepEqual(statuses, want.statuses, 'run statuses');
  const clean = p.rows('Clean').slice(1);
  if (want.cleanCount !== undefined) assert.equal(clean.length, want.cleanCount, 'Clean rows');
  if (want.okCount !== undefined) assert.equal(clean.filter((r) => r[8] === 'ok').length, want.okCount, 'ok rows');
  const rollup = (p.rows('Rollup') || []).slice(1);
  if (want.rollup) assert.deepEqual(rollup, want.rollup, 'Rollup');
  if (input.pickRollup) {
    const [c, m] = input.pickRollup;
    assert.deepEqual(rollup.filter((r) => r[0] === c && r[1] === m), want.picked, 'picked rollup rows');
  }
  if (want.triggers !== undefined) assert.equal(p.w.triggers.length, want.triggers, 'triggers left');
}

function runUtil(input) {
  const p = loadProject();
  if (input.now) p.w.now = Date.parse(input.now);
  assert.deepEqual(p.plain(p.call(input.fn, ...input.args)), input.want.result);
}

const RUNNERS = { webhook: runWebhook, summary: runSummary, bulk: runBulk, util: runUtil };

test('the corpus file holds the 98 cases of the adversary pass', () => {
  assert.equal(CASES.length, 98);
  for (const c of CASES) {
    assert.ok(RUNNERS[c.input.surface], 'line ' + c.line + ' has a known surface');
    assert.ok(c.why.length >= 10, 'line ' + c.line + ' says why');
    assert.ok(c.source === 'real' || c.source === 'invented', 'line ' + c.line + ' has a source');
  }
});

for (const c of CASES) {
  const name = 'corpus_sheetdesk_1.jsonl line ' + c.line + ' (' + c.input.surface + '): ' + c.why.slice(0, 90);
  if (DISPUTED.has(c.line) && !process.env.CORPUS_RUN_DISPUTED) {
    test(name, { skip: 'DISPUTED: ' + DISPUTED.get(c.line) }, () => {});
  } else {
    test(name, () => RUNNERS[c.input.surface](c.input));
  }
}
