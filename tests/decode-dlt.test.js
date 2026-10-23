'use strict';
/* Binary DLT (.dlt) capture decoding: src/decode-dlt.js (SPEC-DLT-BINARY-001).
 * Wire layout per the AUTOSAR DLT v1 specification as summarized in ADR-0014:
 * optional 16-byte storage header, standard header with HTYP typed flags and
 * a 16-bit total length in the MSBF-given byte order, optional 10-byte
 * extended header, then typed verbose arguments or an opaque non-verbose
 * payload. Committed fixtures follow the lzma*.hex ASCII-hex precedent; edge
 * shapes are built in-test with byte builders. */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const DLT = require('../src/decode-dlt.js');
const paged = require('../src/paged.js');

const FX = path.join(__dirname, 'fixtures');
const hexFile = (f) => new Uint8Array(Buffer.from(fs.readFileSync(path.join(FX, f), 'utf8').trim(), 'hex'));

// --- byte builders ---------------------------------------------------------

const enc = (s) => new TextEncoder().encode(s);
const cat = (...xs) => {
  const n = xs.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(n);
  let p = 0;
  for (const a of xs) { out.set(a, p); p += a.length; }
  return out;
};
const bytes = (arr) => new Uint8Array(arr);
const ascii4 = (s) => { const out = new Uint8Array(4); out.set(enc(String(s)).slice(0, 4)); return out; };
const u16 = (v, msbf) => bytes(msbf ? [(v >> 8) & 255, v & 255] : [v & 255, (v >> 8) & 255]);
const u32 = (v, msbf) => {
  const b = [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
  return msbf ? bytes(b) : bytes(b.reverse());
};
const i32 = (v, msbf) => u32(v < 0 ? v + 4294967296 : v, msbf);
const bigBytes = (v, n, msbf) => {
  const b = new Uint8Array(n);
  let x = BigInt(v);
  for (let i = 0; i < n; i++) { b[i] = Number(x & 0xffn); x >>= 8n; }
  return msbf ? b.reverse() : b;
};

/* DLT v1 message builder: computes the declared total length from the parts.
 * opts: { msbf, mcnt, stdEcu, session, tmsp, ueh: { msin, argc, apid, ctid },
 *         payload, storage: { ecu, sec, micros }, len (override for bad- framing tests) } */
function buildMsg(o) {
  const msbf = !!o.msbf;
  let htyp = 0x20; // protocol version 0b001 in bits 5-7
  if (o.ueh) htyp |= 0x01;
  if (msbf) htyp |= 0x02;
  if (o.stdEcu) htyp |= 0x04;
  if (o.session != null) htyp |= 0x08;
  if (o.tmsp != null) htyp |= 0x10;
  const payload = o.payload || new Uint8Array(0);
  const len = o.len != null ? o.len
    : 4 + (o.stdEcu ? 4 : 0) + (o.session != null ? 4 : 0) + (o.tmsp != null ? 4 : 0) + (o.ueh ? 10 : 0) + payload.length;
  let h = cat(bytes([htyp, o.mcnt || 0]), u16(len, msbf));
  if (o.stdEcu) h = cat(h, ascii4(o.stdEcu));
  if (o.session != null) h = cat(h, u32(o.session, msbf));
  if (o.tmsp != null) h = cat(h, u32(o.tmsp, msbf));
  if (o.ueh) h = cat(h, bytes([o.ueh.msin, o.ueh.argc || 0]), ascii4(o.ueh.apid || ''), ascii4(o.ueh.ctid || ''));
  const body = cat(h, payload);
  if (!o.storage) return body;
  return cat(bytes([0x44, 0x4c, 0x54, 0x01]), ascii4(o.storage.ecu), u32(o.storage.sec, msbf), i32(o.storage.micros, msbf), body);
}

// typed verbose argument encoders (type info word per dlt_protocol.h v1 layout)
const TYLE = { 1: 1, 2: 2, 4: 3, 8: 4, 16: 5 };
const argBool = (v, msbf) => cat(u32(0x10 | TYLE[1], msbf), bytes([v ? 1 : 0]));
const argInt = (v, n, signed, msbf) => {
  const ti = (signed ? 0x20 : 0x40) | TYLE[n];
  const val = bigBytes(v, n, msbf);
  return cat(u32(ti, msbf), val);
};
const argF16 = (halfBits, msbf) => cat(u32(0x80 | TYLE[2], msbf), u16(halfBits, msbf));
const argF32 = (v, msbf) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setFloat32(0, v, !msbf);
  return cat(u32(0x80 | TYLE[4], msbf), b);
};
const argF64 = (v, msbf) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, v, !msbf);
  return cat(u32(0x80 | TYLE[8], msbf), b);
};
const argStr = (s, utf8, msbf) => {
  const b = enc(s);
  const withNul = cat(b, bytes([0])); // DLT string length includes the terminating NUL
  return cat(u32(0x200 | (utf8 ? 0x8000 : 0), msbf), u16(withNul.length, msbf), withNul);
};
const argStrBytes = (raw, utf8, msbf) => cat(u32(0x200 | (utf8 ? 0x8000 : 0), msbf), u16(raw.length, msbf), bytes(raw));
const argRaw = (raw, msbf) => cat(u32(0x400, msbf), u16(raw.length, msbf), bytes(raw));
const argVariName = (name, msbf) => { const b = enc(name); return cat(u16(b.length + 1, msbf), cat(b, bytes([0]))); };
const argVariNameUnit = (name, unit, msbf) => cat(argVariName(name, msbf), argVariName(unit, msbf));

