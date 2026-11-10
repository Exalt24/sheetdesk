'use strict';
/**
 * A row that is not a client stops no client (round 4, F6): a row held as
 * needs_review, paused or blank used to stop the reports and the month close of
 * the active client whose name it shares. Only active rows count for a name
 * clash. The other name clash tables are in test/name-collisions.test.js.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadSeeded } = require('./helpers/load');

const LONG = 'x'.repeat(80);

/** Collision kinds: [label, a name that is a client, a second name that shares its report file name or summary tab, which of the two]. */
const KINDS = [
  ['other case', 'Harbor Lane Bakery', 'harbor lane bakery', 'report file name'],
  ['trailing period', 'Harbor Lane Bakery', 'Harbor Lane Bakery.', 'report file name'],
  ['double spaces', 'Harbor Lane Bakery', 'Harbor  Lane   Bakery', 'report file name'],
  ['ampersand left out', 'Orchard & Vine', 'Orchard Vine', 'report file name'],
  ['slash and dash in the tab name', 'A/B Co', 'A-B Co', 'report file name'],
  ['two names equal in their first 80 characters', LONG + '1', LONG + '2', 'summary tab name']
];

const clientRow = (name, status) => [name, 'Casey Contact', 'casey@' + name.toLowerCase().replace(/[^a-z]+/g, '').slice(0, 20) + '.example.com', '', 'search', 100, status, '', ''];
const campaignRow = (name) => [name, 'search', '2026-10-10', 100, 10, 1, 'USD'];

/** The seeded project with both names present as clients (the second with `status`) and with one October Campaigns row each. */
function build(a, b, status) {
  const p = loadSeeded();
  const have = new Set(p.fx.clients.map((r) => r[0]));
  const clients = [];
  const campaigns = [];
  [[a, 'active'], [b, status]].forEach(([n, st]) => {
    if (!have.has(n) || n === b) {
      clients.push(clientRow(n, st));
      campaigns.push(campaignRow(n));
    }
  });
  p.append('Clients', clients);
  p.append('Campaigns', campaigns);
  return p;
}

const quoted = (n) => '"' + n + '"';

function assertNamesBoth(message, a, b, where, what) {
  assert.equal(message, 'Clients ' + quoted(a) + ' and ' + quoted(b) + ' would share one ' + what + '.', where);
}

/** Statuses of the second row as the Clients tab can hold them: [as typed, whether loadClients_ reads it as active]. */
const SECOND_STATUSES = [
  ['active', true], [' Active ', true],
  ['needs_review', false], ['paused', false], ['', false]
];

// CLASS-TABLE: every status of a clashing row against the report of the active client, the report of the row itself and the month close
test('CLASS-TABLE: a row that shares a name blocks an active client only when it is active itself, whatever else its status says', () => {
  for (const [label, a, b, what] of KINDS) {
    for (const [status, active] of SECOND_STATUSES) {
      const where = label + ', second row "' + status + '"';
      const p = build(a, b, status);
      if (active) {
        assert.throws(() => p.call('runClientReport', a, '2026-10'), (e) => { assertNamesBoth(e.message, a, b, where, what); return true; }, where + ': the first is blocked');
      } else {
        assert.equal(p.plain(p.call('runClientReport', a, '2026-10')).status, 'ok', where + ': the active client is reported');
        assert.throws(() => p.call('runClientReport', b, '2026-10'), (e) => { assertNamesBoth(e.message, a, b, where, what); return true; }, where + ': the row that is not a client is still refused');
      }
      const close = build(a, b, status);
      const r = close.plain(close.call('runMonthClose', '2026-10'));
      assert.equal(r.results.filter((x) => x.status === 'error').length, active ? 2 : 0, where + ': month close errors');
      assert.equal(r.clashes === undefined, !active, where + ': month close clashes');
      assert.ok(r.results.every((x) => x.client !== a || (active ? x.status === 'error' : x.status === 'ok')), where + ': the status of ' + a);
    }
  }
});
