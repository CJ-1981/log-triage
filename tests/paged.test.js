'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const LT = require('../src/paged.js');
const DLT = require('../src/decode-dlt.js');
const parser = require('../src/parser.js');

const FX = path.join(__dirname, 'fixtures');
const hexFile = (f) => new Uint8Array(Buffer.from(fs.readFileSync(path.join(FX, f), 'utf8').trim(), 'hex'));
const expectedLines = (f) => fs.readFileSync(path.join(FX, f), 'utf8').replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');

const LOGCAT = [
  '09-11 22:14:01.100  1000  2000 I VHal: line one',
  '09-11 22:14:01.200  1000  2000 W VHal: line two',
  '09-11 22:14:01.300  1000  2000 E VHal: line three',
  'unparseable line without structure',
  '09-11 22:14:02.500  1000  2000 D VHal: line five',
];

function makeFile(text) {
  return new Blob([text]);
}

test('timeKey and timeText round-trip a normalized timestamp', () => {
  const key = LT.timeKey('09-11 22:14:01.123');
  assert.strictEqual(key, 911221401123);
  assert.strictEqual(LT.timeText(key), '09-11 22:14:01.123');
  assert.strictEqual(LT.timeKey(null), 0);
  assert.strictEqual(LT.timeText(0), '00-00 00:00:00.000');
});

test('Column stores values across internal block boundaries', () => {
  const col = new LT.Column(Uint8Array);
  for (let i = 0; i < 70003; i++) col.push(i % 256);
  assert.strictEqual(col.length, 70003);
  assert.strictEqual(col.get(0), 0);
  assert.strictEqual(col.get(65535), 65535 % 256);
  assert.strictEqual(col.get(65536), 65536 % 256);
  assert.strictEqual(col.get(70002), 70002 % 256);
});

test('byteLines splits LF, strips CR, reports offsets and final unterminated line', async () => {
  const file = makeFile('alpha\r\nbeta\ngamma'); // no trailing newline
  const lines = [];
  for await (const l of LT.byteLines(file)) lines.push(l);
  assert.deepStrictEqual(lines.map((l) => l.raw), ['alpha', 'beta', 'gamma']);
  assert.deepStrictEqual(lines.map((l) => l.offset), [0, 7, 12]);
});

test('byteLines keeps one logical line across the 1 MB chunk boundary', async () => {
  const pad = 'x'.repeat(1024 * 1024 - 5);
  const text = pad + 'A' + '\n' + 'tail-line\n'; // the LF of line 1 sits at chunk edge
  const file = makeFile(text);
  const lines = [];
  for await (const l of LT.byteLines(file)) lines.push(l);
  assert.strictEqual(lines.length, 2);
  assert.strictEqual(lines[0].raw.length, 1024 * 1024 - 4);
  assert.ok(lines[0].raw.endsWith('A'));
  assert.strictEqual(lines[1].raw, 'tail-line');
});

test('byteLines reports progress and honors cancellation', async () => {
  // 2 MB of short lines → two 1 MB chunks; progress fires at each chunk end
  const total = 1024 * 1024; // lines
  const file = makeFile('x\n'.repeat(total));
  let progressBytes = 0;
  let calls = 0;
  let seen = 0;
  for await (const l of LT.byteLines(file, (b) => { progressBytes = b; calls++; }, () => calls >= 1)) {
    seen++;
    if (seen > total) break;
  }
  assert.ok(calls >= 1, 'progress callback ran');
  assert.ok(progressBytes > 0, 'progress reported in bytes');
  assert.ok(seen < total, 'cancellation stopped the stream early: ' + seen);
});