// --- sniff matrix (R1-1, R1-2, R1-5) ---------------------------------------

test('sniff: storage-header magic classifies dlt-binary with the flag set', () => {
  const buf = buildMsg({ storage: { ecu: 'ECU1', sec: 0, micros: 0 }, ueh: { msin: 0x41, argc: 1 }, payload: argBool(true, true) });
  assert.deepStrictEqual(DLT.dltSniff(buf, buf.length), { binary: true, storageHeader: true });
});

test('sniff: storage-header magic is version-exact (DLTv2 44 4C 54 02 never classifies)', () => {
  const v2 = bytes([0x44, 0x4c, 0x54, 0x02, 0x20, 0x00, 0x00, 0x08, 1, 2, 3, 4]);
  assert.deepStrictEqual(DLT.dltSniff(v2, v2.length), { binary: false, storageHeader: false });
});

test('sniff: storage-header-less capture classifies via chained plausible boundaries', () => {
  const m1 = buildMsg({ msbf: true, mcnt: 1, tmsp: 100, ueh: { msin: 0x41, argc: 1 }, payload: argBool(true, true) });
  const m2 = buildMsg({ msbf: true, mcnt: 2, tmsp: 200, ueh: { msin: 0x41, argc: 1 }, payload: argBool(false, true) });
  const buf = cat(m1, m2);
  assert.deepStrictEqual(DLT.dltSniff(buf, buf.length), { binary: true, storageHeader: false });
});

test('sniff: single-message capture classifies via a complete verbose decode', () => {
  const m = buildMsg({ msbf: true, mcnt: 7, session: 9, ueh: { msin: 0x41, argc: 1 }, payload: argBool(true, true) });
  assert.deepStrictEqual(DLT.dltSniff(m, m.length), { binary: true, storageHeader: false });
});

test('sniff: single non-verbose message does not classify (no typed structure)', () => {
  const m = buildMsg({ mcnt: 1, tmsp: 5, payload: bytes([1, 2, 3]) });
  assert.deepStrictEqual(DLT.dltSniff(m, m.length), { binary: false, storageHeader: false });
});

test('sniff: wrong protocol version bits are rejected', () => {
  const raw = bytes([0x10, 0x01, 0x00, 0x08]); // version bits 0b000
  assert.deepStrictEqual(DLT.dltSniff(raw, raw.length).binary, false);
});

