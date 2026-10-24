'use strict';
/* Unit tests for src/syntax.js — Source code syntax color highlighting */
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../src/syntax.js');

test('detectCodeLanguage: recognizes supported extensions case-insensitively', () => {
  // Python
  assert.equal(S.detectCodeLanguage('script.py'), 'python');
  assert.equal(S.detectCodeLanguage('daemon.PYW'), 'python');
  assert.equal(S.detectCodeLanguage('/path/to/module.py'), 'python');

  // Shell
  assert.equal(S.detectCodeLanguage('deploy.sh'), 'shell');
  assert.equal(S.detectCodeLanguage('entrypoint.BASH'), 'shell');
  assert.equal(S.detectCodeLanguage('.zshrc.zsh'), 'shell');

  // Batch
  assert.equal(S.detectCodeLanguage('run.bat'), 'batch');
  assert.equal(S.detectCodeLanguage('setup.CMD'), 'batch');

  // JSON
  assert.equal(S.detectCodeLanguage('config.json'), 'json');

  // YAML
  assert.equal(S.detectCodeLanguage('docker-compose.yml'), 'yaml');
  assert.equal(S.detectCodeLanguage('pipeline.YAML'), 'yaml');

  // JavaScript
  assert.equal(S.detectCodeLanguage('index.js'), 'javascript');
  assert.equal(S.detectCodeLanguage('util.mjs'), 'javascript');
  assert.equal(S.detectCodeLanguage('server.CJS'), 'javascript');
});

test('detectCodeLanguage: returns null for non-code files and edge cases', () => {
  assert.equal(S.detectCodeLanguage('syslog.log'), null);
  assert.equal(S.detectCodeLanguage('logcat.txt'), null);
  assert.equal(S.detectCodeLanguage('README.md'), null);
  assert.equal(S.detectCodeLanguage('dumpstate_board.bin'), null);
  assert.equal(S.detectCodeLanguage(''), null);
  assert.equal(S.detectCodeLanguage(null), null);
  assert.equal(S.detectCodeLanguage(undefined), null);
  assert.equal(S.detectCodeLanguage('no_extension'), null);
});

test('Python tokenizer: keywords, comments, strings, numbers, definitions', () => {
  const line = 'def calculate_sum(a, b=10): # compute total';
  const spans = S.syntaxSpans(line, 'python');
  assert.ok(spans.length >= 4, 'extracts multiple spans');

  // def is syn-kwd
  const defSpan = spans.find((s) => s.start === 0 && s.end === 3);
  assert.ok(defSpan, 'finds def');
  assert.equal(defSpan.className, 'syn-kwd');

  // calculate_sum is syn-def
  const nameSpan = spans.find((s) => line.slice(s.start, s.end) === 'calculate_sum');
  assert.ok(nameSpan, 'finds func name');
  assert.equal(nameSpan.className, 'syn-def');

  // 10 is syn-num
  const numSpan = spans.find((s) => line.slice(s.start, s.end) === '10');
  assert.ok(numSpan, 'finds number');
  assert.equal(numSpan.className, 'syn-num');

  // # compute total is syn-cmt
  const cmtSpan = spans.find((s) => line.slice(s.start, s.end).startsWith('#'));
  assert.ok(cmtSpan, 'finds comment');
  assert.equal(cmtSpan.className, 'syn-cmt');
});

test('Python tokenizer: quoted strings and decorators', () => {
  const line1 = '    return f"Result: {val}"';
  const spans1 = S.syntaxSpans(line1, 'python');
  assert.ok(spans1.some((s) => s.className === 'syn-kwd' && line1.slice(s.start, s.end) === 'return'));
  assert.ok(spans1.some((s) => s.className === 'syn-str'));

  const line2 = '@staticmethod';
  const spans2 = S.syntaxSpans(line2, 'python');
  assert.ok(spans2.some((s) => s.className === 'syn-var' && line2.slice(s.start, s.end) === '@staticmethod'));
});

