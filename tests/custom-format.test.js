const test = require('node:test');
const assert = require('node:assert/strict');
const custom = require('../src/custom-format.js');
const { detectFormat } = require('../src/detect.js');
const { parseLine } = require('../src/parser.js');

test('compileCustomFormat validates regex and detects named groups', () => {
  const def = {
    name: 'test-fmt',
    label: 'Test Format',
    pattern: '^\\[(?<ts>\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}\\.\\d{3})\\]\\s+\\[(?<level>\\w+)\\]\\s+\\[(?<tag>[^\\]]+)\\]\\s+(?<msg>.*)$',
    tsFormat: 'YYYY-MM-DD HH:mm:ss.SSS',
    levelMap: { ERROR: 'E', WARN: 'W', INFO: 'I' },
    enabled: true,
  };
  const compiled = custom.compileCustomFormat(def);
  assert.equal(compiled.ok, true);
  assert.equal(compiled.name, 'test-fmt');
  assert.ok(compiled.groups.includes('ts'));
  assert.ok(compiled.groups.includes('level'));
  assert.ok(compiled.groups.includes('tag'));
  assert.ok(compiled.groups.includes('msg'));
});

test('compileCustomFormat fails gracefully on invalid regex or missing fields', () => {
  assert.equal(custom.compileCustomFormat(null).ok, false);
  const def = {
    name: 'bad-fmt',
    label: 'Bad',
    pattern: '^[unclosed(',
  };
  const compiled = custom.compileCustomFormat(def);
  assert.equal(compiled.ok, false);
  assert.ok(compiled.error);
});

test('validateFormatDef checks required fields and naming constraints', () => {
  assert.equal(custom.validateFormatDef(null).valid, false);
  assert.equal(custom.validateFormatDef({}).valid, false);
  assert.equal(custom.validateFormatDef({ name: 'INVALID NAME', pattern: '.*' }).valid, false);
  assert.equal(custom.validateFormatDef({ name: 'ok', pattern: '' }).valid, false);
  const ok = custom.validateFormatDef({
    name: 'valid_name-1',
    label: 'Valid',
    pattern: '^(?<msg>.*)$',
  });
  assert.equal(ok.valid, true);
  assert.deepEqual(ok.groups, ['msg']);
});

test('normalizeCustomTs normalizes various timestamp formats to MM-DD HH:MM:SS.mmm', () => {
  // ISO-8601 / standard YYYY-MM-DD HH:mm:ss.SSS
  assert.equal(
    custom.normalizeCustomTs('2026-10-24 17:53:20.456', 'YYYY-MM-DD HH:mm:ss.SSS'),
    '10-24 17:53:20.456'
  );
  assert.equal(
    custom.normalizeCustomTs('2026-10-24T17:53:20.456Z', 'ISO-8601'),
    '10-24 17:53:20.456'
  );
  // Slashes
  assert.equal(
    custom.normalizeCustomTs('2026/08/15 09:12:34', 'YYYY/MM/DD HH:mm:ss'),
    '08-15 09:12:34.000'
  );
  // MM/DD
  assert.equal(
    custom.normalizeCustomTs('12/25 18:30:00.12', 'MM/DD HH:mm:ss'),
    '12-25 18:30:00.120'
  );
  // Epoch seconds
  assert.equal(
    custom.normalizeCustomTs('1729792400', 'epoch_s'),
    custom.normalizeCustomTs('1729792400', 'X')
  );
  // Epoch milliseconds
  assert.equal(
    custom.normalizeCustomTs('1729792400456', 'epoch_ms'),
    custom.normalizeCustomTs('1729792400456', 'x')
  );
  // Edge cases
  assert.equal(custom.normalizeCustomTs(null), null);
  assert.equal(custom.normalizeCustomTs(123), null);
  assert.equal(custom.normalizeCustomTs('not_a_number', 'epoch_s'), null);
  assert.equal(custom.normalizeCustomTs('not_a_number', 'epoch_ms'), null);
  assert.equal(custom.normalizeCustomTs('invalid-ts', 'YYYY-MM-DD'), null);
});

test('parseCustomLine extracts groups and normalizes fields', () => {
  const def = {
    name: 'spring',
    pattern: '^(\\[)?(?<ts>\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}\\.\\d{3})(?:\\])?\\s+(?<level>[A-Z]+)\\s+(?<pid>\\d+)\\s+---\\s+\\[(?<tag>[^\\]]+)\\]\\s+(?<msg>.*)$',
    tsFormat: 'YYYY-MM-DD HH:mm:ss.SSS',
    levelMap: { TRACE: 'V', DEBUG: 'D', INFO: 'I', WARN: 'W', ERROR: 'E', FATAL: 'F' },
  };
  const compiled = custom.compileCustomFormat(def);
  const line = '2026-10-24 18:30:15.123  WARN 9876 --- [main] org.example.Service: starting up';
  const rec = custom.parseCustomLine(line, compiled);
  assert.ok(rec);
  assert.equal(rec.ts, '10-24 18:30:15.123');
  assert.equal(rec.level, 'W');
  assert.equal(rec.pid, '9876');
  assert.equal(rec.tag, 'main');
  assert.equal(rec.msg, 'org.example.Service: starting up');
});

