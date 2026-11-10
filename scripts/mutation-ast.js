'use strict';
/**
 * Mutants derived from the syntax tree, for the code of the corpus round fixes.
 *
 * scripts/mutation.js holds mutants typed as old text and new text. These are
 * generated instead: the source is parsed with espree (it comes with ESLint),
 * the statements named in TARGETS are selected, and every node inside them is
 * changed by one operator at a time:
 *
 *   comparison     < <= > >= === !==          the boundary or the sense flips
 *   arithmetic     + - * /                    the other one
 *   logic          && ||                      the other one
 *   negation       !x                         x
 *   condition      if, ?:, loop test          true, false, or the opposite
 *   number         n                          n + 1, n - 1, and 0
 *   string         "x"                        the empty string, and "" becomes "x"
 *   boolean        true false                 the other one
 *   call           Math.round                 Math.floor, Math.ceil
 *   call           addCount_(a, b)            (a + b), the fix undone
 *   return         return x                   return undefined
 *   statement      a call or assignment       removed
 *
 * A mutant is an exact position in the file (start, end), so it applies to
 * the one node it came from even when the same text appears twice. The loader
 * (test/helpers/load.js) checks that the text at that position is still the
 * text the mutant expects. Only the corpus replay and the CLASS-TABLE tests
 * are run against these mutants (see TEST_PATTERN in scripts/mutation.js).
 */

const fs = require('node:fs');
const path = require('node:path');
const espree = require('espree');

const SRC = path.join(__dirname, '..', 'src');

/**
 * What to mutate. within: the function whose body is searched (null for the
 * top level of the file). marker: the statements that mention it are chosen.
 * mode: 'inner' picks the innermost such statements, 'outer' the outermost,
 * 'all' every node of the function.
 */
const TARGETS = [
  { file: 'Webhook.js', within: 'webhookValidate_', marker: /warnings/, mode: 'outer' },
  { file: 'Webhook.js', within: 'handleLeadPost_', marker: /warnings|reply/, mode: 'inner' },
  { file: 'Campaigns.js', within: 'parseCampaignRow_', marker: /isBlankCell_|conversionsNumber/, mode: 'inner' },
  { file: 'Util.js', within: 'isBlankCell_', marker: /./, mode: 'all' },
  { file: 'Util.js', within: 'addCount_', marker: /./, mode: 'all' },
  { file: 'Reporting.js', within: 'aggregate_', marker: /addCount_/, mode: 'inner' },
  { file: 'Reporting.js', within: 'sumChannels_', marker: /addCount_/, mode: 'inner' },
  { file: 'BulkProcess.js', within: 'runBulkSlice_', marker: /BULK_MIN_RATE_ROWS/, mode: 'inner' },
  { file: 'BulkProcess.js', within: null, marker: /BULK_MIN_RATE_ROWS =/, mode: 'inner' },
  { file: 'BulkProcess.js', within: 'writeRollup_', marker: /addCount_/, mode: 'inner' }
];

const CONDITIONAL = ['IfStatement', 'ConditionalExpression', 'WhileStatement', 'ForStatement'];

const SWAPS = {
  '<': ['<=', '>'], '<=': ['<', '>='], '>': ['>=', '<'], '>=': ['>', '<='],
  '===': ['!=='], '!==': ['==='], '+': ['-'], '-': ['+'], '*': ['/'], '/': ['*'],
  '&&': ['||'], '||': ['&&']
};

const MATH_SWAPS = { round: ['floor', 'ceil'], floor: ['round'], ceil: ['round'], max: ['min'], min: ['max'] };

function children(node) {
  const out = [];
  for (const key of Object.keys(node)) {
    const v = node[key];
    if (Array.isArray(v)) v.forEach((c) => { if (c && typeof c.type === 'string') out.push(c); });
    else if (v && typeof v.type === 'string') out.push(v);
  }
  return out;
}

function walk(node, fn) {
  fn(node);
  for (const c of children(node)) walk(c, fn);
}

const isStatement = (n) => /Statement$|Declaration$/.test(n.type) && n.type !== 'BlockStatement' && n.type !== 'FunctionDeclaration';

function findFunction(ast, name) {
  let hit = null;
  walk(ast, (n) => { if (n.type === 'FunctionDeclaration' && n.id.name === name) hit = n; });
  if (!hit) throw new Error('function ' + name + ' not found');
  return hit;
}