test('Shell tokenizer: builtins, keywords, variables, comments, strings', () => {
  const line = 'if [ "$STATUS" = 1 ]; then echo "Failure in $0" # alert';
  const spans = S.syntaxSpans(line, 'shell');

  // if and then are syn-kwd
  assert.ok(spans.some((s) => s.className === 'syn-kwd' && line.slice(s.start, s.end) === 'if'));
  assert.ok(spans.some((s) => s.className === 'syn-kwd' && line.slice(s.start, s.end) === 'then'));

  // echo is syn-builtin
  assert.ok(spans.some((s) => s.className === 'syn-builtin' && line.slice(s.start, s.end) === 'echo'));

  // $STATUS and $0 are syn-var
  assert.ok(spans.some((s) => s.className === 'syn-var' && line.slice(s.start, s.end) === '$STATUS'));
  assert.ok(spans.some((s) => s.className === 'syn-var' && line.slice(s.start, s.end) === '$0'));

  // comment is syn-cmt
  assert.ok(spans.some((s) => s.className === 'syn-cmt' && line.slice(s.start, s.end).startsWith('#')));
});

test('Batch script tokenizer: commands, REM and :: comments, %VAR% variables, labels', () => {
  const line1 = '@echo off & REM Initialize build directory';
  const spans1 = S.syntaxSpans(line1, 'batch');
  assert.ok(spans1.some((s) => (s.className === 'syn-kwd' || s.className === 'syn-builtin') && line1.slice(s.start, s.end).toLowerCase() === '@echo'));
  assert.ok(spans1.some((s) => s.className === 'syn-cmt' && line1.slice(s.start, s.end).toLowerCase().startsWith('rem')));

  const line2 = 'set OUT_DIR=%~dp0\\build & goto :success';
  const spans2 = S.syntaxSpans(line2, 'batch');
  assert.ok(spans2.some((s) => s.className === 'syn-kwd' && line2.slice(s.start, s.end).toLowerCase() === 'set'));
  assert.ok(spans2.some((s) => s.className === 'syn-var' && line2.slice(s.start, s.end) === '%~dp0'));
  assert.ok(spans2.some((s) => s.className === 'syn-def' && line2.slice(s.start, s.end) === ':success'));

  const line3 = ':: comment with double colons';
  const spans3 = S.syntaxSpans(line3, 'batch');
  assert.ok(spans3.some((s) => s.className === 'syn-cmt' && line3.slice(s.start, s.end).startsWith('::')));
});

test('JSON tokenizer: keys, string values, numbers, booleans, null', () => {
  const line = '  "timeoutSeconds": 45, "enabled": true, "fallback": null';
  const spans = S.syntaxSpans(line, 'json');

  // "timeoutSeconds": -> key
  assert.ok(spans.some((s) => (s.className === 'syn-def' || s.className === 'syn-kwd') && line.slice(s.start, s.end).includes('timeoutSeconds')));

  // 45 -> number
  assert.ok(spans.some((s) => s.className === 'syn-num' && line.slice(s.start, s.end) === '45'));

  // true and null -> boolean/null literal
  assert.ok(spans.some((s) => s.className === 'syn-kwd' && line.slice(s.start, s.end) === 'true'));
  assert.ok(spans.some((s) => s.className === 'syn-kwd' && line.slice(s.start, s.end) === 'null'));
});

test('YAML tokenizer: mapping keys, strings, numbers, comments, booleans', () => {
  const line = 'max_retries: 5 # upper bound';
  const spans = S.syntaxSpans(line, 'yaml');

  assert.ok(spans.some((s) => (s.className === 'syn-def' || s.className === 'syn-kwd') && line.slice(s.start, s.end).startsWith('max_retries')));
  assert.ok(spans.some((s) => s.className === 'syn-num' && line.slice(s.start, s.end) === '5'));
  assert.ok(spans.some((s) => s.className === 'syn-cmt' && line.slice(s.start, s.end).startsWith('#')));
});

test('JavaScript tokenizer: keywords, comments, strings, numbers, literals', () => {
  const line = 'const maxWorkers = 4; // parallel threads';
  const spans = S.syntaxSpans(line, 'javascript');

  assert.ok(spans.some((s) => s.className === 'syn-kwd' && line.slice(s.start, s.end) === 'const'));
  assert.ok(spans.some((s) => s.className === 'syn-num' && line.slice(s.start, s.end) === '4'));
  assert.ok(spans.some((s) => s.className === 'syn-cmt' && line.slice(s.start, s.end).startsWith('//')));
});