test('PagedLog.index detects format, tallies levels, keeps head+tail sample', async () => {
  // 400 identical filler lines + 5 distinctive lines, sampleLimit 100:
  // head sample (50) + tail ring (50) must include the LAST line and the
  // distinctive late lines, proving no first-N-only bias
  const filler = [];
  for (let i = 0; i < 400; i++) filler.push('09-11 22:10:00.000  1  2 I Fill: filler ' + i);
  const text = LOGCAT.concat(filler).join('\n') + '\n';
  const log = new LT.PagedLog(makeFile(text), 'f1', 0);
  const sample = await log.index(null, null, 100);
  assert.strictEqual(log.format, 'logcat');
  assert.strictEqual(log.count, 405);
  assert.strictEqual(log.counts.I, 401);
  assert.strictEqual(log.counts.W, 1);
  assert.strictEqual(log.counts.E, 1);
  assert.strictEqual(log.counts.D, 1);
  assert.strictEqual(log.counts.null, 1);
  assert.strictEqual(log.maxLength, Math.max(...text.split('\n').map((l) => l.length)));
  assert.ok(log.firstLine.startsWith('09-11'), 'firstLine captured');
  assert.strictEqual(sample.length, 100, 'sample bounded by sampleLimit');
  const lineNos = new Set(sample.map((r) => r.lineNo));
  assert.ok(lineNos.has(1), 'head line present');
  assert.ok(lineNos.has(405), 'newest line present: head+tail sample');
  assert.ok(lineNos.has(2), 'distinctive early line present');
  assert.ok(!lineNos.has(203), 'middle filler outside the sample budget');
  // metadata decodes the packed level/ts columns
  const meta = log.metadata(0);
  assert.strictEqual(meta.level, 'I');
  assert.strictEqual(meta.ts, '09-11 22:14:01.100');
  assert.strictEqual(log.metadata(3).level, null);
  const rec = log.record(0);
  assert.strictEqual(rec.fileId, 'f1');
  assert.strictEqual(rec.lineNo, 1);
  assert.strictEqual(rec.seq, 1);
});

test('PagedLog pages raw lines on demand and caches blocks', async () => {
  const lines = [];
  for (let i = 1; i <= 600; i++) lines.push('09-11 22:14:' + String(Math.floor(i / 60)).padStart(2, '0') + '.' + String(i % 60).padStart(3, '0') + '  1  2 I T: body ' + i);
  const file = makeFile(lines.join('\n') + '\n');
  const log = new LT.PagedLog(file, 'fx', 0);
  await log.index(null, null, 10);
  assert.strictEqual(log.count, 600);
  const page0 = await log.page(0);
  assert.strictEqual(page0.length, 256);
  assert.strictEqual(page0[0].raw, lines[0]);
  assert.strictEqual(page0[255].raw, lines[255]);
  const page2 = await log.page(2); // 600 - 512 = 88 rows
  assert.strictEqual(page2.length, 88);
  assert.strictEqual(page2[87].raw, lines[599]);
  assert.deepStrictEqual(await log.page(9), [], 'empty block returns no rows');
  const rec = await log.get(299);
  assert.strictEqual(rec.raw, lines[299]);
  assert.strictEqual(rec.lineNo, 300);
  assert.strictEqual(await log.get(600), null, 'out-of-range get');
  // second fetch of block 0 hits the cache (same content object identity)
  assert.strictEqual(await log.page(0), page0);
  // a source that shrinks behind the index must surface a readable error
  const log2 = new LT.PagedLog(file, 'fy', 0);
  await log2.index(null, null, 10);
  log2.file = file.slice(0, 40);
  await assert.rejects(() => log2.page(0), /changed|could not be read/i);
});

test('sortIds orders by comparator and reports cancellation', async () => {
  const ids = new Float64Array([5, 3, 9000, 1, 3]);
  const sorted = await LT.sortIds(ids, (a, b) => a - b, () => false);
  assert.deepStrictEqual(Array.from(sorted), [1, 3, 3, 5, 9000]);
  const cancelled = await LT.sortIds(new Float64Array([2, 1]), (a, b) => a - b, () => true);
  assert.strictEqual(cancelled, null, 'cancelled sort returns null');
  const empty = await LT.sortIds(new Float64Array(0), (a, b) => a - b, () => false);
  assert.strictEqual(empty.length, 0);
});

