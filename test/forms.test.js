'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadProject, loadSeeded } = require('./helpers/load');

const T = {
  CLIENT: 'Client name', CONTACT: 'Contact name', EMAIL: 'Contact email',
  CHANNEL: 'Primary channel', BUDGET: 'Monthly budget (USD)', NOTES: 'Notes'
};

function answers(over = {}) {
  return Object.assign({
    [T.CLIENT]: 'Bluebell Bikes', [T.CONTACT]: 'Rae Delgado', [T.EMAIL]: 'rae@bluebellbikes.example.com',
    [T.CHANNEL]: 'social', [T.BUDGET]: '2,500', [T.NOTES]: 'Starts in March'
  }, over);
}

function installed(p) {
  const r = p.plain(p.call('installIntakeTrigger'));
  return { r, form: p.w.forms.get(r.formId) };
}

test('the installer makes the form and one form submit trigger', () => {
  const p = loadProject();
  const { r, form } = installed(p);
  assert.deepEqual(form.getItems().map((i) => i.getTitle()), Object.values(T));
  assert.deepEqual(form.getItems().map((i) => i.isRequired()), [true, true, true, true, false, false]);
  assert.equal(p.w.triggers.length, 1);
  assert.equal(p.w.triggers[0].handler, 'onIntakeSubmit');
  assert.equal(p.w.triggers[0].eventType, 'ON_FORM_SUBMIT');
  assert.equal(p.w.triggers[0].formId, r.formId);
  assert.equal(p.prop('INTAKE_FORM_ID'), r.formId);
  assert.match(r.url, /viewform$/);
});

test('running the installer again keeps one form and one trigger', () => {
  const p = loadProject();
  const first = installed(p).r;
  const second = installed(p).r;
  assert.equal(second.formId, first.formId);
  assert.equal(p.w.forms.size, 1);
  assert.equal(p.w.triggers.length, 1);
  assert.notEqual(second.triggerId, first.triggerId);
});

test('if the saved form was deleted the installer makes a new one', () => {
  const p = loadProject();
  const first = installed(p).r;
  p.w.forms.delete(first.formId);
  const second = installed(p).r;
  assert.notEqual(second.formId, first.formId);
  assert.equal(p.w.triggers.length, 1);
  assert.equal(p.w.triggers[0].formId, second.formId);
});

test('the installer needs real authorisation: a simple trigger context cannot create triggers', () => {
  const p = loadProject();
  assert.throws(() => p.w.callSimple('installIntakeTrigger'), /You do not have permission to call/);
});

test('a submission becomes a Clients row and a confirmation email', () => {
  const p = loadProject();
  p.call('setUp');
  const { form } = installed(p);
  const [res] = p.w.submitForm(form, answers());
  assert.deepEqual(p.plain(res), { status: 'active', client: 'Bluebell Bikes', emailed: true });
  const row = p.rows('Clients')[1];
  assert.deepEqual(row.slice(0, 8), ['Bluebell Bikes', 'Rae Delgado', 'rae@bluebellbikes.example.com', '', 'social', 2500, 'active', row[7]]);
  assert.match(row[7], /^resp/, 'the response id is stored');
  assert.match(row[8], /^2026-11-10T/);
  assert.equal(p.w.sent.length, 1);
  assert.equal(p.w.sent[0].to, 'rae@bluebellbikes.example.com');
  assert.match(p.w.sent[0].subject, /Bluebell Bikes/);
  assert.match(p.w.sent[0].body, /Hello Rae Delgado/);
  assert.deepEqual(p.w.violations, []);
});

test('the fake form refuses a submission the real form would refuse', () => {
  const p = loadProject();
  const { form } = installed(p);
  assert.throws(() => p.w.submitForm(form, answers({ [T.CLIENT]: '' })), /Required item missing/);
  assert.throws(() => p.w.submitForm(form, answers({ [T.CHANNEL]: 'billboards' })), /Not a valid choice/);
  assert.equal(p.rows('Clients'), null);
});

