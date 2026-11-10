'use strict';
const fs = require('node:fs');
const path = require('node:path');
const js = require('@eslint/js');
const globals = require('globals');

/**
 * Apps Script loads every file into one global scope. To lint each file on
 * its own, the names declared at the top of the OTHER files are read from
 * the sources (so this list is derived, never typed) and given to ESLint as
 * read-only globals.
 */
const srcDir = path.join(__dirname, 'src');
const srcFiles = fs.readdirSync(srcDir).filter((f) => f.endsWith('.js'));
const declared = {};
for (const f of srcFiles) {
  const text = fs.readFileSync(path.join(srcDir, f), 'utf8');
  declared[f] = [
    ...[...text.matchAll(/^function\s+([A-Za-z0-9_$]+)\s*\(/gm)].map((m) => m[1]),
    ...[...text.matchAll(/^(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=/gm)].map((m) => m[1])
  ];
}

const APPS_SCRIPT_SERVICES = [
  'SpreadsheetApp', 'DocumentApp', 'DriveApp', 'GmailApp', 'MailApp', 'FormApp', 'HtmlService', 'ContentService',
  'UrlFetchApp', 'CacheService', 'PropertiesService', 'LockService', 'ScriptApp', 'Utilities', 'Logger',
  'Session', 'MimeType'
];

const common = {
  'no-var': 'error',
  'prefer-const': 'error',
  eqeqeq: ['error', 'always'],
  'no-shadow': 'off',
  'no-unused-vars': ['error', { vars: 'local', args: 'after-used', caughtErrors: 'none' }]
};

module.exports = [
  { ignores: ['node_modules/**', 'fixtures/**', 'coverage/**'] },
  js.configs.recommended,
  ...srcFiles.map((file) => ({
    files: ['src/' + file],
    languageOptions: {
      ecmaVersion: 2019,
      sourceType: 'script',
      globals: Object.assign(
        {},
        ...APPS_SCRIPT_SERVICES.map((n) => ({ [n]: 'readonly' })),
        ...srcFiles.filter((f) => f !== file).flatMap((f) => declared[f]).map((n) => ({ [n]: 'readonly' }))
      )
    },
    rules: Object.assign({}, common, {
      // Entry points are called by Google, not by other code.
      'no-unused-vars': ['error', { vars: 'local', args: 'after-used', caughtErrors: 'none' }]
    })
  })),
  {
    files: ['test/**/*.js', 'scripts/**/*.js', 'eslint.config.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'commonjs', globals: Object.assign({}, globals.node) },
    rules: common
  }
];