test('PagedLog.index pins BOM handling and flags non-UTF-8 files', async () => {
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  const text = LOGCAT.join('\n') + '\n';
  const log = new LT.PagedLog(new Blob([bom, text]), 'f1', 0);
  await log.index(null, null, 10);
  assert.strictEqual(log.utf8, true, 'clean utf-8 (with BOM) flagged utf8');
  assert.strictEqual(log.format, 'logcat', 'BOM does not disturb detection');
  const rec0 = await log.get(0);
  assert.ok(!rec0.raw.startsWith('\uFEFF'), 'no BOM char in first record');
  assert.strictEqual(rec0.ts, '09-11 22:14:01.100', 'first line parses despite BOM');
  assert.ok(!log.firstLine.startsWith('\uFEFF'), 'firstLine has no BOM');
  // a latin-1 byte (0xE9) is invalid utf-8
  const bad = new Blob([Buffer.from('09-11 22:14:01.100  1  2 I T: caf\xe9 broken\n09-11 22:14:02.100  1  2 I T: ok\n', 'latin1')]);
  const log2 = new LT.PagedLog(bad, 'f2', 0);
  await log2.index(null, null, 10);
  assert.strictEqual(log2.utf8, false, 'invalid utf-8 flagged false');
  assert.strictEqual(log2.count, 2, 'lines still split and counted');
});

// --- binary DLT captures (SPEC-DLT-BINARY-001 integration) ------------------

const enc = (s) => new TextEncoder().encode(s);
const cat = (...xs) => {
  const n = xs.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(n);
  let p = 0;
  for (const a of xs) { out.set(a, p); p += a.length; }
  return out;
};
const bts = (arr) => new Uint8Array(arr);
const ascii4 = (s) => { const out = new Uint8Array(4); out.set(enc(String(s)).slice(0, 4)); return out; };
const u16 = (v, msbf) => bts(msbf ? [(v >> 8) & 255, v & 255] : [v & 255, (v >> 8) & 255]);
const u32 = (v, msbf) => {
  const b = [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
  return msbf ? bts(b) : bts(b.reverse());
};
const i32 = (v, msbf) => u32(v < 0 ? v + 4294967296 : v, msbf);

/* DLT v1 message builder (same wire layout as tests/decode-dlt.test.js). */
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
  let h = cat(bts([htyp, o.mcnt || 0]), u16(len, msbf));
  if (o.stdEcu) h = cat(h, ascii4(o.stdEcu));
  if (o.session != null) h = cat(h, u32(o.session, msbf));
  if (o.tmsp != null) h = cat(h, u32(o.tmsp, msbf));
  if (o.ueh) h = cat(h, bts([o.ueh.msin, o.ueh.argc || 0]), ascii4(o.ueh.apid || ''), ascii4(o.ueh.ctid || ''));
  const body = cat(h, payload);
  if (!o.storage) return body;
  return cat(bts([0x44, 0x4c, 0x54, 0x01]), ascii4(o.storage.ecu), u32(o.storage.sec, msbf), i32(o.storage.micros, msbf), body);
}
const argStr = (s, msbf) => {
  const withNul = cat(enc(s), bts([0])); // DLT string length includes the terminating NUL
  return cat(u32(0x200 | 0x8000, msbf), u16(withNul.length, msbf), withNul);
};

test('binary capture: storage fixture indexes as dlt-binary with offsets at message starts (AC-1.1, AC-2.2, AC-2.6)', async () => {
  const buf = hexFile('dlt-binary-sample.hex');
  const expected = expectedLines('dlt-binary-sample-expected.txt');
  const log = new LT.PagedLog(new Blob([buf]), 'b1', 0);
  const sample = await log.index(null, null, 100);
  assert.strictEqual(log.format, 'dlt-binary');
  assert.strictEqual(log.count, 5);
  assert.strictEqual(log.utf8, true, 'classification pins the strict UTF-8 head flag true');
  assert.strictEqual(log.storageHeader, true, 'storage-header presence recorded (R1-5)');
  assert.strictEqual(log.warnings, 0);
  assert.strictEqual(log.firstLine, expected[0]);
  // the analysis sample is decoded message lines in the text-path shape
  assert.deepStrictEqual(sample.map((r) => r.raw), expected);
  for (const r of sample) {
    for (const k of ['fileId', 'file', 'lineNo', 'seq', 'raw', 'ts', 'level', 'tag', 'pid', 'msg']) assert.ok(k in r, 'record shape carries ' + k);
  }
  assert.strictEqual(sample[0].ts, '01-01 00:00:00.000');
  assert.strictEqual(sample[0].level, 'I');
  assert.strictEqual(sample[0].tag, 'APP1:CTX1');
  assert.strictEqual(sample[0].pid, '1234');
  // offsets land on message starts and match the reference scan exactly
  const offs = [];
  for (let i = 0; i < log.count; i++) offs.push(log.offsets.get(i));
  assert.strictEqual(offs[0], 0, 'first message starts at the storage header');
  assert.deepStrictEqual(offs, DLT.dltScanMessages(buf).records.map((r) => r.offset), 'offsets match dltScanMessages');
  // slicing at consecutive offsets reproduces exactly those records
  const resliced = offs.map((o, i) => DLT.dltDecodeMessage(buf.subarray(o, i + 1 < offs.length ? offs[i + 1] : buf.length)).line);
  assert.deepStrictEqual(resliced, expected, 'offset slices re-decode to the same lines');
  // metadata decodes the packed times/levels columns
  assert.deepStrictEqual(log.metadata(0), { ts: '01-01 00:00:00.000', level: 'I' });
  assert.deepStrictEqual(log.counts, { I: 2, E: 1, W: 1, D: 1 });
});

