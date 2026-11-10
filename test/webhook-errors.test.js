'use strict';
/**
 * The web app promises JSON with "ok" in every reply. These tests make each
 * step that can throw do so, and check the caller still gets JSON, the cause
 * goes to the log only, and the lock is released.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadSeeded, HEADERS } = require('./helpers/load');

const SECRET = 'unit-test-secret-value';

function setup() {
  const p = loadSeeded();
  p.setProp('WEBHOOK_SECRET', SECRET);
  p.fill('Leads', HEADERS.leads, []);
  return p;
}

const body = (over = {}) => ({
  postData: {
    contents: JSON.stringify(Object.assign({ secret: SECRET, lead_id: 'e-1', client: 'Summit Yoga', email: 'a@example.com' }, over)),
    type: 'application/json'
  },
  parameter: {}
});

const boom = (message) => Object.assign(new Error(message), { name: 'Exception' });

function post(p, over) {
  const out = p.call('doPost', body(over));
  assert.equal(out.getMimeType(), 'JSON', 'the reply is JSON');
  return JSON.parse(out.getContent());
}

/** Makes one service call throw, and counts lock releases. */
function failing(p, serviceName, message) {
  const seen = { releases: 0, tries: 0 };
  p.w.hook = ({ name }) => {
    if (name === 'Lock.releaseLock') seen.releases++;
    if (name === 'Lock.tryLock') seen.tries++;
    if (name === serviceName) throw boom(message);
  };
  return seen;
}

const SERVER_ERROR = { ok: false, error: 'server_error' };

test('doPost: a renamed Leads header gives server_error JSON, the cause goes to the log, the lock is released', () => {
  const p = setup();
  p.fill('Leads', ['id', 'received', 'client', 'name', 'email', 'phone', 'source', 'campaign', 'message'], []);
  const seen = failing(p, 'never', '');
  assert.deepEqual(post(p, {}), SERVER_ERROR);
  assert.match(p.w.logs.join('\n'), /doPost failed: Sheet "Leads" has unexpected headers/);
  assert.equal(seen.tries, 1);
  assert.equal(seen.releases, 1, 'the lock was released');
});

test('doPost: a Clients sheet with a renamed header gives server_error JSON', () => {
  const p = setup();
  p.fill('Clients', ['name', ...HEADERS.clients.slice(1)], p.fx.clients);
  assert.deepEqual(post(p, {}), SERVER_ERROR);
  assert.match(p.w.logs.join('\n'), /Sheet "Clients" has unexpected headers/);
});

test('doPost: a cache that refuses the write gives server_error JSON', () => {
  const p = setup();
  failing(p, 'Cache.put', 'Argument too large: value');
  assert.deepEqual(post(p, {}), SERVER_ERROR);
  assert.match(p.w.logs.join('\n'), /doPost failed: Argument too large: value/);
  assert.equal(p.rows('Leads').length, 1, 'nothing was stored');
});

test('doPost: a cache that cannot be read gives server_error JSON', () => {
  const p = setup();
  failing(p, 'Cache.get', 'Service unavailable: Cache');
  assert.deepEqual(post(p, {}), SERVER_ERROR);
});

test('doPost: a failing append gives server_error JSON and still releases the lock', () => {
  const p = setup();
  const seen = failing(p, 'Sheet.appendRow', 'Service Spreadsheets failed while accessing document');
  assert.deepEqual(post(p, {}), SERVER_ERROR);
  assert.equal(seen.releases, 1);
  assert.equal(p.rows('Leads').length, 1);
});

test('doPost: a failing flush at the end of a good write gives server_error, and the retry is a duplicate', () => {
  const p = setup();
  const seen = failing(p, 'SpreadsheetApp.flush', 'Service Spreadsheets failed');
  assert.deepEqual(post(p, {}), SERVER_ERROR);
  assert.equal(seen.releases, 1, 'the lock is released even when the flush fails');
  p.w.hook = null;
  assert.equal(p.rows('Leads').length, 2, 'the lead was stored');
  assert.deepEqual(post(p, {}), { ok: true, duplicate: true, lead_id: 'e-1' }, 'the retry adds nothing');
  assert.equal(p.rows('Leads').length, 2);
});

test('doPost: a lock service that fails gives server_error JSON', () => {
  const p = setup();
  failing(p, 'Lock.tryLock', 'Lock service unavailable');
  assert.deepEqual(post(p, {}), SERVER_ERROR);
});

test('doPost: the reply never carries the message, the secret or a stack', () => {
  const p = setup();
  failing(p, 'Cache.put', 'internal detail ' + SECRET);
  const out = p.call('doPost', body({}));
  const text = out.getContent();
  assert.equal(text, JSON.stringify(SERVER_ERROR));
  assert.ok(!text.includes('internal'));
  assert.ok(!text.includes(SECRET));
});

test('doPost: something thrown that is not an Error is handled too', () => {
  const p = setup();
  p.w.hook = ({ name }) => { if (name === 'Cache.put') throw 'plain text'; };
  assert.deepEqual(post(p, {}), SERVER_ERROR);
  assert.match(p.w.logs.join('\n'), /doPost failed: plain text/);
});

test('doPost: a long failure message is cut before it is logged', () => {
  const p = setup();
  failing(p, 'Cache.put', 'x'.repeat(5000));
  post(p, {});
  assert.ok(p.w.logs.join('\n').length < 400);
});

test('doPost: the checks still answer in their own words, server_error is only for the unexpected', () => {
  const p = setup();
  assert.deepEqual(post(p, { secret: 'wrong' }), { ok: false, error: 'unauthorized' });
  assert.deepEqual(post(p, { client: 'Nobody' }), { ok: false, error: 'unknown_client' });
  assert.deepEqual(post(p, { lead_id: '' }), { ok: false, error: 'missing_field', field: 'lead_id' });
});

test('doGet: a renamed Leads header gives server_error JSON instead of a script error page', () => {
  const p = setup();
  p.fill('Leads', ['id', 'received', 'client', 'name', 'email', 'phone', 'source', 'campaign', 'message'], []);
  for (const view of ['status', 'dashboard']) {
    const out = p.call('doGet', { parameter: { view, secret: SECRET } });
    assert.equal(out.getMimeType(), 'JSON', view);
    assert.deepEqual(JSON.parse(out.getContent()), SERVER_ERROR, view);
  }
  assert.match(p.w.logs.join('\n'), /doGet failed: Sheet "Leads" has unexpected headers/);
});
