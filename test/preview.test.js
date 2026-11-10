'use strict';
/**
 * "Send to me first": a report that goes to the person running the script
 * instead of the client, from runClientReport (options.preview) and from the
 * sidebar checkbox.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadSeeded } = require('./helpers/load');

const CLIENT = 'Harbor Lane Bakery';
const CLIENT_ADDRESS = 'mira@harborlanebakery.example.com';
const ME = 'owner@example.test';

test('preview: the PDF goes to the person running the script and never to the client', () => {
  const p = loadSeeded();
  const r = p.plain(p.call('runClientReport', CLIENT, '2026-10', { preview: true }));
  assert.equal(r.email, 'preview_sent');
  assert.equal(p.w.sent.length, 1);
  const mail = p.w.sent[0];
  assert.equal(mail.to, ME);
  assert.equal(mail.cc, '');
  assert.equal(mail.bcc, '');
  assert.match(mail.subject, /^\[Preview\] Harbor Lane Bakery marketing report, 2026-10$/);
  assert.match(mail.body, /has not been emailed/);
  assert.equal(mail.attachments.length, 1);
  assert.equal(mail.attachments[0].name, 'harbor-lane-bakery-2026-10.pdf');
  assert.ok(!JSON.stringify(mail).includes(CLIENT_ADDRESS), 'the client address appears nowhere in the message');
});

test('preview: it does not count as the email to the client, so the next real run still sends', () => {
  const p = loadSeeded();
  p.call('runClientReport', CLIENT, '2026-10', { preview: true });
  assert.equal(p.rows('Report Log')[1][5], '', 'emailed_at stays empty');
  const real = p.plain(p.call('runClientReport', CLIENT, '2026-10'));
  assert.equal(real.email, 'sent');
  assert.equal(p.w.sent[1].to, CLIENT_ADDRESS);
  assert.notEqual(p.rows('Report Log')[1][5], '');
});

test('preview: it works even after the client was emailed, and leaves the emailed time alone', () => {
  const p = loadSeeded();
  p.call('runClientReport', CLIENT, '2026-10');
  const emailedAt = p.rows('Report Log')[1][5];
  const r = p.plain(p.call('runClientReport', CLIENT, '2026-10', { preview: true }));
  assert.equal(r.email, 'preview_sent');
  assert.equal(p.w.sent.length, 2);
  assert.equal(p.rows('Report Log')[1][5], emailedAt);
  assert.equal(p.plain(p.call('runClientReport', CLIENT, '2026-10')).email, 'already_sent');
});

test('preview: a client with no address can still be previewed', () => {
  const p = loadSeeded();
  p.w.run(() => p.ss.getSheetByName('Clients').getRange(2, 3).setValue(''));
  assert.equal(p.plain(p.call('runClientReport', CLIENT, '2026-10', { preview: true })).email, 'preview_sent');
});

test('preview: when Google gives no address, REPORT_CC is used; with neither nothing is sent', () => {
  const p = loadSeeded({ world: { activeUserEmail: '' } });
  const none = p.plain(p.call('runClientReport', CLIENT, '2026-10', { preview: true }));
  assert.equal(none.email, 'no_preview_address');
  assert.equal(p.w.sent.length, 0);
  assert.equal(none.status, 'ok', 'the PDF is still made');
  p.setProp('REPORT_CC', 'boss@example.test');
  const via = p.plain(p.call('runClientReport', CLIENT, '2026-10', { preview: true }));
  assert.equal(via.email, 'preview_sent');
  assert.equal(p.w.sent[0].to, 'boss@example.test');
  assert.equal(p.w.sent[0].cc, '', 'the copy address is the recipient, not also a copy');
});

test('preview: a bad REPORT_CC is ignored', () => {
  const p = loadSeeded({ world: { activeUserEmail: '' } });
  p.setProp('REPORT_CC', 'not an address');
  assert.equal(p.plain(p.call('runClientReport', CLIENT, '2026-10', { preview: true })).email, 'no_preview_address');
});

test('preview: no mail quota left is reported, the PDF is still made', () => {
  const p = loadSeeded({ world: { mailQuota: 0 } });
  const r = p.plain(p.call('runClientReport', CLIENT, '2026-10', { preview: true }));
  assert.match(r.email, /^failed: Service invoked too many times/);
  assert.equal(r.status, 'ok');
});

test('REPORT_CC is copied on the real email to the client and not on a preview', () => {
  const p = loadSeeded();
  p.setProp('REPORT_CC', 'boss@example.test');
  p.call('runClientReport', CLIENT, '2026-10', { preview: true });
  p.call('runClientReport', CLIENT, '2026-10');
  assert.equal(p.w.sent[0].cc, '');
  assert.equal(p.w.sent[1].cc, 'boss@example.test');
  assert.equal(p.w.sent[1].to, CLIENT_ADDRESS);
});

test('sidebar: only an explicit false emails the client, anything else is a preview', () => {
  for (const [args, to, email] of [
    [[], ME, 'preview_sent'],
    [[true], ME, 'preview_sent'],
    [['false'], ME, 'preview_sent'],
    [[0], ME, 'preview_sent'],
    [[null], ME, 'preview_sent'],
    [[false], CLIENT_ADDRESS, 'sent']
  ]) {
    const p = loadSeeded();
    const r = p.plain(p.call('sidebarRunReport', CLIENT, '2026-10', ...args));
    assert.equal(r.email, email, JSON.stringify(args));
    assert.equal(p.w.sent[0].to, to, JSON.stringify(args));
  }
});

test('sidebar page: "Send to me first" is a checkbox that starts ticked and its value is passed to the server', () => {
  const p = loadSeeded();
  const html = p.w.htmlFiles.Sidebar;
  assert.match(html, /<input type="checkbox" id="send-to-me" checked>/);
  assert.match(html, /Send to me first/);
  assert.match(html, /document\.getElementById\('send-to-me'\)\.checked/);
});

test('sidebar page: each reply code is shown in words, and no code is shown raw', () => {
  const p = loadSeeded();
  const html = p.w.htmlFiles.Sidebar;
  for (const code of ['sent', 'preview_sent', 'no_preview_address', 'already_sent', 'no_address', 'not_sent']) {
    assert.ok(html.includes(code + ':'), 'words for ' + code);
  }
});

test('month close after a preview still emails the client', () => {
  const p = loadSeeded();
  p.call('runClientReport', CLIENT, '2026-10', { preview: true });
  const close = p.plain(p.call('runMonthClose', '2026-10'));
  const mine = close.results.find((x) => x.client === CLIENT);
  assert.equal(mine.status, 'ok', 'not skipped as current');
  assert.equal(mine.email, 'sent');
  assert.equal(p.w.sent.filter((m) => m.to === CLIENT_ADDRESS).length, 1);
});

test('month close after a failed email tries that client again, and a client with nothing to send to is skipped', () => {
  const p = loadSeeded({ world: { mailQuota: 0 } });
  const first = p.plain(p.call('runMonthClose', '2026-10'));
  assert.ok(first.results.every((x) => /^failed/.test(x.email)));
  p.w.mailQuota = 100;
  const second = p.plain(p.call('runMonthClose', '2026-10'));
  assert.ok(second.results.every((x) => x.status === 'ok' && x.email === 'sent'), 'every client gets the email now');
  const third = p.plain(p.call('runMonthClose', '2026-10'));
  assert.ok(third.results.every((x) => x.status === 'current'));
  assert.equal(p.w.sent.length, 8);
});

test('month close skips a current report for a client with no address instead of rebuilding it each time', () => {
  const p = loadSeeded();
  p.w.run(() => p.ss.getSheetByName('Clients').getRange(2, 3).setValue(''));
  p.call('runMonthClose', '2026-10');
  const again = p.plain(p.call('runMonthClose', '2026-10'));
  assert.equal(again.results.find((x) => x.client === CLIENT).status, 'current');
});

test('every script property is explained in SD.PROP_NOTES', () => {
  const p = loadSeeded();
  const props = p.plain(p.get('SD.PROPS'));
  const notes = p.plain(p.get('SD.PROP_NOTES'));
  assert.deepEqual(Object.keys(notes).sort(), Object.keys(props).sort());
  for (const k of Object.keys(props)) assert.ok(notes[k].length > 20, 'a real sentence for ' + k);
  assert.match(notes.REPORT_CC, /Send to me first/);
  assert.match(notes.AD_API_BASE, /stand-in/);
});

test('preview after the figures changed: the preview does not mark the new figures as emailed, so the real run sends them', () => {
  const p = loadSeeded();
  p.call('runClientReport', CLIENT, '2026-10');
  p.append('Campaigns', [[CLIENT, 'video', '2026-10-31', 10, 5, 1, 'USD']]);
  p.call('runClientReport', CLIENT, '2026-10', { preview: true });
  assert.equal(p.rows('Report Log')[1][5], '', 'the changed figures have no emailed time yet');
  const real = p.plain(p.call('runClientReport', CLIENT, '2026-10'));
  assert.equal(real.email, 'sent');
  assert.equal(p.w.sent.filter((m) => m.to === CLIENT_ADDRESS).length, 2);
});
