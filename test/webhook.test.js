'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadProject, loadSeeded, HEADERS } = require('./helpers/load');
const { rng } = require('../scripts/seed');

const SECRET = 'unit-test-secret-value';

function setup(opts) {
  const p = loadSeeded(opts);
  p.setProp('WEBHOOK_SECRET', SECRET);
  p.fill('Leads', HEADERS.leads, []);
  return p;
}

function event(body, { type = 'application/json', params = {} } = {}) {
  const contents = typeof body === 'string' ? body : JSON.stringify(body);
  return { postData: { contents, type, length: contents.length, name: 'postData' }, parameter: params, parameters: {}, queryString: '', contentLength: contents.length };
}

function post(p, body, o) {
  const out = p.call('doPost', typeof body === 'object' && body !== null && body.__raw ? body.__raw : event(body, o));
  assert.equal(out.getMimeType(), 'JSON', 'every reply is a JSON body');
  return JSON.parse(out.getContent());
}

const lead = (over = {}) => Object.assign({
  secret: SECRET, lead_id: 'z-9001', client: 'Summit Yoga', name: 'Ana Archer', email: 'ana.archer@example.com',
  phone: '+1 555 0123', source: 'facebook', campaign: 'launch-week', message: 'Interested in a quote'
}, over);

const leadRows = (p) => p.rows('Leads').slice(1);

test('a valid lead is appended once with the canonical client name', () => {
  const p = setup();
  const r = post(p, lead({ client: '  summit YOGA ' }));
  assert.deepEqual(r, { ok: true, duplicate: false, lead_id: 'z-9001' });
  const rows = leadRows(p);
  assert.equal(rows.length, 1);
  assert.equal(rows[0][0], 'z-9001');
  assert.equal(rows[0][2], 'Summit Yoga');
  assert.equal(rows[0][3], 'Ana Archer');
  assert.equal(rows[0][4], 'ana.archer@example.com');
  assert.ok(!JSON.stringify(rows).includes(SECRET), 'the secret is never stored');
  assert.match(rows[0][1], /^2026-11-10T/, 'received_at is a date');
});

test('secret: wrong, missing, empty and wrongly typed secrets are all refused and write nothing', () => {
  const p = setup();
  for (const secret of ['nope', '', undefined, null, 123, [SECRET], { a: SECRET }, SECRET + 'x', SECRET.slice(0, -1), SECRET.toUpperCase()]) {
    const body = lead();
    if (secret === undefined) delete body.secret; else body.secret = secret;
    assert.deepEqual(post(p, body), { ok: false, error: 'unauthorized' }, JSON.stringify(secret));
  }
  assert.equal(leadRows(p).length, 0);
});

test('secret: accepted as a URL parameter when the body has none', () => {
  const p = setup();
  const body = lead();
  delete body.secret;
  assert.equal(post(p, body, { params: { secret: SECRET } }).ok, true);
  assert.equal(post(p, lead({ lead_id: 'z-9002', secret: 'wrong' }), { params: { secret: SECRET } }).error, 'unauthorized', 'a wrong body secret wins over a right parameter');
});

test('secret: with no secret configured every request is refused', () => {
  const p = setup();
  p.w.props.script.delete('WEBHOOK_SECRET');
  assert.deepEqual(post(p, lead()), { ok: false, error: 'not_configured' });
  p.setProp('WEBHOOK_SECRET', '');
  assert.deepEqual(post(p, lead({ secret: '' })), { ok: false, error: 'not_configured' });
  assert.equal(leadRows(p).length, 0);
});

test('bad bodies get a JSON error', () => {
  const p = setup();
  assert.equal(post(p, '{not json').error, 'bad_json');
  assert.equal(post(p, '[1,2]').error, 'bad_json');
  assert.equal(post(p, '"text"').error, 'bad_json');
  assert.equal(post(p, 'null').error, 'bad_json');
  assert.equal(post(p, { __raw: {} }).error, 'no_body');
  assert.equal(post(p, { __raw: { postData: { type: 'application/json' } } }).error, 'no_body');
  assert.equal(post(p, JSON.stringify(lead({ message: 'x'.repeat(10001) }))).error, 'too_large');
  assert.equal(leadRows(p).length, 0);
});