function selectRoots(ast, text, t) {
  const scope = t.within ? findFunction(ast, t.within) : ast;
  if (t.mode === 'all') return [scope];
  const hasMarker = (n) => t.marker.test(text.slice(n.range[0], n.range[1]));
  const all = [];
  walk(scope, (n) => { if (n !== scope && isStatement(n) && hasMarker(n)) all.push(n); });
  const inside = (a, b) => a !== b && b.range[0] <= a.range[0] && b.range[1] >= a.range[1];
  if (t.mode === 'outer') return all.filter((n) => !all.some((o) => inside(n, o)));
  return all.filter((n) => !all.some((o) => inside(o, n)));
}

/** The replacements one node gives: {target: the node whose text is replaced, replace, label}. */
function operators(node, text) {
  const out = [];
  const add = (replace, label, target) => out.push({ target: target || node, replace, label });
  const src = (n) => text.slice(n.range[0], n.range[1]);
  if (node.type === 'BinaryExpression' || node.type === 'LogicalExpression') {
    // only the operator token is replaced, so parentheses around an operand stay where they are
    const at = node.left.range[1] + text.slice(node.left.range[1], node.right.range[0]).indexOf(node.operator);
    const token = { range: [at, at + node.operator.length], loc: node.loc };
    for (const op of SWAPS[node.operator] || []) add(op, node.operator + ' to ' + op, token);
  }
  if (node.type === 'UnaryExpression' && node.operator === '!') add(src(node.argument), 'drop !');
  if (CONDITIONAL.includes(node.type) && node.test) {
    add('true', 'condition always true', node.test);
    add('false', 'condition always false', node.test);
    add('!(' + src(node.test) + ')', 'condition negated', node.test);
  }
  if (node.type === 'Literal') {
    if (typeof node.value === 'number') {
      add(String(node.value + 1), 'number + 1');
      add(String(node.value - 1), 'number - 1');
      if (node.value !== 0) add('0', 'number to 0');
    } else if (typeof node.value === 'string') {
      add(node.value === '' ? "'x'" : "''", node.value === '' ? 'empty string to x' : 'string to empty');
    } else if (typeof node.value === 'boolean') {
      add(String(!node.value), 'boolean flipped');
    }
  }
  if (node.type === 'MemberExpression' && !node.computed && node.object.type === 'Identifier' && node.object.name === 'Math') {
    for (const m of MATH_SWAPS[node.property.name] || []) add('Math.' + m, 'Math.' + node.property.name + ' to Math.' + m);
  }
  if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'addCount_') {
    add('(' + src(node.arguments[0]) + ' + ' + src(node.arguments[1]) + ')', 'addCount_ to a plain +');
  }
  if (node.type === 'ReturnStatement' && node.argument) add('return undefined;', 'return value dropped');
  if (node.type === 'ExpressionStatement' && (node.expression.type === 'CallExpression' || node.expression.type === 'AssignmentExpression')) add(';', 'statement removed');
  return out;
}

/**
 * @return {Array<{id: string, file: string, start: number, end: number, find: string, replace: string, breaks: string}>}
 */
function astMutants() {
  const mutants = [];
  const seen = new Set();
  for (const t of TARGETS) {
    const text = fs.readFileSync(path.join(SRC, t.file), 'utf8');
    const ast = espree.parse(text, { ecmaVersion: 2019, range: true, loc: true, sourceType: 'script' });
    for (const root of selectRoots(ast, text, t)) {
      walk(root, (node) => {
        for (const { target, replace, label } of operators(node, text)) {
          const [start, end] = target.range;
          const find = text.slice(start, end);
          const key = t.file + ':' + start + ':' + end + ':' + replace;
          if (find === replace || seen.has(key)) continue;
          seen.add(key);
          const line = target.loc.start.line;
          mutants.push({
            id: 'ast:' + t.file.replace('.js', '') + ':' + line + '@' + start + '+' + (end - start) + ':' + label.split(' ').join('-'),
            file: t.file, start, end, find, replace,
            breaks: t.file + ' line ' + line + ': ' + label + ' (' + find.split(/\s+/).join(' ').slice(0, 50) + ')'
          });
        }
      });
    }
  }
  return mutants;
}

module.exports = { astMutants, TARGETS };

if (require.main === module) {
  const list = astMutants();
  console.log(list.length + ' mutants');
  for (const m of list) console.log(m.id + '  ' + m.breaks);
}