test('sniff: declared length below the HTYP-implied minimum is rejected', () => {
  // UEH implies an 18-byte minimum, declared 8
  const m1 = bytes([0x21, 0x01, 0x00, 0x08]);
  const rest = buildMsg({ mcnt: 2, tmsp: 5, payload: bytes([1, 2, 3, 4, 5, 6, 7, 8]) });
  const buf = cat(m1, rest);
  assert.deepStrictEqual(DLT.dltSniff(buf, buf.length).binary, false);
});

test('sniff: declared length overshooting file size is rejected', () => {
  const m1 = buildMsg({ mcnt: 1, tmsp: 5, len: 4000, payload: bytes([1, 2, 3]) });
  const m2 = buildMsg({ mcnt: 2, tmsp: 5, payload: bytes([1, 2, 3]) });
  const buf = cat(m1, m2);
  assert.deepStrictEqual(DLT.dltSniff(buf, buf.length).binary, false);
});

test('sniff: 16 KiB logcat-style head never classifies dlt-binary', () => {
  const line = '09-11 22:14:01.100  1234  5678 I ActivityManager: Start proc 1234:com.foo/u0a12 for broadcast\n';
  let text = '';
  while (text.length < 16384) text += line;
  const buf = enc(text);
  assert.strictEqual(buf.length >= 16384, true);
  assert.deepStrictEqual(DLT.dltSniff(buf, buf.length), { binary: false, storageHeader: false });
});

// --- header walking (R2-1) ---------------------------------------------------

test('framing: storage header is framing; typed-flag extras decode in MSBF order', () => {
  const buf = buildMsg({
    msbf: true, mcnt: 0x84, stdEcu: 'ECUA', session: 305419896, tmsp: 1000,
    storage: { ecu: 'ECU1', sec: 1577836800, micros: 0 },
    ueh: { msin: 0x41, argc: 1, apid: 'APP1', ctid: 'CTX1' },
    payload: argBool(true, true),
  });
  const m = DLT.dltDecodeMessage(buf);
  assert.strictEqual(m.record.pid, '305419896');
  assert.strictEqual(m.record.tag, 'APP1:CTX1');
  assert.strictEqual(m.record.ts, '01-01 00:00:00.000');
  assert.strictEqual(m.consumed, buf.length - 16, 'next boundary excludes the storage header');
});

test('framing: total length is read little-endian when the MSBF bit is clear', () => {
  // 4 fixed + 4 TMSP + 4 payload = declared 12, stored as LE 0x0C 0x00
  const le = buildMsg({ mcnt: 1, tmsp: 5, payload: bytes([1, 2, 3, 4]) });
  const m = DLT.dltDecodeMessage(le);
  assert.strictEqual(m.consumed, le.length);
  assert.strictEqual(m.record.msg, 'hex 01020304');
});

test('framing: every HTYP flag combination walks to the declared boundary', () => {
  const combos = [
    {},
    { stdEcu: 'E1' },
    { session: 7 },
    { tmsp: 9 },
    { stdEcu: 'E1', session: 7, tmsp: 9 },
    { ueh: { msin: 0x41, argc: 1 } },
    { stdEcu: 'E1', session: 7, tmsp: 9, ueh: { msin: 0x25, argc: 1 } },
  ];
  for (const combo of combos) {
    for (const msbf of [false, true]) {
      const payload = combo.ueh ? argBool(true, msbf) : bytes([1, 2]);
      const m1 = buildMsg(Object.assign({ msbf, mcnt: 1 }, combo, { payload }));
      const m2 = buildMsg({ msbf, mcnt: 2, tmsp: 3, payload: bytes([9, 9]) });
      const buf = cat(m1, m2);
      const scan = DLT.dltScanMessages(buf);
      assert.strictEqual(scan.warnings, 0, 'combo ' + JSON.stringify(combo) + ' msbf ' + msbf);
      assert.strictEqual(scan.records.length, 2);
      assert.strictEqual(scan.records[0].offset, 0);
      assert.strictEqual(scan.records[1].offset, m1.length, 'second boundary at declared length');
    }
  }
});