test('unknown fields are rejected by name, and only after the secret is right', () => {
  const p = setup();
  assert.deepEqual(post(p, lead({ utm_term: 'x', foo: 1 })), { ok: false, error: 'unknown_field', fields: ['utm_term', 'foo'] });
  assert.deepEqual(post(p, lead({ secret: 'bad', utm_term: 'x' })), { ok: false, error: 'unauthorized' }, 'a caller without the secret learns nothing about fields');
  assert.equal(leadRows(p).length, 0);
});

test('field checks: a missing or malformed lead_id and a wrong typed value are refused (an odd optional value is not, see webhook-optional.test.js)', () => {
  const p = setup();
  const cases = [
    [{ lead_id: undefined }, 'missing_field', 'lead_id'],
    [{ lead_id: '' }, 'missing_field', 'lead_id'],
    [{ client: undefined }, 'missing_field', 'client'],
    [{ lead_id: 'has space' }, 'invalid_field', 'lead_id'],
    [{ lead_id: 'x'.repeat(65) }, 'invalid_field', 'lead_id'],
    [{ lead_id: '<script>' }, 'invalid_field', 'lead_id'],
    [{ lead_id: 'https://example.test/leads/1' }, 'invalid_field', 'lead_id'],
    [{ client: 'c'.repeat(121) }, 'invalid_field', 'client'],
    [{ name: { first: 'Ana' } }, 'invalid_field', 'name'],
    [{ name: ['Ana'] }, 'invalid_field', 'name'],
    [{ name: true }, 'invalid_field', 'name']
  ];
  for (const [over, error, field] of cases) {
    const body = lead(over);
    for (const k of Object.keys(over)) if (over[k] === undefined) delete body[k];
    const r = post(p, body);
    assert.equal(r.error, error, JSON.stringify(over));
    assert.equal(r.field, field, JSON.stringify(over));
  }
  assert.deepEqual(post(p, lead({ client: 'Nobody Ltd' })), { ok: false, error: 'unknown_client' });
  assert.equal(leadRows(p).length, 0);
});

test('a number or null in an optional field is accepted', () => {
  const p = setup();
  assert.equal(post(p, lead({ lead_id: 4411, phone: 15550123, name: null, message: null })).ok, true);
  assert.equal(leadRows(p)[0][0], '4411');
});

test('idempotent: the same lead_id twice is one row and a success the second time', () => {
  const p = setup();
  assert.equal(post(p, lead()).duplicate, false);
  assert.deepEqual(post(p, lead()), { ok: true, duplicate: true, lead_id: 'z-9001' });
  assert.deepEqual(post(p, lead({ name: 'Someone Else' })), { ok: true, duplicate: true, lead_id: 'z-9001' });
  assert.equal(leadRows(p).length, 1);
  assert.equal(leadRows(p)[0][3], 'Ana Archer', 'the first version is kept');
});

test('idempotent: ids that look like numbers keep their text, so 007 and 7 are different leads', () => {
  const p = setup();
  assert.equal(post(p, lead({ lead_id: '007' })).duplicate, false);
  assert.equal(post(p, lead({ lead_id: '007' })).duplicate, true);
  assert.equal(post(p, lead({ lead_id: 7 })).duplicate, false);
  assert.equal(post(p, lead({ lead_id: '7' })).duplicate, true);
  assert.deepEqual(leadRows(p).map((r) => r[0]), ['007', '7']);
});

test('text that Sheets would run as a formula is stored as plain text', () => {
  const p = setup();
  const nasty = {
    name: '=IMPORTXML("http://evil.example.test","//a")',
    message: '+SUM(1,2)',
    phone: '+63 912 345 6789',
    campaign: '-2+3',
    source: '@cmd',
    email: 'ok@example.com'
  };
  assert.equal(post(p, lead(nasty)).ok, true);
  assert.deepEqual(p.w.formulas, [], 'no formula was written');
  const row = leadRows(p)[0];
  assert.equal(row[3], nasty.name);
  assert.equal(row[8], nasty.message);
  assert.equal(row[5], nasty.phone);
  assert.equal(row[7], nasty.campaign);
  assert.equal(row[6], nasty.source);
});

