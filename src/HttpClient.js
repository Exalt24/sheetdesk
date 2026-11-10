/**
 * A small JSON client around UrlFetchApp: retries with exponential backoff on
 * 429 and 5xx, honours Retry-After, checks the response, follows pagination.
 */

/**
 * Builds an error that carries the HTTP status and the attempt count.
 * @param {string} message
 * @param {?number} status
 * @param {number} attempts
 * @return {Error}
 */
function httpError_(message, status, attempts) {
  const err = new Error(message);
  err.name = 'HttpError';
  err.status = status;
  err.attempts = attempts;
  return err;
}

/**
 * Case insensitive header lookup.
 * @param {Object} headers
 * @param {string} name
 * @return {?string}
 */
function headerValue_(headers, name) {
  const want = name.toLowerCase();
  const keys = Object.keys(headers || {});
  for (let i = 0; i < keys.length; i++) {
    if (keys[i].toLowerCase() === want) return String(headers[keys[i]]);
  }
  return null;
}

/**
 * Milliseconds to wait before attempt n+1. Exponential, capped, with jitter
 * between half and the full delay.
 * @param {number} attempt the attempt that just failed, starting at 1
 * @param {number} baseMs
 * @param {number} maxMs
 * @param {function(): number} random returns a number in [0, 1)
 * @return {number}
 */
function backoffMs_(attempt, baseMs, maxMs, random) {
  const delay = Math.min(maxMs, baseMs * Math.pow(2, attempt - 1));
  return Math.round(delay / 2 + random() * (delay / 2));
}

/**
 * GET or POST a URL and return parsed JSON.
 * Retries on 429, any 5xx, and on a thrown fetch error (DNS, timeout).
 * Does not retry other 4xx: a 401 or 404 will not fix itself.
 * @param {string} url
 * @param {{method: (string|undefined), headers: (Object|undefined), payload: (string|undefined),
 *   maxAttempts: (number|undefined), baseDelayMs: (number|undefined), maxDelayMs: (number|undefined),
 *   random: (function(): number|undefined), validate: (function(*): ?string|undefined),
 *   deadlineMs: (number|undefined)}} [options]
 *   validate returns an error text for a bad body or null when fine.
 *   deadlineMs is an epoch time after which no further wait is started.
 * @return {{status: number, json: *, headers: Object, attempts: number}}
 */
function httpJson_(url, options) {
  const o = Object.assign({
    method: 'get',
    headers: {},
    maxAttempts: 5,
    baseDelayMs: 500,
    maxDelayMs: 30000,
    random: Math.random,
    validate: null,
    deadlineMs: null
  }, options || {});
  let lastProblem = 'no attempt made';
  let lastStatus = null;
  for (let attempt = 1; attempt <= o.maxAttempts; attempt++) {
    let waitMs;
    try {
      const params = { method: o.method, headers: o.headers, muteHttpExceptions: true };
      if (o.payload !== undefined) {
        params.payload = o.payload;
        params.contentType = 'application/json';
      }
      const res = UrlFetchApp.fetch(url, params);
      const code = res.getResponseCode();
      if (code >= 200 && code < 300) {
        return checkJsonBody_(res, code, o.validate, attempt);
      }
      if (code !== 429 && code < 500) {
        throw httpError_('HTTP ' + code + ' from ' + url, code, attempt);
      }
      lastProblem = 'HTTP ' + code;
      lastStatus = code;
      const retryAfter = Number(headerValue_(res.getAllHeaders(), 'Retry-After'));
      waitMs = retryAfter > 0 && isFinite(retryAfter)
        ? Math.min(o.maxDelayMs, retryAfter * 1000)
        : backoffMs_(attempt, o.baseDelayMs, o.maxDelayMs, o.random);
    } catch (err) {
      if (err && err.name === 'HttpError') throw err;
      lastProblem = String(err && err.message ? err.message : err);
      lastStatus = null;
      waitMs = backoffMs_(attempt, o.baseDelayMs, o.maxDelayMs, o.random);
    }
    if (attempt === o.maxAttempts) break;
    if (o.deadlineMs !== null && Date.now() + waitMs > o.deadlineMs) {
      throw httpError_('Retry would pass the time budget after attempt ' + attempt + ': ' + lastProblem, lastStatus, attempt);
    }
    Utilities.sleep(waitMs);
  }
  throw httpError_('Gave up after ' + o.maxAttempts + ' attempts: ' + lastProblem, lastStatus, o.maxAttempts);
}

/**
 * Checks a 2xx response: content type, parseable body, caller validation.
 * A 200 with an HTML error page is a failure, not data.
 * @param {GoogleAppsScript.URL_Fetch.HTTPResponse} res
 * @param {number} code
 * @param {?function(*): ?string} validate
 * @param {number} attempt
 * @return {{status: number, json: *, headers: Object, attempts: number}}
 */
function checkJsonBody_(res, code, validate, attempt) {
  const headers = res.getHeaders();
  const type = headerValue_(headers, 'Content-Type') || '';
  if (type.toLowerCase().indexOf('json') === -1) {
    // COPY-OK: error text for the script log, read by a developer, never shown in the sheet UI
    throw httpError_('Expected JSON but got content type "' + type + '"', code, attempt);
  }
  let json;
  try {
    json = JSON.parse(res.getContentText());
  } catch (e) {
    // COPY-OK: error text for the script log, read by a developer, never shown in the sheet UI
    throw httpError_('Response body is not valid JSON', code, attempt);
  }
  if (validate) {
    const problem = validate(json);
    if (problem) throw httpError_('Unexpected response: ' + problem, code, attempt);
  }
  return { status: code, json: json, headers: headers, attempts: attempt };
}

/**
 * Follows a cursor style pagination until the next token is empty.
 * @param {function(?string): string} urlFor builds the URL for a page token (null for the first page)
 * @param {Object} httpOptions passed to httpJson_
 * @param {{itemsKey: string, nextKey: string, maxPages: (number|undefined)}} shape
 * @return {{items: Array<*>, pages: number}}
 */
function fetchAllPages_(urlFor, httpOptions, shape) {
  const maxPages = shape.maxPages || 200;
  const seen = {};
  const items = [];
  let token = null;
  let pages = 0;
  do {
    if (pages >= maxPages) throw new Error('Pagination did not end after ' + maxPages + ' pages.');
    const res = httpJson_(urlFor(token), httpOptions);
    const body = res.json;
    if (!body || !Array.isArray(body[shape.itemsKey])) {
      throw new Error('Page ' + (pages + 1) + ' has no "' + shape.itemsKey + '" array.');
    }
    body[shape.itemsKey].forEach(function (it) { items.push(it); });
    pages++;
    token = body[shape.nextKey] || null;
    if (token !== null) {
      if (seen[token]) throw new Error('Pagination loop: token "' + token + '" came back.');
      seen[token] = true;
    }
  } while (token !== null);
  return { items: items, pages: pages };
}