test('framing: extended header decodes msin bit fields, argument count, APID and CTID', () => {
  // msin 0b01100101: verbose, MSTP 2 (nw_trace), MTIN 6
  const buf = buildMsg({ mcnt: 3, ueh: { msin: 0x65, argc: 2, apid: 'NAV', ctid: 'X' }, payload: cat(argBool(true, false), argBool(false, false)) });
  const m = DLT.dltDecodeMessage(buf);
  assert.strictEqual(m.record.level, 'D');
  assert.strictEqual(m.line.split(' ')[4], 'nw_trace', 'type word column (no ts: line starts at mcnt)');
  assert.strictEqual(m.record.msg, 'true false');
});

// --- verbose typed arguments (R4-1..R4-3) -----------------------------------

test('args: boolean renders true/false', () => {
  const buf = buildMsg({ ueh: { msin: 0x41, argc: 2 }, payload: cat(argBool(true, false), argBool(false, false)) });
  assert.strictEqual(DLT.dltDecodeMessage(buf).record.msg, 'true false');
});

test('args: integers 8-32 bit decode exactly, signed and unsigned', () => {
  const payload = cat(
    argInt(255, 1, false, false),
    argInt(-128, 1, true, false),
    argInt(65535, 2, false, false),
    argInt(-1, 2, true, false),
    argInt(4294967295, 4, false, false),
    argInt(-2147483648, 4, true, false),
  );
  const buf = buildMsg({ ueh: { msin: 0x41, argc: 6 }, payload });
  assert.strictEqual(DLT.dltDecodeMessage(buf).record.msg,
    '255 -128 65535 -1 4294967295 -2147483648');
});

test('args: 64- and 128-bit integers decode via BigInt without Float64 loss', () => {
  const payload = cat(
    argInt((2n ** 63n) + 1n, 8, false, true),
    argInt(-(2n ** 63n), 8, true, true),
    argInt(2n ** 127n, 16, false, true),
    argInt(-(2n ** 127n), 16, true, true),
  );
  const buf = buildMsg({ msbf: true, ueh: { msin: 0x41, argc: 4 }, payload });
  assert.strictEqual(DLT.dltDecodeMessage(buf).record.msg,
    '9223372036854775809 -9223372036854775808 170141183460469231731687303715884105728 -170141183460469231731687303715884105728');
});

test('args: float16 decodes to exact float64 equivalents', () => {
  const payload = cat(argF16(0x3c00, false), argF16(0xc100, false), argF16(0x0001, false), argF16(0x7c00, false), argF16(0xfc00, false), argF16(0x7e00, false));
  const buf = buildMsg({ ueh: { msin: 0x41, argc: 6 }, payload });
  assert.strictEqual(DLT.dltDecodeMessage(buf).record.msg,
    '1 -2.5 5.960464477539063e-8 Infinity -Infinity NaN');
});

test('args: float32 and float64 decode exactly', () => {
  const payload = cat(argF32(0.5, false), argF32(3.14, false), argF64(2.718281828459045, false));
  const buf = buildMsg({ ueh: { msin: 0x41, argc: 3 }, payload });
  assert.strictEqual(DLT.dltDecodeMessage(buf).record.msg,
    '0.5 ' + String(Math.fround(3.14)) + ' 2.718281828459045');
});

test('args: ASCII strings decode one byte per char', () => {
  const buf = buildMsg({ ueh: { msin: 0x41, argc: 1 }, payload: argStr('hello world', false, false) });
  assert.strictEqual(DLT.dltDecodeMessage(buf).record.msg, 'hello world');
});

