'use strict';
/**
 * Everyday inputs must not meet a new refusal, flag or warning. Ten normal
 * leads, ten normal Campaigns rows and five normal row counts. A fix that
 * makes one of these refused or flagged is wrong.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadProject, loadSeeded, HEADERS } = require('./helpers/load');

const SECRET = 'everyday-secret';

const LEADS = [
  { lead_id: 'e-1', client: 'Summit Yoga', name: 'Ana Archer', email: 'ana.archer@example.com', phone: '+1 555 0123', source: 'facebook', campaign: 'launch-week', message: 'Interested in a quote' },
  { lead_id: 'e-2', client: 'harbor lane bakery', name: 'José Ñandú', email: 'jose@mail.example.co.uk', phone: '(555) 010-9999', source: 'google-ads', campaign: 'brand_search_2026', message: 'Do you do weddings?' },
  { lead_id: 'e-3', client: 'Orchard & Vine', name: 'Li Wei', email: 'li.wei+promo@example.org', phone: '15550123', source: 'organic', campaign: '', message: 'Line one\nLine two' },
  { lead_id: '1004', client: 'Summit Yoga', name: 'Sam', email: '', phone: '', source: '', campaign: '', message: '' },
  { lead_id: 'z:9.5_a-b', client: 'Copperline Plumbing', name: 'O\'Neil Burke', email: "o'neil@example.ie", phone: '+63 965 935 1300', source: 'referral', campaign: 'q4', message: 'a'.repeat(300) },
  { lead_id: 'e-6', client: 'Tidewater Tutors', name: 'Priya R.', email: 'priya@example.com', phone: 5550123, source: 'email', campaign: 'newsletter-oct', message: 'Can someone call me back after 5pm? Thanks!' },
  { lead_id: 'e-7', client: 'Foxglove Florist', name: 'Hana', email: 'hana@example.com', phone: '+1-555-0199', source: 'instagram', campaign: 'spring-offer', message: '50% off still on?' },
  { lead_id: 'e-8', client: 'Lumen Opticals', name: 'Dr. Ines Alves', email: 'ines.alves@clinic.example.pt', phone: '+351 21 000 0000', source: 'google-ads', campaign: 'eye-test', message: 'Booking for 3 people on Oct 5' },
  { lead_id: 'e-9', client: 'Pinecrest Physio', name: 'Tomas', email: 'tomas@example.com', phone: '555 0100', source: 'facebook', campaign: 'back-pain', message: 'Hello' },
  { lead_id: 'e-10', client: 'Summit Yoga', name: 'N'.repeat(120), email: 'a@b.co', phone: '4'.repeat(40), source: 's'.repeat(60), campaign: 'c'.repeat(120), message: 'm'.repeat(2000) }
];

test('ten everyday leads are stored once each, with no warning and no refusal', () => {
  const p = loadSeeded();
  p.setProp('WEBHOOK_SECRET', SECRET);
  p.fill('Leads', HEADERS.leads, []);
  for (const l of LEADS) {
    const contents = JSON.stringify(Object.assign({ secret: SECRET }, l));
    const e = { postData: { contents, type: 'application/json', length: contents.length, name: 'postData' }, parameter: {}, parameters: {}, queryString: '', contentLength: contents.length };
    const r = JSON.parse(p.call('doPost', e).getContent());
    assert.deepEqual(r, { ok: true, duplicate: false, lead_id: String(l.lead_id) }, l.lead_id);
  }
  assert.equal(p.rows('Leads').length, 11);
});

const ROWS = [
  [['Summit Yoga', 'social', '2026-10-03', 120.5, 300, 12, 'USD'], 120.5],
  [['Summit Yoga', 'Search', '2026-10-04', 0, 0, 0, 'USD'], 0],
  [['Summit Yoga', 'search', '2026-10-05', '62.75', '40', '3', 'USD'], 62.75],
  [['Summit Yoga', 'video', '2026-10-06', 19.99, 1, 0, ''], 19.99],
  [['Summit Yoga', 'social', '2026-10-07', 80, 100, 4, 'usd'], 80],
  [['Summit Yoga', 'search', '2026-10-08', 0.1, 1, 0, 'USD'], 0.1],
  [['Summit Yoga', 'search', '2026-10-09', 1000, 5000, 120, 'USD'], 1000],
  [['Summit Yoga', 'social', '2026-10-10', 45.45, 77, 7, 'USD'], 45.45],
  [['Summit Yoga', ' video ', '2026-10-11', 12, 9, 1, 'USD'], 12],
  [['Summit Yoga', 'search', '2026-10-12', 99.99, 1234, 56, 'USD'], 99.99]
];

test('ten everyday Campaigns rows are all counted, none rejected, in the summary and the bulk job', () => {
  const p = loadProject();
  p.fill('Clients', HEADERS.clients, [['Summit Yoga', 'Priya', 'priya@example.com', 'a', 'social', 4000, 'active', '', '']]);
  p.fill('Campaigns', HEADERS.campaigns, ROWS.map((r) => r[0]));
  const r = p.plain(p.call('buildClientSummaries'));
  assert.equal(r.rejected, 0);
  const all = p.rows('Summary - Summit Yoga').find((x) => x[0] === '2026-10' && x[1] === 'ALL');
  assert.equal(Math.round(all[2] * 100), Math.round(ROWS.reduce((a, x) => a + x[1], 0) * 100));
  assert.equal(all[3], 300 + 0 + 40 + 1 + 100 + 1 + 5000 + 77 + 9 + 1234);
  assert.equal(all[4], 12 + 0 + 3 + 0 + 4 + 0 + 120 + 7 + 1 + 56);
  assert.equal(p.call('startBulkNormalize').status, 'done');
  assert.deepEqual(p.rows('Clean').slice(1).map((x) => x[8]), ROWS.map(() => 'ok'));
});

test('five everyday row counts finish in one run with the real settings', () => {
  for (const n of [1, 99, 100, 101, 250]) {
    const p = loadProject();
    p.fill('Campaigns', HEADERS.campaigns, Array.from({ length: n }, (_, i) => ['Summit Yoga', 'social', '2026-12-' + String(1 + (i % 28)).padStart(2, '0'), 10, 5, 1, 'USD']));
    assert.equal(p.call('startBulkNormalize').status, 'done', 'rows ' + n);
    assert.deepEqual(p.rows('Rollup')[1], ['Summit Yoga', '2026-12', n * 10, n * 5, n, n], 'rows ' + n);
    assert.equal(p.w.triggers.length, 0);
  }
});
