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
