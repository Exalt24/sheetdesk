'use strict';
/**
 * Tests of the fake itself. The rest of the suite is only as honest as the
 * fake, so each rule it enforces has a test here, with its source: DOC (the
 * Apps Script reference says so), KNOWN (seen in practice, not in the
 * reference) or STRICT (the fake is stricter than the documentation).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadProject } = require('./helpers/load');
const { formatDate, zonedMidnight, MAX_EXEC_MS } = require('./fake/gas');

const fresh = () => {
  const p = loadProject();
  return { p, w: p.w, g: p.w.globals, run: (fn, o) => p.w.run(fn, o) };
};

test('DOC/KNOWN: setValues checks the shape of the data against the range', () => {
  const { p, run } = fresh();
  run(() => {
    const sh = p.ss.getSheetByName('Sheet1');
    assert.throws(() => sh.getRange(1, 1, 2, 3).setValues([[1, 2, 3]]), /The number of rows in the data does not match the number of rows in the range\. The data has 1 but the range has 2\./);
    assert.throws(() => sh.getRange(1, 1, 1, 3).setValues([[1, 2]]), /The number of columns in the data does not match the number of columns in the range\. The data has 2 but the range has 3\./);
    assert.throws(() => sh.getRange(1, 1, 1, 1).setValues([1]), /do not match the method signature/);
    assert.throws(() => sh.getRange(1, 1, 1, 1).setValues([[undefined]]), /do not match the method signature/);
    assert.throws(() => sh.getRange(1, 1, 1, 1).setValues([[{}]]), /do not match the method signature/);
    assert.throws(() => sh.getRange(1, 1, 1, 1).setValues([[NaN]]), /non finite/);
  });
});

test('STRICT: a range beyond the grid cannot be written until rows are inserted', () => {
  const { p, run } = fresh();
  run(() => {
    const sh = p.ss.getSheetByName('Sheet1');
    assert.equal(sh.getMaxRows(), 1000);
    assert.throws(() => sh.getRange(1000, 1, 2, 1).setValues([[1], [2]]), /coordinates or dimensions of the range are invalid/);
    sh.insertRowsAfter(1000, 5);
    sh.getRange(1000, 1, 2, 1).setValues([[1], [2]]);
    assert.equal(sh.getMaxRows(), 1005);
  });
});

test('KNOWN: getRange refuses bad arguments', () => {
  const { p, run } = fresh();
  run(() => {
    const sh = p.ss.getSheetByName('Sheet1');
    assert.throws(() => sh.getRange(0, 1), /outside the dimensions/);
    assert.throws(() => sh.getRange(1, 0), /outside the dimensions/);
    assert.throws(() => sh.getRange(1, 1, 0, 1), /number of rows in the range must be at least 1/);
    assert.throws(() => sh.getRange(1, 1, 1, 0), /number of columns in the range must be at least 1/);
    assert.throws(() => sh.getRange('1', 1), /do not match the method signature|range cannot be found/);
    assert.throws(() => sh.getRange(1.5, 1), /do not match the method signature/);
    assert.equal(sh.getRange('B2:C3').getNumRows(), 2);
  });
});

test('KNOWN: values are parsed as if typed, and a leading apostrophe keeps text', () => {
  const { p, w, run } = fresh();
  run(() => {
    const sh = p.ss.getSheetByName('Sheet1');
    sh.getRange(1, 1, 1, 8).setValues([['007', 'TRUE', '2026-10-03', "'007", '1.50', 'plain', '=1+1', "'=1+1"]]);
    const v = sh.getRange(1, 1, 1, 8).getValues()[0];
    assert.equal(v[0], 7);
    assert.equal(v[1], true);
    assert.equal(Object.prototype.toString.call(v[2]), '[object Date]');
    assert.equal(v[2].toISOString(), '2026-10-03T05:00:00.000Z', 'midnight in America/Chicago (UTC-5 in October)');
    assert.equal(v[3], '007');
    assert.equal(v[4], 1.5);
    assert.equal(v[5], 'plain');
    assert.equal(v[7], '=1+1');
  });
  assert.deepEqual(w.formulas, ['=1+1']);
});

test('DOC: a date value comes back as a new Date each time, so a caller cannot change the cell', () => {
  const { p, run } = fresh();
  run(() => {
    const sh = p.ss.getSheetByName('Sheet1');
    sh.getRange(1, 1).setValue('2026-10-03');
    const a = sh.getRange(1, 1).getValue();
    a.setFullYear(1999);
    assert.equal(sh.getRange(1, 1).getValue().getFullYear(), 2026);
  });
});

test('KNOWN: sheet names must be unique and at most 100 characters; the last sheet stays', () => {
  const { p, run } = fresh();
  run(() => {
    p.ss.insertSheet('Data');
    assert.throws(() => p.ss.insertSheet('Data'), /A sheet with the name "Data" already exists\. Please enter another name\./);
    assert.throws(() => p.ss.insertSheet('x'.repeat(101)), /too long/);
    assert.throws(() => p.ss.insertSheet(''), /cannot be empty/);
    p.ss.deleteSheet(p.ss.getSheetByName('Data'));
    assert.throws(() => p.ss.deleteSheet(p.ss.getSheetByName('Sheet1')), /can't delete all the sheets/);
    assert.equal(p.ss.getSheetByName('missing'), null);
  });
});

test('DOC: appendRow adds after the last row with content and needs a value', () => {
  const { p, run } = fresh();
  run(() => {
    const sh = p.ss.getSheetByName('Sheet1');
    sh.getRange(5, 1).setValue('x');
    sh.appendRow(['a', 'b']);
    assert.equal(sh.getRange(6, 2).getValue(), 'b');
    assert.throws(() => sh.appendRow([]), /do not match the method signature/);
  });
});

test('DOC: tryLock times out with false, waitLock throws, a lock is freed at the end of an execution', () => {
  const { p, w, g, run } = fresh();
  w.otherHoldsScriptLock(Infinity);
  const t0 = w.now;
  run(() => {
    assert.equal(g.LockService.getScriptLock().tryLock(3000), false);
    assert.throws(() => g.LockService.getScriptLock().waitLock(3000), /Lock timeout: another process was holding the lock for too long/);
    assert.throws(() => g.LockService.getScriptLock().tryLock(-1), /do not match the method signature/);
  });
  assert.ok(w.now - t0 >= 6000, 'the waiting moved the clock');
  w.releaseOtherLocks();
  run(() => { assert.equal(g.LockService.getScriptLock().tryLock(1), true); });
  assert.equal(w.locks.script.holder, null, 'released when the execution ended');
  run(() => {
    const a = g.LockService.getScriptLock();
    a.tryLock(1);
    assert.equal(a.hasLock(), true);
    a.releaseLock();
    assert.equal(a.hasLock(), false);
    a.releaseLock();
  });
  assert.ok(p);
});

test('DOC: releasing a lock with unflushed spreadsheet writes is recorded', () => {
  const { p, w, g, run } = fresh();
  run(() => {
    const lock = g.LockService.getScriptLock();
    lock.tryLock(10);
    p.ss.getSheetByName('Sheet1').getRange(1, 1).setValue(1);
    lock.releaseLock();
  });
  assert.deepEqual(w.violations, ['lock released with unflushed spreadsheet writes']);
  w.violations.length = 0;
  run(() => {
    const lock = g.LockService.getScriptLock();
    lock.tryLock(10);
    p.ss.getSheetByName('Sheet1').getRange(1, 1).setValue(2);
    g.SpreadsheetApp.flush();
    lock.releaseLock();
  });
  assert.deepEqual(w.violations, []);
});

test('DOC: cache limits are 250 characters for a key, 100 KB for a value and 6 hours for the life', () => {
  const { w, g, run } = fresh();
  run(() => {
    const c = g.CacheService.getScriptCache();
    assert.throws(() => c.put('k'.repeat(251), 'v'), /Argument too large: key/);
    assert.throws(() => c.put('k', 'v'.repeat(100 * 1024 + 1)), /Argument too large: value/);
    assert.throws(() => c.put('k', 'v', 21601), /Invalid expiration/);
    assert.throws(() => c.put('k', 5), /do not match the method signature/);
    c.put('k', 'v', 10);
    assert.equal(c.get('k'), 'v');
    w.now += 11000;
    assert.equal(c.get('k'), null, 'expired');
  });
});

test('DOC: a script property is at most 9 KB and the store is at most 500 KB', () => {
  const { g, run } = fresh();
  run(() => {
    const props = g.PropertiesService.getScriptProperties();
    assert.throws(() => props.setProperty('k', 'v'.repeat(9 * 1024 + 1)), /Argument too large: value/);
    for (let i = 0; i < 55; i++) props.setProperty('k' + i, 'v'.repeat(9 * 1024));
    assert.throws(() => props.setProperty('over', 'v'.repeat(9 * 1024)), /500 KB/);
    assert.equal(props.getProperty('over'), null, 'the failed write left nothing behind');
    assert.equal(props.getProperty('nope'), null);
  });
});

test('DOC: at most 20 triggers per script, and everyMinutes takes only 1, 5, 10, 15 or 30', () => {
  const { g, run } = fresh();
  run(() => {
    for (let i = 0; i < 20; i++) g.ScriptApp.newTrigger('onOpen').timeBased().after(1000).create();
    assert.throws(() => g.ScriptApp.newTrigger('onOpen').timeBased().after(1000).create(), /too many triggers/);
    assert.throws(() => g.ScriptApp.newTrigger('onOpen').timeBased().everyMinutes(2), /must be 1, 5, 10, 15 or 30/);
    assert.throws(() => g.ScriptApp.newTrigger('onOpen').timeBased().after(0), /do not match the method signature/);
    const triggers = g.ScriptApp.getProjectTriggers();
    g.ScriptApp.deleteTrigger(triggers[0]);
    assert.equal(g.ScriptApp.getProjectTriggers().length, 19);
  });
});

test('DOC/KNOWN: GmailApp.sendEmail checks recipients, subject length, attachments and the daily quota', () => {
  const { w, g, run } = fresh();
  run(() => {
    assert.throws(() => g.GmailApp.sendEmail('', 's', 'b'), /no recipient/);
    assert.throws(() => g.GmailApp.sendEmail('nobody', 's', 'b'), /Invalid email: nobody/);
    assert.throws(() => g.GmailApp.sendEmail('a@example.com', 's'.repeat(251), 'b'), /Argument too large: subject/);
    assert.throws(() => g.GmailApp.sendEmail('a@example.com', 's', 'b', { attachments: ['not a blob'] }), /do not match the method signature/);
    assert.throws(() => g.GmailApp.sendEmail('a@example.com', 's'), /do not match the method signature/);
    w.mailQuota = 2;
    g.GmailApp.sendEmail('a@example.com', 's', 'b', { cc: 'c@example.com' });
    assert.throws(() => g.GmailApp.sendEmail('a@example.com', 's', 'b'), /Service invoked too many times for one day: email\./);
  });
  assert.equal(w.sent.length, 1);
  assert.equal(w.sent[0].cc, 'c@example.com');
});

test('KNOWN: a simple trigger cannot send mail, use Drive or fetch URLs', () => {
  const { g, run } = fresh();
  for (const f of [() => g.GmailApp.sendEmail('a@example.com', 's', 'b'), () => g.DriveApp.createFolder('x'), () => g.UrlFetchApp.fetch('https://x.example.test/'),
    () => g.ScriptApp.newTrigger('x'), () => g.DocumentApp.create('x'), () => g.FormApp.create('x')]) {
    assert.throws(() => run(f, { mode: 'simple' }), /You do not have permission to call/);
  }
});

test('KNOWN: Drive messages for a missing id and an exhausted iterator', () => {
  const { g, run } = fresh();
  run(() => {
    assert.throws(() => g.DriveApp.getFolderById('nope'), /Unexpected error while getting the method or property getFolderById on object DriveApp\./);
    assert.throws(() => g.DriveApp.getFileById('nope'), /Unexpected error while getting the method or property getFileById on object DriveApp\./);
    const folder = g.DriveApp.createFolder('f');
    const it = folder.getFilesByName('none');
    assert.equal(it.hasNext(), false);
    assert.throws(() => it.next(), /Cannot retrieve the next object: iterator has reached the end\./);
  });
});

test('DOC: getFilesByName skips trashed files; makeCopy names the copy "Copy of" by default', () => {
  const { g, run } = fresh();
  run(() => {
    const folder = g.DriveApp.createFolder('f');
    const a = folder.createFile('a.txt', 'one', 'text/plain');
    const b = folder.createFile('a.txt', 'two', 'text/plain');
    b.setTrashed(true);
    const it = folder.getFilesByName('a.txt');
    assert.equal(it.next().getId(), a.getId());
    assert.equal(it.hasNext(), false);
    assert.equal(a.makeCopy().getName(), 'Copy of a.txt');
    assert.equal(a.makeCopy('named', folder).getName(), 'named');
  });
});

test('DOC: a Document is closed after saveAndClose, and a PDF made before saving misses the edits', () => {
  const { p, g, run } = fresh();
  run(() => {
    const doc = g.DocumentApp.create('t');
    doc.getBody().appendParagraph('hello');
    const file = g.DriveApp.getFileById(doc.getId());
    assert.ok(!file.getAs('application/pdf').getDataAsString().includes('hello'), 'unsaved edits are not in the PDF');
    doc.saveAndClose();
    assert.ok(file.getAs('application/pdf').getDataAsString().includes('hello'));
    assert.throws(() => doc.getBody(), /Document is closed/);
    assert.throws(() => file.getAs('image/png'), /not supported/);
  });
  assert.ok(p);
});

test('DOC: an open Document is saved when the execution ends', () => {
  const { w, g, run } = fresh();
  let id;
  run(() => {
    const doc = g.DocumentApp.create('t');
    doc.getBody().appendParagraph('kept');
    id = doc.getId();
  });
  run(() => assert.ok(g.DriveApp.getFileById(id).getAs('application/pdf').getDataAsString().includes('kept')));
  assert.ok(w);
});

test('DOC/STRICT: replaceText takes an RE2 pattern; lookahead, backreferences and a $ replacement are refused', () => {
  const { g, run } = fresh();
  run(() => {
    const doc = g.DocumentApp.create('t');
    const body = doc.getBody();
    body.appendParagraph('Hello {{name}}');
    assert.throws(() => body.replaceText('(?=a)', 'x'), /Invalid regular expression/);
    assert.throws(() => body.replaceText('(a)\\1', 'x'), /Invalid regular expression/);
    assert.throws(() => body.replaceText('(', 'x'), /Invalid regular expression/);
    assert.throws(() => body.replaceText('x', 'cost $1'), /dollar sign/);
    assert.throws(() => body.replaceText('x', 5), /do not match the method signature/);
    body.replaceText('\\{\\{name\\}\\}', 'Ana');
    assert.match(body.getText(), /Hello Ana/);
    assert.throws(() => body.insertTable(0, [[1]]), /do not match the method signature/);
    assert.throws(() => body.insertTable(99, [['a']]), /Index out of range/);
    assert.throws(() => body.appendParagraph(5), /do not match the method signature/);
  });
});

test('DOC: UrlFetchApp throws on an error status unless muteHttpExceptions is set', () => {
  const { w, g, run } = fresh();
  w.route((u) => u.startsWith('https://x.example.test/'), () => ({ code: 500, body: { e: 1 } }));
  run(() => {
    assert.throws(() => g.UrlFetchApp.fetch('https://x.example.test/a'), /Request failed for https:\/\/x\.example\.test returned code 500\. Truncated server response: .* \(use muteHttpExceptions option to examine full response\)/);
    assert.equal(g.UrlFetchApp.fetch('https://x.example.test/a', { muteHttpExceptions: true }).getResponseCode(), 500);
    assert.throws(() => g.UrlFetchApp.fetch('not a url'), /Invalid argument: not a url/);
    assert.throws(() => g.UrlFetchApp.fetch('https://nowhere.example.test/'), /DNS error: https:\/\/nowhere\.example\.test\//);
    assert.throws(() => g.UrlFetchApp.fetch('https://x.example.test/a', { method: 'teleport' }), /Invalid argument: method/);
  });
});

test('DOC: Utilities.formatDate uses the time zone given, and local midnight follows daylight saving', () => {
  const d = new Date(Date.UTC(2026, 9, 3, 3, 30, 0));
  assert.equal(formatDate(d, 'America/Chicago', 'yyyy-MM-dd HH:mm'), '2026-10-02 22:30');
  assert.equal(formatDate(d, 'Asia/Manila', 'yyyy-MM-dd HH:mm'), '2026-10-03 11:30');
  assert.equal(formatDate(d, 'UTC', "yyyy-MM-dd'T'HH:mm:ssXXX"), '2026-10-03T03:30:00Z');
  assert.equal(formatDate(d, 'America/Chicago', 'Z'), '-0500');
  assert.equal(zonedMidnight(2026, 3, 8, 'America/Chicago'), Date.UTC(2026, 2, 8, 6), 'before the clocks change: UTC-6');
  assert.equal(zonedMidnight(2026, 3, 9, 'America/Chicago'), Date.UTC(2026, 2, 9, 5), 'after: UTC-5');
  assert.throws(() => formatDate('2026-10-03', 'UTC', 'yyyy'), /do not match the method signature/);
});

test('DOC: an execution that runs past 6 minutes is stopped at the next service call', () => {
  const { w, g, run } = fresh();
  assert.throws(() => run(() => {
    g.Utilities.sleep(MAX_EXEC_MS + 1000);
    g.SpreadsheetApp.flush();
  }), /Exceeded maximum execution time/);
  assert.equal(w.dead, null);
  run(() => g.SpreadsheetApp.flush());
});

test('DOC: the manifest scopes decide which services may run', () => {
  const p = loadProject({ scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  assert.throws(() => p.w.run(() => p.w.globals.GmailApp.sendEmail('a@example.com', 's', 'b')), /Specified permissions are not sufficient to call GmailApp\.sendEmail/);
  assert.throws(() => p.w.run(() => p.w.globals.UrlFetchApp.fetch('https://x.example.test/')), /Specified permissions are not sufficient to call UrlFetchApp\.fetch/);
  p.w.run(() => p.w.globals.SpreadsheetApp.flush());
});

test('DOC: HtmlService templates escape <?= ?>, pass <?!= ?> through and run scriptlets', () => {
  const { p, w, g, run } = fresh();
  w.htmlFiles.T = '<p><?= a ?></p><p><?!= a ?></p><? for (var i = 0; i < n; i++) { ?><i><?= i ?></i><? } ?>';
  run(() => {
    const t = g.HtmlService.createTemplateFromFile('T');
    t.a = '<b>"x" & \'y\'</b>';
    t.n = 2;
    const out = t.evaluate().setTitle('t').getContent();
    assert.equal(out, '<p>&lt;b&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/b&gt;</p><p><b>"x" & \'y\'</b></p><i>0</i><i>1</i>');
    assert.throws(() => g.HtmlService.createTemplateFromFile('Missing'), /No HTML file named Missing was found\./);
  });
  assert.ok(p);
});

test('DOC: ContentService accepts only its own mime types', () => {
  const { g } = fresh();
  const out = g.ContentService.createTextOutput('{}').setMimeType(g.ContentService.MimeType.JSON);
  assert.equal(out.getMimeType(), 'JSON');
  assert.throws(() => out.setMimeType('application/json'), /do not match the method signature/);
});

test('the fake form enforces required items and listed choices', () => {
  const { w, g, run } = fresh();
  let form;
  run(() => {
    form = g.FormApp.create('f');
    form.addTextItem().setTitle('Name').setRequired(true);
    form.addMultipleChoiceItem().setTitle('Pick').setChoiceValues(['a', 'b']);
  });
  assert.throws(() => w.submitForm(form, { Pick: 'a' }), /Required item missing: Name/);
  assert.throws(() => w.submitForm(form, { Name: 'x', Pick: 'c' }), /Not a valid choice for Pick/);
  assert.deepEqual(w.submitForm(form, { Name: 'x', Pick: 'a' }), []);
  run(() => assert.throws(() => g.FormApp.openById('missing'), /Unexpected error while getting the method or property openById on object FormApp\./));
});

test('a kill stops everything after it: a finally block that calls a service is stopped too', () => {
  const { p, w, g } = fresh();
  w.killWhen = ({ name }) => name === 'Range.setValue';
  const ran = [];
  assert.throws(() => w.run(() => {
    try {
      p.ss.getSheetByName('Sheet1').getRange(1, 1).setValue(1);
    } finally {
      try { g.SpreadsheetApp.flush(); ran.push('flush'); } catch (e) { ran.push('stopped'); }
    }
  }), (e) => e.name === 'ExecutionKilled');
  assert.deepEqual(ran, ['stopped']);
});
