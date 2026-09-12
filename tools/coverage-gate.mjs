#!/usr/bin/env node
'use strict';
/* Coverage gate: runs the unit suite with Node's built-in coverage and fails
 * unless every core src/ module meets LINE_MIN / BRANCH_MIN. UI glue modules
 * listed in EXEMPT are reported but not gated. Exits non-zero on any test
 * failure or threshold violation. */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readdirSync } from 'node:fs';
import path from 'node:path';

const LINE_MIN = 90;
const BRANCH_MIN = 85;
const OVERRIDES = { 'pii-remote.js': { line: 95, branch: 75 } }; // new module, actively developed
const EXEMPT = [/src[\\/]app-.*\.js$/];

function collectTestFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'e2e' || e.name === 'tmp' || e.name === 'fixtures') continue;
        walk(p);
      } else if (/\.test\.(js|mjs|cjs)$/.test(e.name)) {
        out.push(p);
      }
    }
  };
  walk(path.join(root, 'tests'));
  return out;
}

function parseCoverage(out) {
  const rows = [];
  let dir = '';
  for (const line of out.split(/\r?\n/)) {
    // container row: "# src  |  |  |  |"
    const dirM = line.match(/^#\s+(\S+)\s*\|\s*\|/);
    if (dirM) { dir = dirM[1]; continue; }
    const m = line.match(/^#\s+(.+?)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|/);
    if (!m) continue;
    const name = m[1].trim();
    const file = name === 'all files' ? 'all files'
      : dir && dir !== 'all files' ? dir + '/' + name : name;
    rows.push({ file, line: parseFloat(m[2]), branch: parseFloat(m[3]), funcs: parseFloat(m[4]) });
  }
  return rows;
}

function main() {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const files = collectTestFiles(root);
  const res = spawnSync(process.execPath, [
    '--test', '--experimental-test-coverage', ...files,
  ], { encoding: 'utf8', cwd: root });
  const out = (res.stdout || '') + (res.stderr || '');

  if (res.status !== 0) {
    console.error(out);
    console.error(`GATE FAIL: unit tests did not pass (exit ${res.status}).`);
    process.exit(1);
  }

  const rows = parseCoverage(out);
  const core = rows.filter((r) => /src[\\/]/.test(r.file) && !EXEMPT.some((rx) => rx.test(r.file)));
  if (core.length === 0) {
    console.error('GATE FAIL: no src/ coverage rows found — is --experimental-test-coverage supported?');
    console.error(out.slice(-2000));
    process.exit(1);
  }

  let failed = false;
  console.log('coverage gate (core src modules):');
  for (const r of core) {
    const base = path.basename(r.file);
    const o = OVERRIDES[base] || {};
    const minLine = o.line || LINE_MIN;
    const minBranch = o.branch || BRANCH_MIN;
    const okLine = r.line >= minLine;
    const okBranch = r.branch >= minBranch;
    const ok = okLine && okBranch;
    if (!ok) failed = true;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${r.file}  line ${r.line}% (>=${minLine})  branch ${r.branch}% (>=${minBranch})`);
  }
  for (const r of rows.filter((x) => !core.includes(x) && x.file !== 'all files')) {
    console.log(`  (exempt) ${r.file}  line ${r.line}%  branch ${r.branch}%`);
  }
  if (failed) {
    console.error('GATE FAIL: coverage below threshold.');
    process.exit(1);
  }
  console.log('GATE PASS');
}

main();
