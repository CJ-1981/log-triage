'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { buildHTML } = require('../build.js');
const { fnv1a32, escapeHtml, clamp, fmtBytes, timestampedName } = require('../src/util.js');

test('buildHTML injects version, modules and demo log into template', () => {
  const template = [
    '<!doctype html><title>Log Triage __LT_VERSION__</title>',
    '<style>/*__LT_CSS__*/</style>',
    '<script>/*__LT_MODULES__*/</script>',
    '<script>const W = /*__LT_WORKER__*/;</script>',
    '<script>/*__LT_CASES__*/</script>',
    '<script>const DEMO = /*__LT_DEMO__*/;</script>',
  ].join('\n');
  const html = buildHTML({
    version: '1.2.3',
    template,
    modules: ['moduleA();', 'moduleB();'],
    cases: 'CASE_A();',
    css: 'body{color:red}',
    demoLog: 'line "1"\nline 2',
    worker: 'var a = 1;',
  });
  assert.ok(html.includes('Log Triage 1.2.3'), 'version token replaced');
  assert.ok(html.includes('moduleA();\nmoduleB();'), 'modules concatenated in order');
  assert.ok(html.includes('CASE_A();'), 'cases injected');
  assert.ok(html.includes('body{color:red}'), 'css injected');
  assert.ok(html.includes('const W = "var a = 1;";'), 'worker source JSON-encoded');
  assert.ok(html.includes('"line \\"1\\"\\nline 2"'), 'demo log JSON-encoded');
});

test('buildHTML throws on missing placeholders', () => {
  assert.throws(() => buildHTML({ version: '1.0.0', template: '<p>no tokens</p>', modules: [], demoLog: '' }));
});

test('buildHTML does not expand $ sequences in module sources (P0 regression)', () => {
  const template = '__LT_VERSION__/*__LT_CSS__*//*__LT_MODULES__*//*__LT_WORKER__*//*__LT_CASES__*//*__LT_DEMO__*/';
  const tricky = "s.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&');";
  const html = buildHTML({ version: '1.0.0', template, modules: [tricky], css: '', cases: '', demoLog: '', worker: '</script><script>alert(1)</script>' });
  assert.ok(html.includes("\\$&"), 'the $& escape sequence must survive verbatim');
  assert.ok(!html.includes('/*__LT_MODULES__*/'), 'token must be replaced');
  assert.ok(!html.includes('</script><script>'), 'worker source must be < -escaped (no script breakout)');
  assert.ok(html.includes('\\u003c/script>'), 'escaped worker source present');
});

test('fnv1a32 is deterministic, hex, and input-sensitive', () => {
  const a = fnv1a32('08-24 15:37:01.123');
  assert.match(a, /^[0-9a-f]{8}$/);
  assert.strictEqual(a, fnv1a32('08-24 15:37:01.123'));
  assert.notStrictEqual(a, fnv1a32('08-24 15:37:01.124'));
});

test('escapeHtml neutralizes markup characters', () => {
  assert.strictEqual(escapeHtml('<img src=x onerror="a">&\''), '&lt;img src=x onerror=&quot;a&quot;&gt;&amp;&#39;');
});

test('clamp bounds value', () => {
  assert.strictEqual(clamp(5, 1, 3), 3);
  assert.strictEqual(clamp(0, 1, 3), 1);
  assert.strictEqual(clamp(2, 1, 3), 2);
});

test('fmtBytes renders human sizes', () => {
  assert.strictEqual(fmtBytes(0), '0 B');
  assert.strictEqual(fmtBytes(999), '999 B');
  assert.strictEqual(fmtBytes(1024), '1.0 KB');
  assert.strictEqual(fmtBytes(1536 * 1024), '1.5 MB');
  assert.strictEqual(fmtBytes(3 * 1024 * 1024 * 1024), '3.00 GB');
});

test('timestampedName prefixes sortable timestamp', () => {
  const d = new Date(2026, 8, 11, 7, 5, 3);
  assert.strictEqual(timestampedName(d, 'extract', 'csv'), '2026-09-11_070503_extract.csv');
});

// P0 regression guard (2026-09 review): pii-remote.js shipped missing from
// MODULE_ORDER, so the built single-file app threw on the Providers tab while
// every test layer stayed green. Every non-glue src module must be bundled.
test('MODULE_ORDER + WORKER_ORDER bundle every non-glue src module', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { MODULE_ORDER, WORKER_ORDER } = require('../build.js');
  const GLUE = new Set(['app.js', 'app-filecache.js', '_src.js']);
  const onDisk = fs.readdirSync(path.join(__dirname, '..', 'src')).filter((f) => f.endsWith('.js'));
  const bundled = new Set([...MODULE_ORDER, ...WORKER_ORDER]);
  const missing = onDisk.filter((f) => !GLUE.has(f) && !bundled.has(f));
  assert.deepStrictEqual(missing, [], 'src modules missing from MODULE_ORDER/WORKER_ORDER: ' + missing.join(', '));
  const unknown = [...MODULE_ORDER, ...WORKER_ORDER].filter((f) => !onDisk.includes(f));
  assert.deepStrictEqual(unknown, [], 'bundle entries with no file: ' + unknown.join(', '));
});
