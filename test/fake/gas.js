'use strict';
/**
 * A local fake of the Google Apps Script services this repo uses.
 *
 * It was written from Google's public Apps Script reference
 * (developers.google.com/apps-script/reference). It is NOT Google's code and
 * has never been compared against a live account. Where the documentation is
 * silent, the fake is strict (it throws), so a script that passes here is not
 * relying on behaviour nobody documented. Each rule below says which kind it
 * is: DOC (stated in the reference), KNOWN (wording or behaviour seen in
 * practice, not in the reference) or STRICT (a deliberate choice, the real
 * service may accept more).
 *
 * Scopes (SCOPE below) follow the per method "Authorization" lists in the
 * reference, and a call is accepted only with a scope the reference lists for
 * it. GmailApp lists only https://mail.google.com/. MailApp lists only
 * script.send_mail. Session.getActiveUser lists userinfo.email. The
 * spreadsheets.currentonly scope is accepted where the reference lists it
 * beside spreadsheets, and SpreadsheetApp.openById and create list only
 * spreadsheets. script.container.ui is KNOWN: the Ui pages state no scope and
 * the Spreadsheet.show page names it.
 *
 * The clock is simulated. Every service call advances it by a cost, the 6
 * minute execution limit is enforced, and Utilities.sleep moves it forward
 * without waiting.
 */

const crypto = require('node:crypto');
const vm = require('node:vm');

const MAX_EXEC_MS = 6 * 60 * 1000;
const SCOPE = {
  sheets: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/spreadsheets.currentonly'],
  docs: ['https://www.googleapis.com/auth/documents'],
  drive: ['https://www.googleapis.com/auth/drive'],
  sheetsFull: ['https://www.googleapis.com/auth/spreadsheets'],
  gmail: ['https://mail.google.com/'],
  mail: ['https://www.googleapis.com/auth/script.send_mail'],
  user: ['https://www.googleapis.com/auth/userinfo.email'],
  forms: ['https://www.googleapis.com/auth/forms'],
  fetch: ['https://www.googleapis.com/auth/script.external_request'],
  triggers: ['https://www.googleapis.com/auth/script.scriptapp'],
  ui: ['https://www.googleapis.com/auth/script.container.ui']
};

class ExecutionKilled extends Error {
  constructor(msg) {
    super(msg || 'Execution killed by the test');
    this.name = 'ExecutionKilled';
  }
}

/** Errors thrown by Google services have the name Exception. */
function gasError(message) {
  const e = new Error(message);
  e.name = 'Exception';
  return e;
}

const isDateObj = (v) => Object.prototype.toString.call(v) === '[object Date]';

// ---------------------------------------------------------------- time zones

const dtfCache = new Map();
function dtf(tz) {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short'
    });
    dtfCache.set(tz, f);
  }
  return f;
}

function zoneParts(ts, tz) {
  const o = {};
  for (const p of dtf(tz).formatToParts(new Date(ts))) o[p.type] = p.value;
  return {
    y: Number(o.year), mo: Number(o.month), d: Number(o.day),
    h: Number(o.hour), mi: Number(o.minute), s: Number(o.second), wd: o.weekday
  };
}

function zoneOffsetMs(ts, tz) {
  const p = zoneParts(ts, tz);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ts / 1000) * 1000;
}

/** The instant of local midnight in a zone. */
function zonedMidnight(y, mo, d, tz) {
  const guess = Date.UTC(y, mo - 1, d);
  let ts = guess - zoneOffsetMs(guess, tz);
  ts = guess - zoneOffsetMs(ts, tz);
  return ts;
}

function formatDate(date, tz, pattern) {
  if (!isDateObj(date)) throw gasError('The parameters (' + typeof date + ',string,string) do not match the method signature for Utilities.formatDate.');
  const ts = date.getTime();
  const p = zoneParts(ts, tz);
  const pad = (n, w) => String(n).padStart(w, '0');
  const off = zoneOffsetMs(ts, tz) / 60000;
  const sign = off < 0 ? '-' : '+';
  const offH = pad(Math.floor(Math.abs(off) / 60), 2);
  const offM = pad(Math.abs(off) % 60, 2);
  let out = '';
  for (let i = 0; i < pattern.length;) {
    if (pattern[i] === "'") {
      if (pattern[i + 1] === "'") { out += "'"; i += 2; continue; }
      const end = pattern.indexOf("'", i + 1);
      if (end === -1) throw gasError('Unterminated quote in date pattern');
      out += pattern.slice(i + 1, end);
      i = end + 1;
      continue;
    }
    const rest = pattern.slice(i);
    const tok = ['yyyy', 'SSS', 'EEE', 'XXX', 'MM', 'dd', 'HH', 'mm', 'ss', 'yy', 'Z', 'X'].find((t) => rest.startsWith(t));
    if (!tok) { out += pattern[i]; i++; continue; }
    switch (tok) {
      case 'yyyy': out += pad(p.y, 4); break;
      case 'yy': out += pad(p.y % 100, 2); break;
      case 'MM': out += pad(p.mo, 2); break;
      case 'dd': out += pad(p.d, 2); break;
      case 'HH': out += pad(p.h, 2); break;
      case 'mm': out += pad(p.mi, 2); break;
      case 'ss': out += pad(p.s, 2); break;
      case 'SSS': out += pad(((ts % 1000) + 1000) % 1000, 3); break;
      case 'EEE': out += p.wd; break;
      case 'Z': out += sign + offH + offM; break;
      case 'X': out += off === 0 ? 'Z' : sign + offH; break;
      case 'XXX': out += off === 0 ? 'Z' : sign + offH + ':' + offM; break;
      default: break;
    }
    i += tok.length;
  }
  return out;
}

// -------------------------------------------------------------------- world

