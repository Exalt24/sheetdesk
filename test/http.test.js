'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadProject, loadSeeded, HEADERS } = require('./helpers/load');
const { installAdPlatform, installFrankfurter } = require('./fake/services');
const { generateRates, rng } = require('../scripts/seed');

const KEY = 'test-key';

function makeHttp(p, routes) {
  p.w.route((u) => u.startsWith('https://svc.example.test/'), routes);
}

/** Replies from a queue, then repeats the last reply. */
function queue(...replies) {
  const state = { n: 0 };
  makeHandler.state = state;
  return { state, handler: () => replies[Math.min(state.n++, replies.length - 1)] };
}
function makeHandler() {}

const ok = (body = { ok: true }) => ({ code: 200, body });

function getJson(p, url, options) {
  return p.w.run(() => p.ctx.httpJson_(url, options));
}

test('httpJson_ returns parsed JSON on a 200', () => {
  const p = loadProject();
  const q = queue(ok({ hello: 'world' }));
  makeHttp(p, q.handler);
  const r = getJson(p, 'https://svc.example.test/a');
  assert.deepEqual(p.plain(r.json), { hello: 'world' });
  assert.equal(r.attempts, 1);
  assert.equal(q.state.n, 1);
});

test('a 429 with Retry-After waits that long and tries again', () => {
  const p = loadProject();
  const q = queue({ code: 429, body: {}, headers: { 'Retry-After': '2' } }, ok());
  makeHttp(p, q.handler);
  const r = getJson(p, 'https://svc.example.test/a');
  assert.equal(r.attempts, 2);
  assert.deepEqual(p.w.sleeps, [2000]);
});

test('a 429 without Retry-After backs off exponentially: 500, 1000, 2000, 4000 (jitter fixed at the top)', () => {
  const p = loadProject();
  const q = queue({ code: 429, body: {} }, { code: 503, body: {} }, { code: 500, body: {} }, { code: 502, body: {} }, ok());
  makeHttp(p, q.handler);
  const r = getJson(p, 'https://svc.example.test/a', { random: () => 1 });
  assert.equal(r.attempts, 5);
  assert.deepEqual(p.w.sleeps, [500, 1000, 2000, 4000]);
});

test('jitter keeps each wait between half and the full delay', () => {
  const p = loadProject();
  const q = queue({ code: 500, body: {} }, { code: 500, body: {} }, ok());
  makeHttp(p, q.handler);
  getJson(p, 'https://svc.example.test/a', { random: () => 0 });
  assert.deepEqual(p.w.sleeps, [250, 500]);
});

test('the wait is capped', () => {
  const p = loadProject();
  const q = queue({ code: 500, body: {} });
  makeHttp(p, q.handler);
  assert.throws(() => getJson(p, 'https://svc.example.test/a', { random: () => 1, maxAttempts: 9, baseDelayMs: 1000, maxDelayMs: 5000 }), /Gave up after 9 attempts/);
  assert.deepEqual(p.w.sleeps, [1000, 2000, 4000, 5000, 5000, 5000, 5000, 5000]);
});

test('Retry-After is capped, and a nonsense value falls back to backoff', () => {
  const p = loadProject();
  const q = queue({ code: 429, body: {}, headers: { 'Retry-After': '999' } }, { code: 429, body: {}, headers: { 'Retry-After': 'soon' } }, { code: 429, body: {}, headers: { 'Retry-After': '0' } }, ok());
  makeHttp(p, q.handler);
  getJson(p, 'https://svc.example.test/a', { random: () => 1 });
  assert.deepEqual(p.w.sleeps, [30000, 1000, 2000]);
});

test('after the last attempt it throws an error that carries the status and the attempts', () => {
  const p = loadProject();
  const q = queue({ code: 503, body: {} });
  makeHttp(p, q.handler);
  let err;
  try { getJson(p, 'https://svc.example.test/a', { maxAttempts: 3 }); } catch (e) { err = e; }
  assert.equal(err.name, 'HttpError');
  assert.equal(err.status, 503);
  assert.equal(err.attempts, 3);
  assert.equal(q.state.n, 3);
  assert.equal(p.w.sleeps.length, 2, 'no wait after the last attempt');
});

test('401, 403, 404 and 400 are not retried', () => {
  for (const code of [400, 401, 403, 404, 422]) {
    const p = loadProject();
    const q = queue({ code, body: { error: 'no' } }, ok());
    makeHttp(p, q.handler);
    let err;
    try { getJson(p, 'https://svc.example.test/a'); } catch (e) { err = e; }
    assert.equal(err.status, code);
    assert.equal(q.state.n, 1, 'one request for ' + code);
    assert.deepEqual(p.w.sleeps, []);
  }
});

