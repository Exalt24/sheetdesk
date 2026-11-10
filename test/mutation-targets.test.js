'use strict';
/**
 * Every mutant of scripts/mutation.js and scripts/mutation-ast.js must still find its text in src/ exactly
 * once and compile. Found by the full run of the fourth pass: two typed mutants pointed at lines the fixes
 * had rewritten, so the run refused them after the fixes were done. This test runs the check without running
 * any mutant, so `npm test` and CI fail the moment a source edit moves a guard that a mutant names.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

function check(args) {
  const env = Object.assign({}, process.env);
  delete env.SHEETDESK_MUTANT;
  return spawnSync(process.execPath, ['scripts/mutation.js', '--check', ...args], { cwd: ROOT, env, encoding: 'utf8', timeout: 120000 });
}

// CLASS-TABLE: every kind of mutant against the check that its text is still there
test('CLASS-TABLE: every typed mutant and every syntax tree mutant finds its text once and compiles', () => {
  for (const [label, args] of [['all mutants', []], ['syntax tree mutants only', ['--ast']]]) {
    for (const filter of [[], ['bulk'], ['ast:Reporting']]) {
      const r = check([...args, ...filter]);
      assert.equal(r.status, 0, label + ' ' + filter.join(' ') + ': ' + r.stdout + r.stderr);
      assert.match(r.stdout, /^checked \d+ mutants/m, label);
    }
  }
});
