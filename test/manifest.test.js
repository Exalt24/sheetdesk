'use strict';
/**
 * The OAuth scopes in src/appsscript.json. Each one is listed in the reference
 * for a method this repo calls (see docs/maintenance.md for the table), the
 * list has no Gmail scope, and each scope is needed: with one removed, some
 * feature fails with a permission error.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadSeeded } = require('./helpers/load');
const { installAdPlatform } = require('./fake/services');

const MANIFEST = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'appsscript.json'), 'utf8'));
const SCOPES = MANIFEST.oauthScopes;

const EXPECTED = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/script.send_mail',
  'https://www.googleapis.com/auth/forms',
  'https://www.googleapis.com/auth/script.external_request',
  'https://www.googleapis.com/auth/script.scriptapp',
  'https://www.googleapis.com/auth/script.container.ui',
  'https://www.googleapis.com/auth/userinfo.email'
];

/** Runs every feature once with these scopes and returns the permission errors it met. */
function permissionErrors(scopes) {
  let p;
  try {
    p = loadSeeded({ scopes });
  } catch (e) {
    return ['setup: ' + e.message];
  }
  const errors = [];
  const step = (name, fn) => {
    try {
      const out = fn();
      const text = JSON.stringify(out === undefined ? null : out);
      if (/failed: .*not sufficient/.test(text)) errors.push(name + ': ' + text);
    } catch (e) {
      errors.push(name + ': ' + e.message);
    }
  };
  p.setProp('WEBHOOK_SECRET', 'manifest-test-secret');
  p.setProp('AD_API_KEY', 'k');
  installAdPlatform(p.w, { days: p.fx.adDays, apiKey: 'k' });
  step('setUp', () => p.call('setUp'));
  step('onOpen', () => p.w.callSimple('onOpen', {}));
  step('openDesk', () => p.call('openDesk'));
  step('sidebarGetOptions', () => p.call('sidebarGetOptions'));
  step('runClientReport', () => p.call('runClientReport', 'Harbor Lane Bakery', '2026-10'));
  step('sidebarRunReport', () => p.call('sidebarRunReport', 'Harbor Lane Bakery', '2026-09', true));
  step('installIntakeTrigger', () => p.call('installIntakeTrigger'));
  step('syncAdCosts', () => p.call('syncAdCosts', '2026-10-01', '2026-10-05'));
  step('doPost', () => {
    const body = JSON.stringify({ secret: 'manifest-test-secret', lead_id: 'm-1', client: 'Summit Yoga' });
    const out = p.call('doPost', { postData: { contents: body, type: 'application/json' }, parameter: {} });
    return JSON.parse(out.getContent()).ok ? null : 'doPost refused';
  });
  step('startBulkNormalize', () => p.call('startBulkNormalize'));
  return errors;
}

test('the manifest lists exactly the scopes in the table, and no Gmail scope', () => {
  assert.deepEqual([...SCOPES].sort(), [...EXPECTED].sort());
  assert.ok(!SCOPES.some((s) => /gmail|mail\.google\.com/.test(s)), 'sending uses MailApp, which needs only script.send_mail');
});

test('with every scope in the manifest, every feature runs', () => {
  assert.deepEqual(permissionErrors(SCOPES), []);
});

for (const scope of EXPECTED) {
  test('the scope is needed, a feature stops without it: ' + scope.replace('https://www.googleapis.com/auth/', ''), () => {
    const errors = permissionErrors(SCOPES.filter((s) => s !== scope));
    assert.ok(errors.length > 0, 'nothing failed without ' + scope + ', so it is not needed');
    assert.ok(errors.every((e) => /not sufficient|^setup:/.test(e)), 'only permission errors expected: ' + errors.join(' | '));
  });
}

test('.clasp.json sets the source folder and the push order, and holds no script id', () => {
  const root = path.join(__dirname, '..');
  const clasp = JSON.parse(fs.readFileSync(path.join(root, '.clasp.json'), 'utf8'));
  assert.equal(clasp.rootDir, 'src');
  assert.equal(clasp.scriptId, undefined, 'the id belongs to whoever deploys, so it is not committed');
  assert.deepEqual(clasp.filePushOrder, ['src/Config.js', 'src/Util.js']);
  for (const f of clasp.filePushOrder) assert.ok(fs.existsSync(path.join(root, f)), f + ' exists');
  // The test loader puts the same two files first, so the tests and a push see one order.
  const { sourceFiles } = require('./helpers/load');
  assert.deepEqual(sourceFiles().slice(0, 2), ['Config.js', 'Util.js']);
});