test('lock: the row is written while the script lock is held, and the lock is released after a flush', () => {
  const p = setup();
  let heldAtWrite = null;
  p.w.hook = ({ name }) => { if (name === 'Sheet.appendRow') heldAtWrite = p.w.locks.script.holder === p.w.execId; };
  post(p, lead());
  assert.equal(heldAtWrite, true);
  assert.equal(p.w.locks.script.holder, null);
  assert.deepEqual(p.w.violations, []);
});

test('lock: while another run holds it the caller gets busy, nothing is written, and a retry works', () => {
  const p = setup();
  p.w.otherHoldsScriptLock(60000);
  const before = p.w.now;
  assert.deepEqual(post(p, lead()), { ok: false, error: 'busy', retry: true });
  assert.ok(p.w.now - before >= 10000, 'it waited the 10 seconds');
  assert.equal(leadRows(p).length, 0);
  p.w.now += 60000;
  assert.equal(post(p, lead()).ok, true);
  assert.equal(leadRows(p).length, 1);
});

test('lock: a lock that frees within the wait is taken', () => {
  const p = setup();
  p.w.otherHoldsScriptLock(4000);
  assert.equal(post(p, lead()).ok, true);
});

test('lock: two overlapping requests for one lead_id make one row', () => {
  const p = setup();
  let nested = null;
  p.w.hook = ({ name }) => {
    if (name === 'Sheet.appendRow' && nested === null) {
      nested = 'running';
      nested = post(p, lead());
    }
  };
  const outer = post(p, lead());
  assert.equal(outer.ok, true);
  assert.equal(outer.duplicate, false);
  assert.equal(nested.ok === false ? nested.error : 'duplicate:' + nested.duplicate, 'busy', 'the second request is told to retry');
  assert.equal(post(p, lead()).duplicate, true);
  assert.equal(leadRows(p).length, 1);
});

test('form encoded posts use the form fields', () => {
  const p = setup();
  const r = post(p, 'lead_id=f-1&client=Summit+Yoga', {
    type: 'application/x-www-form-urlencoded',
    params: { secret: SECRET, lead_id: 'f-1', client: 'Summit Yoga', email: 'f@example.com' }
  });
  assert.equal(r.ok, true);
  assert.equal(leadRows(p)[0][4], 'f@example.com');
});

test('client list is cached for 5 minutes and a new client is picked up after that', () => {
  const p = setup();
  assert.equal(post(p, lead()).ok, true);
  assert.ok(p.w.caches.script.has('sd:clients'));
  p.append('Clients', [['Late Joiner', 'L', 'l@example.com', 'acct-9', 'search', 1, 'active', '', '']]);
  assert.equal(post(p, lead({ lead_id: 'z-2', client: 'Late Joiner' })).error, 'unknown_client');
  p.w.now += 301000;
  assert.equal(post(p, lead({ lead_id: 'z-3', client: 'Late Joiner' })).ok, true);
});

test('doGet: with no view it says the service is up and shows no data', () => {
  const p = setup();
  post(p, lead());
  const out = p.call('doGet', { parameter: {} });
  assert.deepEqual(JSON.parse(out.getContent()), { ok: true, service: 'sheetdesk' });
  const out2 = p.call('doGet', { parameter: { secret: SECRET } });
  assert.deepEqual(JSON.parse(out2.getContent()), { ok: true, service: 'sheetdesk' });
});

test('doGet: the status and dashboard views need the secret', () => {
  const p = setup();
  for (const view of ['status', 'dashboard', 'other']) {
    for (const secret of [undefined, 'bad', '']) {
      const out = p.call('doGet', { parameter: { view, secret } });
      assert.deepEqual(JSON.parse(out.getContent()), { ok: false, error: 'unauthorized' }, view + ' ' + secret);
    }
  }
  p.w.props.script.delete('WEBHOOK_SECRET');
  assert.equal(JSON.parse(p.call('doGet', { parameter: { view: 'status', secret: 'x' } }).getContent()).error, 'not_configured');
});