test('binary capture: page re-decode equals index-time lines, bounded per page (AC-3.1, AC-3.2, AC-5.6)', async () => {
  const parts = [];
  for (let i = 1; i <= 300; i++) parts.push(buildMsg({ msbf: true, mcnt: i % 256, ueh: { msin: 0x41, argc: 1, apid: 'APP', ctid: 'CTX' }, payload: argStr('body ' + i, true) }));
  const buf = cat(...parts);
  const expected = DLT.dltScanMessages(buf).records.map((r) => r.line);
  assert.strictEqual(expected.length, 300);
  const log = new LT.PagedLog(new Blob([buf]), 'b2', 0);
  await log.index(null, null, 10);
  assert.strictEqual(log.count, 300);
  const page0 = await log.page(0);
  assert.strictEqual(page0.length, 256);
  assert.deepStrictEqual(page0.map((r) => r.raw), expected.slice(0, 256), 'page 0 re-decodes only its own records');
  const page1 = await log.page(1);
  assert.strictEqual(page1.length, 44);
  assert.deepStrictEqual(page1.map((r) => r.raw), expected.slice(256), 'page 1 re-decodes its tail records');
  assert.deepStrictEqual(await log.page(3), [], 'empty block returns no rows');
  const rec = await log.get(299);
  assert.strictEqual(rec.raw, expected[299]);
  assert.strictEqual(rec.lineNo, 300);
  // re-decode after the cache hold is byte-identical (determinism, R5-6)
  const again = await log.page(0);
  assert.deepStrictEqual(again.map((r) => r.raw), expected.slice(0, 256));
});

test('binary capture: headerless fixture starts offsets at zero with no storage leakage (AC-E.1)', async () => {
  const buf = hexFile('dlt-binary-nostorage.hex');
  const expected = expectedLines('dlt-binary-nostorage-expected.txt');
  const log = new LT.PagedLog(new Blob([buf]), 'b3', 0);
  const sample = await log.index(null, null, 50);
  assert.strictEqual(log.format, 'dlt-binary');
  assert.strictEqual(log.storageHeader, false);
  assert.strictEqual(log.offsets.get(0), 0, 'record iterator starts at offset 0');
  assert.deepStrictEqual(sample.map((r) => r.raw), expected);
  assert.deepStrictEqual((await log.page(0)).map((r) => r.raw), expected);
  for (const r of sample) assert.strictEqual(r.ts, null, 'no storage-header timestamps in the headerless fixture');
});

