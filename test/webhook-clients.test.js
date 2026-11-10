'use strict';
/**
 * The key of a lead is the client and the lead_id together. Found by the final
 * blind recall (round 4, F3): a lead_id was unique across all clients, so the
 * lead of a second client whose id another client had already used was dropped
 * while the reply said ok and duplicate. Ad platforms and forms number their
 * leads per account, so two clients using 1001 is ordinary.
 *
 * The table is built by code: each shape of id against pairs of client names
 * (other case, outer spaces), in both orders, with the same id twice for one
 * client still stored once.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadSeeded, HEADERS } = require('./helpers/load');

const SECRET = 'clients-test-secret';

function setup() {
  const p = loadSeeded();
  p.setProp('WEBHOOK_SECRET', SECRET);
  p.fill('Leads', HEADERS.leads, []);
  return p;
}

function post(p, over) {
  const contents = JSON.stringify(Object.assign({ secret: SECRET, lead_id: '1001', client: 'Summit Yoga', name: 'Ana Archer', email: 'ana@example.com' }, over));
  const e = { postData: { contents, type: 'application/json', length: contents.length, name: 'postData' }, parameter: {}, parameters: {}, queryString: '', contentLength: contents.length };
  return JSON.parse(p.call('doPost', e).getContent());
}

const rows = (p) => p.rows('Leads').slice(1);

const IDS = ['1001', '007', 'z-1', '1e3', 'a.b:c', '2026-10-05', 1001, 7];
/** Pairs of client spellings: [first, second, the same client?]. */
const PAIRS = [
  ['Summit Yoga', 'Harbor Lane Bakery', false],
  ['Harbor Lane Bakery', 'Summit Yoga', false],
  ['Summit Yoga', 'summit yoga', true],
  ['Summit Yoga', '  SUMMIT YOGA ', true],
  ['Orchard & Vine', 'Foxglove Florist', false]
];

// CLASS-TABLE: every id shape against every pair of clients, in the order given
test('CLASS-TABLE: the same lead_id for two clients is two leads, and for one client in any spelling it is one', () => {
  for (const id of IDS) {
    for (const [first, second, same] of PAIRS) {
      const where = JSON.stringify(id) + ' ' + first + ' then ' + second;
      const p = setup();
      const a = post(p, { lead_id: id, client: first, name: 'First Lead' });
      assert.deepEqual(a, { ok: true, duplicate: false, lead_id: String(id) }, where + ': first');
      const b = post(p, { lead_id: id, client: second, name: 'Second Lead' });
      assert.deepEqual(b, { ok: true, duplicate: same, lead_id: String(id) }, where + ': second');
      assert.equal(rows(p).length, same ? 1 : 2, where + ': rows');
      assert.deepEqual(rows(p).map((r) => r[3]), same ? ['First Lead'] : ['First Lead', 'Second Lead'], where + ': the second lead is stored when it is another client');
      // a retry of either one adds nothing
      assert.equal(post(p, { lead_id: id, client: first, name: 'First Lead' }).duplicate, true, where + ': retry of the first');
      assert.equal(post(p, { lead_id: id, client: second, name: 'Second Lead' }).duplicate, true, where + ': retry of the second');
      assert.equal(rows(p).length, same ? 1 : 2, where + ': rows after the retries');
    }
  }
});

// CLASS-TABLE: three clients with one id, and one client with two ids
test('CLASS-TABLE: three clients can each hold the id 1001, and one client with two ids has two leads', () => {
  const p = setup();
  for (const client of ['Summit Yoga', 'Harbor Lane Bakery', 'Orchard & Vine']) {
    assert.equal(post(p, { client }).duplicate, false, client);
  }
  assert.equal(post(p, { client: 'Harbor Lane Bakery', lead_id: '1002' }).duplicate, false);
  assert.equal(post(p, { client: 'Harbor Lane Bakery', lead_id: '1001' }).duplicate, true);
  assert.deepEqual(rows(p).map((r) => r[2] + '/' + r[0]), ['Summit Yoga/1001', 'Harbor Lane Bakery/1001', 'Orchard & Vine/1001', 'Harbor Lane Bakery/1002']);
  const status = JSON.parse(p.call('doGet', { parameter: { view: 'status', secret: SECRET } }).getContent());
  assert.equal(status.leads_total, 4);
});

// CLASS-TABLE: the id of a client's lead is not mistaken for another column
test('CLASS-TABLE: a client name that is another lead\'s id, and an id that is another client\'s name, do not collide', () => {
  const p = setup();
  p.append('Clients', [['1001', 'Casey', 'casey@example.com', '', 'search', 1, 'active', '', '']]);
  p.call('invalidateClientCache_');
  assert.equal(post(p, { lead_id: '1001', client: 'Summit Yoga' }).duplicate, false);
  assert.equal(post(p, { lead_id: 'Summit Yoga'.replace(/ /g, '-'), client: '1001' }).duplicate, false);
  assert.equal(post(p, { lead_id: '1001', client: '1001' }).duplicate, false);
  assert.equal(rows(p).length, 3);
});
