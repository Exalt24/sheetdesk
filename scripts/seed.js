'use strict';
/**
 * Seeded generator for a made-up marketing agency. Every client, person,
 * campaign and lead here is invented. Same seed, same files.
 *
 *   node scripts/seed.js            writes fixtures/*.csv and fixtures/*.json
 *   node scripts/seed.js --seed 7   another agency
 */

const fs = require('node:fs');
const path = require('node:path');

/** Small seeded random number generator (mulberry32). */
function rng(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CHANNELS = ['search', 'social', 'display', 'email', 'video'];

const CLIENT_TEMPLATES = [
  { client: 'Harbor Lane Bakery', contact: 'Mira Okafor', ccy: 'USD', channels: ['search', 'social', 'email'], base: 90, status: 'active' },
  { client: 'Pinecrest Physio', contact: 'Tomas Lindqvist', ccy: 'USD', channels: ['search', 'display'], base: 140, status: 'active' },
  { client: 'Orchard & Vine', contact: 'Elena Marchetti', ccy: 'EUR', channels: ['social', 'video', 'search'], base: 120, status: 'active' },
  { client: 'Summit Yoga', contact: 'Priya Raman', ccy: 'USD', channels: ['social', 'email'], base: 60, status: 'active' },
  { client: 'Copperline Plumbing', contact: 'Dale Whitford', ccy: 'USD', channels: ['search', 'display', 'video'], base: 180, status: 'active' },
  { client: 'Lumen Opticals', contact: 'Sofia Brandt', ccy: 'GBP', channels: ['search', 'social'], base: 110, status: 'active' },
  { client: 'Tidewater Tutors', contact: 'Kwame Adeyemi', ccy: 'USD', channels: ['search', 'email', 'social'], base: 70, status: 'active' },
  { client: 'Foxglove Florist', contact: 'Hana Sorensen', ccy: 'USD', channels: ['social', 'display'], base: 50, status: 'active' },
  { client: 'Granite Ridge Climbing', contact: 'Owen Pritchard', ccy: 'USD', channels: ['video', 'social'], base: 80, status: 'paused' }
];

const FIRST = ['Ana', 'Ben', 'Chloe', 'Dev', 'Esme', 'Farid', 'Gita', 'Hugo', 'Ines', 'Jonas', 'Kira', 'Leo', 'Maya', 'Nico', 'Opal', 'Pia'];
const LAST = ['Archer', 'Bell', 'Castillo', 'Dunn', 'Eastman', 'Frost', 'Gill', 'Hale', 'Ivers', 'Joshi', 'Kane', 'Lowe', 'Mercer', 'Nash', 'Ortega', 'Pike'];
const SOURCES = ['google-ads', 'facebook', 'referral', 'organic', 'newsletter'];
const CAMPAIGNS = ['spring-offer', 'brand-search', 'retarget-30d', 'launch-week', 'lookalike-a', 'video-intro'];
const MESSAGES = ['Interested in a quote', 'Can someone call me back?', 'Need opening hours', 'Do you offer weekend slots?', 'Please send pricing'];

function pad(n, w = 2) { return String(n).padStart(w, '0'); }
function isoDay(ms) { return new Date(ms).toISOString().slice(0, 10); }
function daysBetween(fromIso, toIso) {
  const out = [];
  for (let t = Date.parse(fromIso + 'T00:00:00Z'); t <= Date.parse(toIso + 'T00:00:00Z'); t += 86400000) out.push(isoDay(t));
  return out;
}

/** Daily USD based rates for weekdays only, like a central bank feed. */
function generateRates(fromIso, toIso, seed) {
  const rand = rng(seed + 101);
  const level = { EUR: 0.89, GBP: 0.75 };
  const rows = [];
  for (const day of daysBetween(fromIso, toIso)) {
    const dow = new Date(day + 'T00:00:00Z').getUTCDay();
    for (const ccy of Object.keys(level)) {
      level[ccy] = Math.max(0.5, level[ccy] + (rand() - 0.5) * 0.006);
      if (dow !== 0 && dow !== 6) rows.push({ date: day, base: 'USD', quote: ccy, rate: Math.round(level[ccy] * 100000) / 100000 });
    }
  }
  return rows;
}

function generate(seed = 20261110, opts = {}) {
  const from = opts.from || '2026-08-01';
  const to = opts.to || '2026-10-31';
  const rand = rng(seed);
  const clients = CLIENT_TEMPLATES.map((t, i) => {
    const slug = t.client.toLowerCase().replace(/[^a-z0-9]+/g, '');
    return [t.client, t.contact, `${t.contact.split(' ')[0].toLowerCase()}@${slug}.example.com`,
      `acct-${1000 + i * 7}`, t.channels[0], Math.round(t.base * t.channels.length * 30 * 1.1 / 100) * 100, t.status, '', ''];
  });
  const days = daysBetween(from, to);
  const campaigns = [];
  CLIENT_TEMPLATES.forEach((t) => {
    t.channels.forEach((ch) => {
      const chBase = t.base * (0.6 + rand() * 0.9);
      days.forEach((day) => {
        const dow = new Date(day + 'T00:00:00Z').getUTCDay();
        const weekend = dow === 0 || dow === 6 ? 0.7 : 1;
        const spend = Math.round(chBase * weekend * (0.75 + rand() * 0.5) * 100) / 100;
        const cpc = 0.6 + rand() * 1.4;
        const clicks = Math.max(0, Math.round(spend / cpc));
        const conversions = Math.round(clicks * (0.02 + rand() * 0.06));
        campaigns.push([t.client, ch, day, spend, clicks, conversions, t.ccy]);
      });
    });
  });
  const active = CLIENT_TEMPLATES.map((t) => t.client);
  const leads = [];
  for (let i = 0; i < 300; i++) {
    const first = FIRST[Math.floor(rand() * FIRST.length)];
    const last = LAST[Math.floor(rand() * LAST.length)];
    const day = days[Math.floor(rand() * days.length)];
    leads.push([
      `z-${pad(i + 1, 4)}`, `${day}T${pad(Math.floor(rand() * 24))}:${pad(Math.floor(rand() * 60))}:00`,
      active[Math.floor(rand() * active.length)], `${first} ${last}`,
      `${first.toLowerCase()}.${last.toLowerCase()}@example.com`, `+1 555 01${pad(Math.floor(rand() * 100))}`,
      SOURCES[Math.floor(rand() * SOURCES.length)], CAMPAIGNS[Math.floor(rand() * CAMPAIGNS.length)],
      MESSAGES[Math.floor(rand() * MESSAGES.length)]
    ]);
  }
  const rates = generateRates('2026-07-25', '2026-11-02', seed);
  return { clients, campaigns, leads, rates, channels: CHANNELS };
}

/**
 * What the stand-in ad platform serves: one record per account, channel and
 * day for search and social. The last 3 days of the range are restated 2%
 * higher, so a sync after the first one has changes to apply.
 */
function adPlatformDays(data, from, to) {
  const accountOf = {};
  data.clients.forEach((c) => { accountOf[c[0]] = c[3]; });
  const out = [];
  data.campaigns.forEach((r) => {
    if (r[2] < from || r[2] > to || !['search', 'social'].includes(r[1])) return;
    const restated = r[2] > isoDay(Date.parse(to + 'T00:00:00Z') - 3 * 86400000);
    const cost = restated ? Math.round(r[3] * 1.02 * 100) / 100 : r[3];
    out.push({
      date: r[2], account_id: accountOf[r[0]], channel: r[1], cost_micros: Math.round(cost * 1000000),
      currency: r[6], clicks: r[4], conversions: r[5]
    });
  });
  return out;
}

/**
 * Rows for the scale test: n campaign rows, about 1 in 60 of them bad on
 * purpose (blank client, text spend, negative spend, impossible date, unknown
 * currency). Returns the rows and, separately, how many are valid.
 */
function generateScaleRows(n, seed, fromIso = '2025-01-01', toIso = '2026-10-31') {
  const rand = rng(seed);
  const days = daysBetween(fromIso, toIso);
  const names = CLIENT_TEMPLATES.map((t) => [t.client, t.ccy]);
  const rows = new Array(n);
  let valid = 0;
  for (let i = 0; i < n; i++) {
    const [client, ccy] = names[Math.floor(rand() * names.length)];
    const ch = CHANNELS[Math.floor(rand() * CHANNELS.length)];
    const day = days[Math.floor(rand() * days.length)];
    const spend = Math.round((5 + rand() * 400) * 100) / 100;
    const clicks = Math.floor(rand() * 300);
    const conv = Math.floor(rand() * clicks * 0.1);
    const row = [client, ch, day, spend, clicks, conv, ccy];
    if (i % 60 === 7) {
      const kind = Math.floor(rand() * 5);
      if (kind === 0) row[0] = '';
      else if (kind === 1) row[3] = 'n/a';
      else if (kind === 2) row[3] = -Math.abs(spend);
      else if (kind === 3) row[2] = 'soon';
      else row[6] = 'XYZ';
    } else {
      valid++;
    }
    rows[i] = row;
  }
  return { rows, valid };
}

/**
 * An independent reference for the rollup of generateScaleRows rows. It does
 * not use any code under src/. A row counts when it is valid, and its USD
 * amount is rounded to cents before summing.
 */
function referenceRollup(rows, rates) {
  const perUsd = {};
  rates.forEach((r) => { (perUsd[r.quote] = perUsd[r.quote] || {})[r.date] = r.rate; });
  const sums = new Map();
  let counted = 0;
  rows.forEach((row) => {
    const [client, channel, day, spend, clicks, conv, ccy] = row;
    if (!client || !channel || typeof spend !== 'number' || spend < 0 || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return;
    let rate = 1;
    if (ccy !== 'USD') {
      const table = perUsd[ccy];
      if (!table) return;
      let t = Date.parse(day + 'T00:00:00Z');
      let found = null;
      for (let k = 0; k <= 7; k++, t -= 86400000) {
        if (table[isoDay(t)] !== undefined) { found = table[isoDay(t)]; break; }
      }
      if (found === null) return;
      rate = found;
    }
    const cents = Math.round(Math.round(spend / rate * 100) / 100 * 100);
    const key = client + '|' + day.slice(0, 7);
    const s = sums.get(key) || { cents: 0, clicks: 0, conversions: 0, rows: 0 };
    s.cents += cents; s.clicks += clicks; s.conversions += conv; s.rows += 1;
    sums.set(key, s);
    counted++;
  });
  return { sums, counted };
}

function csvCell(v) {
  const s = String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function toCsv(header, rows) {
  return [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
}

/** Parses the simple CSV this file writes. */
function parseCsv(text) {
  const rows = [];
  let row = []; let cell = ''; let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; } else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function writeFixtures(dir, seed) {
  const data = generate(seed);
  fs.mkdirSync(dir, { recursive: true });
  const H = {
    clients: ['client', 'contact_name', 'contact_email', 'ad_account_id', 'primary_channel', 'monthly_budget', 'status', 'intake_response_id', 'created_at'],
    campaigns: ['client', 'channel', 'date', 'spend', 'clicks', 'conversions', 'currency'],
    leads: ['lead_id', 'received_at', 'client', 'name', 'email', 'phone', 'source', 'campaign', 'message'],
    rates: ['date', 'currency', 'per_usd']
  };
  fs.writeFileSync(path.join(dir, 'clients.csv'), toCsv(H.clients, data.clients));
  fs.writeFileSync(path.join(dir, 'campaigns.csv'), toCsv(H.campaigns, data.campaigns));
  fs.writeFileSync(path.join(dir, 'leads.csv'), toCsv(H.leads, data.leads));
  // The same rates in the column layout of the Rates tab, ready for File, Import.
  fs.writeFileSync(path.join(dir, 'rates.csv'), toCsv(H.rates, data.rates.map((r) => [r.date, r.quote, r.rate])));
  fs.writeFileSync(path.join(dir, 'rates.json'), JSON.stringify(data.rates, null, 1) + '\n');
  fs.writeFileSync(path.join(dir, 'ad_platform_days.json'), JSON.stringify(adPlatformDays(data, '2026-10-01', '2026-10-31'), null, 1) + '\n');
  return { clients: data.clients.length, campaigns: data.campaigns.length, leads: data.leads.length, rates: data.rates.length };
}

module.exports = { generate, generateRates, adPlatformDays, generateScaleRows, referenceRollup, parseCsv, toCsv, rng, CHANNELS, CLIENT_TEMPLATES };

if (require.main === module) {
  const i = process.argv.indexOf('--seed');
  const seed = i > -1 ? Number(process.argv[i + 1]) : 20261110;
  const counts = writeFixtures(path.join(__dirname, '..', 'fixtures'), seed);
  console.log('seed ' + seed + ': ' + JSON.stringify(counts));
}
