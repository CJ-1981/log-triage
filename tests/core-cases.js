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

  /* ============================== G2: masks + providers ============================== */

  T('mask', 'VIN keeps first 3 and last 4', () => {
    eq(SRC.maskLine('VIN read: YV4AB9CD12EF34567 from ECU'), 'VIN read: YV4**********4567 from ECU');
    eq(SRC.maskLine('"vehicleId":"YV4ZZZCD12EF34567"'), '"vehicleId":"YV4**********4567"');
  });

  T('mask', 'IBAN keeps country+check digits', () => {
    eq(SRC.maskLine('contract DE89370400440532013000 validated'), 'contract DE89********** validated');
  });

  T('mask', 'credit card becomes [card]', () => {
    eq(SRC.maskLine('card 4111 1111 1111 1111 declined'), 'card [card] declined');
    eq(SRC.maskLine('card 4111-1111-1111-1111 declined'), 'card [card] declined');
  });

  T('mask', 'SSN keeps area number', () => {
    eq(SRC.maskLine('owner ssn 123-45-6789 verified'), 'owner ssn 123-**-**** verified');
  });

  T('mask', 'international phone keeps country code', () => {
    eq(SRC.maskLine('paired to phone +46 70 123 45 67 today'), 'paired to phone +46 *** today');
  });

  T('mask', 'US phone keeps area code', () => {
    eq(SRC.maskLine('call (555) 123-4567 now'), 'call (555) ***-**** now');
  });

  T('mask', 'IMEI exact 15 digits; epoch ms survives', () => {
    eq(SRC.maskLine('IMEI reported 350774129305118 ok'), 'IMEI reported [IMEI] ok');
    eq(SRC.maskLine('ts 1787611054935 ok'), 'ts 1787611054935 ok');
  });

  T('mask', 'email keeps first local char and TLD', () => {
    eq(SRC.maskLine('rejected for driver.jung@lotus-tech.example'), 'rejected for d***@***.example');
  });

  T('mask', 'device serial keeps SN- prefix', () => {
    eq(SRC.maskLine('serial SN-A1B2C3D4E5F6 stored'), 'serial SN-*** stored');
  });

  T('mask', 'MAC keeps OUI', () => {
    eq(SRC.maskLine('bssid=aa:bb:cc:11:22:33 rssi=-52'), 'bssid=aa:bb:cc:**:**:** rssi=-52');
  });

  T('mask', 'private IPv4 before public IPv4', () => {
    eq(SRC.maskLine('lease 192.168.1.104/24'), 'lease 192.168.1.x/24');
    eq(SRC.maskLine('dns 10.20.30.40 ok'), 'dns 10.20.30.x ok');
    eq(SRC.maskLine('host 172.25.10.3 up'), 'host 172.25.10.x up');
    eq(SRC.maskLine('timeout host 203.0.113.77'), 'timeout host 203.0.x.x');
  });

  T('mask', 'IPv6 link-local/ULA masked, multicast untouched', () => {
    eq(SRC.maskLine('ipv6 fe80::7a8b:cafe:1234:5678%wlan0'), 'ipv6 IPv6-masked%wlan0');
    eq(SRC.maskLine('ula fdab::1234:5678 ok'), 'ula IPv6-masked ok');
    eq(SRC.maskLine('mcast ff02::1 ok'), 'mcast ff02::1 ok');
  });

  T('mask', 'GNSS coordinate pairs, plain and degree forms', () => {
    eq(SRC.maskLine('fix 48.858400, 2.294500 acc=3m'), 'fix [coords] acc=3m');
    eq(SRC.maskLine('fix 48.858412°N, 2.294511°E ok'), 'fix [coords]°E ok');
    eq(SRC.maskLine('single 1.2345 stays'), 'single 1.2345 stays');
  });

  T('mask', 'subscriberId and hotspot SSID', () => {
    eq(SRC.maskLine('subscriberId=41011223344 not provisioned'), 'subscriberId=*** not provisioned');
    eq(SRC.maskLine('ssid=AndroidShare_4821'), 'ssid=AndroidShare_****');
  });

  T('mask', 'false-positive guards leave timestamps and versions intact', () => {
    eq(SRC.maskLine('08-24 15:37:01.123  1234  5678 I Tag: v2.41.3'), '08-24 15:37:01.123  1234  5678 I Tag: v2.41.3');
    eq(SRC.maskLine('+0200 offset'), '+0200 offset');
  });

  T('mask', 'MaskEngine disables individual rules', () => {
    const eng = new SRC.MaskEngine();
    eq(eng.maskLine('mail a.b@x.example here'), 'mail a***@***.example here');
    eng.setEnabled('email', false);
    eq(eng.maskLine('mail a.b@x.example here'), 'mail a.b@x.example here');
    eng.setEnabled('email', true);
    eq(eng.maskLine('mail a.b@x.example here'), 'mail a***@***.example here');
  });

  T('mask', 'MaskEngine counts hits per rule id', () => {
    const eng = new SRC.MaskEngine();
    eng.maskLine('VIN YV4AB9CD12EF34567 and 10.0.0.7 and 10.0.0.8');
    const hits = eng.hitCounts();
    eq(hits.vin, 1);
    eq(hits.ipv4Private, 2);
  });

  T('mask', 'custom rules apply after built-ins', () => {
    const eng = new SRC.MaskEngine();
    eng.addCustom({ name: 'secret', pattern: 'secret-[a-z]+', replacement: 'secret-***' });
    eq(eng.maskLine('token secret-alpha here'), 'token secret-*** here');
    eq(eng.maskLine('VIN YV4AB9CD12EF34567'), 'VIN YV4**********4567');
  });

  T('mask', 'custom rules expand $N group references', () => {
    const eng = new SRC.MaskEngine();
    eng.addCustom({ name: 'opid', pattern: 'op=(\\d+)/(\\d+)', replacement: 'op=$1/$2**' });
    eq(eng.maskLine('op=12/345 done'), 'op=12/345** done');
  });

  T('mask', 'invalid custom regex surfaces error without crashing', () => {
    const eng = new SRC.MaskEngine();
    const rule = eng.addCustom({ name: 'bad', pattern: '([unclosed', replacement: 'x' });
    ok(rule.error, 'rule.error must be set');
    eq(eng.maskLine('safe text ([unclosed ok'), 'safe text ([unclosed ok');
  });

  T('provider', 'registry validates and lists providers', () => {
    eq(SRC.listProviders().length, 1); // built-in local regex provider
    eq(SRC.listProviders()[0].id, 'local-regex');
    eq(SRC.listProviders()[0].local, true);
    let threw = false;
    try { SRC.defineProvider({ label: 'no id' }); } catch (e) { threw = true; }
    ok(threw, 'missing id must throw');
  });

  T('provider', 'mock provider analyze returns findings with offsets', () => {
    const mock = SRC.defineProvider({
      id: 'mock', label: 'Mock', local: true,
      analyze(lines) {
        const out = [];
        lines.forEach((line, i) => {
          const idx = line.indexOf('token ');
          if (idx >= 0) out.push({ line: i, start: idx, end: idx + 6, type: 'secret', score: 1 });
        });
        return out;
      },
    });
    const findings = SRC.getProvider('mock').analyze(['a token abc', 'nothing']);
    eq(findings.length, 1);
    deepEq(findings[0], { line: 0, start: 2, end: 8, type: 'secret', score: 1 });
    eq(mock.id, 'mock');
  });

  T('provider', 'local-regex provider finds VIN findings', () => {
    const p = SRC.getProvider('local-regex');
    ok(p.available());
    const findings = p.analyze(['VIN read: YV4AB9CD12EF34567 end']);
    ok(findings.length === 1 && findings[0].type === 'vin');
    eq(SRC.maskLine('VIN read: YV4AB9CD12EF34567 end'), 'VIN read: YV4**********4567 end');
  });

  T('provider', 'remote flag and unknown id', () => {
    eq(SRC.getProvider('does-not-exist'), null);
    SRC.defineProvider({ id: 'remote-mock', label: 'Remote', local: false, analyze: () => [] });
    eq(SRC.getProvider('remote-mock').local, false);
    ok(SRC.listProviders().some((p) => p.id === 'remote-mock'));
  });

  T('provider', 'available() gate, label fallback, zero-width match safety', () => {
    let avail = false;
    SRC.defineProvider({ id: 'gated', available: () => avail, analyze: () => [] });
    eq(SRC.getProvider('gated').available(), false);
    eq(SRC.getProvider('gated').label, 'gated'); // label falls back to id
    avail = true;
    eq(SRC.getProvider('gated').available(), true);
    SRC.defineProvider({ id: 'nolabel', analyze: () => [] });
    eq(SRC.getProvider('nolabel').label, 'nolabel');
    const p = SRC.makeLocalRegexProvider(() => [{ id: 'zw', re: /x*/g, repl: () => 'y' }]);
    const findings = p.analyze(['abc']);
    ok(findings.length >= 1 && findings.every((f) => f.end >= f.start), 'zero-width match must not hang');
  });

  return { CASES, eq, deepEq, ok };
}));
