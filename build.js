#!/usr/bin/env node
'use strict';
/* Log Triage — build.js: bundles src modules + template into the single-file
 * log-triage.html. No bundler, no transpile: modules are UMD-style files
 * concatenated in the order given by MODULE_ORDER. */
const fs = require('fs');
const path = require('path');

const MODULE_ORDER = [
  'util.js',
  'detect.js',
  'parser.js',
  'masks.js',
  'pii-provider.js',
  'filters.js',
  'levels.js',
  'search.js',
  'store.js',
  'timeline.js',
  'selection.js',
  'bookmarks.js',
  // appended by later gates in dependency order
];

const TOKENS = [
  '__LT_VERSION__',
  '/*__LT_CSS__*/',
  '/*__LT_MODULES__*/',
  '/*__LT_CASES__*/',
  '/*__LT_DEMO__*/',
];

function buildHTML({ version, template, modules, cases, css, demoLog }) {
  for (const tok of TOKENS) {
    if (!template.includes(tok)) {
      throw new Error('template is missing token ' + tok);
    }
  }
  return template
    .replace('__LT_VERSION__', String(version))
    .replace('/*__LT_CSS__*/', String(css || ''))
    .replace('/*__LT_MODULES__*/', modules.join('\n'))
    .replace('/*__LT_CASES__*/', String(cases || ''))
    .replace('/*__LT_DEMO__*/', JSON.stringify(String(demoLog)));
}

function main() {
  const root = __dirname;
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const template = fs.readFileSync(path.join(root, 'template.html'), 'utf8');
  const demoLog = fs.readFileSync(path.join(root, 'tests', 'fixtures', 'demo.log'), 'utf8');
  const modules = MODULE_ORDER.map((name) =>
    fs.readFileSync(path.join(root, 'src', name), 'utf8'));
  const html = buildHTML({ version: pkg.version, template, modules, demoLog });
  const out = path.join(root, 'log-triage.html');
  fs.writeFileSync(out, html, 'utf8');
  console.log('built', out, (html.length / 1024).toFixed(1) + ' KB', 'v' + pkg.version);
}

if (require.main === module) main();

module.exports = { buildHTML, MODULE_ORDER };