test('parseCustomLine fallback to token scan for unmapped level', () => {
  const def = {
    name: 'myfmt',
    pattern: '^<(?<level>\\w+)> (?<msg>.*)$',
  };
  const compiled = custom.compileCustomFormat(def);
  const rec = custom.parseCustomLine('<WARNING> Something bad happened', compiled);
  assert.ok(rec);
  assert.equal(rec.level, 'W');
});

test('parseCustomLine returns null on non-matching line or invalid compiled', () => {
  assert.equal(custom.parseCustomLine('abc', null), null);
  const def = {
    name: 'spring',
    pattern: '^\\[(?<ts>\\d+)\\] (?<msg>.*)$',
  };
  const compiled = custom.compileCustomFormat(def);
  const rec = custom.parseCustomLine('random continuation line without bracket', compiled);
  assert.equal(rec, null);
});

test('DEFAULT_CUSTOM_FORMAT_EXAMPLES provide valid starter templates', () => {
  assert.ok(Array.isArray(custom.DEFAULT_CUSTOM_FORMAT_EXAMPLES));
  assert.ok(custom.DEFAULT_CUSTOM_FORMAT_EXAMPLES.length >= 2);
  for (const ex of custom.DEFAULT_CUSTOM_FORMAT_EXAMPLES) {
    const v = custom.validateFormatDef(ex);
    assert.equal(v.valid, true, `Example ${ex.name} is invalid: ${v.errors.join(', ')}`);
    const c = custom.compileCustomFormat(ex);
    assert.equal(c.ok, true);
  }
});

test('detectFormat autodetection with customFormats', () => {
  const customFormats = [
    {
      name: 'nginx-err',
      label: 'Nginx Error',
      pattern: '^(?<ts>\\d{4}/\\d{2}/\\d{2} \\d{2}:\\d{2}:\\d{2})\\s+\\[(?<level>\\w+)\\]\\s+(?<pid>\\d+)#\\d+:\\s+(?<msg>.*)$',
      priority: 20,
      enabled: true,
    },
  ];

  const lines = [
    '2026/10/24 17:53:20 [error] 1234#0: *1 open() failed (2: No such file or directory)',
    '2026/10/24 17:53:21 [warn] 1234#0: *2 an upstream response is buffered',
    '2026/10/24 17:53:22 [error] 1234#0: *3 connect() failed (111: Connection refused)',
  ];

  const res = detectFormat(lines, customFormats);
  assert.equal(res.format, 'nginx-err');
  assert.equal(res.confidence, 1.0);
});

test('detectFormat ignores disabled custom formats', () => {
  const customFormats = [
    {
      name: 'nginx-err',
      pattern: '^(?<ts>\\d{4}/\\d{2}/\\d{2} \\d{2}:\\d{2}:\\d{2})\\s+\\[(?<level>\\w+)\\]\\s+(?<pid>\\d+)#\\d+:\\s+(?<msg>.*)$',
      priority: 20,
      enabled: false,
    },
  ];
  const lines = [
    '2026/10/24 17:53:20 [error] 1234#0: *1 open() failed (2: No such file or directory)',
  ];
  const res = detectFormat(lines, customFormats);
  assert.notEqual(res.format, 'nginx-err');
});

test('detectFormat respects priority ordering among custom formats', () => {
  const customFormats = [
    { name: 'low-prio', pattern: '^.*$', priority: 5, enabled: true },
    { name: 'high-prio', pattern: '^.*$', priority: 50, enabled: true },
  ];
  const lines = ['some line 1', 'some line 2'];
  const res = detectFormat(lines, customFormats);
  assert.equal(res.format, 'high-prio');
});

test('parseLine parses custom format lines and falls back on non-matches', () => {
  const customFormats = [
    {
      name: 'nginx-err',
      pattern: '^(?<ts>\\d{4}/\\d{2}/\\d{2} \\d{2}:\\d{2}:\\d{2})\\s+\\[(?<level>\\w+)\\]\\s+(?<pid>\\d+)#\\d+:\\s+(?<msg>.*)$',
      tsFormat: 'YYYY/MM/DD HH:mm:ss',
      levelMap: { error: 'E', warn: 'W' },
    },
  ];

  const matchLine = '2026/10/24 17:53:20 [error] 1234#0: *1 open() failed';
  const rec = parseLine(matchLine, 'nginx-err', customFormats);
  assert.equal(rec.ts, '10-24 17:53:20.000');
  assert.equal(rec.level, 'E');
  assert.equal(rec.pid, '1234');
  assert.equal(rec.msg, '*1 open() failed');

  // Continuation non-match line
  const nonMatch = '  just a regular continuation line';
  const recFallback = parseLine(nonMatch, 'nginx-err', customFormats);
  assert.equal(recFallback.ts, null);
  assert.equal(recFallback.level, null);
  assert.equal(recFallback.msg, nonMatch);

  // Precompiled format object
  const precompiled = [custom.compileCustomFormat(customFormats[0])];
  const recPre = parseLine(matchLine, 'nginx-err', precompiled);
  assert.equal(recPre.level, 'E');

  // Format name not matching any custom format
  const recUnknown = parseLine(matchLine, 'non-existent-format', customFormats);
  assert.ok(recUnknown);
});
