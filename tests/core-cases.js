/* Shared logic test cases — the single source of truth for both `node --test`
 * and the in-browser ?selftest panel. Cases must be pure (no DOM, no fs) and
 * resolve src modules lazily so they run in Node (via src/_src.js) and in the
 * bundled browser (via window.LT). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(root); } else { (root.LT || (root.LT = {})).CASES = factory(root); }
}(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  const SRC = (typeof module === 'object' && module.exports)
    ? require('../src/_src.js')
    : (root.LT || {});

  function eq(actual, expected, msg) {
    if (actual !== expected) {
      throw new Error((msg || 'eq') + ': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
    }
  }
  function deepEq(actual, expected, msg) {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b) throw new Error((msg || 'deepEq') + ': expected ' + b + ', got ' + a);
  }
  function ok(value, msg) {
    if (!value) throw new Error(msg || 'expected truthy, got ' + JSON.stringify(value));
  }

  const CASES = [];
  const T = (group, name, fn) => CASES.push({ group, name, fn });

  /* ============================== G1: detect + parse ============================== */

  T('detect', 'logcat threadtime majority', () => {
    const r = SRC.detectFormat([
      '08-24 15:37:01.123  1234  5678 I ActivityManager: Start proc 1234:com.foo/u0a12 for broadcast',
      '08-24 15:37:02.456  1234  5678 E Foo    : bar baz',
      '08-24 15:37:03.000  1234  5678 W SXM:S:K2IP : tag with colons: message',
      '',
      '    at com.foo.Bar.method(Bar.java:42)',
    ]);
    eq(r.format, 'logcat');
    ok(r.confidence >= 0.5);
  });

  T('detect', 'syslog majority', () => {
    const r = SRC.detectFormat([
      '<34>Aug 24 15:37:01 myhost sshd[1234]: Failed password for root',
      'Aug 25 09:00:00 myhost cron[99]: (root) CMD (run-parts)',
      'Sep  9 23:59:59 fw kernel: DROP IN=eth0',
    ]);
    eq(r.format, 'syslog');
  });

  T('detect', 'apache CLF majority', () => {
    const r = SRC.detectFormat([
      '127.0.0.1 - - [24/Aug/2026:15:37:01 +0200] "GET /index.html HTTP/1.1" 200 1234',
      '192.168.0.5 - alice [24/Aug/2026:15:38:01 +0200] "POST /api/login HTTP/1.1" 401 512',
    ]);
    eq(r.format, 'clf');
  });

  T('detect', 'iso8601 majority', () => {
    const r = SRC.detectFormat([
      '2026-08-24T15:37:01.123Z main INFO service started',
      '2026-08-24T15:37:02.000+02:00 worker ERROR connection refused',
      '2026-08-24 15:37:03.500 job TRACE tick',
    ]);
    eq(r.format, 'iso8601');
  });

  T('detect', 'falls back to plain for unstructured text', () => {
    const r = SRC.detectFormat(['just some text', 'more text without timestamps', 'and a third line']);
    eq(r.format, 'plain');
  });

  T('detect', 'empty input is plain', () => {
    eq(SRC.detectFormat([]).format, 'plain');
    eq(SRC.detectFormat(['', '']).format, 'plain');
  });

  T('ts', 'ISO 8601 with T, Z, millis', () => {
    eq(SRC.detectTs('2026-08-24T15:37:01.123Z rest'), '08-24 15:37:01.123');
  });

  T('ts', 'ISO 8601 with space separator and offset, pads millis', () => {
    eq(SRC.detectTs('2026-08-24 15:37:01 +02:00 rest'), '08-24 15:37:01.000');
    eq(SRC.detectTs('2026-08-24 15:37:01.5 +02:00'), '08-24 15:37:01.500');
    eq(SRC.detectTs('2026-08-24 15:37:01.12 +02:00'), '08-24 15:37:01.120');
  });

  T('ts', 'RFC3164 syslog with space-padded day', () => {
    eq(SRC.detectTs('Sep  9 23:59:59 fw kernel: DROP'), '09-09 23:59:59.000');
    eq(SRC.detectTs('aug 24 15:37:01 h svc: x'), '08-24 15:37:01.000');
  });

  T('ts', 'unknown month name falls through to later patterns', () => {
    eq(SRC.detectTs('Foo 24 15:37:01 rest'), null);
  });

  T('ts', 'Apache CLF bracket timestamp', () => {
    eq(SRC.detectTs('127.0.0.1 - - [24/Aug/2026:15:37:01 +0200] "GET / HTTP/1.1" 200 1'), '08-24 15:37:01.000');
  });

  T('ts', 'bare MM-DD timestamp (logcat without pid)', () => {
    eq(SRC.detectTs('08-24 15:37:01.123 something'), '08-24 15:37:01.123');
    eq(SRC.detectTs('08-24 15:37:01 something'), '08-24 15:37:01.000');
  });

  T('ts', 'false-positive guards return null', () => {
    eq(SRC.detectTs('version 2.41.3 released'), null);
    eq(SRC.detectTs('10.20.30.40 connected'), null);
    eq(SRC.detectTs('value 1.2345'), null);
    eq(SRC.detectTs('at 1787611054935'), null);
  });

  T('parse', 'logcat threadtime full record', () => {
    const r = SRC.parseLine('08-24 15:37:01.123  1234  5678 I ActivityManager: Start proc', 'logcat');
    deepEq(r, { ts: '08-24 15:37:01.123', level: 'I', tag: 'ActivityManager', pid: '1234', msg: 'Start proc' });
  });

  T('parse', 'logcat tag containing colons splits on first ": "', () => {
    const r = SRC.parseLine('08-24 15:37:01.123  1234  5678 W SXM:S:K2IP : tuning failed: retry', 'logcat');
    eq(r.tag, 'SXM:S:K2IP ');
    eq(r.msg, 'tuning failed: retry');
    eq(r.level, 'W');
  });

  T('parse', 'logcat continuation line has null ts/level and stays raw msg', () => {
    const r = SRC.parseLine('    at com.foo.Bar.method(Bar.java:42)', 'logcat');
    eq(r.ts, null);
    eq(r.level, null);
    eq(r.tag, null);
    eq(r.pid, null);
    eq(r.msg, '    at com.foo.Bar.method(Bar.java:42)');
  });

  T('parse', 'kernel fencepost line without header stays unparsed', () => {
    const r = SRC.parseLine('<3>[12345.678901] usb 1-1: reset', 'logcat');
    eq(r.level, null);
    eq(r.msg, '<3>[12345.678901] usb 1-1: reset');
  });

  T('parse', 'syslog with PRI maps severity to ladder', () => {
    const r = SRC.parseLine('<34>Aug 24 15:37:01 myhost sshd[1234]: Failed password', 'syslog');
    eq(r.ts, '08-24 15:37:01.000');
    eq(r.level, 'E'); // 34 % 8 = 2 -> crit -> E
    eq(r.tag, 'sshd');
    eq(r.pid, '1234');
    eq(r.msg, 'Failed password');
  });

  T('parse', 'syslog without PRI', () => {
    const r = SRC.parseLine('Aug 24 15:37:01 myhost cron[99]: (root) CMD (run-parts)', 'syslog');
    eq(r.level, 'I'); // no PRI -> info default
    eq(r.tag, 'cron');
    eq(r.msg, '(root) CMD (run-parts)');
  });

  T('parse', 'syslog severity boundaries emerg/crit/warning/debug', () => {
    eq(SRC.parseLine('<2>Aug 24 15:37:01 h a[1]: crit', 'syslog').level, 'E');
    eq(SRC.parseLine('<0>Aug 24 15:37:01 h a[1]: emerg', 'syslog').level, 'F');
    eq(SRC.parseLine('<4>Aug 24 15:37:01 h a[1]: warn', 'syslog').level, 'W');
    eq(SRC.parseLine('<7>Aug 24 15:37:01 h a[1]: dbg', 'syslog').level, 'D');
  });

  T('parse', 'apache CLF status to level mapping', () => {
    const g = (status) => SRC.parseLine(
      '127.0.0.1 - - [24/Aug/2026:15:37:01 +0200] "GET /x HTTP/1.1" ' + status + ' 10', 'clf').level;
    eq(g('200'), 'I');
    eq(g('302'), 'I');
    eq(g('404'), 'W');
    eq(g('500'), 'E');
    const r = SRC.parseLine('127.0.0.1 - - [24/Aug/2026:15:37:01 +0200] "POST /login HTTP/1.1" 401 512', 'clf');
    eq(r.tag, 'POST');
    eq(r.ts, '08-24 15:37:01.000');
  });

  T('parse', 'iso8601 line picks up severity token', () => {
    const r = SRC.parseLine('2026-08-24T15:37:01.123Z svc ERROR connection refused', 'iso8601');
    eq(r.ts, '08-24 15:37:01.123');
    eq(r.level, 'E');
    eq(r.msg, 'svc ERROR connection refused');
  });

  T('parse', 'mmdd line with explicit millis', () => {
    const r = SRC.parseLine('08-24 15:37:01.123 GNSS fix lat=48.858400 lon=2.294500', 'mmdd');
    eq(r.ts, '08-24 15:37:01.123');
    eq(r.level, null);
  });

  T('parse', 'plain line: null ts, severity token from text', () => {
    const r = SRC.parseLine('something WARN: disk almost full', 'plain');
    eq(r.ts, null);
    eq(r.level, 'W');
  });

  T('parse', 'plain line without tokens: all null but message kept', () => {
    const r = SRC.parseLine('plain continuation text', 'plain');
    deepEq(r, { ts: null, level: null, tag: null, pid: null, msg: 'plain continuation text' });
  });

  T('parse', 'severity token matching is word-bounded', () => {
    eq(SRC.parseLine('the ERRORCODE field', 'plain').level, null);
    eq(SRC.parseLine('informatie over iets', 'plain').level, null);
  });

  T('parse', 'syslog with unknown month falls back to raw record', () => {
    const r = SRC.parseLine('Foo 24 15:37:01 host tag: WARNING', 'syslog');
    eq(r.ts, null);
    eq(r.level, 'W');
    eq(r.msg, 'Foo 24 15:37:01 host tag: WARNING');
  });

  T('parse', 'syslog without pid bracket has null pid', () => {
    const r = SRC.parseLine('Aug 24 15:37:01 myhost cron: hello', 'syslog');
    eq(r.tag, 'cron');
    eq(r.pid, null);
    eq(r.msg, 'hello');
  });

  T('parse', 'clf with unknown month falls back to raw record', () => {
    const r = SRC.parseLine('h - u [24/Foo/2026:15:37:01 +0200] "GET / HTTP/1.1" 200 1', 'clf');
    eq(r.ts, null);
    eq(r.msg, 'h - u [24/Foo/2026:15:37:01 +0200] "GET / HTTP/1.1" 200 1');
  });

  T('parse', 'iso8601 with offset strips tz from message', () => {
    const r = SRC.parseLine('2026-08-24 15:37:01.5 +02:00 worker ERROR boom', 'iso8601');
    eq(r.ts, '08-24 15:37:01.500');
    eq(r.level, 'E');
    eq(r.msg, 'worker ERROR boom');
  });

  return { CASES, eq, deepEq, ok };
}));