test('binary capture: mixed storage-header and headerless records share one capture (AC-E.9, R2-4)', async () => {
  const a = buildMsg({ storage: { ecu: 'ECU1', sec: 1577840461, micros: 234567 }, mcnt: 1, ueh: { msin: 0x41, argc: 1 }, payload: argStr('one', false) });
  const b = buildMsg({ mcnt: 2, ueh: { msin: 0x41, argc: 1 }, payload: argStr('two', false) });
  const c = buildMsg({ storage: { ecu: 'ECU1', sec: 1577840521, micros: 999999 }, mcnt: 3, ueh: { msin: 0x41, argc: 1 }, payload: argStr('three', false) });
  const d = buildMsg({ mcnt: 4, ueh: { msin: 0x41, argc: 1 }, payload: argStr('four', false) });
  const buf = cat(a, b, c, d);
  const log = new LT.PagedLog(new Blob([buf]), 'b4', 0);
  await log.index(null, null, 10);
  assert.strictEqual(log.count, 4);
  assert.strictEqual(log.warnings, 0, 'no spurious resynchronization warnings');
  // each offset lands on that record's message start; storage headers frame
  assert.deepStrictEqual([0, 1, 2, 3].map((i) => log.offsets.get(i)), [0, a.length, a.length + b.length, a.length + b.length + c.length]);
  // storage timestamps apply where present; the others carry forward (R2-4)
  assert.strictEqual(log.times.get(0), LT.timeKey('01-01 01:01:01.234'));
  assert.strictEqual(log.times.get(1), log.times.get(0), 'timestamp-less record carries the predecessor time key');
  assert.strictEqual(log.metadata(1).ts, null, 'carried record keeps the null-ts levels bit');
  assert.strictEqual(log.times.get(2), LT.timeKey('01-01 01:02:01.999'));
  assert.strictEqual(log.times.get(3), log.times.get(2));
  // page re-decode is identical to index-time rendering
  const rows = await log.page(0);
  assert.deepStrictEqual(rows.map((r) => r.raw), DLT.dltScanMessages(buf).records.map((r) => r.line));
  for (const r of rows) assert.ok(!r.raw.includes('DLT'), 'no magic bytes leak into rendered lines');
});

test('binary capture: mid-file resync plus truncated tail counts exactly two warnings (AC-E.2, AC-5.1, AC-5.2)', async () => {
  const m1 = buildMsg({ msbf: true, mcnt: 1, ueh: { msin: 0x41, argc: 1 }, payload: argStr('first', true) });
  const bad = buildMsg({ msbf: true, mcnt: 9, len: 5, ueh: { msin: 0x41, argc: 1 }, payload: argStr('xxjj', true) }); // declared length below the HTYP minimum
  const m2 = buildMsg({ msbf: true, mcnt: 2, ueh: { msin: 0x41, argc: 1 }, payload: argStr('second', true) });
  const whole = buildMsg({ msbf: true, mcnt: 3, ueh: { msin: 0x41, argc: 1 }, payload: argStr('tailpart', true) });
  const cut = whole.slice(0, whole.length - 8); // truncated final message at EOF
  const buf = cat(m1, bad, m2, cut);
  const log = new LT.PagedLog(new Blob([buf]), 'b5', 0);
  await log.index(null, null, 10);
  assert.strictEqual(log.format, 'dlt-binary');
  assert.strictEqual(log.warnings, 2, 'one resync warning plus one truncation warning');
  assert.strictEqual(log.count, 3, 'records before the corruption, the recovered record, and the partial tail');
  const rows = await log.page(0);
  assert.ok(rows[0].raw.includes('first'), 'records before the corruption are intact');
  assert.ok(rows[1].raw.includes('second'), 'resync recovered exactly at the next valid message');
  assert.ok(rows[2].raw.includes('hex'), 'truncated tail decodes as a partial record');
});

test('binary capture: exhausted resync fails loudly naming offset and record count (AC-5.4)', async () => {
  const m1 = buildMsg({ msbf: true, mcnt: 1, ueh: { msin: 0x41, argc: 1 }, payload: argStr('first', true) });
  const buf = cat(m1, bts(new Array(300).fill(0x41))); // 'A' run: never a plausible boundary
  const log = new LT.PagedLog(new Blob([buf]), 'b6', 0);
  await assert.rejects(() => log.index(null, null, 10), (e) => {
    assert.match(e.message, /no plausible DLT boundary found after byte \d+ \(1 records indexed\)/);
    return true;
  });
});

test('binary capture: empty shapes index cleanly with zero records (AC-E.6)', async () => {
  const empty = new LT.PagedLog(new Blob([]), 'e1', 0);
  await empty.index(null, null, 10);
  assert.strictEqual(empty.count, 0);
  const bare = new LT.PagedLog(new Blob([bts([0x44, 0x4c, 0x54, 0x01, 0x45, 0x43, 0x55, 0x31, 0, 0, 0, 0, 0, 0, 0, 0])]), 'e2', 0);
  await bare.index(null, null, 10);
  assert.strictEqual(bare.format, 'dlt-binary');
  assert.strictEqual(bare.count, 0, 'a bare storage header is a clean empty capture');
  assert.strictEqual(bare.warnings, 0, 'no resync failure for the header-only tail');
  const lone = new LT.PagedLog(new Blob([buildMsg({ mcnt: 1, ueh: { msin: 0x01, argc: 0 }, apid: 'APP1', ctid: 'CTX1' })]), 'e3', 0);
  await lone.index(null, null, 10);
  assert.strictEqual(lone.format, 'dlt-binary');
  assert.strictEqual(lone.count, 0, 'a lone self-consistent header completes as framing');
  assert.strictEqual(lone.warnings, 0, 'an empty message is not a record and not a warning');
});

