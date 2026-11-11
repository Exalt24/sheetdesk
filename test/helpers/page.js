'use strict';
/**
 * Runs the script of the sidebar or the dialog page against a small fake page.
 * `replies` maps a server function name to what the page gets back when it
 * calls that function through google.script.run. A reply may also be a function:
 * it is given the arguments of the call and returns the reply, so a page can be
 * pressed twice and get a different answer the second time. `calls` lists every
 * call the page made, as [function name, arguments].
 */
const vm = require('node:vm');
const { readSource } = require('./load');

/** The script of a page as the loader reads it, so a mutant of the page is run by the tests too. */
function pageScript(file) {
  const html = readSource(file);
  return /<script>([\s\S]*)<\/script>/.exec(html)[1];
}

function openPage(file, replies) {
  const elements = {};
  const calls = [];
  const el = (id) => elements[id] || (elements[id] = { id, value: '', checked: true, disabled: false, textContent: '', className: '', appendChild() {}, onclick: null, onchange: null, oninput: null });
  const make = (s, f) => new Proxy({}, {
    get(_, k) {
      if (k === 'withSuccessHandler') return (fn) => make(fn, f);
      if (k === 'withFailureHandler') return (fn) => make(s, fn);
      return (...args) => {
        calls.push([k, JSON.parse(JSON.stringify(args))]);
        const reply = typeof replies[k] === 'function' ? replies[k](...args) : replies[k];
        if (s && reply !== undefined) s(reply);
      };
    }
  });
  const sandbox = { document: { getElementById: el, createElement: () => ({}) }, google: { script: { run: make(null, null), host: { close() {} } } } };
  vm.runInNewContext(pageScript(file), sandbox);
  return {
    click: (id) => el(id).onclick(),
    status: () => el('status').textContent,
    value: (id) => el(id).value,
    set: (id, value) => { el(id).value = value; },
    fire: (id, handler) => el(id)[handler](),
    label: (id) => el(id).textContent,
    disabled: (id) => el(id).disabled,
    calls
  };
}

module.exports = { openPage, pageScript };
