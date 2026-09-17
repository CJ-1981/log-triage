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
  'pii-remote.js',
  'filters.js',
  'highlights.js',
  'levels.js',
  'search.js',
  'store.js',
  'timeline.js',
  'selection.js',
  'bookmarks.js',
  'exporter.js',
  'themes.js',
  'issues.js',
  'lzma.js',
  'format-7z.js',
  'archive.js',
  'app-filecache.js',
  'app-paging.js',
  'droptree.js',
  'app.js',
];

/* Worker bundle: pure-logic modules the paging worker needs, inlined as a
 * string into the single-file HTML (spawned from a Blob URL). Kept separate
 * from MODULE_ORDER — the worker must run standalone, without UI glue. */
const WORKER_ORDER = [
  'util.js',
  'detect.js',
  'parser.js',
  'filters.js',
  'search.js',
  'paged.js',
  'app-paging-worker.js',
];

const TOKENS = [
  '__LT_VERSION__',
  '/*__LT_CSS__*/',
  '/*__LT_MODULES__*/',
  '/*__LT_WORKER__*/',
  '/*__LT_CASES__*/',
  '/*__LT_DEMO__*/',
];

const LF = (s) => String(s).replace(/\r\n/g, '\n').replace(/\r/g, '\n');

function buildHTML({ version, template, modules, cases, css, demoLog, worker }) {
  for (const tok of TOKENS) {
    if (!template.includes(tok)) {
      throw new Error('template is missing token ' + tok);
    }
  }
  // LF-normalize every input first: a Windows checkout carries CRLF sources,
  // and the worker JSON would otherwise embed \r escapes that a CI build (LF
  // checkout) never produces — breaking the committed-bundle freshness check.
  template = LF(template);
  modules = modules.map(LF);
  cases = LF(cases);
  css = LF(css);
  demoLog = LF(demoLog);
  worker = LF(worker || '');
  // Function replacers are mandatory: string replacements would expand
  // $&, $`, $' sequences inside injected module sources.
  return template
    .replace(/__LT_VERSION__/g, () => String(version))
    .replace('/*__LT_CSS__*/', () => String(css || ''))
    .replace('/*__LT_MODULES__*/', () => modules.join('\n'))
    .replace('/*__LT_WORKER__*/', () => JSON.stringify(worker).replace(/</g, '\\u003c'))
    .replace('/*__LT_CASES__*/', () => String(cases || ''))
    .replace('/*__LT_DEMO__*/', () => JSON.stringify(String(demoLog)));
}

function main() {
  const root = __dirname;
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const template = fs.readFileSync(path.join(root, 'template.html'), 'utf8');
  const demoLog = fs.readFileSync(path.join(root, 'tests', 'fixtures', 'demo.log'), 'utf8');
  const css = require('./src/themes.js').generateCss();
  const cases = fs.readFileSync(path.join(root, 'tests', 'core-cases.js'), 'utf8');
  const modules = MODULE_ORDER.map((name) =>
    fs.readFileSync(path.join(root, 'src', name), 'utf8'));
  const worker = WORKER_ORDER
    .map((name) => fs.readFileSync(path.join(root, 'src', name), 'utf8')).join('\n');
  const html = buildHTML({ version: pkg.version, template, modules, cases, css, demoLog, worker });
  const out = path.join(root, 'log-triage.html');
  fs.writeFileSync(out, html, 'utf8');
  console.log('built', out, (html.length / 1024).toFixed(1) + ' KB', 'v' + pkg.version);
}

if (require.main === module) main();

module.exports = { buildHTML, MODULE_ORDER, WORKER_ORDER };
