'use strict';
/**
 * Two ways a lead was lost with an ok reply, found by the blind adversary pass
 * (test/corpus/corpus_sheetdesk_blind_2.jsonl, lines 14 and 19):
 *
 *  - a JSON number the parser cannot hold exactly (a 17 digit ad platform id)
 *    arrived as a different number, so two people shared one lead_id and the
 *    second was answered "duplicate" and never stored;
 *  - a JSON body sent with a text/plain content type was ignored, so the right
 *    secret was answered "unauthorized".
 *
 * Both are tables built by code, one lead per row.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadSeeded, HEADERS } = require('./helpers/load');

const SECRET = 'numbers-test-secret';
const MAX = BigInt(Number.MAX_SAFE_INTEGER);

function setup() {
  const p = loadSeeded();
  p.setProp('WEBHOOK_SECRET', SECRET);
  p.fill('Leads', HEADERS.leads, []);
  return p;
}

function event(contents, type, parameter) {
  return { postData: { contents, type, length: contents.length, name: 'postData' }, parameter: parameter || {}, parameters: {}, queryString: '', contentLength: contents.length };
}

function reply(p, contents, type, parameter) {
  return JSON.parse(p.call('doPost', event(contents, type, parameter)).getContent());
}

/** The JSON text of a lead with the lead_id written as `idText` exactly (a number is written without quotes). */
function leadText(idText, extra) {
  return '{"secret":"' + SECRET + '","lead_id":' + idText + ',"client":"Harbor Lane Bakery","name":"Ana Archer"' + (extra || '') + '}';
}

const storedIds = (p) => p.rows('Leads').slice(1).map((r) => r[0]);

// CLASS-TABLE: a numeric lead_id across the safe integer limit, in every spelling a Zap or a Make scenario produces
test('CLASS-TABLE: a numeric lead_id is stored when it is a safe integer and refused with a text hint when it is not', () => {
  const numberSpellings = [];
  for (const delta of [-2n, -1n, 0n, 1n, 2n, 3n, 1000n]) {
    numberSpellings.push({ label: 'MAX_SAFE_INTEGER ' + (delta >= 0n ? '+ ' : '- ') + (delta < 0n ? -delta : delta), text: String(MAX + delta), safe: delta <= 0n });
    numberSpellings.push({ label: 'minus MAX_SAFE_INTEGER ' + (delta >= 0n ? '- ' : '+ ') + (delta < 0n ? -delta : delta), text: String(-MAX - delta), safe: delta <= 0n });
  }
  for (const text of ['0', '1', '7', '1001', '99999999', '-5', '12345678901234']) numberSpellings.push({ label: 'small ' + text, text, safe: true });
  for (const text of ['12345678901234567', '12345678901234568', '99999999999999999999', '1e21', '1.5', '0.1', '-2.5', '1e400']) {
    numberSpellings.push({ label: 'not exact ' + text, text, safe: false });
  }
  for (const n of numberSpellings) {
    const p = setup();
    const r = reply(p, leadText(n.text), 'application/json');
    if (n.safe) {
      assert.equal(r.ok, true, n.label);
      assert.equal(r.duplicate, false, n.label);
      assert.deepEqual(storedIds(p), [String(Number(n.text))], n.label + ' is stored as its text');
    } else {
      assert.equal(r.ok, false, n.label);
      assert.equal(r.error, 'invalid_field', n.label);
      assert.equal(r.field, 'lead_id', n.label);
      assert.match(r.hint, /as text/, n.label + ' says to send it as text');
      assert.deepEqual(storedIds(p), [], n.label + ' stores nothing');
    }
  }
});

// CLASS-TABLE: two different ids in every spelling, sent one after the other: none may collapse into the other
test('CLASS-TABLE: two different lead ids are never answered as one, whatever their spelling', () => {
  const pairs = [
    ['12345678901234567', '12345678901234568'],
    [String(MAX), String(MAX + 1n)],
    [String(MAX + 1n), String(MAX + 2n)],
    ['1001', '1002']
  ];
  const spellings = [
    { label: 'both as numbers', a: (t) => t, b: (t) => t },
    { label: 'both as text', a: (t) => '"' + t + '"', b: (t) => '"' + t + '"' },
    { label: 'number then text', a: (t) => t, b: (t) => '"' + t + '"' },
    { label: 'text then number', a: (t) => '"' + t + '"', b: (t) => t }
  ];
  for (const [x, y] of pairs) {
    for (const s of spellings) {
      const p = setup();
      const first = reply(p, leadText(s.a(x), ',"message":"first"'), 'application/json');
      const second = reply(p, leadText(s.b(y), ',"message":"second"'), 'application/json');
      const where = s.label + ' ' + x + ' then ' + y;
      for (const r of [first, second]) {
        // each lead is stored on its own or refused with a reply that says why: never "ok, duplicate" for a lead that is not stored
        if (r.ok) assert.equal(r.duplicate, false, where + ' is not a duplicate');
        else assert.equal(r.error, 'invalid_field', where);
      }
      const messages = p.rows('Leads').slice(1).map((r) => r[8]);
      const okCount = [first, second].filter((r) => r.ok).length;
      assert.equal(messages.length, okCount, where + ': every ok reply has its row');
      assert.equal(new Set(storedIds(p)).size, okCount, where + ': the stored ids differ');
    }
  }
});

// CLASS-TABLE: the same id as a number and as text is one lead, as before
test('CLASS-TABLE: a safe number and its text are one lead', () => {
  for (const id of ['1001', '0', '42', String(MAX)]) {
    const p = setup();
    const first = reply(p, leadText(id), 'application/json');
    const second = reply(p, leadText('"' + id + '"'), 'application/json');
    assert.deepEqual([first.ok, first.duplicate, second.ok, second.duplicate], [true, false, true, true], id);
    assert.equal(p.rows('Leads').length, 2, id);
  }
});