test('detection: a 16 KiB logcat-style head never classifies dlt-binary (AC-1.3, R1-2)', async () => {
  const lines = [];
  let size = 0;
  for (let i = 0; size < 16384; i++) {
    const line = '09-11 22:14:01.100  1000  2000 I VHal: filler ' + i;
    lines.push(line);
    size += line.length + 1;
  }
  const log = new LT.PagedLog(new Blob([lines.join('\n')]), 't1', 0);
  await log.index(null, null, 10);
  assert.strictEqual(log.format, 'logcat', 'the text scorer wins over the version-bit false positive');
  assert.notStrictEqual(log.format, 'dlt-binary');
  assert.strictEqual(log.count, lines.length);
});

test('detection: DLTv2 magic 44 4C 54 02 routes to the text path as plain (AC-1.6)', async () => {
  const buf = cat(bts([0x44, 0x4c, 0x54, 0x02]), enc('\nsecond line\n'));
  const log = new LT.PagedLog(new Blob([buf]), 't2', 0);
  await log.index(null, null, 10);
  assert.notStrictEqual(log.format, 'dlt-binary', 'the magic check is version-exact');
  assert.strictEqual(log.format, 'plain');
  assert.strictEqual(log.count, 2, 'routed to the text path without a decode error');
});

test('detection: the dlt text export still detects dlt, never dlt-binary (R1-3)', async () => {
  const log = new LT.PagedLog(new Blob([fs.readFileSync(path.join(FX, 'dlt-viewer-sample.txt'))]), 't3', 0);
  await log.index(null, null, 10);
  assert.strictEqual(log.format, 'dlt');
  assert.strictEqual(log.count, 42);
});

test('binary capture: classification pins utf8 true even for non-UTF-8 bytes (R1-1)', async () => {
  // 0xFF/0xFE in the payload fail strict UTF-8 validation, yet a positive
  // dlt-binary classification must pin the head flag true (no enc? badge).
  const buf = buildMsg({ storage: { ecu: 'ECU1', sec: 1577840461, micros: 0 }, mcnt: 1, ueh: { msin: 0x41, argc: 1 }, payload: cat(argStr('ok', true), bts([0xff, 0xfe])) });
  const log = new LT.PagedLog(new Blob([buf]), 'b7', 0);
  await log.index(null, null, 10);
  assert.strictEqual(log.format, 'dlt-binary');
  assert.strictEqual(log.utf8, true, 'binary rendered text comes from the decoder, not TextDecoder');
  assert.strictEqual(log.count, 1);
});

test('recordLines: one format-agnostic iterator for text and binary raw scans (R3-2)', async () => {
  const text = makeFile(LOGCAT.join('\n'));
  const textLog = new LT.PagedLog(text, 'r1', 0);
  await textLog.index(null, null, 10);
  const viaRecordLines = [];
  for await (const line of textLog.recordLines(null, null)) viaRecordLines.push(line);
  const viaByteLines = [];
  for await (const line of LT.byteLines(text)) viaByteLines.push(line);
  assert.deepStrictEqual(viaRecordLines, viaByteLines, 'text formats keep the byteLines stream');
  const buf = hexFile('dlt-binary-sample.hex');
  const expected = expectedLines('dlt-binary-sample-expected.txt');
  const log = new LT.PagedLog(new Blob([buf]), 'r2', 0);
  await log.index(null, null, 10);
  const scanned = [];
  for await (const line of log.recordLines(null, null)) scanned.push(line);
  assert.deepStrictEqual(scanned.map((l) => l.raw), expected, 'binary scans iterate decoded records');
  assert.deepStrictEqual(scanned.map((l) => l.offset), DLT.dltScanMessages(buf).records.map((r) => r.offset), 'binary scans iterate in record index space');
  assert.strictEqual(scanned[0].record.msg, '4097 3.5 hello world');
  // a cancellation callback that is already true stops the stream without throwing
  let seen = 0;
  for await (const line of log.recordLines(null, () => true)) { seen++; break; }
  assert.ok(seen <= 1, 'cancellation honored');
});