test('doGet status: leads per client match the sheet', () => {
  const p = setup();
  p.fill('Leads', HEADERS.leads, p.fx.leads);
  const out = JSON.parse(p.call('doGet', { parameter: { view: 'status', secret: SECRET } }).getContent());
  assert.equal(out.leads_total, 300);
  const expected = {};
  p.fx.leads.forEach((r) => { expected[r[2]] = (expected[r[2]] || 0) + 1; });
  assert.deepEqual(Object.fromEntries(out.clients.map((c) => [c.client, c.leads])), expected);
  assert.equal(JSON.parse(p.call('doGet', { parameter: { view: 'x', secret: SECRET } }).getContent()).error, 'unknown_view');
});

test('doGet dashboard: an HTML table, client names escaped, recent leads counted', () => {
  const p = setup();
  p.append('Clients', [['Tom & <i>Jerry</i>', 'T', 't@example.com', 'acct-8', 'search', 1, 'active', '', '']]);
  assert.equal(post(p, lead({ lead_id: 'h-1', client: 'Tom & <i>Jerry</i>' })).ok, true);
  assert.equal(post(p, lead({ lead_id: 'h-2', client: 'Tom & <i>Jerry</i>' })).ok, true);
  const html = p.call('doGet', { parameter: { view: 'dashboard', secret: SECRET } });
  const text = html.getContent();
  assert.equal(html.getTitle(), 'Leads by client');
  assert.match(text, /<td>Tom &amp; &lt;i&gt;Jerry&lt;\/i&gt;<\/td><td class="num">2<\/td><td class="num">2<\/td>/);
  assert.ok(!text.includes('<i>Jerry'));
  assert.ok(!text.includes('<?'), 'every scriptlet was evaluated');
  assert.match(text, /All leads: 2/);
});

test('property: random request sequences never store a lead twice or lose an accepted one', () => {
  for (let seed = 1; seed <= 25; seed++) {
    const rand = rng(seed);
    const p = setup();
    const pool = ['a-1', 'a-2', '007', '7', 'z:9', 'Q.5', '1e3', '2026-10-05'];
    const model = new Set();
    const variants = ['Summit Yoga', 'summit yoga', ' SUMMIT YOGA', 'Foxglove Florist'];
    for (let step = 0; step < 40; step++) {
      const id = pool[Math.floor(rand() * pool.length)];
      const roll = rand();
      const body = lead({ lead_id: rand() < 0.2 && /^\d+$/.test(id) ? Number(id) : id, client: variants[Math.floor(rand() * variants.length)] });
      if (roll < 0.15) body.secret = 'wrong';
      else if (roll < 0.25) body.extra = 1;
      else if (roll < 0.3) body.email = 'bad';
      if (rand() < 0.1) p.w.otherHoldsScriptLock(20000);
      const r = post(p, body);
      p.w.releaseOtherLocks();
      if (r.ok) {
        assert.equal(r.duplicate, model.has(String(body.lead_id)), 'seed ' + seed + ' step ' + step);
        model.add(String(body.lead_id));
      } else {
        assert.ok(['unauthorized', 'unknown_field', 'invalid_field', 'busy'].includes(r.error), r.error);
      }
    }
    const stored = leadRows(p).map((r) => String(r[0]));
    assert.equal(stored.length, new Set(stored).size, 'seed ' + seed + ': no id stored twice');
    assert.deepEqual([...stored].sort(), [...model].sort(), 'seed ' + seed + ': every accepted lead is stored');
    assert.deepEqual(p.w.violations, []);
    assert.deepEqual(p.w.formulas, []);
  }
});

test('the web app manifest allows anonymous callers, so the secret is the only gate', () => {
  const p = loadProject();
  assert.equal(p.w.manifest.webapp.access, 'ANYONE_ANONYMOUS');
  assert.equal(p.w.manifest.webapp.executeAs, 'USER_DEPLOYING');
});