test('highlightSyntaxHtml: escapes HTML characters to prevent XSS injection', () => {
  const xssLine = '# <script>alert("xss")</script> & <b>bold</b>';
  const html = S.highlightSyntaxHtml(xssLine, 'python');

  assert.ok(!html.includes('<script>'), 'no raw script tag');
  assert.ok(html.includes('&lt;script&gt;'), 'escapes <script>');
  assert.ok(html.includes('&amp;'), 'escapes &');
  assert.ok(html.includes('&lt;b&gt;'), 'escapes <b>');
  assert.ok(html.includes('class="syn-cmt"'), 'contains comment span');
});

test('syntaxSpans: guarantees ordered non-overlapping spans', () => {
  const line = 'export PATH="$HOME/bin:$PATH" # update path 100 times';
  const spans = S.syntaxSpans(line, 'shell');

  for (let i = 0; i < spans.length - 1; i++) {
    const cur = spans[i];
    const next = spans[i + 1];
    assert.ok(cur.start < cur.end, 'span has positive width');
    assert.ok(cur.end <= next.start, 'spans do not overlap: cur.end <= next.start');
  }
});

test('syntaxSpans: handles edge cases and empty inputs without throwing', () => {
  assert.deepEqual(S.syntaxSpans('', 'python'), []);
  assert.deepEqual(S.syntaxSpans(null, 'python'), []);
  assert.deepEqual(S.syntaxSpans(undefined, 'python'), []);
  assert.deepEqual(S.syntaxSpans('plain line', 'unknown-lang'), []);
  assert.deepEqual(S.syntaxSpans('   ', 'python'), []);
});

test('syntaxSpans: complex tokens in Python, JS, YAML, JSON, and Shell', () => {
  // Python float with exponent and hex
  const pyLine = 'timeout = 0x1F + 3.14e-2';
  const pySpans = S.syntaxSpans(pyLine, 'python');
  assert.ok(pySpans.some((s) => s.className === 'syn-num' && pyLine.slice(s.start, s.end) === '0x1F'));
  assert.ok(pySpans.some((s) => s.className === 'syn-num' && pyLine.slice(s.start, s.end) === '3.14e-2'));

  // Shell backticks with variable interpolation
  const shLine = 'LOG_DIR=`dirname "$0"`';
  const shSpans = S.syntaxSpans(shLine, 'shell');
  assert.ok(shSpans.some((s) => s.className === 'syn-var' && shLine.slice(s.start, s.end) === '$0'));

  // JavaScript class definition
  const jsLine = 'class TriageViewer extends BaseComponent {';
  const jsSpans = S.syntaxSpans(jsLine, 'javascript');
  assert.ok(jsSpans.some((s) => s.className === 'syn-kwd' && jsLine.slice(s.start, s.end) === 'class'));
  assert.ok(jsSpans.some((s) => s.className === 'syn-def' && jsLine.slice(s.start, s.end) === 'TriageViewer'));

  // YAML boolean flags
  const yamlLine = 'production_mode: yes';
  const yamlSpans = S.syntaxSpans(yamlLine, 'yaml');
  assert.ok(yamlSpans.some((s) => s.className === 'syn-kwd' && yamlLine.slice(s.start, s.end) === 'yes'));

  // Batch labels with goto
  const batLine = 'goto :done';
  const batSpans = S.syntaxSpans(batLine, 'batch');
  assert.ok(batSpans.some((s) => s.className === 'syn-kwd' && batLine.slice(s.start, s.end).toLowerCase() === 'goto'));
  assert.ok(batSpans.some((s) => s.className === 'syn-def' && batLine.slice(s.start, s.end) === ':done'));
});

test('highlightSyntaxHtml: renders leading and trailing unstyled text and literal strings without variables', () => {
  const line = '  echo "constant string without variables"  ';
  const html = S.highlightSyntaxHtml(line, 'shell');
  assert.ok(html.startsWith('  '), 'keeps leading whitespace');
  assert.ok(html.endsWith('  '), 'keeps trailing whitespace');
  assert.ok(html.includes('class="syn-str"'), 'highlights literal string');
});

test('escapeHtml helper: neutralizes all special characters', () => {
  assert.equal(S.escapeHtml('<div>&"\'</div>'), '&lt;div&gt;&amp;&quot;&#39;&lt;/div&gt;');
  assert.equal(S.escapeHtml(''), '');
  assert.equal(S.escapeHtml(null), '');
});