test('parser: a dlt-binary re-parse degrades to null fields, never the dlt text regex', () => {
  const rec = parser.parseLine('hex deadbeef', 'dlt-binary');
  assert.strictEqual(rec.ts, null, 'no hallucinated ts for a hex-dump line');
  assert.strictEqual(rec.level, null, 'no hallucinated level');
  assert.strictEqual(rec.tag, null);
  assert.strictEqual(rec.pid, null);
  assert.strictEqual(rec.msg, 'hex deadbeef');
});

test('binary capture: a message straddling the 1 MiB read chunk indexes intact (R2-5)', async () => {
  // DLT's u16 total-length field caps a message at 64 KiB, so spanning is
  // produced by position: 37435 x 28-byte messages land the next message
  // (408 bytes) across the iterator's 1 MiB chunk boundary.
  const filler = buildMsg({ mcnt: 1, ueh: { msin: 0x01, argc: 1, apid: 'APP', ctid: 'CTX' }, payload: argStr('tick000') });
  assert.strictEqual(filler.length, 28);
  const parts = [];
  for (let i = 0; i < 37435; i++) parts.push(filler);
  const span = buildMsg({ mcnt: 2, ueh: { msin: 0x01, argc: 2, apid: 'APP', ctid: 'CTX' }, payload: cat(argStr('y'.repeat(160)), argStr('z'.repeat(220))) });
  assert.strictEqual(span.length, 408);
  assert.ok(1048180 < 1024 * 1024 && 1048180 + 408 > 1024 * 1024, 'the span message crosses the chunk boundary');
  parts.push(span, buildMsg({ mcnt: 3, ueh: { msin: 0x01, argc: 1, apid: 'APP', ctid: 'CTX' }, payload: argStr('after') }));
  const progress = [];
  const log = new LT.PagedLog(new Blob([cat(...parts)]), 'big', 0);
  await log.index((bytes) => progress.push(bytes), null, 10);
  assert.strictEqual(log.count, 37437, 'the spanning message decodes exactly once');
  assert.ok(progress.length > 0, 'byte progress reported from the chunk reader');
  // offsets stay absolute file positions across the chunk-boundary prefix drop
  const buf = cat(...parts);
  const scan = DLT.dltScanMessages(buf);
  assert.strictEqual(scan.records.length, 37437);
  for (const i of [0, 1, 37434, 37435, 37436]) assert.strictEqual(log.offsets.get(i), scan.records[i].offset, 'offset ' + i + ' is the absolute message start');
  const last = await log.get(log.count - 1);
  assert.match(last.raw, /after/);
  const spanRow = await log.get(37435);
  assert.ok(spanRow.raw.includes('y'.repeat(160)), 'the straddling record renders complete');
  assert.ok(spanRow.raw.includes('z'.repeat(220)), 'both args survive the boundary merge');
});

test('binary capture: indexing trips the 8 ms deadline pause and still counts every record', async () => {
  const parts = [];
  for (let i = 0; i < 30000; i++) parts.push(buildMsg({ mcnt: i % 256, ueh: { msin: 0x01, argc: 1, apid: 'APP', ctid: 'CTX' }, payload: argStr('tick ' + i) }));
  const log = new LT.PagedLog(new Blob([cat(...parts)]), 'many', 0);
  await log.index(null, null, 10);
  assert.strictEqual(log.count, 30000);
});

test('binary capture: a pre-cancelled index() throws Cancelled after the aborted scan (R2-4)', async () => {
  const log = new LT.PagedLog(new Blob([hexFile('dlt-binary-nostorage.hex')]), 'cx', 0);
  await assert.rejects(log.index(null, () => true, 10), /^Error: Cancelled$/);
});