test('args: UTF-8 strings decode; each invalid byte renders as a lowercase \\xNN escape', () => {
  const ok = argStr('héllo café', true, false);
  const bad = argStrBytes(cat(enc('bad'), [0xff], enc('!')), true, false);
  const buf = buildMsg({ ueh: { msin: 0x41, argc: 2 }, payload: cat(ok, bad) });
  assert.strictEqual(DLT.dltDecodeMessage(buf).record.msg, 'héllo café bad\\xff!');
});

test('args: UTF-16 surrogate-half bytes (ED A0 80) render as pinned \\xNN escapes, never a lone surrogate (AC-4.3/R4-3)', () => {
  // 48 'H' + ED A0 80 (3-byte lead 0xED with a continuation byte in the
  // surrogate range D800-DFFF) + 00 NUL terminator
  const buf = buildMsg({ ueh: { msin: 0x41, argc: 1 }, payload: argStrBytes([0x48, 0xed, 0xa0, 0x80, 0x00], true, false) });
  const msg = DLT.dltDecodeMessage(buf).record.msg;
  assert.strictEqual(msg, 'H\\xed\\xa0\\x80');
  assert.ok(!/[\uD800-\uDFFF]/.test(msg), 'no lone surrogate code point survives rendering');
});

test('args: raw payload renders as lowercase hex', () => {
  const buf = buildMsg({ ueh: { msin: 0x41, argc: 1 }, payload: argRaw([0x00, 0xff, 0x10], false) });
  assert.strictEqual(DLT.dltDecodeMessage(buf).record.msg, '00ff10');
});

test('args: variable-info name and unit attributes are consumed before the value', () => {
  const payload = cat(
    u32(0x800 | 0x40 | TYLE[4], false),
    argVariNameUnit('rpm', 'Hz', false),
    u32(5000, false),
  );
  const buf = buildMsg({ ueh: { msin: 0x41, argc: 1 }, payload });
  assert.strictEqual(DLT.dltDecodeMessage(buf).record.msg, '5000');
});

// --- non-verbose rendering, levels, MSTP (R3-4, R3-5, R4-4) -----------------

test('render: non-verbose payload renders as a hex dump and stays searchable', () => {
  const buf = buildMsg({ mcnt: 9, ueh: { msin: 0x30, argc: 0, apid: 'HMI', ctid: 'CAN' }, payload: bytes([0xde, 0xad, 0xbe, 0xef]) });
  const m = DLT.dltDecodeMessage(buf);
  assert.strictEqual(m.record.msg, 'hex deadbeef');
  assert.strictEqual(m.line.includes('hex deadbeef'), true);
});

test('render: level nibble 1-6 maps to F/E/W/I/D/V, 0 and 7+ have none', () => {
  const levels = { 1: 'F', 2: 'E', 3: 'W', 4: 'I', 5: 'D', 6: 'V', 0: null, 7: null, 15: null };
  for (const [mtin, want] of Object.entries(levels)) {
    const msin = (0 << 1) | (Number(mtin) << 4) | 1;
    const buf = buildMsg({ ueh: { msin, argc: 1 }, payload: argBool(true, false) });
    assert.strictEqual(DLT.dltDecodeMessage(buf).record.level, want, 'mtin ' + mtin);
  }
});

test('render: MSTP 1-4 keep the text-path keywords, reserved values render mstp=N', () => {
  const cases = [[1, 'app_trace', 'D'], [2, 'nw_trace', 'D'], [3, 'control', 'I'], [4, 'extension', null], [5, 'mstp=5', null], [7, 'mstp=7', null]];
  for (const [mstp, word, level] of cases) {
    const msin = (mstp << 1) | (1 << 4) | 1; // verbose, mtin 1
    const buf = buildMsg({ ueh: { msin, argc: 1 }, payload: argBool(true, false) });
    const m = DLT.dltDecodeMessage(buf);
    assert.strictEqual(m.line.split(' ')[4], word, 'mstp ' + mstp);
    assert.strictEqual(m.record.level, level, 'mstp ' + mstp + ' level');
  }
});