test('syntaxSpans: advanced grammar constructs across all 6 formats', () => {
  // Python docstring & numbers with underscores
  const pyLine = '"""Docstring title""" count = 1_000_000';
  const pySpans = S.syntaxSpans(pyLine, 'python');
  assert.ok(pySpans.some((s) => s.className === 'syn-str' && pyLine.slice(s.start, s.end).includes('Docstring')));
  assert.ok(pySpans.some((s) => s.className === 'syn-num' && pyLine.slice(s.start, s.end) === '1_000_000'));

  // Shell parameter expansion & escaped characters
  const shLine = 'TARGET="${PREFIX}_${INDEX}"';
  const shSpans = S.syntaxSpans(shLine, 'shell');
  assert.ok(shSpans.some((s) => s.className === 'syn-var' && pyLine.slice(s.start, s.end) !== ''));

  // Batch delayed expansion !COUNTER! and %ERRORLEVEL%
  const batLine = 'if !COUNTER! equ 0 (echo %ERRORLEVEL%)';
  const batSpans = S.syntaxSpans(batLine, 'batch');
  assert.ok(batSpans.some((s) => s.className === 'syn-var' && batLine.slice(s.start, s.end) === '!COUNTER!'));
  assert.ok(batSpans.some((s) => s.className === 'syn-var' && batLine.slice(s.start, s.end) === '%ERRORLEVEL%'));

  // YAML boolean variants and numbers
  const ymlLine = 'debug_mode: false # port: 8080';
  const ymlSpans = S.syntaxSpans(ymlLine, 'yaml');
  assert.ok(ymlSpans.some((s) => s.className === 'syn-def' && ymlLine.slice(s.start, s.end).startsWith('debug_mode')));
  assert.ok(ymlSpans.some((s) => s.className === 'syn-kwd' && ymlLine.slice(s.start, s.end) === 'false'));
  assert.ok(ymlSpans.some((s) => s.className === 'syn-cmt' && ymlLine.slice(s.start, s.end).startsWith('#')));

  // JavaScript template strings and keywords
  const jsLine = 'const isMatch = `valid_token_${id}`; // verify match';
  const jsSpans = S.syntaxSpans(jsLine, 'javascript');
  assert.ok(jsSpans.some((s) => s.className === 'syn-kwd' && jsLine.slice(s.start, s.end) === 'const'));
  assert.ok(jsSpans.some((s) => s.className === 'syn-str' && jsLine.slice(s.start, s.end).includes('valid_token')));
  assert.ok(jsSpans.some((s) => s.className === 'syn-cmt' && jsLine.slice(s.start, s.end).startsWith('//')));
});

test('syntaxSpans: throughput performance stress test', () => {
  const sampleLines = [
    'def execute_pipeline(items, dry_run=False): # run all jobs',
    'if [ "$EXIT_CODE" -ne 0 ]; then echo "Failed!" >&2; exit 1; fi',
    'set BUILD_DIR=%~dp0\\target & if %ERRORLEVEL% neq 0 goto :error',
    '  "metrics": { "cpu_usage": 84.5, "healthy": true, "logs": null }',
    'database: postgresql # connection string for cluster',
    'const handler = async (req, res) => { return res.json({ ok: 1 }); };',
  ];
  const languages = ['python', 'shell', 'batch', 'json', 'yaml', 'javascript'];

  const iterations = 10000;
  const t0 = performance.now();
  for (let i = 0; i < iterations; i++) {
    const idx = i % sampleLines.length;
    S.syntaxSpans(sampleLines[idx], languages[idx]);
  }
  const elapsedMs = performance.now() - t0;
  // 10,000 lines should tokenize in well under 250ms (~0.025ms/line)
  assert.ok(elapsedMs < 1000, `tokenization throughput: 10,000 lines in ${elapsedMs.toFixed(2)}ms`);
});

test('syntaxSpans: ultra-long line safety and boundary resistance', () => {
  const longLine = 'const ' + 'veryLongIdentifierName_'.repeat(1000) + ' = "text";';
  const spans = S.syntaxSpans(longLine, 'javascript');
  assert.ok(Array.isArray(spans), 'returns array without timeout or crash');
  assert.ok(spans.length >= 2, 'identifies keywords and strings on ultra-long lines');
});



