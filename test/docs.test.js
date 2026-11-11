'use strict';
/**
 * The docs must name what the code does that a reader would not guess. Found by
 * the final blind recall (round 4): F7, Set up changes the Sheet's time zone to
 * America/Chicago and the README's Set up step did not say so; F3, the README and
 * docs/webhook.md had to say that a lead_id is unique for each client.
 */
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const ZONE = JSON.parse(read('src/appsscript.json')).timeZone;

test('the README step that runs Set up says that Set up changes the Sheet time zone, and names the zone from the manifest', () => {
  const steps = read('README.md').split('\n').filter((l) => /^\d+\. /.test(l) && l.includes('**Set up**'));
  assert.equal(steps.length, 1, 'one step runs Set up');
  const step = steps[0];
  assert.match(step, /sets the Sheet's time zone to the script's/);
  assert.ok(step.includes(ZONE), 'the step names ' + ZONE);
  assert.ok(step.includes('src/appsscript.json'), 'and says where the zone comes from');
});

test('docs/maintenance.md has a Set up and the time zone section that names the zone, the file it comes from and the reason', () => {
  const doc = read('docs/maintenance.md');
  const at = doc.indexOf('## Set up and the time zone');
  assert.ok(at !== -1, 'the section exists');
  const section = doc.slice(at, doc.indexOf('\n## ', at + 5));
  assert.ok(section.includes(ZONE), 'the section names ' + ZONE);
  assert.match(section, /Set up changes the Sheet's time zone/);
  assert.match(section, /appsscript\.json/);
  assert.match(section, /a day early/, 'and why');
});

test('the README and docs/webhook.md say that a lead_id is unique for each client', () => {
  assert.match(read('README.md'), /one row per client and lead_id/);
  assert.match(read('README.md'), /one row per client and `lead_id`/);
  const webhook = read('docs/webhook.md');
  assert.match(webhook, /The key is the client and the `lead_id` together/);
  assert.match(webhook, /two clients can both have a lead 1001/);
  assert.match(webhook, /`lead_id`\*\* is unique for each client, not across clients/);
});

test('the docs say that a month close emails clients, refuses an open month and names clients with no address', () => {
  assert.match(read('README.md'), /emails each client the PDF, so it only runs for a month that has ended/);
  const menu = read('docs/menu-and-sidebar.md');
  assert.match(menu, /emails each client the PDF\. Send to me first does not apply here\./);
  assert.match(menu, /has not ended yet/);
  assert.match(menu, /`noAddress`/);
  assert.match(menu, /`defaultMonth`/);
});

test('the README line that promises once-only delivery and docs/webhook.md both say that a refused lead still answers HTTP 200 and that Zapier or Make needs a step that checks ok', () => {
  const lines = read('README.md').split('\n').filter((l) => l.includes('Each lead lands in the Leads tab once'));
  assert.equal(lines.length, 1, 'one feature line makes the promise');
  const promise = lines[0];
  assert.match(promise, /even when Zapier retries/, 'the promise itself is still there');
  assert.match(promise, /always answer HTTP 200, even for a lead they refuse/, 'the same line says it');
  assert.match(promise, /one step in Zapier or Make that stops the run when `ok` is not true/, 'and the step the user adds');
  const doc = read('docs/webhook.md');
  const top = doc.slice(0, doc.indexOf('## Call it'));
  assert.match(top, /\*\*Every reply is HTTP 200, so add an `ok` check\.\*\*/, 'the doc says it before the field list, not only far below');
  assert.match(top, /Zapier and Make count a 200 as a success/);
  assert.match(top, /stops the run, or sends you an alert, when `ok` is not true/);
  assert.match(top, /the once-only delivery below only holds for the leads that were accepted/);
  // every refusal the paragraph names is a code the webhook can answer, and none is made up
  const named = (top.match(/\(`unknown_client`[^)]*\)/) || [''])[0].match(/`(\w+)`/g).map((c) => c.slice(1, -1));
  assert.deepEqual(named, ['unknown_client', 'unknown_field', 'invalid_field', 'unauthorized', 'busy']);
  const source = read('src/Webhook.js');
  for (const code of named) assert.ok(source.includes("'" + code + "'"), code + ' is an answer of src/Webhook.js');
});

test('a refused lead really does answer ok false with nothing that carries a status, which is what the docs tell Zapier and Make users to check', () => {
  const { loadSeeded, HEADERS } = require('./helpers/load');
  const p = loadSeeded();
  p.setProp('WEBHOOK_SECRET', 'SECRET');
  p.fill('Leads', HEADERS.leads, []);
  const post = (body) => {
    const contents = JSON.stringify(body);
    const out = p.call('doPost', { postData: { contents, type: 'application/json', length: contents.length, name: 'postData' }, parameter: {}, parameters: {}, queryString: '', contentLength: contents.length });
    return { reply: JSON.parse(out.getContent()), keys: Object.keys(out) };
  };
  for (const [body, code] of [
    [{ secret: 'SECRET', lead_id: 'a', client: 'Nobody Ltd' }, 'unknown_client'],
    [{ secret: 'SECRET', lead_id: 'b', client: 'Summit Yoga', colour: 'red' }, 'unknown_field'],
    [{ secret: 'SECRET', lead_id: 'c d', client: 'Summit Yoga' }, 'invalid_field'],
    [{ secret: 'WRONG', lead_id: 'e', client: 'Summit Yoga' }, 'unauthorized']
  ]) {
    const { reply, keys } = post(body);
    assert.equal(reply.ok, false, code);
    assert.equal(reply.error, code);
    assert.ok(!keys.some((k) => /status|code/i.test(k)), code + ': the reply object has no field that could carry an HTTP status');
  }
  assert.equal(post({ secret: 'SECRET', lead_id: 'ok-1', client: 'Summit Yoga' }).reply.ok, true);
});

test('the README Limits list the known limits that the fifth pass left as they are', () => {
  const limits = read('README.md').split('## Limits')[1].split('## Stack')[0];
  for (const phrase of [
    /reads "0 done"/,
    /no Latin letter or digit/,
    /repeated `lead_id` for one client is answered `duplicate` even when the other fields changed/,
    /dollar sign cannot be used in a PDF/,
    /emails again when the figures changed by one cent/,
    /rounded to the cent before the rows are added/
  ]) assert.match(limits, phrase);
});

test('the README and docs/testing.md name the equivalent mutants that the mutation run skips, with the count that scripts/mutation.js lists', () => {
  const script = read('scripts/mutation.js');
  const start = script.indexOf('const EQUIVALENT = {');
  const block = script.slice(start, script.indexOf('\n};', start));
  const listed = (block.match(/^\s*'ast:[^']+':/gm) || []).length;
  assert.ok(listed > 0, 'the list is found');
  for (const file of ['README.md', 'docs/testing.md']) {
    const text = read(file);
    assert.ok(text.includes(listed + ' equivalent mutants'), file + ' says "' + listed + ' equivalent mutants", the number in EQUIVALENT');
    assert.match(text, /`EQUIVALENT` in `scripts\/mutation\.js`/, file + ' says where the reasons are');
    assert.ok(!/none was excluded|none were excluded/i.test(text), file + ' does not say that nothing was excluded');
  }
});
