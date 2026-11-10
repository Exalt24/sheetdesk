'use strict';
/**
 * An optional lead field never refuses the lead. A lead with a lead_id in the
 * right shape and a known client is stored, an odd optional value is kept as
 * typed (after the formula guard) and the reply lists it in `warnings`.
 * test/corpus.test.js replays the adversary's cases for the same promise.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadSeeded, HEADERS } = require('./helpers/load');

const SECRET = 'optional-test-secret';
const CAPS = { name: 120, phone: 40, source: 60, campaign: 120, message: 2000 };
const OPTIONAL = ['name', 'email', 'phone', 'source', 'campaign', 'message'];

function setup() {
  const p = loadSeeded();
  p.setProp('WEBHOOK_SECRET', SECRET);
  p.fill('Leads', HEADERS.leads, []);
  return p;
}

function post(p, body) {
  const contents = JSON.stringify(body);
  const e = { postData: { contents, type: 'application/json', length: contents.length, name: 'postData' }, parameter: {}, parameters: {}, queryString: '', contentLength: contents.length };
  return JSON.parse(p.call('doPost', e).getContent());
}

const base = (over) => Object.assign({
  secret: SECRET, lead_id: 'o-1', client: 'Summit Yoga', name: 'Ana Archer', email: 'ana.archer@example.com',
  phone: '+1 555 0123', source: 'facebook', campaign: 'launch-week', message: 'Interested in a quote'
}, over);

/** The value cases of one optional field: [label, value, the warning it must get, or null]. */
function valuesFor(field) {
  const rows = [['blank', '', null]];
  if (field !== 'email') {
    rows.push(['ordinary text', 'Ana Archer', null]);
    rows.push(['text starting with a digit', '12 apples', null]);
    rows.push(['a formula', '=IMPORTXML("http://x.example","//a")', null]);
    rows.push(['a plus number', '+63 965 935 1300', null]);
  }
  if (field === 'email') {
    rows.push(['ordinary address', 'ana.archer@example.com', null]);
    rows.push(['address with a plus tag', 'ana+promo@example.co.uk', null]);
    rows.push(['apostrophe address', "o'brien@example.ie", null]);
    for (const odd of ['=IMPORTXML("http://x.example","//a")', '+63 965 935 1300', 'ana@gmail', 'ana@gmail,com', 'Ana Archer <ana@example.com>', 'not an email', 'a@b', 'ana@@example.com']) {
      rows.push(['malformed ' + odd, odd, { field: 'email', issue: 'not_an_email' }]);
    }
    rows.push(['255 characters', 'a'.repeat(242) + '@example.test', { field: 'email', issue: 'not_an_email' }]);
  } else {
    const cap = CAPS[field];
    rows.push(['exactly the limit', 'm'.repeat(cap), null]);
    rows.push(['one over the limit', 'm'.repeat(cap + 1), { field, issue: 'too_long', max: cap }]);
    rows.push(['far over the limit', 'x y'.repeat(2000), { field, issue: 'too_long', max: cap }]);
  }
  return rows;
}

// CLASS-TABLE: every optional field against every odd or ordinary value, one lead per row
const TABLE = [];
for (const field of OPTIONAL) {
  for (const [label, value, warning] of valuesFor(field)) TABLE.push({ field, label, value, warning });
}

test('CLASS-TABLE: an optional field never refuses a lead, an odd value is stored as typed and reported', () => {
  const p = setup();
  let n = 0;
  for (const row of TABLE) {
    n++;
    const id = 'row-' + n;
    const r = post(p, base({ lead_id: id, [row.field]: row.value }));
    const where = row.field + ' ' + row.label;
    const want = { ok: true, duplicate: false, lead_id: id };
    if (row.warning) want.warnings = [row.warning];
    assert.deepEqual(r, want, where);
    const stored = p.rows('Leads').find((x) => x[0] === id);
    assert.equal(stored[HEADERS.leads.indexOf(row.field)], row.value, where + ' is stored as typed');
  }
  assert.equal(p.rows('Leads').length - 1, TABLE.length, 'one row per lead');
  assert.deepEqual(p.w.formulas, [], 'no formula reached a cell');
  assert.ok(TABLE.filter((x) => x.warning).length >= 15 && TABLE.filter((x) => !x.warning).length >= 15, 'the table has harm rows and ordinary rows');
});

test('CLASS-TABLE: several odd values in one lead are all stored and each is named once, in field order', () => {
  const p = setup();
  const r = post(p, base({ email: 'ana@gmail', phone: 'p'.repeat(41), message: 'm'.repeat(2001) }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.warnings, [
    { field: 'phone', issue: 'too_long', max: 40 },
    { field: 'message', issue: 'too_long', max: 2000 },
    { field: 'email', issue: 'not_an_email' }
  ]);
  assert.equal(p.rows('Leads').length, 2);
});

test('a retry of an odd lead is a duplicate with no second row and no warnings', () => {
  const p = setup();
  assert.equal(post(p, base({ email: 'ana@gmail' })).ok, true);
  assert.deepEqual(post(p, base({ email: 'ana@gmail' })), { ok: true, duplicate: true, lead_id: 'o-1' });
  assert.equal(p.rows('Leads').length, 2);
});

test('CLASS-TABLE: what is still refused: the lead_id shape, the client, the secret, unknown fields and wrong typed values', () => {
  const p = setup();
  const refused = [];
  for (const id of ['has space', 'a/b', 'https://example.test/1', 'x'.repeat(65), '']) {
    refused.push([base({ lead_id: id }), id === '' ? 'missing_field' : 'invalid_field']);
  }
  for (const client of ['Nobody Ltd', '   ', 'c'.repeat(120), 'c'.repeat(121)]) {
    refused.push([base({ client }), !client.trim() ? 'missing_field' : client.length > 120 ? 'invalid_field' : 'unknown_client']);
  }
  refused.push([base({ secret: 'wrong' }), 'unauthorized']);
  refused.push([base({ utm_term: 'x' }), 'unknown_field']);
  for (const field of OPTIONAL) {
    for (const value of [{ a: 1 }, ['x'], true]) refused.push([base({ [field]: value }), 'invalid_field']);
  }
  for (const [body, error] of refused) {
    const r = post(p, body);
    assert.equal(r.ok, false, JSON.stringify(body));
    assert.equal(r.error, error, JSON.stringify(body));
    assert.equal(r.warnings, undefined);
    if (body.client && body.client.length > 120) assert.equal(r.field, 'client');
  }
  assert.equal(p.rows('Leads').length, 1, 'nothing was stored');
});
