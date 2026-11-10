'use strict';
/**
 * Runs the script of the sidebar or the dialog page against a small fake page.
 * `replies` maps a server function name to what the page gets back when it
 * calls that function through google.script.run.
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function pageScript(file) {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'src', file), 'utf8');
  return /<script>([\s\S]*)<\/script>/.exec(html)[1];
}

function openPage(file, replies) {
  const elements = {};
  const el = (id) => elements[id] || (elements[id] = { id, value: '', checked: true, disabled: false, textContent: '', className: '', appendChild() {}, onclick: null });
  const make = (s, f) => new Proxy({}, {
    get(_, k) {
      if (k === 'withSuccessHandler') return (fn) => make(fn, f);
      if (k === 'withFailureHandler') return (fn) => make(s, fn);
      return () => { if (s && replies[k] !== undefined) s(replies[k]); };
    }
  });
  const sandbox = { document: { getElementById: el, createElement: () => ({}) }, google: { script: { run: make(null, null), host: { close() {} } } } };
  vm.runInNewContext(pageScript(file), sandbox);
  return { click: (id) => el(id).onclick(), status: () => el('status').textContent, value: (id) => el(id).value };
}

module.exports = { openPage, pageScript };