function createWorld(opts = {}) {
  const w = {
    now: opts.now !== undefined ? opts.now : Date.UTC(2026, 10, 10, 15, 0, 0),
    tz: opts.tz || 'America/Chicago',
    execStart: 0,
    execId: 0,
    execCounter: 0,
    mode: 'normal',
    calls: 0,
    cost: Object.assign({ callMs: 15, readCellMs: 0.002, writeCellMs: 0.01, fetchMs: 120 }, opts.cost),
    killWhen: null,
    dead: null,
    sleeps: [],
    hook: null,
    manifest: opts.manifest || null,
    htmlFiles: opts.htmlFiles || {},
    ctx: null,
    violations: [],
    formulas: [],
    logs: [],
    sent: [],
    activeUserEmail: opts.activeUserEmail !== undefined ? opts.activeUserEmail : 'owner@example.test',
    mailQuota: opts.mailQuota !== undefined ? opts.mailQuota : 100,
    nextId: 1,
    props: { script: new Map(), user: new Map(), document: new Map() },
    caches: { script: new Map(), user: new Map(), document: new Map() },
    locks: { script: { holder: null, releaseAt: null }, user: { holder: null, releaseAt: null }, document: { holder: null, releaseAt: null } },
    unflushed: false,
    triggers: [],
    files: new Map(),
    forms: new Map(),
    spreadsheets: new Map(),
    openDocs: new Set(),
    http: { routes: [], log: [], calls: 0 },
    ui: { menus: [], sidebar: null, dialog: null, alerts: [], toasts: [] },
    activeSpreadsheet: null,
    openOrder: []
  };

  const newId = (prefix) => prefix + String(w.nextId++).padStart(5, '0');

  // ---- execution control
  function svc(name, o = {}) {
    w.calls++;
    // After a kill nothing more runs: a finally block that calls a service is killed too.
    if (w.dead) throw w.dead;
    if (w.hook) w.hook({ name, n: w.calls });
    if (w.killWhen && w.killWhen({ name, n: w.calls })) {
      w.dead = new ExecutionKilled();
      throw w.dead;
    }
    if (w.now - w.execStart > MAX_EXEC_MS) {
      w.dead = gasError('Exceeded maximum execution time');
      throw w.dead;
    }
    if (o.scope && w.manifest && Array.isArray(w.manifest.oauthScopes)) {
      if (!o.scope.some((s) => w.manifest.oauthScopes.includes(s))) {
        throw gasError('Specified permissions are not sufficient to call ' + name + '. Required permissions: ' + o.scope[0]);
      }
    }
    if (o.restricted && w.mode === 'simple') {
      throw gasError('You do not have permission to call ' + name + '. Required permissions: ' + (o.scope ? o.scope[0] : 'authorisation'));
    }
    w.now += w.cost.callMs + (o.cells || 0) * (o.write ? w.cost.writeCellMs : w.cost.readCellMs);
  }

  function heldLocks() {
    return Object.values(w.locks).filter((l) => l.holder === w.execId).length;
  }

  function endExecution() {
    for (const l of Object.values(w.locks)) if (l.holder === w.execId) l.holder = null;
    for (const d of w.openDocs) if (d.execId === w.execId) d.commit();
    for (const d of [...w.openDocs]) if (d.execId === w.execId) w.openDocs.delete(d);
    if (w.now - w.execStart > MAX_EXEC_MS) throw gasError('Exceeded maximum execution time');
  }

  /**
   * Runs fn as one execution (nested runs are allowed, to simulate two
   * requests that overlap). Returns what fn returns.
   */
  function run(fn, runOpts = {}) {
    const saved = { start: w.execStart, id: w.execId, mode: w.mode, calls: w.calls, dead: w.dead };
    w.dead = null;
    w.execStart = w.now;
    w.execId = ++w.execCounter;
    w.mode = runOpts.mode || 'normal';
    w.calls = 0;
    try {
      const result = fn();
      endExecution();
      return result;
    } catch (e) {
      if (!(e instanceof ExecutionKilled)) {
        try { endExecution(); } catch (e2) { /* the original error matters more */ }
      } else {
        for (const l of Object.values(w.locks)) if (l.holder === w.execId) l.holder = null;
        for (const d of [...w.openDocs]) if (d.execId === w.execId) w.openDocs.delete(d);
      }
      throw e;
    } finally {
      w.execStart = saved.start;
      w.execId = saved.id;
      w.mode = saved.mode;
      w.calls = saved.calls;
      w.dead = saved.dead;
    }
  }

  // ---- Blob
  class Blob {
    constructor(bytes, type, name) {
      this._bytes = Buffer.from(bytes);
      this._type = type || null;
      this._name = name || null;
    }
    getBytes() { return Array.from(this._bytes, (b) => (b > 127 ? b - 256 : b)); }
    getDataAsString() { return this._bytes.toString('utf8'); }
    getName() { return this._name; }
    setName(n) { this._name = n; return this; }
    getContentType() { return this._type; }
    setContentType(t) { this._type = t; return this; }
    getAs(type) {
      if (type === this._type) return this;
      throw gasError('Conversion from ' + this._type + ' to ' + type + ' is not supported.');
    }
    copyBlob() { return new Blob(this._bytes, this._type, this._name); }
  }

  const MimeType = {
    PDF: 'application/pdf',
    GOOGLE_DOCS: 'application/vnd.google-apps.document',
    GOOGLE_SHEETS: 'application/vnd.google-apps.spreadsheet',
    GOOGLE_FORMS: 'application/vnd.google-apps.form',
    PLAIN_TEXT: 'text/plain',
    CSV: 'text/csv',
    HTML: 'text/html',
    JPEG: 'image/jpeg',
    PNG: 'image/png'
  };

  // ---- Utilities / Logger / Session
  const Utilities = {
    sleep(ms) {
      if (!Number.isInteger(ms) || ms < 0) throw gasError('The parameters (' + typeof ms + ') do not match the method signature for Utilities.sleep.');
      svc('Utilities.sleep');
      w.sleeps.push(ms);
      w.now += ms;
    },
    formatDate(date, tz, pattern) {
      return formatDate(date, tz, pattern);
    },
    getUuid() { return crypto.randomUUID(); },
    newBlob(data, contentType, name) {
      const b = new Blob(typeof data === 'string' ? Buffer.from(data, 'utf8') : data, contentType || 'text/plain', name);
      return b;
    }
  };
  const Logger = {
    log(...a) { w.logs.push(a.map(String).join(' ')); return Logger; },
    getLog() { return w.logs.join('\n'); }
  };
  const Session = {
    getScriptTimeZone() { return w.manifest && w.manifest.timeZone ? w.manifest.timeZone : w.tz; },
    // DOC: the address is blank where the script runs without the user's authorisation (a simple trigger).
    getActiveUser() {
      svc('Session.getActiveUser', { scope: SCOPE.user });
      const email = w.mode === 'simple' ? '' : w.activeUserEmail;
      return { getEmail: () => email };
    },
    getEffectiveUser() {
      svc('Session.getEffectiveUser', { scope: SCOPE.user });
      return { getEmail: () => w.activeUserEmail };
    }
  };

  // ---- PropertiesService
  function makeProps(store) {
    const total = () => [...store].reduce((n, [k, v]) => n + k.length + v.length, 0);
    return {
      getProperty(k) { svc('Properties.getProperty'); return store.has(String(k)) ? store.get(String(k)) : null; },
      setProperty(k, v) {
        svc('Properties.setProperty');
        const val = String(v);
        if (val.length > 9 * 1024) throw gasError('Argument too large: value');
        const old = store.get(String(k));
        store.set(String(k), val);
        if (total() > 500 * 1024) {
          if (old === undefined) store.delete(String(k)); else store.set(String(k), old);
          throw gasError('Properties store is over its 500 KB limit');
        }
        return this;
      },
      setProperties(obj, deleteAll) {
        svc('Properties.setProperties');
        if (deleteAll) store.clear();
        for (const [k, v] of Object.entries(obj)) store.set(k, String(v));
        return this;
      },
      getProperties() { svc('Properties.getProperties'); return Object.fromEntries(store); },
      getKeys() { svc('Properties.getKeys'); return [...store.keys()]; },
      deleteProperty(k) { svc('Properties.deleteProperty'); store.delete(String(k)); return this; },
      deleteAllProperties() { svc('Properties.deleteAllProperties'); store.clear(); return this; }
    };
  }
  const PropertiesService = {
    getScriptProperties: () => makeProps(w.props.script),
    getUserProperties: () => makeProps(w.props.user),
    getDocumentProperties: () => makeProps(w.props.document)
  };

  // ---- CacheService (DOC: key 250 chars, value 100 KB, expiry max 21600 s)
  function makeCache(store) {
    const live = (k) => {
      const e = store.get(k);
      if (!e) return null;
      if (e.expiresAt <= w.now) { store.delete(k); return null; }
      return e.value;
    };
    return {
      get(k) { svc('Cache.get'); return live(String(k)); },
      put(k, v, secs) {
        svc('Cache.put');
        if (typeof k !== 'string' || typeof v !== 'string') throw gasError('The parameters (' + typeof k + ',' + typeof v + ') do not match the method signature for CacheService.Cache.put.');
        if (k.length > 250) throw gasError('Argument too large: key');
        if (Buffer.byteLength(v) > 100 * 1024) throw gasError('Argument too large: value');
        const ttl = secs === undefined ? 600 : secs;
        if (ttl > 21600 || ttl < 1) throw gasError('Invalid expiration: ' + ttl);
        store.set(k, { value: v, expiresAt: w.now + ttl * 1000 });
      },
      remove(k) { svc('Cache.remove'); store.delete(String(k)); },
      removeAll(keys) { svc('Cache.removeAll'); keys.forEach((k) => store.delete(k)); }
    };
  }
  const CacheService = {
    getScriptCache: () => makeCache(w.caches.script),
    getUserCache: () => makeCache(w.caches.user),
    getDocumentCache: () => makeCache(w.caches.document)
  };

  // ---- LockService (DOC: tryLock returns false on timeout, waitLock throws,
  // release flushes first; the lock frees when the execution ends)
  function makeLock(state) {
    return {
      _held: false,
      _try(ms) {
        if (!Number.isInteger(ms) || ms < 0) throw gasError('The parameters (' + typeof ms + ') do not match the method signature for LockService.Lock.tryLock.');
        if (this._held) return true;
        if (state.holder === null) { state.holder = w.execId; this._held = true; return true; }
        if (state.releaseAt !== null && state.releaseAt <= w.now + ms) {
          w.now = Math.max(w.now, state.releaseAt);
          state.holder = w.execId;
          state.releaseAt = null;
          this._held = true;
          return true;
        }
        w.now += ms;
        return false;
      },
      tryLock(ms) { svc('Lock.tryLock'); return this._try(ms); },
      waitLock(ms) {
        svc('Lock.waitLock');
        if (!this._try(ms)) throw gasError('Lock timeout: another process was holding the lock for too long.');
      },
      hasLock() { return this._held && state.holder === w.execId; },
      releaseLock() {
        svc('Lock.releaseLock');
        if (!this._held) return;
        if (w.unflushed) w.violations.push('lock released with unflushed spreadsheet writes');
        this._held = false;
        if (state.holder === w.execId) state.holder = null;
      }
    };
  }
  const LockService = {
    getScriptLock: () => makeLock(w.locks.script),
    getUserLock: () => makeLock(w.locks.user),
    getDocumentLock: () => makeLock(w.locks.document)
  };

  // ---- Spreadsheets
  function typedValue(v, tz, where) {
    if (v === null) return '';
    if (v === undefined) throw gasError('The parameters (object[][]) do not match the method signature for SpreadsheetApp.' + where + '.');
    if (isDateObj(v)) return new Date(v.getTime());
    if (typeof v === 'number') {
      if (!isFinite(v)) throw gasError('Cannot write a non finite number');
      return v;
    }
    if (typeof v === 'boolean') return v;
    if (typeof v !== 'string') throw gasError('The parameters (object[][]) do not match the method signature for SpreadsheetApp.' + where + '.');
    if (v === '') return '';
    // KNOWN: text is parsed as if typed. A leading apostrophe keeps it as text.
    if (v[0] === "'") return v.slice(1);
    if (v[0] === '=' || (v[0] === '+' && v.length > 1)) {
      w.formulas.push(v);
      return v;
    }
    return typedFromText(v, tz);
  }

  const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const MONTH_WORD = /^(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|june?|july?|aug(ust)?|sep(t(ember)?)?|oct(ober)?|nov(ember)?|dec(ember)?)$/i;

  /**
   * What Sheets makes of text it is given as if typed. Every line is KNOWN:
   * seen in practice, not stated in the reference. Some lines depend on the
   * locale. This is the US English reading: month first, comma thousands.
   * The matching guard is sheetText_ in src/Util.js.
   */
  function typedFromText(v, tz) {
    const day = (y, mo, d) => new Date(zonedMidnight(y, mo, d, tz));
    const monthOf = (name) => (MONTH_WORD.test(name) ? MONTH_NAMES.indexOf(name.slice(0, 3).toLowerCase()) + 1 : 0);
    const thisYear = zoneParts(w.now, tz).y;
    let m;
    // plain numbers, and booleans
    if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
    if (/^(true|false)$/i.test(v)) return v.toLowerCase() === 'true';
    // 1,000 and 1,000.50 and 1e5 and 1.5E-3 and .5
    if (/^[-+]?(\d{1,3}(,\d{3})+(\.\d+)?|\d+(\.\d+)?|\.\d+)([eE][-+]?\d+)?$/.test(v)) return Number(v.replace(/,/g, ''));
    // percent and currency signs
    if (/^-?\d+(\.\d+)?%$/.test(v)) return Number(v.slice(0, -1)) / 100;
    if (/^[$\u20ac\u00a3\u00a5\u20b1]\s*\d[\d,]*(\.\d+)?$/.test(v)) return Number(v.replace(/[^\d.]/g, ''));
    // a time of day becomes a time value on the Sheets epoch day
    m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s?([AaPp])[Mm])?$/.exec(v);
    if (m) {
      let h = Number(m[1]);
      if (m[4]) h = (h % 12) + (m[4].toLowerCase() === 'p' ? 12 : 0);
      if (h < 24 && Number(m[2]) < 60) return new Date(Date.UTC(1899, 11, 30, h, Number(m[2]), Number(m[3] || 0)));
    }
    // dates: 2026-10-03, 2026-10, 2026/10/03, 3/4, 3/4/2026, Oct 5, 5 Oct 2026, Oct 2026
    m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
    if (m) return day(Number(m[1]), Number(m[2]), Number(m[3]));
    m = /^(\d{4})-(\d{2})$/.exec(v);
    if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12) return day(Number(m[1]), Number(m[2]), 1);
    m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(v);
    if (m) return day(Number(m[1]), Number(m[2]), Number(m[3]));
    m = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?$/.exec(v);
    if (m && Number(m[1]) >= 1 && Number(m[1]) <= 12 && Number(m[2]) >= 1 && Number(m[2]) <= 31) {
      const y = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : thisYear;
      return day(y, Number(m[1]), Number(m[2]));
    }
    m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?$/.exec(v);
    if (m && monthOf(m[1]) > 0) return day(m[3] ? Number(m[3]) : thisYear, monthOf(m[1]), Number(m[2]));
    m = /^(\d{1,2})\s+([A-Za-z]{3,9})\.?(?:,?\s+(\d{4}))?$/.exec(v);
    if (m && monthOf(m[2]) > 0) return day(m[3] ? Number(m[3]) : thisYear, monthOf(m[2]), Number(m[1]));
    m = /^([A-Za-z]{3,9})\.?\s+(\d{4})$/.exec(v);
    if (m && monthOf(m[1]) > 0) return day(Number(m[2]), monthOf(m[1]), 1);
    return v;
  }

  function colLetters(n) {
    let s = '';
    while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
    return s;
  }
  function colNumber(s) {
    let n = 0;
    for (const ch of s) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n;
  }

  class Range {
    constructor(sheet, row, col, nRows, nCols) {
      this._s = sheet; this._r = row; this._c = col; this._nr = nRows; this._nc = nCols;
    }
    _check() {
      if (this._r + this._nr - 1 > this._s._maxRows || this._c + this._nc - 1 > this._s._maxCols) {
        // STRICT: the real service may grow the sheet. Writing past the grid is refused here.
        throw gasError('The coordinates or dimensions of the range are invalid.');
      }
    }
    getRow() { return this._r; }
    getColumn() { return this._c; }
    getNumRows() { return this._nr; }
    getNumColumns() { return this._nc; }
    getSheet() { return this._s; }
    getA1Notation() { return colLetters(this._c) + this._r + (this._nr * this._nc > 1 ? ':' + colLetters(this._c + this._nc - 1) + (this._r + this._nr - 1) : ''); }
    getValues() {
      svc('Range.getValues', { scope: SCOPE.sheets, cells: this._nr * this._nc });
      this._check();
      const out = new Array(this._nr);
      for (let i = 0; i < this._nr; i++) {
        const src = this._s._rows[this._r - 1 + i];
        const row = new Array(this._nc);
        for (let j = 0; j < this._nc; j++) {
          const v = src ? src[this._c - 1 + j] : undefined;
          row[j] = v === undefined ? '' : (isDateObj(v) ? new Date(v.getTime()) : v);
        }
        out[i] = row;
      }
      return out;
    }
    getValue() { return new Range(this._s, this._r, this._c, 1, 1).getValues()[0][0]; }
    setValues(values) {
      svc('Range.setValues', { scope: SCOPE.sheets, cells: this._nr * this._nc, write: true });
      if (!Array.isArray(values) || !values.every(Array.isArray)) {
        throw gasError('The parameters (' + typeof values + ') do not match the method signature for SpreadsheetApp.Range.setValues.');
      }
      if (values.length !== this._nr) {
        throw gasError('The number of rows in the data does not match the number of rows in the range. The data has ' + values.length + ' but the range has ' + this._nr + '.');
      }
      for (const row of values) {
        if (row.length !== this._nc) {
          throw gasError('The number of columns in the data does not match the number of columns in the range. The data has ' + row.length + ' but the range has ' + this._nc + '.');
        }
      }
      this._check();
      const tz = this._s._ss._tz;
      for (let i = 0; i < this._nr; i++) {
        const target = this._s._rows[this._r - 1 + i] || (this._s._rows[this._r - 1 + i] = []);
        for (let j = 0; j < this._nc; j++) target[this._c - 1 + j] = typedValue(values[i][j], tz, 'Range.setValues');
      }
      this._s._touch();
      return this;
    }
    setValue(value) {
      svc('Range.setValue', { scope: SCOPE.sheets, cells: 1, write: true });
      this._check();
      for (let i = 0; i < this._nr; i++) {
        const t = this._s._rows[this._r - 1 + i] || (this._s._rows[this._r - 1 + i] = []);
        for (let j = 0; j < this._nc; j++) t[this._c - 1 + j] = typedValue(value, this._s._ss._tz, 'Range.setValue');
      }
      this._s._touch();
      return this;
    }
    clearContent() {
      svc('Range.clearContent', { scope: SCOPE.sheets, write: true });
      this._check();
      for (let i = 0; i < this._nr; i++) {
        const t = this._s._rows[this._r - 1 + i];
        if (t) for (let j = 0; j < this._nc; j++) t[this._c - 1 + j] = undefined;
      }
      this._s._touch();
      return this;
    }
    clear() { return this.clearContent(); }
    setFontWeight() { svc('Range.setFontWeight', { scope: SCOPE.sheets }); return this; }
    setNumberFormat() { svc('Range.setNumberFormat', { scope: SCOPE.sheets }); return this; }
  }

  class Sheet {
    constructor(ss, name) {
      this._ss = ss; this._name = name; this._rows = []; this._maxRows = 1000; this._maxCols = 26;
      this._frozen = 0; this._id = w.nextId++;
    }
    _touch() {
      if (heldLocks() > 0) w.unflushed = true;
      this._ss._dirty = true;
    }
    getName() { return this._name; }
    getSheetId() { return this._id; }
    getParent() { return this._ss; }
    getMaxRows() { svc('Sheet.getMaxRows', { scope: SCOPE.sheets }); return this._maxRows; }
    getMaxColumns() { svc('Sheet.getMaxColumns', { scope: SCOPE.sheets }); return this._maxCols; }
    _lastRow() {
      let i = this._rows.length - 1;
      for (; i >= 0; i--) {
        const r = this._rows[i];
        if (r && r.some((v) => v !== undefined && v !== '')) break;
      }
      this._rows.length = i + 1;
      return i + 1;
    }
    getLastRow() { svc('Sheet.getLastRow', { scope: SCOPE.sheets }); return this._lastRow(); }
    getLastColumn() {
      svc('Sheet.getLastColumn', { scope: SCOPE.sheets });
      let last = 0;
      for (const r of this._rows) {
        if (!r) continue;
        for (let c = r.length - 1; c >= last; c--) if (r[c] !== undefined && r[c] !== '') { last = c + 1; break; }
      }
      return last;
    }
    getFrozenRows() { return this._frozen; }
    setFrozenRows(n) {
      svc('Sheet.setFrozenRows', { scope: SCOPE.sheets });
      if (!Number.isInteger(n) || n < 0 || n > this._maxRows) throw gasError('Invalid number of frozen rows');
      this._frozen = n;
    }
    getRange(a, b, c, d) {
      svc('Sheet.getRange', { scope: SCOPE.sheets });
      if (typeof a === 'string') {
        const m = /^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/.exec(a);
        if (!m) throw gasError('The range cannot be found: ' + a);
        const c1 = colNumber(m[1]); const r1 = Number(m[2]);
        const c2 = m[3] ? colNumber(m[3]) : c1; const r2 = m[4] ? Number(m[4]) : r1;
        return new Range(this, r1, c1, r2 - r1 + 1, c2 - c1 + 1);
      }
      const nr = c === undefined ? 1 : c;
      const nc = d === undefined ? 1 : d;
      for (const n of [a, b, nr, nc]) {
        if (!Number.isInteger(n)) throw gasError('The parameters (' + [a, b, c, d].filter((x) => x !== undefined).map((x) => typeof x).join(',') + ') do not match the method signature for SpreadsheetApp.Sheet.getRange.');
      }
      if (a < 1 || b < 1) throw gasError('The coordinates of the range are outside the dimensions of the sheet.');
      if (nr < 1) throw gasError('The number of rows in the range must be at least 1.');
      if (nc < 1) throw gasError('The number of columns in the range must be at least 1.');
      return new Range(this, a, b, nr, nc);
    }
    getDataRange() {
      const lr = this.getLastRow() || 1;
      const lc = this.getLastColumn() || 1;
      return this.getRange(1, 1, lr, lc);
    }
    appendRow(values) {
      svc('Sheet.appendRow', { scope: SCOPE.sheets, cells: Array.isArray(values) ? values.length : 0, write: true });
      if (!Array.isArray(values) || values.length === 0) {
        throw gasError('The parameters () do not match the method signature for SpreadsheetApp.Sheet.appendRow.');
      }
      const row = this._lastRow() + 1;
      if (row > this._maxRows) this._maxRows = row;
      if (values.length > this._maxCols) this._maxCols = values.length;
      const tz = this._ss._tz;
      this._rows[row - 1] = values.map((v) => typedValue(v, tz, 'Sheet.appendRow'));
      this._touch();
      return this;
    }
    insertRowsAfter(pos, n) {
      svc('Sheet.insertRowsAfter', { scope: SCOPE.sheets, write: true });
      if (!Number.isInteger(pos) || !Number.isInteger(n) || n < 1 || pos < 0 || pos > this._maxRows) throw gasError('Invalid arguments for insertRowsAfter');
      if (pos < this._rows.length) this._rows.splice(pos, 0, ...Array.from({ length: n }, () => undefined));
      this._maxRows += n;
      this._touch();
      return this;
    }
    insertColumnsAfter(pos, n) {
      svc('Sheet.insertColumnsAfter', { scope: SCOPE.sheets, write: true });
      if (!Number.isInteger(pos) || !Number.isInteger(n) || n < 1 || pos < 0 || pos > this._maxCols) throw gasError('Invalid arguments for insertColumnsAfter');
      for (const r of this._rows) if (r && pos < r.length) r.splice(pos, 0, ...Array.from({ length: n }, () => undefined));
      this._maxCols += n;
      this._touch();
      return this;
    }
    deleteRows(row, n) {
      svc('Sheet.deleteRows', { scope: SCOPE.sheets, write: true });
      if (row < 1 || n < 1 || row + n - 1 > this._maxRows) throw gasError('Invalid arguments for deleteRows');
      this._rows.splice(row - 1, n);
      this._maxRows -= n;
      this._touch();
    }
    clearContents() { svc('Sheet.clearContents', { scope: SCOPE.sheets, write: true }); this._rows = []; this._touch(); return this; }
    clear() { return this.clearContents(); }
  }

  class Spreadsheet {
    constructor(name) {
      this._id = newId('ss'); this._name = name; this._tz = w.tz; this._sheets = [new Sheet(this, 'Sheet1')];
      this._dirty = false;
      w.spreadsheets.set(this._id, this);
    }
    getId() { return this._id; }
    getName() { return this._name; }
    getUrl() { return 'https://docs.google.com/spreadsheets/d/' + this._id + '/edit'; }
    getSpreadsheetTimeZone() { svc('Spreadsheet.getSpreadsheetTimeZone', { scope: SCOPE.sheets }); return this._tz; }
    setSpreadsheetTimeZone(tz) { this._tz = tz; }
    getSheets() { svc('Spreadsheet.getSheets', { scope: SCOPE.sheets }); return [...this._sheets]; }
    getSheetByName(name) {
      svc('Spreadsheet.getSheetByName', { scope: SCOPE.sheets });
      return this._sheets.find((s) => s._name === name) || null;
    }
    insertSheet(name) {
      svc('Spreadsheet.insertSheet', { scope: SCOPE.sheets, write: true });
      if (typeof name !== 'string' || name === '') throw gasError('Sheet name cannot be empty.');
      if (name.length > 100) throw gasError('Sheet name is too long. Use at most 100 characters.');
      if (this._sheets.some((s) => s._name === name)) {
        throw gasError('A sheet with the name "' + name + '" already exists. Please enter another name.');
      }
      const s = new Sheet(this, name);
      this._sheets.push(s);
      this._dirty = true;
      return s;
    }
    deleteSheet(sheet) {
      svc('Spreadsheet.deleteSheet', { scope: SCOPE.sheets, write: true });
      if (this._sheets.length === 1) throw gasError("You can't delete all the sheets in a spreadsheet.");
      this._sheets = this._sheets.filter((s) => s !== sheet);
    }
    toast(msg, title) { w.ui.toasts.push({ msg, title }); }
  }

  const Ui = {
    createMenu(caption) {
      const items = [];
      const menu = {
        caption, items,
        addItem(cap, fn) {
          if (typeof cap !== 'string' || typeof fn !== 'string') throw gasError('The parameters do not match the method signature for Menu.addItem.');
          items.push({ caption: cap, fn }); return menu;
        },
        addSeparator() { items.push({ separator: true }); return menu; },
        addSubMenu(sub) { items.push({ caption: sub.caption, sub: sub.items }); return menu; },
        addToUi() { svc('Menu.addToUi', { scope: SCOPE.ui }); w.ui.menus.push({ caption, items }); }
      };
      return menu;
    },
    showSidebar(html) {
      svc('Ui.showSidebar', { scope: SCOPE.ui });
      if (!html || typeof html.getContent !== 'function') throw gasError('The parameters do not match the method signature for Ui.showSidebar.');
      w.ui.sidebar = { title: html.getTitle(), content: html.getContent() };
    },
    showModalDialog(html, title) {
      svc('Ui.showModalDialog', { scope: SCOPE.ui });
      if (!html || typeof html.getContent !== 'function' || typeof title !== 'string') throw gasError('The parameters do not match the method signature for Ui.showModalDialog.');
      w.ui.dialog = { title, content: html.getContent(), width: html.getWidth(), height: html.getHeight() };
    },
    alert(...args) {
      svc('Ui.alert', { scope: SCOPE.ui });
      w.ui.alerts.push(args);
      return 'OK';
    },
    ButtonSet: { OK: 'OK', OK_CANCEL: 'OK_CANCEL', YES_NO: 'YES_NO' },
    Button: { OK: 'OK', CANCEL: 'CANCEL', YES: 'YES', NO: 'NO', CLOSE: 'CLOSE' }
  };

  const SpreadsheetApp = {
    ButtonSet: Ui.ButtonSet,
    getActiveSpreadsheet() {
      svc('SpreadsheetApp.getActiveSpreadsheet', { scope: SCOPE.sheets });
      return w.activeSpreadsheet;
    },
    openById(id) {
      svc('SpreadsheetApp.openById', { scope: SCOPE.sheetsFull, restricted: true });
      const s = w.spreadsheets.get(id);
      if (!s) throw gasError('Unexpected error while getting the method or property openById on object SpreadsheetApp.');
      return s;
    },
    create(name) { svc('SpreadsheetApp.create', { scope: SCOPE.sheetsFull, restricted: true }); return new Spreadsheet(name); },
    getUi() { svc('SpreadsheetApp.getUi', { scope: SCOPE.ui }); return Ui; },
    flush() { svc('SpreadsheetApp.flush', { scope: SCOPE.sheets }); w.unflushed = false; }
  };

  // ---- ContentService
  const ContentService = {
    MimeType: { CSV: 'CSV', ICAL: 'ICAL', JAVASCRIPT: 'JAVASCRIPT', JSON: 'JSON', TEXT: 'TEXT', VCARD: 'VCARD' },
    createTextOutput(text) {
      let content = text === undefined || text === null ? '' : String(text);
      let mime = 'TEXT';
      const out = {
        getContent: () => content,
        setContent(c) { content = String(c); return out; },
        append(c) { content += String(c); return out; },
        clear() { content = ''; return out; },
        getMimeType: () => mime,
        setMimeType(m) {
          if (!ContentService.MimeType[m]) throw gasError('The parameters do not match the method signature for TextOutput.setMimeType.');
          mime = m; return out;
        }
      };
      return out;
    }
  };

  // ---- HtmlService (templates use <? ?>, <?= ?> escaped, <?!= ?> raw)
  const escapeHtml = (v) => String(v === undefined || v === null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  function htmlOutput(content) {
    let title = ''; let width = null; let height = null;
    const out = {
      getContent: () => content,
      getTitle: () => title,
      setTitle(t) { title = String(t); return out; },
      getWidth: () => width,
      setWidth(x) { width = x; return out; },
      getHeight: () => height,
      setHeight(x) { height = x; return out; },
      append(s) { content += s; return out; },
      setXFrameOptionsMode() { return out; }
    };
    return out;
  }

  function readHtmlFile(name) {
    if (!Object.prototype.hasOwnProperty.call(w.htmlFiles, name)) throw gasError('No HTML file named ' + name + ' was found.');
    return w.htmlFiles[name];
  }

  function compileTemplate(source) {
    let code = 'var __out=[];\n';
    const re = /<\?(!?=)?([\s\S]*?)\?>/g;
    let last = 0;
    let m;
    while ((m = re.exec(source))) {
      code += '__out.push(' + JSON.stringify(source.slice(last, m.index)) + ');\n';
      if (m[1] === '=') code += '__out.push(__esc(' + m[2] + '));\n';
      else if (m[1] === '!=') code += '__out.push(String(' + m[2] + '));\n';
      else code += m[2] + '\n';
      last = re.lastIndex;
    }
    code += '__out.push(' + JSON.stringify(source.slice(last)) + ');\nreturn __out.join("");';
    return code;
  }

  function makeTemplate(source) {
    const t = {
      evaluate() {
        svc('HtmlTemplate.evaluate');
        const keys = Object.keys(t).filter((k) => k !== 'evaluate' && k !== 'getCode');
        const body = 'with (__vars) {\n' + compileTemplate(source) + '\n}';
        const fn = vm.runInContext('(function (__vars, __esc) { ' + body + ' })', w.ctx);
        const vars = {};
        keys.forEach((k) => { vars[k] = t[k]; });
        return htmlOutput(fn(vars, escapeHtml));
      }
    };
    return t;
  }

  const HtmlService = {
    XFrameOptionsMode: { ALLOWALL: 'ALLOWALL', DEFAULT: 'DEFAULT' },
    createHtmlOutput(s) { return htmlOutput(String(s)); },
    createHtmlOutputFromFile(name) { svc('HtmlService.createHtmlOutputFromFile'); return htmlOutput(readHtmlFile(name)); },
    createTemplate(s) { return makeTemplate(String(s)); },
    createTemplateFromFile(name) { svc('HtmlService.createTemplateFromFile'); return makeTemplate(readHtmlFile(name)); }
  };

  // ---- Drive
  class FileIterator {
    constructor(list) { this._l = list; this._i = 0; }
    hasNext() { svc('FileIterator.hasNext', { scope: SCOPE.drive }); return this._i < this._l.length; }
    next() {
      svc('FileIterator.next', { scope: SCOPE.drive });
      if (this._i >= this._l.length) throw gasError('Cannot retrieve the next object: iterator has reached the end.');
      return this._l[this._i++];
    }
  }

  function renderPdf(model, name) {
    const lines = [];
    for (const ch of model) {
      if (ch.type === 'p') lines.push(ch.text);
      else for (const row of ch.cells) lines.push(row.join('\t'));
    }
    return new Blob('%PDF-1.4\n% fake pdf for ' + name + '\n' + lines.join('\n') + '\n%%EOF', 'application/pdf', name + '.pdf');
  }

  class DriveFile {
    constructor(name, mime, content, parentId) {
      this._id = newId('file'); this._name = name; this._mime = mime; this._content = content;
      this._trashed = false; this._parent = parentId; this._doc = null; this._created = w.now;
      this._content = Buffer.from(content);
      w.files.set(this._id, this);
    }
    getId() { return this._id; }
    getName() { return this._name; }
    setName(n) { svc('File.setName', { scope: SCOPE.drive }); this._name = n; return this; }
    getMimeType() { return this._mime; }
    getUrl() { return 'https://drive.google.com/file/d/' + this._id + '/view'; }
    isTrashed() { return this._trashed; }
    setTrashed(b) { svc('File.setTrashed', { scope: SCOPE.drive, restricted: true }); this._trashed = !!b; return this; }
    getSize() { return this._content.length; }
    getBlob() {
      svc('File.getBlob', { scope: SCOPE.drive });
      if (this._doc) return renderPdf(this._doc.saved, this._name);
      return new Blob(this._content, this._mime, this._name);
    }
    getAs(type) {
      svc('File.getAs', { scope: SCOPE.drive });
      if (this._doc) {
        if (type !== MimeType.PDF) throw gasError('Conversion from ' + this._mime + ' to ' + type + ' is not supported.');
        return renderPdf(this._doc.saved, this._name);
      }
      return new Blob(this._content, this._mime, this._name).getAs(type);
    }
    makeCopy(a, b) {
      svc('File.makeCopy', { scope: SCOPE.drive, restricted: true });
      let name = 'Copy of ' + this._name; let folder = null;
      if (typeof a === 'string') { name = a; folder = b || null; } else if (a) { folder = a; }
      const copy = new DriveFile(name, this._mime, this._content, folder ? folder._id : this._parent);
      if (this._doc) copy._doc = { saved: JSON.parse(JSON.stringify(this._doc.saved)) };
      return copy;
    }
    moveTo(folder) { svc('File.moveTo', { scope: SCOPE.drive }); this._parent = folder._id; return this; }
  }

  class Folder {
    constructor(name, parentId) { this._id = newId('folder'); this._name = name; this._parent = parentId; w.files.set(this._id, this); this._isFolder = true; this._trashed = false; }
    getId() { return this._id; }
    getName() { return this._name; }
    createFile(a, b, c) {
      svc('Folder.createFile', { scope: SCOPE.drive, restricted: true });
      if (typeof a === 'string') return new DriveFile(a, c || 'text/plain', Buffer.from(String(b)), this._id);
      if (!a || typeof a.getBytes !== 'function') throw gasError('The parameters do not match the method signature for DriveApp.Folder.createFile.');
      const f = new DriveFile(a.getName() || 'Untitled', a.getContentType() || 'application/octet-stream', Buffer.from(a._bytes), this._id);
      return f;
    }
    getFilesByName(name) {
      svc('Folder.getFilesByName', { scope: SCOPE.drive, restricted: true });
      return new FileIterator([...w.files.values()].filter((f) => !f._isFolder && !f._trashed && f._parent === this._id && f._name === name));
    }
    getFiles() {
      svc('Folder.getFiles', { scope: SCOPE.drive, restricted: true });
      return new FileIterator([...w.files.values()].filter((f) => !f._isFolder && !f._trashed && f._parent === this._id));
    }
  }
  const rootFolder = new Folder('My Drive', null);

  const DriveApp = {
    getRootFolder() { svc('DriveApp.getRootFolder', { scope: SCOPE.drive, restricted: true }); return rootFolder; },
    createFolder(name) { svc('DriveApp.createFolder', { scope: SCOPE.drive, restricted: true }); return new Folder(name, rootFolder._id); },
    getFolderById(id) {
      svc('DriveApp.getFolderById', { scope: SCOPE.drive, restricted: true });
      const f = w.files.get(id);
      if (!f || !f._isFolder) throw gasError('Unexpected error while getting the method or property getFolderById on object DriveApp.');
      return f;
    },
    getFileById(id) {
      svc('DriveApp.getFileById', { scope: SCOPE.drive, restricted: true });
      const f = w.files.get(id);
      if (!f || f._isFolder) throw gasError('Unexpected error while getting the method or property getFileById on object DriveApp.');
      return f;
    }
  };

  // ---- Documents
  function deepModel(m) { return JSON.parse(JSON.stringify(m)); }

  class DocElement {
    constructor(doc, node) { this._doc = doc; this._n = node; }
    getParent() { return new DocElement(this._doc, this._n.parentNode || null); }
  }

  function checkRe2(pattern) {
    // KNOWN: replaceText and findText use RE2, which has no lookaround or backreferences.
    if (/\(\?[=!<]/.test(pattern) || /\\[1-9]/.test(pattern)) throw gasError('Invalid regular expression: ' + pattern);
    try { return new RegExp(pattern, 'g'); } catch (e) { throw gasError('Invalid regular expression: ' + pattern); }
  }

  class DocBody {
    constructor(doc) { this._doc = doc; }
    _model() {
      if (this._doc._closed) throw gasError('Document is closed. Open it again to edit.');
      svc('Body', { scope: SCOPE.docs });
      return this._doc._live;
    }
    appendParagraph(text) {
      if (typeof text !== 'string') throw gasError('The parameters (' + typeof text + ') do not match the method signature for DocumentApp.Body.appendParagraph.');
      const node = { type: 'p', text };
      this._model().push(node);
      return new Paragraph(this._doc, node);
    }
    appendTable(cells) { return this.insertTable(this._model().length, cells); }
    insertTable(index, cells) {
      const model = this._model();
      if (!Number.isInteger(index) || index < 0 || index > model.length) throw gasError('Index out of range: ' + index);
      if (!Array.isArray(cells) || !cells.every((r) => Array.isArray(r) && r.every((c) => typeof c === 'string'))) {
        throw gasError('The parameters (String[][]) do not match the method signature for DocumentApp.Body.insertTable.');
      }
      const node = { type: 'table', cells: cells.map((r) => [...r]) };
      model.splice(index, 0, node);
      return new Table(this._doc, node);
    }
    getNumChildren() { return this._model().length; }
    getChildIndex(el) {
      const i = this._model().indexOf(el._n);
      if (i === -1) throw gasError('The element is not a child of this body.');
      return i;
    }
    getText() { return this._model().map((c) => (c.type === 'p' ? c.text : c.cells.map((r) => r.join('\t')).join('\n'))).join('\n'); }
    findText(pattern) {
      const re = checkRe2(pattern);
      for (const node of this._model()) {
        if (node.type !== 'p') continue;
        re.lastIndex = 0;
        const m = re.exec(node.text);
        if (m) return new RangeElement(this._doc, node, m.index, m.index + m[0].length - 1);
      }
      return null;
    }
    replaceText(pattern, replacement) {
      const re = checkRe2(pattern);
      if (typeof replacement !== 'string') throw gasError('The parameters do not match the method signature for DocumentApp.Body.replaceText.');
      // STRICT: the reference does not say how $ in the replacement is read, so it is refused.
      if (replacement.includes('$')) throw gasError('Replacement text with a dollar sign is not allowed in this fake: the reference does not define it.');
      for (const node of this._model()) {
        if (node.type === 'p') node.text = node.text.replace(re, () => replacement);
        else node.cells = node.cells.map((r) => r.map((c) => c.replace(re, () => replacement)));
      }
      return this;
    }
  }

  class Paragraph extends DocElement {
    getText() { return this._n.text; }
    setText(t) { this._n.text = String(t); return this; }
    asParagraph() { return this; }
  }
  class Table extends DocElement {
    getNumRows() { return this._n.cells.length; }
    getCell(r, c) { return { getText: () => this._n.cells[r][c] }; }
  }
  class RangeElement {
    constructor(doc, node, start, end) { this._doc = doc; this._n = node; this._s = start; this._e = end; }
    getElement() {
      const para = new Paragraph(this._doc, this._n);
      return { getParent: () => para, asText: () => ({ getText: () => this._n.text }), getText: () => this._n.text };
    }
    getStartOffset() { return this._s; }
    getEndOffsetInclusive() { return this._e; }
  }

  class Document {
    constructor(file) {
      this._file = file; this._closed = false; this._live = deepModel(file._doc.saved);
      this.execId = w.execId;
    }
    getId() { return this._file._id; }
    getName() { return this._file._name; }
    getUrl() { return 'https://docs.google.com/document/d/' + this._file._id + '/edit'; }
    getBody() {
      if (this._closed) throw gasError('Document is closed. Open it again to edit.');
      svc('Document.getBody', { scope: SCOPE.docs });
      return new DocBody(this);
    }
    commit() { this._file._doc.saved = deepModel(this._live); }
    saveAndClose() {
      svc('Document.saveAndClose', { scope: SCOPE.docs });
      this.commit();
      this._closed = true;
      w.openDocs.delete(this);
    }
  }

  const DocumentApp = {
    create(name) {
      svc('DocumentApp.create', { scope: SCOPE.docs, restricted: true });
      const file = new DriveFile(name, MimeType.GOOGLE_DOCS, '', rootFolder._id);
      file._doc = { saved: [{ type: 'p', text: '' }] };
      const d = new Document(file);
      w.openDocs.add(d);
      return d;
    },
    openById(id) {
      svc('DocumentApp.openById', { scope: SCOPE.docs, restricted: true });
      const f = w.files.get(id);
      if (!f || !f._doc) throw gasError('Unexpected error while getting the method or property openById on object DocumentApp.');
      const d = new Document(f);
      w.openDocs.add(d);
      return d;
    },
    getActiveDocument() { return null; }
  };

  // ---- Gmail (DOC: subject up to 250 chars, attachments are blobs, quota per day)
  function sendMail(api, scope, to, subject, body, options) {
    svc(api, { scope, restricted: true });
    if (typeof to !== 'string' || typeof subject !== 'string' || typeof body !== 'string') {
      throw gasError('The parameters (' + [to, subject, body].map((x) => typeof x).join(',') + ') do not match the method signature for ' + api + '.');
    }
    const o = options || {};
    const split = (s) => (s ? String(s).split(',').map((x) => x.trim()).filter(Boolean) : []);
    const recipients = [...split(to), ...split(o.cc), ...split(o.bcc)];
    if (recipients.length === 0) throw gasError('Failed to send email: no recipient');
    for (const r of recipients) {
      if (!/^[^\s@<>,]+@[^\s@<>,]+\.[^\s@<>,]+$/.test(r)) throw gasError('Invalid email: ' + r);
    }
    if (subject.length > 250) throw gasError('Argument too large: subject');
    const attachments = o.attachments || [];
    for (const a of attachments) {
      if (!a || typeof a.getBytes !== 'function') throw gasError('The parameters do not match the method signature for ' + api + '.');
    }
    if (w.mailQuota < recipients.length) throw gasError('Service invoked too many times for one day: email.');
    w.mailQuota -= recipients.length;
    w.sent.push({
      to, cc: o.cc || '', bcc: o.bcc || '', subject, body, htmlBody: o.htmlBody || '', name: o.name || '',
      attachments: attachments.map((a) => ({ name: a.getName(), type: a.getContentType(), text: a.getDataAsString() })),
      at: w.now
    });
  }
  const GmailApp = { sendEmail(to, subject, body, options) { sendMail('GmailApp.sendEmail', SCOPE.gmail, to, subject, body, options); return GmailApp; } };
  // DOC: MailApp.sendEmail(recipient, subject, body, options) takes the same options and the same quota.
  // STRICT: the message object form and the (to, replyTo, subject, body) form are not implemented.
  const MailApp = {
    sendEmail(to, subject, body, options) {
      if (options !== undefined && (options === null || typeof options !== 'object')) {
        throw gasError('The parameters do not match the method signature for MailApp.sendEmail.');
      }
      sendMail('MailApp.sendEmail', SCOPE.mail, to, subject, body, options);
    }
  };

  // ---- Forms
  function makeItem(form, type) {
    const item = {
      _type: type, _title: '', _required: false, _choices: [],
      setTitle(t) { item._title = String(t); return item; },
      getTitle() { return item._title; },
      setRequired(b) { item._required = !!b; return item; },
      isRequired() { return item._required; },
      setHelpText() { return item; },
      setChoiceValues(v) { item._choices = [...v]; return item; }
    };
    form._items.push(item);
    return item;
  }

  class Form {
    constructor(title) {
      this._id = newId('form'); this._title = title; this._items = []; this._responses = []; this._desc = '';
      w.forms.set(this._id, this);
    }
    getId() { return this._id; }
    getTitle() { return this._title; }
    setDescription(d) { this._desc = d; return this; }
    getPublishedUrl() { return 'https://docs.google.com/forms/d/e/' + this._id + '/viewform'; }
    getEditUrl() { return 'https://docs.google.com/forms/d/' + this._id + '/edit'; }
    addTextItem() { svc('Form.addTextItem', { scope: SCOPE.forms }); return makeItem(this, 'TEXT'); }
    addParagraphTextItem() { svc('Form.addParagraphTextItem', { scope: SCOPE.forms }); return makeItem(this, 'PARAGRAPH_TEXT'); }
    addMultipleChoiceItem() { svc('Form.addMultipleChoiceItem', { scope: SCOPE.forms }); return makeItem(this, 'MULTIPLE_CHOICE'); }
    getItems() { return [...this._items]; }
    getResponses() { return [...this._responses]; }
  }
  const FormApp = {
    create(title) { svc('FormApp.create', { scope: SCOPE.forms, restricted: true }); return new Form(title); },
    openById(id) {
      svc('FormApp.openById', { scope: SCOPE.forms, restricted: true });
      const f = w.forms.get(id);
      if (!f) throw gasError('Unexpected error while getting the method or property openById on object FormApp.');
      return f;
    }
  };

  // ---- Triggers (DOC: 20 triggers per user per script)
  function addTrigger(t) {
    if (w.triggers.length >= 20) {
      throw gasError('This script has too many triggers. Triggers must be deleted from the script before more can be added.');
    }
    w.triggers.push(t);
    return triggerObject(t);
  }
  function triggerObject(t) {
    return {
      _t: t,
      getHandlerFunction: () => t.handler,
      getUniqueId: () => t.id,
      getEventType: () => t.eventType,
      getTriggerSource: () => t.source
    };
  }
  const ScriptApp = {
    EventType: { CLOCK: 'CLOCK', ON_FORM_SUBMIT: 'ON_FORM_SUBMIT', ON_OPEN: 'ON_OPEN' },
    newTrigger(handler) {
      svc('ScriptApp.newTrigger', { scope: SCOPE.triggers, restricted: true });
      if (typeof handler !== 'string' || !handler) throw gasError('The parameters do not match the method signature for ScriptApp.newTrigger.');
      return {
        timeBased() {
          const t = { id: newId('trg'), handler, eventType: 'CLOCK', source: 'CLOCK', fireAt: null, formId: null };
          const b = {
            after(ms) {
              if (!Number.isInteger(ms) || ms < 1) throw gasError('The parameters do not match the method signature for ClockTriggerBuilder.after.');
              t.fireAt = w.now + ms; return b;
            },
            everyMinutes(n) {
              if (![1, 5, 10, 15, 30].includes(n)) throw gasError('Number of minutes must be 1, 5, 10, 15 or 30.');
              t.everyMs = n * 60000; t.fireAt = w.now + t.everyMs; return b;
            },
            create() { svc('ClockTriggerBuilder.create', { scope: SCOPE.triggers }); return addTrigger(t); }
          };
          return b;
        },
        forForm(form) {
          if (!form || !form._items) throw gasError('The parameters do not match the method signature for TriggerBuilder.forForm.');
          return {
            onFormSubmit() {
              return {
                create() {
                  svc('FormTriggerBuilder.create', { scope: SCOPE.triggers });
                  return addTrigger({ id: newId('trg'), handler, eventType: 'ON_FORM_SUBMIT', source: 'FORMS', formId: form._id, fireAt: null });
                }
              };
            }
          };
        }
      };
    },
    getProjectTriggers() { svc('ScriptApp.getProjectTriggers', { scope: SCOPE.triggers }); return w.triggers.map(triggerObject); },
    deleteTrigger(tr) {
      svc('ScriptApp.deleteTrigger', { scope: SCOPE.triggers });
      w.triggers = w.triggers.filter((t) => t.id !== tr.getUniqueId());
    }
  };

  // ---- UrlFetchApp
  const UrlFetchApp = {
    fetch(url, params) {
      svc('UrlFetchApp.fetch', { scope: SCOPE.fetch, restricted: true });
      if (typeof url !== 'string' || !/^https?:\/\/[^\s/]+/.test(url)) throw gasError('Invalid argument: ' + url);
      const p = params || {};
      const method = String(p.method || 'get').toLowerCase();
      if (!['get', 'post', 'put', 'delete', 'patch', 'head'].includes(method)) throw gasError('Invalid argument: method');
      w.http.calls++;
      w.http.log.push({ url, method, headers: Object.assign({}, p.headers), payload: p.payload, at: w.now });
      const route = w.http.routes.find((r) => r.test(url, method));
      w.now += w.cost.fetchMs;
      if (!route) throw gasError('DNS error: ' + url);
      const r = route.handler({ url, method, headers: Object.assign({}, p.headers), payload: p.payload });
      if (r && r.throw) throw gasError(r.throw);
      const headers = Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, r.headers);
      const res = {
        getResponseCode: () => r.code,
        getContentText: () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)),
        getHeaders: () => Object.assign({}, headers),
        getAllHeaders: () => Object.assign({}, headers)
      };
      if (r.code >= 400 && !p.muteHttpExceptions) {
        throw gasError('Request failed for ' + new URL(url).origin + ' returned code ' + r.code + '. Truncated server response: ' + res.getContentText().slice(0, 100) + ' (use muteHttpExceptions option to examine full response)');
      }
      return res;
    }
  };

  const globals = {
    SpreadsheetApp, DocumentApp, DriveApp, GmailApp, MailApp, FormApp, HtmlService, ContentService, UrlFetchApp,
    CacheService, PropertiesService, LockService, ScriptApp, Utilities, Logger, Session, MimeType
  };

  // ---- world helpers for tests
  Object.assign(w, {
    globals, svc, run, Blob, ExecutionKilled,
    newSpreadsheet(name) {
      const ss = new Spreadsheet(name || 'sheetdesk test');
      w.activeSpreadsheet = ss;
      return ss;
    },
    /** Another execution holds the script lock for ms of simulated time. */
    otherHoldsScriptLock(ms) { w.locks.script = { holder: -1, releaseAt: ms === Infinity ? null : w.now + ms }; },
    releaseOtherLocks() { w.locks.script = { holder: null, releaseAt: null }; },
    route(test, handler) { w.http.routes.push({ test, handler }); },
    folderFiles(folderId, { trashed = false } = {}) {
      return [...w.files.values()].filter((f) => !f._isFolder && f._parent === folderId && f._trashed === trashed);
    },
    allFiles() { return [...w.files.values()].filter((f) => !f._isFolder); },
    /** Submit a form as a respondent: checks required items and choices, then runs the form triggers. */
    submitForm(form, answers, { respondentEmail = '' } = {}) {
      const itemResponses = [];
      for (const item of form._items) {
        const a = answers[item._title];
        if ((a === undefined || a === '') && item._required) throw gasError('Required item missing: ' + item._title);
        if (a === undefined || a === '') continue;
        if (item._type === 'MULTIPLE_CHOICE' && !item._choices.includes(a)) throw gasError('Not a valid choice for ' + item._title);
        itemResponses.push({ getItem: () => item, getResponse: () => a });
      }
      const response = {
        getId: () => 'resp' + String(w.nextId++).padStart(5, '0'),
        getItemResponses: () => itemResponses,
        getRespondentEmail: () => respondentEmail,
        getTimestamp: () => new Date(w.now)
      };
      const id = response.getId();
      response.getId = () => id;
      form._responses.push(response);
      return w.deliverFormResponse(form, response);
    },
    deliverFormResponse(form, response) {
      const results = [];
      for (const t of w.triggers.filter((x) => x.eventType === 'ON_FORM_SUBMIT' && x.formId === form._id)) {
        results.push(w.run(() => w.ctx[t.handler]({ response, source: form, triggerUid: t.id })));
      }
      return results;
    },
    /** Move the clock to the next time trigger, run it as its own execution, and return its result. */
    fireNextClockTrigger() {
      const due = w.triggers.filter((t) => t.eventType === 'CLOCK' && t.fireAt !== null).sort((a, b) => a.fireAt - b.fireAt)[0];
      if (!due) return null;
      if (due.fireAt > w.now) w.now = due.fireAt;
      return { handler: due.handler, result: w.run(() => w.ctx[due.handler]({ triggerUid: due.id })) };
    },
    /** Run a global function as one execution. */
    call(name, ...args) {
      return w.run(() => {
        if (typeof w.ctx[name] !== 'function') throw gasError('Script function not found: ' + name);
        return w.ctx[name](...args);
      });
    },
    /** Run as a simple trigger, which may not use services that need authorisation. */
    callSimple(name, ...args) { return w.run(() => w.ctx[name](...args), { mode: 'simple' }); }
  });

  return w;
}

module.exports = { createWorld, ExecutionKilled, formatDate, zonedMidnight, MAX_EXEC_MS, SCOPE };