test('a bad email or budget is stored as needs_review and nobody is emailed', () => {
  const p = loadProject();
  const { form } = installed(p);
  const [a] = p.w.submitForm(form, answers({ [T.EMAIL]: 'not an email' }));
  const [b] = p.w.submitForm(form, answers({ [T.CLIENT]: 'Second Co', [T.BUDGET]: 'lots' }));
  const [c] = p.w.submitForm(form, answers({ [T.CLIENT]: 'Third Co', [T.BUDGET]: '-5' }));
  assert.deepEqual([a, b, c].map((x) => p.plain(x).status), ['needs_review', 'needs_review', 'needs_review']);
  assert.equal(p.w.sent.length, 0);
  assert.equal(p.rows('Clients').length, 4, 'all three are kept for a person to look at');
});

test('a client name that already exists is needs_review, not a second active row', () => {
  const p = loadProject();
  const { form } = installed(p);
  p.w.submitForm(form, answers());
  const [again] = p.w.submitForm(form, answers({ [T.CLIENT]: 'BLUEBELL BIKES' }));
  assert.equal(p.plain(again).status, 'needs_review');
  assert.equal(p.w.sent.length, 1);
});

test('the same response delivered twice is one row and one email', () => {
  const p = loadProject();
  const { form } = installed(p);
  p.w.submitForm(form, answers());
  const response = form.getResponses()[0];
  const [second] = p.w.deliverFormResponse(form, response);
  assert.equal(p.plain(second).status, 'duplicate');
  assert.equal(p.rows('Clients').length, 2);
  assert.equal(p.w.sent.length, 1);
});

test('two deliveries at the same moment: the lock keeps it to one row', () => {
  const p = loadProject();
  const { form } = installed(p);
  p.w.submitForm(form, answers({ [T.CLIENT]: 'Warm Up Co' }));
  const response = form.getResponses()[0];
  const fresh = Object.assign({}, response, { getId: () => 'resp-race' });
  let nestedError = null;
  let fired = false;
  p.w.hook = ({ name }) => {
    if (name === 'Sheet.appendRow' && !fired) {
      fired = true;
      try { p.w.deliverFormResponse(form, fresh); } catch (e) { nestedError = e; }
    }
  };
  p.w.deliverFormResponse(form, fresh);
  p.w.hook = null;
  assert.match(nestedError.message, /Lock timeout/, 'the second delivery had to wait and gave up');
  const [retry] = p.w.deliverFormResponse(form, fresh);
  assert.equal(p.plain(retry).status, 'duplicate');
  assert.equal(p.rows('Clients').filter((r) => r[7] === 'resp-race').length, 1);
});

test('if the confirmation email fails the row is still saved', () => {
  const p = loadProject({ world: { mailQuota: 0 } });
  const { form } = installed(p);
  const [res] = p.w.submitForm(form, answers());
  assert.deepEqual(p.plain(res), { status: 'active', client: 'Bluebell Bikes', emailed: false });
  assert.equal(p.rows('Clients').length, 2);
  assert.match(p.w.logs.join('\n'), /Confirmation email failed/);
});

test('text that starts like a formula is stored as text', () => {
  const p = loadProject();
  const { form } = installed(p);
  p.w.submitForm(form, answers({ [T.CLIENT]: '=HYPERLINK("http://x.example.test","a")', [T.CONTACT]: '+1 555' }));
  assert.deepEqual(p.w.formulas, []);
  assert.equal(p.rows('Clients')[1][0], '=HYPERLINK("http://x.example.test","a")');
  assert.equal(p.rows('Clients')[1][1], '+1 555');
});

test('a new client from the form is accepted by the webhook at once, not after the cache expires', () => {
  const p = loadSeeded();
  p.setProp('WEBHOOK_SECRET', 's');
  const post = (client) => {
    const body = JSON.stringify({ secret: 's', lead_id: 'x-' + client.length, client });
    return JSON.parse(p.call('doPost', { postData: { contents: body, type: 'application/json' }, parameter: {} }).getContent());
  };
  assert.equal(post('Bluebell Bikes').error, 'unknown_client');
  const { form } = installed(p);
  p.w.submitForm(form, answers());
  assert.equal(post('Bluebell Bikes').ok, true);
});

test('the handler refuses an event with no response', () => {
  const p = loadProject();
  assert.throws(() => p.call('onIntakeSubmit', {}), /needs a form response event/);
  assert.throws(() => p.call('onIntakeSubmit'), /needs a form response event/);
});

test('the Forms scope is needed in the manifest', () => {
  const p = loadProject({ scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/script.scriptapp'] });
  assert.throws(() => p.call('installIntakeTrigger'), /Specified permissions are not sufficient to call FormApp/);
});
