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
    eq(SRC.maskLine('16 digits 1234567890123456 stay-not-imei'), '16 digits [card] stay-not-imei');
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
    eq(SRC.maskLine('two decimals 12.12, 13.12 stay'), 'two decimals 12.12, 13.12 stay', 'needs >= 3 decimals');
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

  /* ============================== G3: filters + levels ============================== */

  function mkEngine() {
    return new SRC.FilterEngine();
  }

  T('filter', 'no rules means everything is kept', () => {
    const e = mkEngine();
    deepEq(e.evaluate({ raw: 'anything', ts: null, level: null }), { kept: true, highlights: [] });
  });

  T('filter', 'include rules OR together', () => {
    const e = mkEngine();
    e.setRules([
      { id: 'r1', pattern: 'alpha', action: 'include', enabled: true },
      { id: 'r2', pattern: 'beta', action: 'include', enabled: true },
    ]);
    eq(e.evaluate({ raw: 'has ALPHA here', ts: null, level: null }).kept, true, 'case-insensitive by default');
    eq(e.evaluate({ raw: 'has beta here', ts: null, level: null }).kept, true);
    eq(e.evaluate({ raw: 'has gamma here', ts: null, level: null }).kept, false);
  });

  T('filter', 'case-sensitive include', () => {
    const e = mkEngine();
    e.setRules([{ id: 'r1', pattern: 'Alpha', caseSensitive: true, action: 'include', enabled: true }]);
    eq(e.evaluate({ raw: 'x alpha x', ts: null, level: null }).kept, false);
    eq(e.evaluate({ raw: 'x Alpha x', ts: null, level: null }).kept, true);
  });

  T('filter', 'exclude subtracts even when include matches', () => {
    const e = mkEngine();
    e.setRules([
      { id: 'in', pattern: 'heartbeat', action: 'include', enabled: true },
      { id: 'out', pattern: 'missed', action: 'exclude', enabled: true },
    ]);
    eq(e.evaluate({ raw: 'heartbeat alive', ts: null, level: null }).kept, true);
    eq(e.evaluate({ raw: 'heartbeat missed seq', ts: null, level: null }).kept, false);
  });

  T('filter', 'highlight is additive and never drops', () => {
    const e = mkEngine();
    e.setRules([
      { id: 'h1', pattern: 'gps', action: 'highlight', enabled: true },
    ]);
    const r = e.evaluate({ raw: 'GPS fix', ts: null, level: null });
    eq(r.kept, true);
    deepEq(r.highlights, ['h1']);
    eq(e.evaluate({ raw: 'no match', ts: null, level: null }).kept, true);
  });

  T('filter', 'disabled rules are ignored', () => {
    const e = mkEngine();
    e.setRules([
      { id: 'a', pattern: 'keepme', action: 'include', enabled: false },
      { id: 'b', pattern: 'dropme', action: 'exclude', enabled: false },
    ]);
    eq(e.evaluate({ raw: 'nothing relevant', ts: null, level: null }).kept, true);
  });

  T('filter', 'invalid regex surfaces error and rule is skipped', () => {
    const e = mkEngine();
    e.setRules([{ id: 'bad', pattern: '([unclosed', action: 'include', enabled: true }]);
    const errs = e.errors();
    eq(errs.length, 1);
    eq(errs[0].id, 'bad');
    eq(e.evaluate({ raw: 'safe', ts: null, level: null }).kept, true, 'invalid include acts as absent');
  });

  T('filter', 'quick search acts as an include rule', () => {
    const e = mkEngine();
    e.quick = { pattern: 'foo.bar', fixed: false, caseSensitive: false };
    eq(e.evaluate({ raw: 'fooXbar', ts: null, level: null }).kept, true);
    e.quick = { pattern: 'foo.bar', fixed: true, caseSensitive: false };
    eq(e.evaluate({ raw: 'fooXbar', ts: null, level: null }).kept, false);
    eq(e.evaluate({ raw: 'x foo.bar y', ts: null, level: null }).kept, true);
  });

  T('filter', 'level chips: none selected passes all, selection is OR, null bypasses', () => {
    const e = mkEngine();
    eq(e.evaluate({ raw: 'x', ts: null, level: 'I' }).kept, true);
    e.setLevels(['W', 'E']);
    eq(e.evaluate({ raw: 'x', ts: null, level: 'W' }).kept, true);
    eq(e.evaluate({ raw: 'x', ts: null, level: 'I' }).kept, false);
    eq(e.evaluate({ raw: 'stack trace line', ts: null, level: null }).kept, true, 'null level bypasses');
  });

  T('filter', 'time range uses inclusive prefix compare', () => {
    const e = mkEngine();
    e.timeFrom = '08-24 15:37';
    e.timeTo = '08-24 19:22';
    eq(e.evaluate({ raw: 'x', ts: '08-24 15:37:00.000', level: null }).kept, true, 'from includes exact minute start');
    eq(e.evaluate({ raw: 'x', ts: '08-24 19:22:59.999', level: null }).kept, true, 'to includes minute end');
    eq(e.evaluate({ raw: 'x', ts: '08-24 15:36:59.999', level: null }).kept, false);
    eq(e.evaluate({ raw: 'x', ts: '08-24 19:23:00.000', level: null }).kept, false);
    eq(e.evaluate({ raw: 'x', ts: null, level: null }).kept, true, 'null ts bypasses');
  });

  T('filter', 'one-sided time ranges', () => {
    const e = mkEngine();
    e.timeFrom = '08-24 15:37';
    eq(e.evaluate({ raw: 'x', ts: '08-24 23:59:59.999', level: null }).kept, true, 'from only: everything later passes');
    eq(e.evaluate({ raw: 'x', ts: '08-24 15:36:00.000', level: null }).kept, false);
    const e2 = mkEngine();
    e2.timeTo = '08-24 09:00';
    eq(e2.evaluate({ raw: 'x', ts: '08-24 00:00:00.000', level: null }).kept, true, 'to only: everything earlier passes');
    eq(e2.evaluate({ raw: 'x', ts: '08-24 09:00:59.999', level: null }).kept, true, 'inclusive minute end');
    eq(e2.evaluate({ raw: 'x', ts: '08-24 09:01:00.000', level: null }).kept, false);
  });

  T('filter', 'invalid quick pattern acts as absent and is reported', () => {
    const e = mkEngine();
    e.quick = { pattern: '([unclosed', fixed: false, caseSensitive: false };
    eq(e.evaluate({ raw: 'anything', ts: null, level: null }).kept, true, 'invalid quick = no constraint');
    eq(e.errors().some((x) => x.id === '__quick'), true, 'quick error is surfaced');
  });

  T('filter', 'quick regex compiles once per pattern, not per line', () => {
    const e = mkEngine();
    e.quick = { pattern: 'hit', fixed: false, caseSensitive: false };
    e.evaluate({ raw: 'hit', ts: null, level: null });
    const cache1 = e._quickCache;
    e.evaluate({ raw: 'hit again', ts: null, level: null });
    eq(e._quickCache, cache1, 'same quick object must reuse the cached compile');
  });

  T('filter', 'hit counters accumulate per rule', () => {
    const e = mkEngine();
    e.setRules([{ id: 'in', pattern: 'hit', action: 'include', enabled: true }]);
    e.evaluate({ raw: 'hit one', ts: null, level: null });
    e.evaluate({ raw: 'hit two', ts: null, level: null });
    e.evaluate({ raw: 'miss', ts: null, level: null });
    eq(e.hits.in, 2);
    e.quick = { pattern: 'hit', fixed: false, caseSensitive: false };
    e.evaluate({ raw: 'hit three', ts: null, level: null });
    eq(e.hits.__quick, 1);
  });

  T('levels', 'tally counts levels and unknown bucket', () => {
    const t = new SRC.LevelTally();
    ['I', 'I', 'W', 'E', null, null].forEach((l) => t.add(l));
    const counts = t.counts();
    eq(counts.I, 2);
    eq(counts.W, 1);
    eq(counts.E, 1);
    eq(counts.__, 2);
  });

  T('levels', 'chip list is ordered V D I W E F then unknown, only present', () => {
    const t = new SRC.LevelTally();
    ['F', 'I', 'D', null, 'W', null].forEach((l) => t.add(l));
    deepEq(t.chipList().map((c) => c.id), ['D', 'I', 'W', 'F', '__']);
    deepEq(t.chipList().map((c) => c.count), [1, 1, 1, 1, 2]);
  });

  /* ============================== G4: ripgrep-style search ============================== */

  T('search', 'plain regex search', () => {
    const s = SRC.buildSearcher('heartb.at', {});
    ok(s.ok);
    eq(SRC.matchLine(s, 'heartbeat alive'), true);
    eq(SRC.matchLine(s, 'heatbeat dead'), false);
  });

  T('search', 'fixed strings mode escapes metacharacters', () => {
    const s = SRC.buildSearcher('a.b', { fixed: true });
    eq(SRC.matchLine(s, 'xx a.b yy'), true);
    eq(SRC.matchLine(s, 'xx aXb yy'), false);
  });

  T('search', 'smart case: lowercase pattern matches any case, uppercase is sensitive', () => {
    const smartLo = SRC.buildSearcher('error', { caseMode: 'smart' });
    eq(SRC.matchLine(smartLo, 'ERROR occurred'), true);
    const smartHi = SRC.buildSearcher('Error', { caseMode: 'smart' });
    eq(SRC.matchLine(smartHi, 'ERROR occurred'), false);
    eq(SRC.matchLine(smartHi, 'Error occurred'), true);
  });

  T('search', 'forced insensitive and sensitive', () => {
    const ins = SRC.buildSearcher('ERROR', { caseMode: 'insensitive' });
    eq(SRC.matchLine(ins, 'error'), true);
    const sen = SRC.buildSearcher('error', { caseMode: 'sensitive' });
    eq(SRC.matchLine(sen, 'ERROR'), false);
    eq(SRC.matchLine(sen, 'error'), true);
  });

  T('search', 'whole word mode', () => {
    const w = SRC.buildSearcher('cat', { caseMode: 'sensitive', word: true });
    eq(SRC.matchLine(w, 'the cat sat'), true);
    eq(SRC.matchLine(w, 'the category'), false);
  });

  T('search', 'invert matches non-matching lines only', () => {
    const s = SRC.buildSearcher('noise', { invert: true });
    eq(SRC.matchLine(s, 'clean line'), true);
    eq(SRC.matchLine(s, 'noisy line noise'), false);
  });

  T('search', 'spans give match offsets for highlighting', () => {
    const s = SRC.buildSearcher('ab', {});
    deepEq(SRC.matchSpans(s, '-ab-ab-'), [[1, 3], [4, 6]]);
    deepEq(SRC.matchSpans(s, 'zzz'), []);
  });

  T('search', 'empty pattern means no search', () => {
    const s = SRC.buildSearcher('', {});
    ok(s.ok);
    eq(SRC.matchLine(s, 'anything'), false);
    deepEq(SRC.matchSpans(s, 'anything'), []);
  });

  T('search', 'invalid regex surfaces error', () => {
    const s = SRC.buildSearcher('([unclosed', {});
    eq(s.ok, false);
    ok(s.error);
  });

  T('search', 'searchRecords aggregates per-file counts', () => {
    const s = SRC.buildSearcher('heartbeat', {});
    const recs = [
      { file: 'f1', raw: 'heartbeat seq=1' },
      { file: 'f1', raw: 'heartbeat seq=2' },
      { file: 'f2', raw: 'heartbeat missed' },
      { file: 'f2', raw: 'silence' },
    ];
    const r = SRC.searchRecords(recs, s);
    eq(r.total, 3);
    eq(r.byFile.f1, 2);
    eq(r.byFile.f2, 1);
    eq(r.rows.length, 3);
    eq(r.rows[0].idx, 0);
  });

  T('search', 'context merges adjacent matches into contiguous ranges', () => {
    const s = SRC.buildSearcher('M', {});
    const lines = ['a', 'M', 'M', 'b', 'c', 'M', 'd'];
    const rows = SRC.searchWithContext(lines, s, 1, 1);
    // matches at 1,2,5 → ranges [0..3] and [4..6]
    deepEq(rows.map((r) => r.idx), [0, 1, 2, 3, 4, 5, 6]);
    deepEq(rows.map((r) => r.isMatch), [false, true, true, false, false, true, false]);
  });

  T('search', 'context zero returns only match lines', () => {
    const s = SRC.buildSearcher('M', {});
    const rows = SRC.searchWithContext(['a', 'M', 'b'], s, 0, 0);
    deepEq(rows.map((r) => r.idx), [1]);
  });

  T('search', 'defaults: no opts, missing file, undefined context, zero-width spans', () => {
    const s = SRC.buildSearcher('x*'); // no opts at all; zero-width regex
    eq(SRC.matchLine(s, 'abc'), true);
    deepEq(SRC.matchSpans(s, 'ab'), [], 'zero-width matches yield no spans');
    const r = SRC.searchRecords([{ raw: 'xx' }], SRC.buildSearcher('xx'));
    eq(r.total, 1);
    eq(r.byFile['?'], 1, 'records without file bucket under ?');
    const rows = SRC.searchWithContext(['a', 'b', 'a'], SRC.buildSearcher('a'), undefined, undefined);
    deepEq(rows.map((x) => x.idx), [0, 2]);
  });

  /* ============================== G5: store / timeline / selection / bookmarks ============================== */

  T('store', 'cap trims FIFO but counters stay exact', () => {
    const s = new SRC.Store(3);
    s.add('f1', 1, 'line1', { level: 'I' }, true);
    s.add('f1', 2, 'line2', { level: 'W' }, true);
    s.add('f1', 3, 'line3', { level: 'E' }, true);
    s.add('f1', 4, 'line4', { level: 'I' }, true);
    eq(s.kept.length, 3);
    eq(s.kept[0].lineNo, 2, 'oldest trimmed first');
    const st = s.stats();
    eq(st.keptTotal, 4);
    eq(st.trimmed, 1);
    eq(st.files.f1.total, 4);
    eq(st.files.f1.kept, 4);
    eq(st.files.f1.dropped, 0);
  });

  T('store', 'dropped lines counted, tally counts all scanned levels', () => {
    const s = new SRC.Store(100);
    s.add('a', 1, 'x', { level: 'I' }, true);
    s.add('a', 2, 'y', { level: 'E' }, false);
    s.add('b', 1, 'z', { level: null }, true);
    const st = s.stats();
    eq(st.files.a.kept, 1);
    eq(st.files.a.dropped, 1);
    deepEq(s.tally.counts(), { I: 1, E: 1, __: 1 });
  });

  T('store', 'bytes accumulate per file', () => {
    const s = new SRC.Store(100);
    s.addBytes('a', 10);
    s.addBytes('a', 5);
    s.addBytes('b', 7);
    eq(s.stats().files.a.bytes, 15);
    eq(s.stats().files.b.bytes, 7);
  });

  T('timeline', 'null-ts stack traces attach to preceding line in same file', () => {
    const recs = [
      { fileId: 'f', seq: 0, ts: '08-24 15:37:07.000', raw: 'E boom' },
      { fileId: 'f', seq: 1, ts: null, raw: '    at Foo.bar(Foo.java:1)' },
      { fileId: 'f', seq: 2, ts: null, raw: '    at Baz.qux(Baz.java:2)' },
    ];
    const merged = SRC.mergeTimeline(recs);
    deepEq(merged.map((r) => r.effTs), ['08-24 15:37:07.000', '08-24 15:37:07.000', '08-24 15:37:07.000']);
  });

  T('timeline', 'leading null-ts lines sort within their file block, first', () => {
    const recs = [
      { fileId: 'f', seq: 0, ts: null, raw: 'header line' },
      { fileId: 'f', seq: 1, ts: '08-24 15:37:07.000', raw: 'first parsed' },
    ];
    const merged = SRC.mergeTimeline(recs);
    deepEq(merged.map((r) => r.raw), ['header line', 'first parsed']);
  });

  T('timeline', 'merges interleaved files by timestamp', () => {
    const recs = [
      { fileId: 'a', seq: 0, ts: '08-24 15:37:01.000', raw: 'a1' },
      { fileId: 'b', seq: 1, ts: '08-24 15:37:01.500', raw: 'b1' },
      { fileId: 'a', seq: 2, ts: '08-24 15:37:02.000', raw: 'a2' },
      { fileId: 'b', seq: 3, ts: '08-24 15:37:01.200', raw: 'b0' },
    ];
    const merged = SRC.mergeTimeline(recs);
    deepEq(merged.map((r) => r.raw), ['a1', 'b0', 'b1', 'a2']);
  });

  T('timeline', 'equal timestamps break ties by file order then insertion', () => {
    const recs = [
      { fileId: 'b', seq: 0, ts: '08-24 15:37:01.000', raw: 'b-first-seen' },
      { fileId: 'a', seq: 1, ts: '08-24 15:37:01.000', raw: 'a-second' },
      { fileId: 'b', seq: 2, ts: '08-24 15:37:01.000', raw: 'b-third' },
    ];
    const merged = SRC.mergeTimeline(recs);
    deepEq(merged.map((r) => r.raw), ['b-first-seen', 'b-third', 'a-second']);
  });

  T('store', 'setFileInfo, default msg fallback, keptInMemory', () => {
    const s = new SRC.Store(100);
    s.setFileInfo('f', 'demo.log', 4096);
    s.add('f', 1, 'raw line', { level: 'I' }, true); // no msg -> raw
    eq(s.kept[0].msg, 'raw line');
    const st = s.stats();
    eq(st.files.f.name, 'demo.log');
    eq(st.files.f.size, 4096);
    eq(st.keptInMemory, 1);
  });

  T('store', 'defaults: cap default, unnamed file info, null rec, full rec', () => {
    const s = new SRC.Store();
    s.setFileInfo('f', 'x.log'); // size omitted -> 0
    s.add('f', 1, 'r1', null, true); // null record
    s.add('f', 2, 'r2', { ts: '', tag: 'T', pid: '9', msg: 'm' }, true); // empty ts -> null
    eq(s.kept[0].level, null);
    eq(s.kept[0].msg, 'r1');
    eq(s.kept[1].ts, null);
    eq(s.kept[1].tag, 'T');
    eq(s.kept[1].pid, '9');
    eq(s.kept[1].msg, 'm');
    eq(s.stats().files.f.size, 0);
    s.addBytes('f', 1);
    eq(s.stats().files.f.bytes, 1);
  });

  T('timeline', 'records without seq stay stable', () => {
    const recs = [
      { fileId: 'a', ts: '08-24 15:37:01.000', raw: 'a1' },
      { fileId: 'a', ts: '08-24 15:37:01.000', raw: 'a2' },
    ];
    const merged = SRC.mergeTimeline(recs);
    deepEq(merged.map((r) => r.raw), ['a1', 'a2']);
  });

  T('selection', 'click anchors, shift extends range, ctrl toggles', () => {
    const sel = new SRC.SelectionModel();
    sel.click(5);
    deepEq(sel.indices(), [5]);
    sel.shiftClick(8);
    deepEq(sel.indices(), [5, 6, 7, 8]);
    sel.ctrlClick(6);
    deepEq(sel.indices(), [5, 7, 8]);
    sel.ctrlClick(6);
    deepEq(sel.indices(), [5, 6, 7, 8], 'second ctrl-click toggles back on');
  });

  T('selection', 'shift back above anchor, selectAll, clear', () => {
    const sel = new SRC.SelectionModel();
    sel.click(5);
    sel.shiftClick(2);
    deepEq(sel.indices(), [2, 3, 4, 5]);
    sel.selectAll(7);
    eq(sel.count, 7);
    sel.clear();
    eq(sel.count, 0);
  });

  T('selection', 'shift-click from toggled anchor extends from last anchor', () => {
    const sel = new SRC.SelectionModel();
    sel.click(1);
    sel.ctrlClick(4);
    sel.shiftClick(6);
    deepEq(sel.indices(), [1, 4, 5, 6]);
  });

  T('bookmarks', 'toggle, has, note, remove', () => {
    const bm = new SRC.BookmarkStore();
    eq(bm.toggle('k', 10, { snippet: 's' }), true);
    eq(bm.has('k', 10), true);
    eq(bm.toggle('k', 10), false);
    eq(bm.has('k', 10), false);
    bm.toggle('k', 11, { snippet: 's2' });
    bm.setNote('k', 11, 'check this');
    eq(bm.list('k')[0].note, 'check this');
    bm.remove('k', 11);
    eq(bm.list('k').length, 0);
  });

  T('bookmarks', 'JSON round trip preserves entries and notes', () => {
    const bm = new SRC.BookmarkStore();
    bm.toggle('f1', 3, { snippet: 'a', ts: '08-24 15:37:01.000' });
    bm.toggle('f1', 9, { snippet: 'b' });
    bm.toggle('f2', 1, { snippet: 'c' });
    bm.setNote('f1', 9, 'note');
    const bm2 = new SRC.BookmarkStore();
    bm2.fromJSON(bm.toJSON());
    eq(bm2.all().length, 3);
    eq(bm2.list('f1').length, 2);
    eq(bm2.list('f1')[1].note, 'note');
  });

  T('bookmarks', 'file identity key is stable and size-sensitive', () => {
    const k1 = SRC.bookmarkFileKey('logcat.txt', 1234, '08-24 15:37:01.123 first');
    const k2 = SRC.bookmarkFileKey('logcat.txt', 1234, '08-24 15:37:01.123 first');
    const k3 = SRC.bookmarkFileKey('logcat.txt', 1235, '08-24 15:37:01.123 first');
    const k4 = SRC.bookmarkFileKey('other.txt', 1234, '08-24 15:37:01.123 first');
    eq(k1, k2);
    ok(k1 !== k3);
    ok(k1 !== k4);
  });

  T('bookmarks', 'edge branches: no-meta toggle, unknown key ops, defensive fromJSON', () => {
    const bm = new SRC.BookmarkStore();
    eq(bm.has('nokey', 1), false); // unknown key
    bm.setNote('nokey', 1, 'ignored'); // unknown key, no throw
    bm.toggle('k', 1); // no meta
    eq(bm.list('k')[0].meta && Object.keys(bm.list('k')[0].meta).length, 0);
    deepEq(bm.list('never'), []);
    bm.setNote('k', 999, 'ignored'); // entry does not exist
    bm.setNote('k', 1, 'ok');
    eq(bm.list('k')[0].note, 'ok');
    const bm2 = new SRC.BookmarkStore();
    bm2.fromJSON(null); // must not throw
    bm2.fromJSON({ k: [{ lineNo: 2 }, null, { broken: true }, { lineNo: 3, meta: { a: 1 }, note: 'n' }] });
    eq(bm2.list('k').length, 2);
    eq(bm2.list('k')[0].meta && Object.keys(bm2.list('k')[0].meta).length, 0);
    eq(bm2.list('k')[1].note, 'n');
  });

  /* ============================== G6: exporters ============================== */

  function rec(file, lineNo, raw, extra) {
    return Object.assign({ file, fileId: file, lineNo, raw, ts: null, level: null, tag: null, pid: null, msg: raw }, extra);
  }

  T('export', 'text with and without prefixes', () => {
    const recs = [rec('a.log', 3, 'hello'), rec('b.log', 7, 'world', { ts: '08-24 15:37:01.000' })];
    eq(SRC.toText(recs, { prefix: 'none' }), 'hello\nworld');
    eq(SRC.toText(recs, { prefix: 'ln' }), '[L3] hello\n[L7] world');
    eq(SRC.toText(recs, { prefix: 'file:line' }), 'a.log:3: hello\nb.log:7: world');
  });

  T('export', 'csv escapes quotes commas and newlines', () => {
    const recs = [rec('a.log', 1, 'plain', { ts: '08-24 15:37:01.000', level: 'I', tag: 'Tag', pid: '12' }),
      rec('a.log', 2, 'say "hi", ok', { level: 'W' })];
    const csv = SRC.toCsv(recs);
    const lines = csv.split('\n');
    eq(lines[0], 'file,lineNo,ts,level,tag,pid,message');
    eq(lines[1], 'a.log,1,08-24 15:37:01.000,I,Tag,12,plain');
    eq(lines[2], 'a.log,2,,W,,,"say ""hi"", ok"');
  });

  T('export', 'json output is stable and parseable', () => {
    const recs = [rec('a.log', 5, 'x', { level: 'E' })];
    const parsed = JSON.parse(SRC.toJson(recs));
    eq(parsed.length, 1);
    eq(parsed[0].file, 'a.log');
    eq(parsed[0].lineNo, 5);
    eq(parsed[0].level, 'E');
  });

  T('export', 'rg text uses file:lineNo: format', () => {
    const rows = [
      { file: 'a.log', lineNo: 4, text: 'matched line' },
      { file: 'a.log', lineNo: 5, text: 'context line', isMatch: false },
    ];
    eq(SRC.toRgText(rows), 'a.log:4: matched line\na.log:5- context line');
  });

  T('export', 'bookmarks export is json with all keys', () => {
    const bm = new SRC.BookmarkStore();
    bm.toggle('f1', 3, { snippet: 's' });
    const parsed = JSON.parse(SRC.bookmarksToJson(bm));
    eq(parsed.f1.length, 1);
    eq(parsed.f1[0].lineNo, 3);
  });

  T('export', 'search json export records match flags', () => {
    const rows = [{ file: 'a.log', lineNo: 4, text: 'm', isMatch: true }, { file: 'a.log', lineNo: 5, text: 'c', isMatch: false }];
    const parsed = JSON.parse(SRC.searchToJson(rows));
    eq(parsed.length, 2);
    eq(parsed[0].match, true);
    eq(parsed[1].match, false);
    eq(parsed[1].text, 'c');
  });

  T('export', 'null-safe fields fall back to raw and empty', () => {
    eq(SRC.csvField(null), '');
    eq(SRC.csvField('a,b'), '"a,b"');
    const recs = [{ file: 'a.log', lineNo: 1, raw: 'rr', ts: null, level: null, tag: null, pid: null, msg: null }];
    eq(SRC.toCsv(recs), 'file,lineNo,ts,level,tag,pid,message\na.log,1,,,,,rr');
    const parsed = JSON.parse(SRC.toJson(recs));
    eq(parsed[0].message, 'rr');
  });

  /* ============================== G7: themes ============================== */

  T('themes', 'six built-in themes with expected names', () => {
    deepEq(SRC.themeNames(), ['midnight', 'paper', 'solarized-dark', 'solarized-light', 'monokai', 'high-contrast']);
    eq(SRC.THEMES.midnight.dark, true);
    eq(SRC.THEMES.paper.dark, false);
  });

  T('themes', 'every theme defines every required variable', () => {
    deepEq(SRC.themeCompletenessErrors(), []);
  });

  T('themes', 'generated CSS includes default root block and all data-theme blocks', () => {
    const css = SRC.generateCss();
    ok(css.includes(':root {'), 'root block');
    for (const n of SRC.themeNames()) ok(css.includes('body[data-theme="' + n + '"]'));
    ok(css.includes('--accent'), 'accent var present');
  });

  T('themes', 'completeness check reports partial themes by name', () => {
    const errs = SRC.themeCompletenessErrors({ broken: { label: 'Broken', dark: true, vars: { '--bg': '#000' } } });
    eq(errs.length, 1);
    ok(errs[0].startsWith('broken: missing '));
    const css = SRC.generateCss({ only: { label: 'Only', dark: false, vars: SRC.THEMES.paper.vars } });
    ok(css.includes('body[data-theme="only"]'));
  });

  T('detect', 'logcat beats mmdd on tie (specificity order pinned)', () => {
    const lines = [
      '08-24 15:37:01.123  1234  5678 I Tag: x',
      '08-24 15:37:02.456  1234  5678 E Tag: y',
    ];
    const r = SRC.detectFormat(lines);
    eq(r.format, 'logcat');
    eq(r.hits.logcat, r.hits.mmdd, 'both patterns match — order decides');
  });

  /* ============================== per-file removal ============================== */

  T('store', 'removeFile drops lines, stats and its tally contribution', () => {
    const s = new SRC.Store(100);
    s.add('a', 1, 'x', { level: 'I' }, true);
    s.add('a', 2, 'y', { level: 'E' }, true);
    s.add('a', 3, 'z', {}, false); // dropped, null level -> '__' tallied
    s.add('b', 1, 'q', { level: 'E' }, true);
    s.removeFile('a');
    const st = s.stats();
    eq(st.totalLines, 1);
    eq(st.keptTotal, 1);
    eq(st.keptInMemory, 1);
    eq(st.files.b.total, 1);
    ok(!st.files.a, 'removed file gone from stats');
    deepEq(s.tally.counts(), { E: 1 });
    eq(s.kept[0].fileId, 'b');
    s.removeFile('nope'); // unknown id is a no-op
    eq(s.stats().totalLines, 1);
  });

  T('levels', 'remove subtracts counts and drops empty buckets', () => {
    const t = new SRC.LevelTally();
    ['I', 'I', 'W'].forEach((l) => t.add(l));
    t.remove('I', 2);
    t.remove('W', 1);
    deepEq(t.counts(), {});
    deepEq(t.chipList(), []);
  });

  T('levels', 'remove defaults to one and never goes negative', () => {
    const t = new SRC.LevelTally();
    t.add('D');
    t.add('D');
    t.remove('D'); // n omitted -> subtract 1
    eq(t.counts().D, 1);
    t.remove('D', 5); // over-removal clamps: bucket disappears
    deepEq(t.counts(), {});
    t.remove(null, 3); // unknown bucket key
    deepEq(t.counts(), {});
  });

  T('store', 'tallyFor returns the per-file level tally', () => {
    const s = new SRC.Store(100);
    s.add('a', 1, 'x', { level: 'I' }, true);
    s.add('a', 2, 'y', { level: 'W' }, true);
    s.add('a', 3, 'z', { level: 'W' }, false); // dropped lines count too
    s.add('a', 4, 'c', {}, true);              // null level -> '__' bucket
    s.add('b', 1, 'q', { level: 'E' }, true);
    deepEq(s.tallyFor('a').counts(), { I: 1, W: 2, __: 1 });
    deepEq(s.tallyFor('b').counts(), { E: 1 });
    deepEq(s.tallyFor('zz').counts(), {});
    deepEq(s.tallyFor('a').chipList().map((c) => c.id), ['I', 'W', '__']);
  });

  T('bookmarks', 'removeFile drops every entry of that file', () => {
    const bm = new SRC.BookmarkStore();
    bm.toggle('a|100|hash1', 1, {});
    bm.toggle('a|100|hash1', 2, {});
    bm.toggle('b|100|hash1', 3, {});
    bm.removeFile('a|100|hash1');
    eq(bm.list('a|100|hash1').length, 0);
    eq(bm.list('b|100|hash1').length, 1);
  });

  T('bookmarks', 'removeAll clears every entry', () => {
    const bm = new SRC.BookmarkStore();
    bm.toggle('a', 1, {});
    bm.toggle('b', 2, {});
    bm.removeAll();
    eq(bm.all().length, 0);
  });

  return { CASES, eq, deepEq, ok };
}));