test('detection: a headerless capture whose payload renders logcat text is vetoed to text (R1-2, R1-4)', async () => {
  // one verbose message whose string arg begins with LF so the decoded head is
  // one junk header line + nine clean logcat lines -> confidence 0.9 >= 0.5
  const line = '09-11 22:14:01.100  1000  2000 I VHal: boot stage';
  const text = '\n' + new Array(9).fill(line).join('\n') + '\n';
  const msg = buildMsg({ mcnt: 1, ueh: { msin: 0x01, argc: 1, apid: 'APP', ctid: 'CTX' }, payload: argStr(text) });
  const log = new LT.PagedLog(new Blob([msg]), 'veto', 0);
  await log.index(null, null, 10);
  assert.strictEqual(log.format, 'logcat', 'the text scorer wins over the decode-complete sniff');
  assert.strictEqual(log.count, 11, 'junk header line + nine logcat lines + the NUL tail line index as text');
  assert.strictEqual(log.storageHeader, false);
});

test('binary page: a corrupted offset falls back to an empty record without throwing', async () => {
  const log = new LT.PagedLog(new Blob([hexFile('dlt-binary-sample.hex')]), 'cor', 0);
  await log.index(null, null, 100);
  assert.strictEqual(log.count, 5);
  log.offsets.blocks[0][2] = 5; // mid storage header of record 1: implausible at page time
  const rows = await log.page(0);
  assert.strictEqual(rows.length, 5);
  assert.strictEqual(rows[2].raw, '', 'an undecodable window degrades to an empty line');
  assert.strictEqual(rows[2].msg, '');
  assert.strictEqual(rows[2].ts, null);
  assert.match(rows[0].raw, /hello world/, 'neighbouring rows still decode');
});

test('binary capture: a truncated declared length with an embedded boundary resyncs at EOF (R5-2)', async () => {
  // msg1 (30 B) + msg2 declared 80 B but only 74 B present, with a complete
  // msg3 embedded after 10 B of the dead span + a 2 B framing tail.
  const msg1 = buildMsg({ mcnt: 1, ueh: { msin: 0x01, argc: 1, apid: 'APP', ctid: 'CTX' }, payload: argStr('alpha') });
  const dead = buildMsg({ mcnt: 2, ueh: { msin: 0x01, argc: 1, apid: 'APP', ctid: 'CTX' }, payload: argStr('bravo'), len: 80 });
  const junk = new Uint8Array(10);
  const msg3 = buildMsg({ mcnt: 3, ueh: { msin: 0x01, argc: 1, apid: 'APP', ctid: 'CTX' }, payload: argStr('charlie') });
  const tail = new Uint8Array(2);
  const buf = cat(msg1, dead, junk, msg3, tail);
  const log = new LT.PagedLog(new Blob([buf]), 'res', 0);
  await log.index(null, null, 10);
  assert.strictEqual(log.format, 'dlt-binary');
  assert.strictEqual(log.count, 2, 'msg1 and the resync target msg3 survive');
  assert.strictEqual(log.warnings, 2, 'decoder truncation warning + iterator resync warning');
  assert.strictEqual(log.warnings, DLT.dltScanMessages(buf).warnings, 'index parity with dltScanMessages (R5-6)');
  const rows = await log.page(0);
  assert.match(rows[0].raw, /alpha/);
  assert.match(rows[1].raw, /charlie/);
  assert.ok(!rows.some((r) => r.raw.includes('bravo')), 'the dead span contributed no record');
});

test('binary capture: a truncated framing-only tail is dropped silently (AC-E.6, R5-1)', async () => {
  const msg1 = buildMsg({ mcnt: 1, ueh: { msin: 0x01, argc: 1, apid: 'APP', ctid: 'CTX' }, payload: argStr('alpha') });
  const stub = buildMsg({ mcnt: 2, ueh: { msin: 0x01, argc: 0, apid: 'APP', ctid: 'CTX' }, len: 40 }); // real 18 B
  const log = new LT.PagedLog(new Blob([cat(msg1, stub)]), 'stub', 0);
  await log.index(null, null, 10);
  assert.strictEqual(log.count, 1, 'the truncated no-arg tail yields no record');
  assert.strictEqual(log.warnings, 1, 'the decoder still flags the truncation itself (R5-1)');
  assert.strictEqual(log.warnings, DLT.dltScanMessages(cat(msg1, stub)).warnings, 'index parity with dltScanMessages (R5-6)');
});