test('render: control message without APID/CTID falls back to the ECU id', () => {
  const buf = buildMsg({
    storage: { ecu: 'ECU9', sec: 0, micros: 0 },
    ueh: { msin: 0x16, argc: 0, apid: '', ctid: '' },
    payload: bytes([0x01]),
  });
  const m = DLT.dltDecodeMessage(buf);
  assert.strictEqual(m.record.tag, 'ECU9');
  assert.strictEqual(m.record.level, 'I');
  assert.strictEqual(m.line, '01-01 00:00:00.000 0 ECU9 ECU9 - control request hex 01');
});

test('render: message without an extended header renders with the fields it has', () => {
  const buf = buildMsg({ mcnt: 2, stdEcu: 'ECU2', session: 42, payload: bytes([0xaa, 0xbb]) });
  const m = DLT.dltDecodeMessage(buf);
  assert.strictEqual(m.record.level, null);
  assert.strictEqual(m.record.tag, 'ECU2');
  assert.strictEqual(m.record.pid, '42');
  assert.strictEqual(m.line, '2 ECU2 ECU2 42 - - hex aabb');
});

// --- boundaries and resilience (R4-5, R5-1..R5-4, R5-6) ----------------------

test('boundary: an argument read past the declared total length never touches the next message', () => {
  // argc 2 but only one tiny bool fits; the second type info claims 16 bytes
  const greedy = cat(argBool(true, false), u32(0x40 | TYLE[16], false), new Uint8Array(16));
  const m1 = buildMsg({ mcnt: 1, ueh: { msin: 0x41, argc: 2 }, payload: greedy.slice(0, 20), len: 4 + 10 + 20 });
  const m2 = buildMsg({ mcnt: 2, ueh: { msin: 0x41, argc: 1 }, payload: argBool(false, false) });
  const scan = DLT.dltScanMessages(cat(m1, m2));
  assert.strictEqual(scan.warnings, 1, 'invalid argument counts one warning');
  assert.strictEqual(scan.records.length, 2, 'the next message still decodes');
  assert.strictEqual(scan.records[0].record.msg.startsWith('hex '), true);
  assert.strictEqual(scan.records[1].record.msg, 'false');
});

test('resilience: truncated final message yields one partial record and one warning', () => {
  const full = buildMsg({ mcnt: 1, ueh: { msin: 0x30, argc: 0, apid: 'HMI', ctid: 'CAN' }, payload: bytes([1, 2, 3, 4, 5, 6]) });
  const before = buildMsg({ mcnt: 0, ueh: { msin: 0x41, argc: 1 }, payload: argBool(true, false) });
  const cut = full.subarray(0, full.length - 3);
  const scan = DLT.dltScanMessages(cat(before, cut));
  assert.strictEqual(scan.warnings, 1);
  assert.strictEqual(scan.records.length, 2);
  assert.strictEqual(scan.records[1].record.msg, 'hex 010203');
});

test('resilience: implausible mid-file length resynchronizes at the next boundary (AC-E.3)', () => {
  const m1 = buildMsg({ mcnt: 1, ueh: { msin: 0x41, argc: 1 }, payload: argBool(true, false) });
  const garbage = bytes([0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa]);
  const m2 = buildMsg({ mcnt: 2, ueh: { msin: 0x41, argc: 1 }, payload: argBool(false, false) });
  const buf = cat(m1, garbage, m2);
  const scan = DLT.dltScanMessages(buf);
  assert.strictEqual(scan.warnings, 1);
  assert.strictEqual(scan.records.length, 2);
  assert.strictEqual(scan.records[1].offset, m1.length + garbage.length, 'recovered exactly at message 2');
  assert.strictEqual(scan.records[1].record.msg, 'false');
});

