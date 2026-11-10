'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { generate, generateScaleRows, generateRates, referenceRollup, adPlatformDays, parseCsv, toCsv, CLIENT_TEMPLATES } = require('../scripts/seed');
const { loadFixtures } = require('./helpers/load');

const FIX = path.join(__dirname, '..', 'fixtures');

test('the same seed gives the same agency, another seed gives another', () => {
  assert.deepEqual(generate(1), generate(1));
  assert.notDeepEqual(generate(1).campaigns, generate(2).campaigns);
  assert.deepEqual(generateScaleRows(500, 3), generateScaleRows(500, 3));
});

test('the committed fixtures are exactly what the generator writes for the default seed', () => {
  const data = generate(20261110);
  const csv = (f) => fs.readFileSync(path.join(FIX, f), 'utf8');
  assert.equal(csv('campaigns.csv'), toCsv(['client', 'channel', 'date', 'spend', 'clicks', 'conversions', 'currency'], data.campaigns));
  assert.equal(csv('clients.csv').split('\n')[0], 'client,contact_name,contact_email,ad_account_id,primary_channel,monthly_budget,status,intake_response_id,created_at');
  assert.equal(parseCsv(csv('clients.csv')).length - 1, data.clients.length);
  assert.equal(parseCsv(csv('leads.csv')).length - 1, 300);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(FIX, 'rates.json'), 'utf8')), data.rates);
  assert.equal(csv('rates.csv'), toCsv(['date', 'currency', 'per_usd'], data.rates.map((r) => [r.date, r.quote, r.rate])));
  assert.equal(csv('rates.csv').split('\n')[0], 'date,currency,per_usd', 'the header matches the Rates tab');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(FIX, 'ad_platform_days.json'), 'utf8')), adPlatformDays(data, '2026-10-01', '2026-10-31'));
});

test('everything in the fixtures is invented: example domains, reserved phone numbers, a fixed list of clients', () => {
  const fx = loadFixtures();
  const names = new Set(CLIENT_TEMPLATES.map((t) => t.client));
  assert.equal(fx.clients.length, 9);
  for (const c of fx.clients) {
    assert.ok(names.has(c[0]));
    assert.match(c[2], /@[a-z0-9]+\.example\.com$/);
  }
  for (const l of fx.leads) {
    assert.match(l[4], /@example\.com$/);
    assert.match(l[5], /^\+1 555 01\d\d$/, 'a 555-01xx number is reserved for fiction');
    assert.ok(names.has(l[2]));
  }
  const ids = fx.leads.map((l) => l[0]);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(fx.campaigns.every((r) => names.has(r[0]) && /^\d{4}-\d{2}-\d{2}$/.test(r[2]) && r[3] > 0));
});

test('the data has the shape the demo needs: a paused client, two other currencies, three months, rate gaps', () => {
  const fx = loadFixtures();
  assert.equal(fx.clients.filter((c) => c[6] === 'paused').length, 1);
  assert.deepEqual([...new Set(fx.campaigns.map((r) => r[6]))].sort(), ['EUR', 'GBP', 'USD']);
  assert.deepEqual([...new Set(fx.campaigns.map((r) => r[2].slice(0, 7)))].sort(), ['2026-08', '2026-09', '2026-10']);
  const days = new Set(fx.rates.filter((r) => r.quote === 'EUR').map((r) => r.date));
  assert.ok(!days.has('2026-10-03') && !days.has('2026-10-04'), 'no rate on a weekend');
  assert.ok(fx.rates.every((r) => r.base === 'USD' && r.rate > 0.5 && r.rate < 1.2));
});

test('scale rows: about 1 in 60 is bad on purpose, and the reference counts the rest', () => {
  const { rows, valid } = generateScaleRows(6000, 9);
  assert.equal(rows.length, 6000);
  assert.equal(valid, 6000 - 100);
  const rates = generateRates('2024-12-20', '2026-11-02', 9);
  const ref = referenceRollup(rows, rates);
  assert.equal(ref.counted, valid);
  assert.ok(ref.sums.size > 50);
});

test('the reference rollup rounds each row to cents and uses the latest earlier rate', () => {
  const rates = [{ date: '2026-10-02', base: 'USD', quote: 'EUR', rate: 0.9 }];
  const rows = [['A', 'search', '2026-10-03', 10, 2, 1, 'EUR'], ['A', 'search', '2026-10-12', 10, 2, 1, 'EUR'], ['A', 'search', '2026-10-03', 10.005, 2, 1, 'USD']];
  const { sums, counted } = referenceRollup(rows, rates);
  assert.equal(counted, 2, 'the 12th is more than 7 days after the last rate');
  assert.equal(sums.get('A|2026-10').cents, 1111 + 1001);
});