test('a thrown fetch error (no DNS, timeout) is retried like a 5xx', () => {
  const p = loadProject();
  const q = queue({ throw: 'DNS error: https://svc.example.test/a' }, { throw: 'Timeout: https://svc.example.test/a' }, ok());
  makeHttp(p, q.handler);
  assert.equal(getJson(p, 'https://svc.example.test/a').attempts, 3);
  const p2 = loadProject();
  assert.throws(() => getJson(p2, 'https://svc.example.test/none', { maxAttempts: 2 }), /Gave up after 2 attempts: DNS error/);
});

test('a 200 with an HTML page or broken JSON is an error and is not retried', () => {
  for (const [reply, message] of [
    [{ code: 200, headers: { 'Content-Type': 'text/html' }, body: '<html>maintenance</html>' }, /Expected JSON but got content type "text\/html"/],
    [{ code: 200, body: '{"half":' }, /Response body is not valid JSON/]
  ]) {
    const p = loadProject();
    const q = queue(reply, ok());
    makeHttp(p, q.handler);
    assert.throws(() => getJson(p, 'https://svc.example.test/a'), message);
    assert.equal(q.state.n, 1);
  }
});

test('the validate callback can reject a good looking 200', () => {
  const p = loadProject();
  makeHttp(p, queue(ok({ data: 'wrong shape' })).handler);
  assert.throws(() => getJson(p, 'https://svc.example.test/a', { validate: (b) => (Array.isArray(b.data) ? null : 'data is not a list') }), /Unexpected response: data is not a list/);
});

test('the deadline stops a retry that would run past the time budget', () => {
  const p = loadProject();
  const q = queue({ code: 503, body: {} }, ok());
  makeHttp(p, q.handler);
  assert.throws(() => p.w.run(() => p.ctx.httpJson_('https://svc.example.test/a', { deadlineMs: p.w.now + 100, random: () => 1 })), /Retry would pass the time budget/);
  assert.equal(q.state.n, 1);
  assert.deepEqual(p.w.sleeps, []);
});

test('the request is sent with muteHttpExceptions, so the status code is readable', () => {
  const p = loadProject();
  makeHttp(p, queue({ code: 404, body: {} }).handler);
  assert.throws(() => getJson(p, 'https://svc.example.test/a'), (e) => e.name === 'HttpError' && e.status === 404);
});

