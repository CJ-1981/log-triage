'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const LT = require('../src/paged.js');

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
