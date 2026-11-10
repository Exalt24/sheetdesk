'use strict';
/**
 * Stand-in third party APIs for the UrlFetchApp fake: a made-up ad platform
 * and the Frankfurter rates API (v2 shape, checked by hand on 2026-11-10).
 */

function json(code, body, headers) {
  return { code, body, headers };
}

function installAdPlatform(w, { days, apiKey = 'test-key', pageSize = 100, base = 'https://ads.example.test' }) {
  const state = { faults: [], requests: [] };
  w.route((url) => url.startsWith(base + '/v1/costs'), (req) => {
    state.requests.push(req);
    if (req.headers.Authorization !== 'Bearer ' + apiKey) return json(401, { error: 'bad key' });
    const fault = state.faults.shift();
    if (fault) {
      if (fault.html) return { code: 200, headers: { 'Content-Type': 'text/html' }, body: '<html>maintenance</html>' };
      if (fault.throw) return { throw: fault.throw };
      return json(fault.code, { error: 'fault' }, fault.headers);
    }
    const q = new URL(req.url).searchParams;
    const from = q.get('from');
    const to = q.get('to');
    if (!from || !to) return json(400, { error: 'from and to are required' });
    const matching = days.filter((d) => !d || (d.date >= from && d.date <= to));
    const offset = q.get('page_token') ? Number(Buffer.from(q.get('page_token'), 'base64').toString()) : 0;
    const slice = matching.slice(offset, offset + pageSize);
    const next = offset + pageSize < matching.length ? Buffer.from(String(offset + pageSize)).toString('base64') : null;
    return json(200, { data: slice, next_page_token: next });
  });
  return state;
}

function installFrankfurter(w, rates) {
  const state = { requests: [] };
  w.route((url) => url.startsWith('https://api.frankfurter.dev/v2/rates'), (req) => {
    state.requests.push(req);
    const q = new URL(req.url).searchParams;
    if (q.get('base') !== 'USD') return json(422, { status: 422, message: 'unsupported base in this stand-in' });
    const quotes = (q.get('quotes') || '').split(',').filter(Boolean);
    const from = q.get('from') || '0000-00-00';
    const to = q.get('to') || '9999-99-99';
    return json(200, rates.filter((r) => quotes.includes(r.quote) && r.date >= from && r.date <= to));
  });
  return state;
}

module.exports = { installAdPlatform, installFrankfurter };