test('resilience: resync failure fails loudly naming offset and record count (R5-4)', () => {
  const m1 = buildMsg({ mcnt: 1, ueh: { msin: 0x41, argc: 1 }, payload: argBool(true, false) });
  const garbage = bytes([0xaa, 0xab, 0xac, 0xad, 0xae, 0xaf, 0xba, 0xbb, 0xbc, 0xbd, 0xbe, 0xbf, 0xca, 0xcb, 0xcc, 0xcd, 0xce, 0xcf, 0xda, 0xdb]);
  assert.throws(() => DLT.dltScanMessages(cat(m1, garbage)), (e) => {
    assert.match(e.message, /byte (\d+)/);
    assert.match(e.message, /\(1 records indexed\)/);
    assert.strictEqual(Number(RegExp.lastMatch !== null), 1);
    return true;
  });
});

test('resilience: mid-file implausible framing plus truncated tail count exactly 2 warnings (AC-E.2)', () => {
  const m1 = buildMsg({ mcnt: 1, ueh: { msin: 0x41, argc: 1 }, payload: argBool(true, false) });
  const bad = buildMsg({ mcnt: 2, tmsp: 5, len: 1, payload: bytes([0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x11, 0x22]) });
  const m3 = buildMsg({ mcnt: 3, ueh: { msin: 0x41, argc: 1 }, payload: argBool(false, false) });
  const full = buildMsg({ mcnt: 4, ueh: { msin: 0x30, argc: 0 }, payload: bytes([1, 2, 3, 4]) });
  const cut = full.subarray(0, full.length - 2);
  const scan = DLT.dltScanMessages(cat(m1, bad, m3, cut));
  assert.strictEqual(scan.warnings, 2);
  assert.strictEqual(scan.records.length, 3, 'msg1, msg3, and the truncated tail');
});

test('resilience: decoding twice is deterministic (R5-6)', () => {
  const m1 = buildMsg({ storage: { ecu: 'E', sec: 5, micros: 7 }, msbf: true, mcnt: 1, ueh: { msin: 0x41, argc: 1 }, payload: argStr('x', true, true) });
  const a = DLT.dltScanMessages(m1);
  const b = DLT.dltScanMessages(m1);
  assert.deepStrictEqual(a, b);
});

// --- AC-E.6 header-only shapes ----------------------------------------------

test('empty: a zero-byte capture scans to zero records with no warnings', () => {
  assert.deepStrictEqual(DLT.dltScanMessages(new Uint8Array(0)), { records: [], warnings: 0 });
});

test('empty: a bare 16-byte storage header is a clean empty capture (AC-E.6)', () => {
  const buf = bytes([0x44, 0x4c, 0x54, 0x01, 0x45, 0x43, 0x55, 0x31, 0, 0, 0, 0, 0, 0, 0, 0]);
  const scan = DLT.dltScanMessages(buf);
  assert.strictEqual(scan.records.length, 0);
  assert.strictEqual(scan.warnings, 0);
});

test('empty: a lone self-consistent standard header completes as framing (AC-E.6)', () => {
  const buf = buildMsg({ mcnt: 1, tmsp: 100 }); // declared length == header size
  const scan = DLT.dltScanMessages(buf);
  assert.strictEqual(scan.records.length, 0);
  assert.strictEqual(scan.warnings, 0);
  const m = DLT.dltDecodeMessage(buf);
  assert.strictEqual(m.record, null);
  assert.strictEqual(m.warnings, 0);
});

// --- mixed shapes and timestamps (AC-E.9, R2-3, R2-4, R3-3) ------------------