test('UrlFetchApp needs its scope in the manifest', () => {
  const p = loadProject({ scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  makeHttp(p, queue(ok()).handler);
  assert.throws(() => getJson(p, 'https://svc.example.test/a'), /Specified permissions are not sufficient to call UrlFetchApp\.fetch\. Required permissions: .*script\.external_request/);
});

test('fetchAllPages_ follows the token to the end and keeps the order', () => {
  const p = loadProject();
  const pages = { '': { items: [1, 2], next: 'b' }, b: { items: [3], next: 'c' }, c: { items: [4, 5], next: null } };
  p.w.route((u) => u.startsWith('https://svc.example.test/list'), (req) => {
    const t = new URL(req.url).searchParams.get('t') || '';
    return ok({ items: pages[t].items, next: pages[t].next });
  });
  const r = p.w.run(() => p.ctx.fetchAllPages_((t) => 'https://svc.example.test/list' + (t ? '?t=' + t : ''), {}, { itemsKey: 'items', nextKey: 'next' }));
  assert.deepEqual(p.plain(r), { items: [1, 2, 3, 4, 5], pages: 3 });
});

test('fetchAllPages_ stops on a repeated token and on a page with no list', () => {
  const p = loadProject();
  p.w.route((u) => u.startsWith('https://svc.example.test/loop'), () => ok({ items: [1], next: 'same' }));
  assert.throws(() => p.w.run(() => p.ctx.fetchAllPages_((t) => 'https://svc.example.test/loop?t=' + t, {}, { itemsKey: 'items', nextKey: 'next' })), /Pagination loop/);
  p.w.route((u) => u.startsWith('https://svc.example.test/nolist'), () => ok({ nothing: true }));
  assert.throws(() => p.w.run(() => p.ctx.fetchAllPages_(() => 'https://svc.example.test/nolist', {}, { itemsKey: 'items', nextKey: 'next' })), /has no "items" array/);
  let n = 0;
  p.w.route((u) => u.startsWith('https://svc.example.test/long'), () => ok({ items: [1], next: 'n' + n++ }));
  assert.throws(() => p.w.run(() => p.ctx.fetchAllPages_(() => 'https://svc.example.test/long', {}, { itemsKey: 'items', nextKey: 'next', maxPages: 5 })), /did not end after 5 pages/);
});

test('property: random fault sequences end in the data or in a clear error, never a partial result', () => {
  for (let seed = 1; seed <= 30; seed++) {
    const rand = rng(seed);
    const p = loadProject();
    const faults = [];
    const plan = [];
    for (let i = 0; i < 12; i++) {
      const r = rand();
      if (r < 0.25) plan.push({ code: 429, body: {}, headers: rand() < 0.5 ? { 'Retry-After': String(1 + Math.floor(rand() * 3)) } : {} });
      else if (r < 0.45) plan.push({ code: 500 + Math.floor(rand() * 4), body: {} });
      else if (r < 0.5) plan.push({ throw: 'Address unavailable: x' });
      else plan.push(ok({ n: i }));
    }
    let i = 0;
    p.w.route((u) => u.startsWith('https://svc.example.test/'), () => { faults.push(i); return plan[i++ % plan.length]; });
    const maxAttempts = 1 + Math.floor(rand() * 6);
    let result = null;
    let error = null;
    try { result = getJson(p, 'https://svc.example.test/a', { maxAttempts, random: rand }); } catch (e) { error = e; }
    const firstOk = plan.slice(0, maxAttempts).findIndex((x) => x.code === 200);
    if (firstOk >= 0) {
      assert.ok(result, 'seed ' + seed + ': success within the attempts');
      assert.equal(result.attempts, firstOk + 1);
      assert.equal(p.w.sleeps.length, firstOk);
    } else {
      assert.equal(error.name, 'HttpError', 'seed ' + seed);
      assert.equal(error.attempts, maxAttempts);
      assert.equal(p.w.sleeps.length, maxAttempts - 1);
    }
    for (const s of p.w.sleeps) assert.ok(s >= 0 && s <= 30000);
  }
});

// ------------------------------------------------------------ ad platform

function adSetup({ extraDays = [], pageSize = 100 } = {}) {
  const p = loadSeeded();
  const days = [...p.fx.adDays, ...extraDays];
  const ad = installAdPlatform(p.w, { days, apiKey: KEY, pageSize });
  p.setProp('AD_API_KEY', KEY);
  return { p, ad, days };
}

test('syncAdCosts pages through the stand-in platform and changes only what differs', () => {
  const { p, ad, days } = adSetup();
  const before = p.rows('Campaigns').length;
  const camp = new Map(p.fx.campaigns.map((r) => [r[0] + '|' + r[1] + '|' + r[2], r]));
  const acct = Object.fromEntries(p.fx.clients.map((c) => [c[3], c[0]]));
  const expectedUpdates = days.filter((d) => {
    const row = camp.get(acct[d.account_id] + '|' + d.channel + '|' + d.date);
    return Math.round(d.cost_micros / 10000) / 100 !== row[3];
  }).length;
  assert.ok(expectedUpdates > 30, 'the last 3 days were restated');
  let writes = 0;
  p.w.hook = ({ name }) => { if (name === 'Range.setValues') writes++; };
  const r = p.plain(p.call('syncAdCosts', '2026-10-01', '2026-10-31'));
  assert.equal(r.fetched, days.length);
  assert.equal(r.pages, Math.ceil(days.length / 100));
  assert.equal(r.inserted, 0);
  assert.equal(r.updated, expectedUpdates);
  assert.equal(r.unchanged, days.length - expectedUpdates);
  assert.equal(r.unknownAccount, 0);
  assert.equal(p.rows('Campaigns').length, before, 'no row added or lost');
  assert.ok(writes <= 20, 'updates are written in runs, not one by one: ' + writes);
  assert.ok(ad.requests.every((q) => q.headers.Authorization === 'Bearer ' + KEY));
  assert.equal(ad.requests.length, r.pages);
  const again = p.plain(p.call('syncAdCosts', '2026-10-01', '2026-10-31'));
  assert.deepEqual([again.inserted, again.updated, again.unchanged], [0, 0, days.length]);
});

test('syncAdCosts adds new days, ignores unknown accounts and bad records, and counts them', () => {
  const extra = [
    { date: '2026-11-01', account_id: 'acct-1000', channel: 'Search', cost_micros: 12345678, currency: 'USD', clicks: 10, conversions: 1 },
    { date: '2026-11-01', account_id: 'acct-1000', channel: 'search', cost_micros: 99, currency: 'USD', clicks: 1, conversions: 0 },
    { date: '2026-11-01', account_id: 'acct-9999', channel: 'search', cost_micros: 5000000, currency: 'USD', clicks: 10, conversions: 1 },
    { date: '2026-11-01', account_id: 'acct-1000', channel: 'social', cost_micros: -5, currency: 'USD', clicks: 1, conversions: 0 },
    { date: '2026-11-31', account_id: 'acct-1000', channel: 'social', cost_micros: 5, currency: 'USD', clicks: 1, conversions: 0 },
    { date: '2026-11-01', account_id: 'acct-1000', channel: 'social', cost_micros: 5, currency: 'usd', clicks: 1, conversions: 0 },
    { date: '2026-11-01', account_id: 'acct-1000', channel: 'social', cost_micros: 5, currency: 'USD', clicks: 1.5, conversions: 0 },
    null
  ];
  const { p } = adSetup({ extraDays: extra });
  const r = p.plain(p.call('syncAdCosts', '2026-11-01', '2026-12-01'));
  assert.equal(r.fetched, 8);
  assert.equal(r.invalid, 5);
  assert.equal(r.duplicates, 1, 'the duplicate key is counted, so the replacement is visible');
  assert.equal(r.unknownAccount, 1);
  assert.equal(r.inserted, 1, 'the second record has the same key as the first and wins');
  const last = p.rows('Campaigns').pop();
  assert.deepEqual(last.slice(0, 2).concat(last.slice(3, 7)), ['Harbor Lane Bakery', 'search', 0, 1, 0, 'USD']);
  assert.equal(last[2].slice(0, 10), '2026-11-01');
});

test('syncAdCosts works through a 429 and a 503 on the way', () => {
  const { p, ad } = adSetup();
  ad.faults.push({ code: 429, headers: { 'Retry-After': '1' } }, { code: 503 });
  const r = p.plain(p.call('syncAdCosts', '2026-10-01', '2026-10-31'));
  assert.equal(r.fetched, p.fx.adDays.length);
  assert.equal(p.w.sleeps.length, 2);
  assert.equal(p.w.sleeps[0], 1000);
});

test('syncAdCosts fails clearly on a wrong key and on bad arguments, before writing anything', () => {
  const { p, ad } = adSetup();
  p.setProp('AD_API_KEY', 'wrong');
  assert.throws(() => p.call('syncAdCosts', '2026-10-01', '2026-10-31'), (e) => e.name === 'HttpError' && e.status === 401);
  p.w.props.script.delete('AD_API_KEY');
  assert.throws(() => p.call('syncAdCosts', '2026-10-01', '2026-10-31'), /AD_API_KEY/);
  p.setProp('AD_API_KEY', KEY);
  const calls = ad.requests.length;
  for (const [a, b] of [['2026-10-31', '2026-10-01'], ['2026-13-01', '2026-10-01'], ['2026-10-01', 'tomorrow'], [undefined, undefined], ['2026-01-01', '2026-10-01']]) {
    assert.throws(() => p.call('syncAdCosts', a, b), /Dates must look like|after the end date|at most 92 days/);
  }
  assert.equal(ad.requests.length, calls, 'no request for a bad range');
});

test('syncAdCosts gives up on an outage after 5 tries and leaves Campaigns alone', () => {
  const { p, ad } = adSetup();
  for (let i = 0; i < 10; i++) ad.faults.push({ code: 503 });
  const before = JSON.stringify(p.rows('Campaigns'));
  assert.throws(() => p.call('syncAdCosts', '2026-10-01', '2026-10-31'), /Gave up after 5 attempts/);
  assert.equal(JSON.stringify(p.rows('Campaigns')), before);
});

test('syncAdCosts rejects a maintenance page served with status 200', () => {
  const { p, ad } = adSetup();
  ad.faults.push({ html: true });
  assert.throws(() => p.call('syncAdCosts', '2026-10-01', '2026-10-31'), /Expected JSON/);
});

test('syncAdCosts writes under the script lock and refuses while another run holds it', () => {
  const { p } = adSetup();
  let heldAtWrite = null;
  p.w.hook = ({ name }) => { if (name === 'Range.setValues') heldAtWrite = p.w.locks.script.holder === p.w.execId; };
  p.call('syncAdCosts', '2026-10-01', '2026-10-31');
  assert.equal(heldAtWrite, true);
  p.w.hook = null;
  p.w.otherHoldsScriptLock(Infinity);
  const before = JSON.stringify(p.rows('Campaigns'));
  assert.throws(() => p.call('syncAdCosts', '2026-10-01', '2026-10-31'), /Another run is writing to Campaigns/);
  p.w.releaseOtherLocks();
  assert.equal(JSON.stringify(p.rows('Campaigns')), before);
  assert.deepEqual(p.w.violations, []);
});

test('syncCurrencyRates also takes the lock', () => {
  const { p } = fxSetup();
  p.w.otherHoldsScriptLock(Infinity);
  assert.throws(() => p.call('syncCurrencyRates', '2026-10-01', '2026-10-10'), /Another run is writing rates/);
  p.w.releaseOtherLocks();
  p.call('syncCurrencyRates', '2026-10-01', '2026-10-10');
  assert.deepEqual(p.w.violations, []);
});

test('the menu items pull the last 30 days', () => {
  const { p, ad } = adSetup();
  installFrankfurter(p.w, p.fx.rates);
  p.call('menuSyncAdCosts');
  assert.match(ad.requests[0].url, /from=2026-10-11&to=2026-11-10/);
  assert.match(p.w.ui.toasts[0].msg, /new,.*changed/);
});

// -------------------------------------------------------------- currency

function fxSetup() {
  const p = loadProject();
  const rates = generateRates('2026-10-01', '2026-10-31', 5);
  const fx = installFrankfurter(p.w, rates);
  p.fill('Campaigns', HEADERS.campaigns, [
    ['Euro Co', 'search', '2026-10-05', 100, 10, 1, 'EUR'],
    ['Pound Co', 'search', '2026-10-06', 100, 10, 1, 'GBP'],
    ['Plain Co', 'search', '2026-10-06', 100, 10, 1, 'USD']
  ]);
  return { p, rates, fx };
}

test('syncCurrencyRates asks for the currencies in Campaigns, in the Frankfurter v2 shape', () => {
  const { p, rates, fx } = fxSetup();
  const r = p.plain(p.call('syncCurrencyRates', '2026-10-01', '2026-10-10'));
  assert.equal(fx.requests[0].url, 'https://api.frankfurter.dev/v2/rates?base=USD&quotes=EUR,GBP&from=2026-10-01&to=2026-10-10');
  const wanted = rates.filter((x) => x.date <= '2026-10-10');
  assert.deepEqual([r.currencies, r.fetched, r.inserted, r.updated], [['EUR', 'GBP'], wanted.length, wanted.length, 0]);
  assert.equal(p.rows('Rates').length, wanted.length + 1);
  const row = p.rows('Rates')[1];
  assert.deepEqual([row[0].slice(0, 10), row[1], row[2]], [wanted[0].date, wanted[0].quote, wanted[0].rate]);
});

// CLASS-TABLE: a malformed currency cell in Campaigns never stops the rates of the other currencies (the final recall: one US$ cell made the whole pull throw)
for (const bad of ['US$', 'eur1', 'EU', 'EURO', '\u20ac', 'E R']) {
  test('syncCurrencyRates skips the malformed currency cell ' + JSON.stringify(bad) + ', pulls the rest and names the cell', () => {
    const { p, rates, fx } = fxSetup();
    p.fill('Campaigns', HEADERS.campaigns, [
      ['Euro Co', 'search', '2026-10-05', 100, 10, 1, 'EUR'],
      ['Odd Co', 'search', '2026-10-06', 100, 10, 1, bad],
      ['Odd Co', 'search', '2026-10-07', 100, 10, 1, bad]
    ]);
    const r = p.plain(p.call('syncCurrencyRates', '2026-10-01', '2026-10-10'));
    assert.deepEqual(r.currencies, ['EUR']);
    assert.match(fx.requests[0].url, /quotes=EUR&/);
    assert.deepEqual(r.invalid, [{ value: bad.toUpperCase(), rows: [3, 4] }]);
    const wanted = rates.filter((x) => x.date <= '2026-10-10' && x.quote === 'EUR');
    assert.equal(r.inserted, wanted.length);
  });
}

test('the menu rate pull names a malformed currency cell in its message and still pulls the others', () => {
  const { p } = fxSetup();
  p.fill('Campaigns', HEADERS.campaigns, [
    ['Euro Co', 'search', '2026-10-05', 100, 10, 1, 'EUR'],
    ['Odd Co', 'search', '2026-10-06', 100, 10, 1, 'US$']
  ]);
  p.call('menuSyncRates');
  assert.match(p.w.ui.toasts[0].msg, /new,.*changed\. Fix the currency cell: US\$ on row 3/);
  assert.ok(p.rows('Rates').length > 1);
});

test('a currency list given to syncCurrencyRates is still refused when one code is malformed', () => {
  const { p } = fxSetup();
  assert.throws(() => p.call('syncCurrencyRates', '2026-10-01', '2026-10-10', ['EUR', 'US$']), /3 letter upper case/);
});

test('syncCurrencyRates: a rerun changes nothing, a restated rate is updated, a gap is filled', () => {
  const { p, rates } = fxSetup();
  p.call('syncCurrencyRates', '2026-10-01', '2026-10-10');
  const again = p.plain(p.call('syncCurrencyRates', '2026-10-01', '2026-10-10'));
  assert.deepEqual([again.inserted, again.updated], [0, 0]);
  rates.find((x) => x.date === '2026-10-05' && x.quote === 'EUR').rate = 0.5;
  const third = p.plain(p.call('syncCurrencyRates', '2026-10-01', '2026-10-15'));
  assert.equal(third.updated, 1);
  assert.equal(third.inserted, rates.filter((x) => x.date > '2026-10-10' && x.date <= '2026-10-15').length);
  const row = p.rows('Rates').find((r) => r[0].startsWith('2026-10-05') && r[1] === 'EUR');
  assert.equal(row[2], 0.5);
});

test('rates feed the summary: euro spend is converted with the synced rate', () => {
  const { p, rates } = fxSetup();
  p.call('syncCurrencyRates', '2026-10-01', '2026-10-10');
  p.call('buildClientSummaries');
  const rate = rates.find((x) => x.date === '2026-10-05' && x.quote === 'EUR').rate;
  const all = p.rows('Summary - Euro Co').find((x) => x[1] === 'ALL');
  assert.equal(all[2], Math.round(100 / rate * 100) / 100);
});

test('syncCurrencyRates with only USD asks for nothing', () => {
  const { p, fx } = fxSetup();
  p.w.run(() => p.ss.getSheetByName('Campaigns').getRange(2, 7, 2, 1).setValues([['USD'], ['USD']]));
  const r = p.plain(p.call('syncCurrencyRates', '2026-10-01', '2026-10-10'));
  assert.deepEqual(r, { currencies: [], fetched: 0, inserted: 0, updated: 0, invalid: [] });
  assert.equal(fx.requests.length, 0);
});

test('syncCurrencyRates rejects bad arguments and a reply with a bad rate, writing nothing', () => {
  const { p, rates } = fxSetup();
  assert.throws(() => p.call('syncCurrencyRates', '2026-10-10', '2026-10-01'), /valid date range/);
  assert.throws(() => p.call('syncCurrencyRates', '2026-10-01', '2026-10-10', ['eur']), /3 letter upper case/);
  assert.throws(() => p.call('syncCurrencyRates', '2026-10-01', '2026-10-10', ['USD']), /3 letter upper case/);
  rates[3].rate = -1;
  assert.throws(() => p.call('syncCurrencyRates', '2026-10-01', '2026-10-10'), /bad rate record/);
  assert.equal(p.sheet('Rates'), undefined);
});

test('syncCurrencyRates is not run against the live API anywhere in this repo', () => {
  const { p } = fxSetup();
  assert.equal(p.get('SD.FRANKFURTER_BASE'), 'https://api.frankfurter.dev/v2/rates');
  const bare = loadProject();
  bare.fill('Campaigns', HEADERS.campaigns, [['Euro Co', 'search', '2026-10-05', 100, 10, 1, 'EUR']]);
  assert.throws(() => bare.call('syncCurrencyRates', '2026-10-01', '2026-10-10', ['EUR']), /DNS error|Gave up/);
});

// --------------------------------------------------------------- upsert

test('upsertCampaigns_ keeps the sheet free of duplicate keys when the same key repeats in one batch', () => {
  const p = loadProject();
  p.call('setUp');
  const counts = p.w.run(() => p.ctx.upsertCampaigns_(p.ss, [
    ['A Co', 'search', '2026-10-01', 5, 1, 0, 'USD'],
    ['A Co', 'search', '2026-10-01', 6, 1, 0, 'USD']
  ]));
  assert.deepEqual(p.plain(counts), { inserted: 1, updated: 0, unchanged: 0 });
  assert.equal(p.rows('Campaigns')[1][3], 6);
});