// CLASS-TABLE: only lead_id is held to this; another numeric field is stored as it was
test('CLASS-TABLE: a large number in phone is still stored, only lead_id refuses an inexact number', () => {
  for (const field of ['phone', 'name', 'source', 'campaign', 'message']) {
    for (const text of ['5550123', '12345678901234567', '1.5']) {
      const p = setup();
      const body = '{"secret":"' + SECRET + '","lead_id":"n-1","client":"Harbor Lane Bakery","' + field + '":' + text + '}';
      const r = reply(p, body, 'application/json');
      assert.equal(r.ok, true, field + ' ' + text);
      assert.equal(r.duplicate, false, field + ' ' + text);
    }
  }
});

const GOOD = '{"secret":"' + SECRET + '","lead_id":"ct-1","client":"Harbor Lane Bakery","name":"Ana Archer"}';

/** Body kinds: [label, contents, parameter, reply when the type says json, reply when it does not]. A reply is the error code or 'stored'. */
const BODY_KINDS = [
  ['an object with the right secret', GOOD, {}, 'stored', 'stored'],
  ['an object with leading whitespace', '\n  ' + GOOD + '\n', {}, 'stored', 'stored'],
  ['an object with the wrong secret', GOOD.replace(SECRET, 'wrong'), {}, 'unauthorized', 'unauthorized'],
  ['an object with no secret and none in the URL', GOOD.replace('"secret":"' + SECRET + '",', ''), {}, 'unauthorized', 'unauthorized'],
  ['an object with no secret and the secret in the URL', GOOD.replace('"secret":"' + SECRET + '",', ''), { secret: SECRET }, 'stored', 'stored'],
  ['an array', '[' + GOOD + ']', {}, 'bad_json', 'unauthorized'],
  ['a string', '"' + SECRET + '"', {}, 'bad_json', 'unauthorized'],
  ['a number', '42', {}, 'bad_json', 'unauthorized'],
  ['null', 'null', {}, 'bad_json', 'unauthorized'],
  ['a body cut off', GOOD.slice(0, 40), {}, 'bad_json', 'unauthorized'],
  ['an empty body', '', {}, 'bad_json', 'unauthorized'],
  ['a form body', 'secret=' + SECRET + '&lead_id=ct-1&client=Harbor+Lane+Bakery', { secret: SECRET, lead_id: 'ct-1', client: 'Harbor Lane Bakery' }, 'bad_json', 'stored'],
  ['an object over the size limit', GOOD.slice(0, -1) + ',"message":"' + 'x'.repeat(10001) + '"}', {}, 'too_large', 'too_large']
];

const TYPES = [
  ['application/json', true], ['application/json; charset=utf-8', true], ['APPLICATION/JSON', true], ['text/json', true],
  ['application/vnd.api+json', true],
  ['text/plain', false], ['text/plain; charset=utf-8', false], ['application/x-www-form-urlencoded', false],
  ['multipart/form-data', false], ['application/octet-stream', false], ['', false], [undefined, false]
];

// CLASS-TABLE: every content type against every kind of body
test('CLASS-TABLE: a body that parses to an object is read as JSON whatever the content type says, anything else keeps its reply', () => {
  for (const [type, isJson] of TYPES) {
    for (const [label, contents, parameter, whenJson, whenOther] of BODY_KINDS) {
      const p = setup();
      const r = reply(p, contents, type, parameter);
      const want = isJson ? whenJson : whenOther;
      const where = JSON.stringify(type) + ' with ' + label;
      if (want === 'stored') {
        assert.equal(r.ok, true, where);
        assert.equal(r.duplicate, false, where);
        assert.deepEqual(storedIds(p), ['ct-1'], where);
      } else {
        assert.equal(r.ok, false, where);
        assert.equal(r.error, want, where);
        assert.deepEqual(storedIds(p), [], where);
      }
    }
  }
});

// CLASS-TABLE: a request with no readable body is answered no_body, whatever the rest of the event holds
test('CLASS-TABLE: an event with no text body is answered no_body, with or without a content type or parameters', () => {
  const events = [undefined, null, {}, { parameter: { secret: SECRET } }, { postData: null }, { postData: {} },
    { postData: { type: 'application/json' } }, { postData: { contents: 42, type: 'application/json' } },
    { postData: { contents: null, type: 'text/plain' }, parameter: { secret: SECRET, lead_id: 'n-1', client: 'Summit Yoga' } },
    { postData: { contents: { lead_id: 'n-1' }, type: 'application/json' } }];
  for (const e of events) {
    const p = setup();
    const r = JSON.parse(p.call('doPost', e).getContent());
    assert.deepEqual(r, { ok: false, error: 'no_body' }, JSON.stringify(e));
    assert.deepEqual(storedIds(p), []);
  }
});

// CLASS-TABLE: the body size limit is 10,000 characters: the limit itself is read, one more is refused
test('CLASS-TABLE: a body of exactly 10000 characters is read and one of 10001 is too_large, for every content type', () => {
  for (const [type] of TYPES) {
    for (const [length, want] of [[9999, 'stored'], [10000, 'stored'], [10001, 'too_large'], [20000, 'too_large']]) {
      const p = setup();
      const r = reply(p, GOOD + ' '.repeat(length - GOOD.length), type);
      const where = JSON.stringify(type) + ' at ' + length;
      assert.equal(r.ok, want === 'stored', where);
      if (want === 'stored') assert.deepEqual(storedIds(p), ['ct-1'], where);
      else assert.equal(r.error, want, where);
    }
  }
});