test('mixed: storage-header and headerless messages share one capture without spurious warnings', () => {
  const a = buildMsg({ storage: { ecu: 'ECU1', sec: 1577840461, micros: 234567 }, mcnt: 1, ueh: { msin: 0x41, argc: 1 }, payload: argBool(true, false) });
  const b = buildMsg({ mcnt: 2, ueh: { msin: 0x41, argc: 1 }, payload: argBool(false, false) });
  const c = buildMsg({ storage: { ecu: 'ECU1', sec: 1577840521, micros: 999999 }, mcnt: 3, ueh: { msin: 0x41, argc: 1 }, payload: argBool(true, false) });
  const d = buildMsg({ mcnt: 4, ueh: { msin: 0x41, argc: 1 }, payload: argBool(false, false) });
  const buf = cat(a, b, c, d);
  const scan = DLT.dltScanMessages(buf);
  assert.strictEqual(scan.warnings, 0);
  assert.strictEqual(scan.records.length, 4);
  assert.strictEqual(scan.records[0].offset, 0);
  assert.strictEqual(scan.records[1].offset, a.length, 'headerless record offset is its standard header');
  assert.strictEqual(scan.records[0].record.ts, '01-01 01:01:01.234');
  assert.strictEqual(scan.records[1].record.ts, null, 'timestamp-less records carry no ts of their own');
  assert.strictEqual(scan.records[2].record.ts, '01-01 01:02:01.999');
  assert.strictEqual(scan.records[3].record.ts, null);
});

test('timestamps: epoch seconds + microseconds normalize to year-less UTC-naive text', () => {
  assert.strictEqual(DLT.dltEpochToTimeText(1577836800, 0), '01-01 00:00:00.000');
  assert.strictEqual(DLT.dltEpochToTimeText(1577840461, 234567), '01-01 01:01:01.234');
  assert.strictEqual(DLT.dltEpochToTimeText(1577840521, 999999), '01-01 01:02:01.999', 'microseconds truncate to milliseconds');
});

test('timestamps: rendered ts round-trips through the timeKey/timeText model', () => {
  const ts = DLT.dltEpochToTimeText(1577840461, 234567);
  assert.strictEqual(paged.timeText(paged.timeKey(ts)), ts);
});

test('timestamps: the TMSP relative counter never becomes a time-column source', () => {
  const withTmspOnly = buildMsg({ mcnt: 1, tmsp: 987654321, ueh: { msin: 0x41, argc: 1 }, payload: argBool(true, false) });
  assert.strictEqual(DLT.dltDecodeMessage(withTmspOnly).record.ts, null);
});

// --- committed hex fixtures (lzma*.hex precedent) ----------------------------

test('fixture: dlt-binary-sample.hex decodes to the pinned rendered lines', () => {
  const buf = hexFile('dlt-binary-sample.hex');
  assert.strictEqual(DLT.dltSniff(buf, buf.length).binary, true);
  const scan = DLT.dltScanMessages(buf);
  assert.strictEqual(scan.warnings, 0);
  const expected = fs.readFileSync(path.join(FX, 'dlt-binary-sample-expected.txt'), 'utf8').replace(/\r\n/g, '\n').replace(/\n$/, '');
  assert.strictEqual(scan.records.map((r) => r.line).join('\n'), expected);
  assert.strictEqual(scan.records[0].record.msg, '4097 3.5 hello world');
  assert.strictEqual(scan.records[2].record.msg, 'hex 01ff10');
});

test('fixture: dlt-binary-nostorage.hex decodes without storage-header leakage', () => {
  const buf = hexFile('dlt-binary-nostorage.hex');
  assert.deepStrictEqual(DLT.dltSniff(buf, buf.length), { binary: true, storageHeader: false });
  const scan = DLT.dltScanMessages(buf);
  assert.strictEqual(scan.warnings, 0);
  const expected = fs.readFileSync(path.join(FX, 'dlt-binary-nostorage-expected.txt'), 'utf8').replace(/\r\n/g, '\n').replace(/\n$/, '');
  assert.strictEqual(scan.records.map((r) => r.line).join('\n'), expected);
  for (const rec of scan.records) assert.strictEqual(rec.record.ts, null);
  assert.ok(!scan.records[0].line.includes('DLT'), 'no storage magic leaks into rendered lines');
});
