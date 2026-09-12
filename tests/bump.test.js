'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { parseBumpType, nextVersion, updateReadme, changelogEntry, commitsSince } = require('../tools/bump.mjs');

test('parseBumpType: feat minor, fix patch, breaking major, chore none', () => {
  assert.strictEqual(parseBumpType(['feat: add x']), 'minor');
  assert.strictEqual(parseBumpType(['fix: repair y']), 'patch');
  assert.strictEqual(parseBumpType(['feat!: new api']), 'major');
  assert.strictEqual(parseBumpType(['feat: x\n\nBREAKING CHANGE: drops z']), 'major');
  assert.strictEqual(parseBumpType(['chore: tidy', 'docs: read']), null);
  assert.strictEqual(parseBumpType([]), null);
});

test('parseBumpType: highest rank wins in mixed sets', () => {
  assert.strictEqual(parseBumpType(['fix: a', 'feat: b']), 'minor');
  assert.strictEqual(parseBumpType(['fix: a', 'feat: b', 'chore!: c']), 'major');
});

test('nextVersion applies semver arithmetic', () => {
  assert.strictEqual(nextVersion('0.1.0', ['fix: a']), '0.1.1');
  assert.strictEqual(nextVersion('0.1.0', ['feat: a']), '0.2.0');
  assert.strictEqual(nextVersion('1.2.3', ['feat!: a']), '2.0.0');
  assert.strictEqual(nextVersion('v1.2.3', ['fix: a']), '1.2.4');
  assert.strictEqual(nextVersion('1.2.3', ['docs: only']), null);
});

test('updateReadme rewrites the version marker', () => {
  const md = '<!-- version: 0.1.0-dev -->\n# Log Triage\n';
  assert.ok(updateReadme(md, '1.2.3').includes('<!-- version: 1.2.3 -->'));
  assert.ok(updateReadme('no marker', '1.2.3') === 'no marker');
});

test('changelogEntry renders version, date and commit subjects', () => {
  const entry = changelogEntry('1.2.3', '2026-09-11', ['feat: a\n\nbody', 'fix: b']);
  assert.ok(entry.startsWith('## 1.2.3 (2026-09-11)'));
  assert.ok(entry.includes('- feat: a'));
  assert.ok(entry.includes('- fix: b'));
  assert.ok(!entry.includes('body'));
});

test('commitsSince uses the injected git runner', () => {
  const out = commitsSince('v1.0.0', () => 'feat: one\nfix: two\n');
  assert.deepStrictEqual(out, ['feat: one', 'fix: two']);
});
