'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const ar = require('../src/archive.js');

const hasStreams = typeof DecompressionStream !== 'undefined';

test('detectArchiveType recognises supported formats', () => {
  assert.strictEqual(ar.detectArchiveType('app.log.gz'), 'gz');
  assert.strictEqual(ar.detectArchiveType('bundle.tar.gz'), 'tar.gz');
  assert.strictEqual(ar.detectArchiveType('bundle.tgz'), 'tar.gz');
  assert.strictEqual(ar.detectArchiveType('logs.tar'), 'tar');
  assert.strictEqual(ar.detectArchiveType('logs.zip'), 'zip');
  assert.strictEqual(ar.detectArchiveType('app.log'), null);
  assert.strictEqual(ar.detectArchiveType('file.bz2'), null);
});

test('writeTar + parseTar round-trip preserves entries', () => {
  const entries = [
    { name: 'app.log', data: new TextEncoder().encode('log line 1\nlog line 2\n') },
    { name: 'sys/syslog', data: new TextEncoder().encode('syslog content\n') },
  ];
  const tarBuf = ar.writeTar(entries);
  const parsed = ar.parseTar(tarBuf);
  assert.strictEqual(parsed.length, entries.length);
  for (let i = 0; i < entries.length; i++) {
    assert.strictEqual(parsed[i].name, entries[i].name);
    assert.deepStrictEqual(parsed[i].data, entries[i].data);
  }
});

test('parseTar handles 512-byte alignment padding', () => {
  const data = new TextEncoder().encode('x'.repeat(100));
  const tarBuf = ar.writeTar([{ name: 'test.log', data }]);
  const parsed = ar.parseTar(tarBuf);
  assert.strictEqual(parsed.length, 1);
  assert.strictEqual(parsed[0].data.length, 100);
});

test('parseTar returns [] for empty buffer', () => {
  assert.deepStrictEqual(ar.parseTar(new Uint8Array(1024)), []);
});

test('writeZipStored produces valid PK header and EOCD', () => {
  const entries = [
    { name: 'a.log', data: new TextEncoder().encode('content a\n') },
    { name: 'b.log', data: new TextEncoder().encode('content b\n') },
  ];
  const zipBuf = ar.writeZipStored(entries);
  assert.strictEqual(zipBuf[0], 0x50); // P
  assert.strictEqual(zipBuf[1], 0x4B); // K
  assert.ok(zipBuf.length > entries[0].data.length + entries[1].data.length, 'zip has headers + data');
});

test('crc32 produces known checksum', () => {
  assert.strictEqual(ar.crc32(new TextEncoder().encode('123456789')), 0xCBF43926);
});

test('extractArchive passes through non-archive files', async () => {
  const data = new TextEncoder().encode('plain text');
  const entries = await ar.extractArchive('app.log', data);
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].name, 'app.log');
});

// --- gzip round-trip (browser / Node 22 with DecompressionStream) ---

test('gzip round-trip', { skip: !hasStreams }, async () => {
  const original = new TextEncoder().encode('hello log world\nline two\n');
  const compressed = await ar.gzipData(original);
  assert.strictEqual(compressed[0], 0x1f, 'gzip magic byte 1');
  assert.strictEqual(compressed[1], 0x8b, 'gzip magic byte 2');
  const decompressed = await ar.gunzipData(compressed);
  assert.deepStrictEqual(decompressed, original);
});

test('extractArchive handles .gz containing a text file', { skip: !hasStreams }, async () => {
  const content = new TextEncoder().encode('compressed log line\n');
  const compressed = await ar.gzipData(content);
  const entries = await ar.extractArchive('app.log.gz', compressed);
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].name, 'app.log');
  assert.deepStrictEqual(entries[0].data, content);
});

test('buildArchive creates zip with stored entries', { skip: !hasStreams }, async () => {
  const entries = [
    { name: 'masked/demo.log', data: new TextEncoder().encode('masked content\n') },
    { name: 'masked/sys.log', data: new TextEncoder().encode('more masked\n') },
  ];
  const zipBuf = await ar.buildArchive(entries, 'zip');
  assert.strictEqual(zipBuf[0], 0x50); // P
  assert.strictEqual(zipBuf[1], 0x4B); // K
  assert.ok(zipBuf.length > 100, 'zip has content');
});

test('buildArchive creates tar.gz from entries', { skip: !hasStreams }, async () => {
  const entries = [{ name: 'log.txt', data: new TextEncoder().encode('content\n') }];
  const gzBuf = await ar.buildArchive(entries, 'tar.gz');
  assert.strictEqual(gzBuf[0], 0x1f); // gzip magic
  assert.strictEqual(gzBuf[1], 0x8b);
});

// --- zip extraction (FR-26): stored + deflate entries ---

test('extractArchive unpacks stored zip entries and recurses', { skip: !hasStreams }, async () => {
  const entries = [
    { name: 'a.log', data: new TextEncoder().encode('zip stored a\n') },
    { name: 'sub/b.log', data: new TextEncoder().encode('zip stored b\n') },
  ];
  const zipBuf = ar.writeZipStored(entries);
  const out = await ar.extractArchive('bundle.zip', zipBuf);
  assert.strictEqual(out.length, 2);
  assert.deepStrictEqual(out.map((e) => e.name).sort(), ['bundle/a.log', 'bundle/sub/b.log']);
  assert.strictEqual(new TextDecoder().decode(out.find((e) => e.name === 'bundle/a.log').data), 'zip stored a\n');
});

test('extractArchive unpacks deflate zip entries', { skip: !hasStreams }, async () => {
  const zlib = require('node:zlib');
  const enc = (s) => new TextEncoder().encode(s);
  const content = enc('deflate me, deflate me, deflate me\n'.repeat(10));
  const comp = zlib.deflateRawSync(content);
  const crc = ar.crc32(content);
  // hand-build a minimal zip: local header + data + central dir + EOCD (method 8)
  const nameB = enc('deflated.log');
  const parts = [];
  const lfh = new Uint8Array(30 + nameB.length);
  const lv = new DataView(lfh.buffer);
  lv.setUint32(0, 0x04034b50, true);
  lv.setUint16(4, 20, true);
  lv.setUint16(8, 0, true); // flags
  lv.setUint16(10, 8, true); // method deflate
  lv.setUint32(14, crc, true);
  lv.setUint32(18, comp.length, true);
  lv.setUint32(22, content.length, true);
  lv.setUint16(26, nameB.length, true);
  lfh.set(nameB, 30);
  parts.push(lfh, comp);
  const cd = new Uint8Array(46 + nameB.length);
  const cv = new DataView(cd.buffer);
  cv.setUint32(0, 0x02014b50, true);
  cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
  cv.setUint16(10, 8, true);
  cv.setUint32(16, crc, true);
  cv.setUint32(20, comp.length, true);
  cv.setUint32(24, content.length, true);
  cv.setUint16(28, nameB.length, true);
  cv.setUint32(42, 0, true);
  cd.set(nameB, 46);
  const cdOff = lfh.length + comp.length;
  parts.push(cd);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, 1, true);
  ev.setUint16(10, 1, true);
  ev.setUint32(12, cd.length, true);
  ev.setUint32(16, cdOff, true);
  parts.push(eocd);
  const total = parts.reduce((s, p) => s + p.length, 0);
  const zipBuf = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) { zipBuf.set(p, pos); pos += p.length; }

  const out = await ar.extractArchive('packed.zip', zipBuf);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].name, 'packed/deflated.log');
  assert.deepStrictEqual(out[0].data, content);
});

test('extractArchive rejects encrypted zip entries', { skip: !hasStreams }, async () => {
  const enc = (s) => new TextEncoder().encode(s);
  const nameB = enc('secret.log');
  const dataB = enc('cannot decrypt me');
  const parts = [];
  const lfh = new Uint8Array(30 + nameB.length);
  const lv = new DataView(lfh.buffer);
  lv.setUint32(0, 0x04034b50, true);
  lv.setUint16(4, 20, true);
  lv.setUint16(8, 1, true); // encrypted flag
  lv.setUint32(18, dataB.length, true);
  lv.setUint32(22, dataB.length, true);
  lv.setUint16(26, nameB.length, true);
  lfh.set(nameB, 30);
  parts.push(lfh, dataB);
  const cd = new Uint8Array(46 + nameB.length);
  const cv = new DataView(cd.buffer);
  cv.setUint32(0, 0x02014b50, true);
  cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
  cv.setUint16(8, 1, true); // encrypted flag in central dir too
  cv.setUint32(20, dataB.length, true);
  cv.setUint32(24, dataB.length, true);
  cv.setUint16(28, nameB.length, true);
  cv.setUint32(42, 0, true);
  cd.set(nameB, 46);
  parts.push(cd);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, 1, true);
  ev.setUint16(10, 1, true);
  ev.setUint32(16, lfh.length + dataB.length, true);
  parts.push(eocd);
  const total = parts.reduce((s, p) => s + p.length, 0);
  const zipBuf = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) { zipBuf.set(p, pos); pos += p.length; }

  await assert.rejects(() => ar.extractArchive('bad.zip', zipBuf), /encrypt/i);
});

test('extractArchive rejects a non-zip file named .zip', { skip: !hasStreams }, async () => {
  const notZip = new TextEncoder().encode('plain text with a zip extension');
  await assert.rejects(() => ar.extractArchive('fake.zip', notZip), /central directory|zip/i);
});

// minimal zip builder for reader edge cases (dirs, bad methods, zip64)
function craftZip(entries) {
  const enc = (s) => new TextEncoder().encode(s);
  const parts = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const nameB = enc(e.name);
    const dataB = e.data || new Uint8Array(0);
    const lfh = new Uint8Array(30 + nameB.length);
    const lv = new DataView(lfh.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(10, e.method || 0, true);
    lv.setUint32(18, dataB.length, true);
    lv.setUint32(22, dataB.length, true);
    lv.setUint16(26, nameB.length, true);
    lfh.set(nameB, 30);
    parts.push(lfh, dataB);
    central.push({ e, nameB, size: dataB.length, offset });
    offset += 30 + nameB.length + dataB.length;
  }
  const cdStart = offset;
  for (const c of central) {
    const cd = new Uint8Array(46 + c.nameB.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
    cv.setUint16(10, c.e.method || 0, true);
    cv.setUint32(16, ar.crc32(c.e.data || new Uint8Array(0)), true);
    cv.setUint32(20, c.e.zip64 ? 0xffffffff : c.size, true);
    cv.setUint32(24, c.e.zip64 ? 0xffffffff : c.size, true);
    cv.setUint16(28, c.nameB.length, true);
    cv.setUint32(42, c.offset, true);
    cd.set(c.nameB, 46);
    parts.push(cd);
    offset += cd.length;
  }
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(16, cdStart, true);
  parts.push(eocd);
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) { out.set(p, pos); pos += p.length; }
  return out;
}

test('extractArchive skips zip directory entries', { skip: !hasStreams }, async () => {
  const zipBuf = craftZip([
    { name: 'sub/', data: new Uint8Array(0) },
    { name: 'sub/a.log', data: new TextEncoder().encode('inside dir\n') },
  ]);
  const out = await ar.extractArchive('bundle.zip', zipBuf);
  assert.deepStrictEqual(out.map((e) => e.name), ['bundle/sub/a.log']);
  assert.strictEqual(new TextDecoder().decode(out[0].data), 'inside dir\n');
});

test('extractArchive rejects unknown zip compression methods', { skip: !hasStreams }, async () => {
  const zipBuf = craftZip([{ name: 'a.log', data: new TextEncoder().encode('bzip2 me\n'), method: 12 }]);
  await assert.rejects(() => ar.extractArchive('weird.zip', zipBuf), /method 12/i);
});

test('extractArchive rejects zip64 entries', { skip: !hasStreams }, async () => {
  const zipBuf = craftZip([{ name: 'huge.log', data: new TextEncoder().encode('too big\n'), zip64: true }]);
  await assert.rejects(() => ar.extractArchive('huge.zip', zipBuf), /zip64/i);
});

test('buildArchive gz fallback concatenates and compresses', { skip: !hasStreams }, async () => {
  const entries = [
    { name: 'a.log', data: new TextEncoder().encode('concat a\n') },
    { name: 'b.log', data: new TextEncoder().encode('concat b\n') },
  ];
  const gz = await ar.buildArchive(entries, 'gz');
  const back = await ar.gunzipData(gz);
  assert.strictEqual(new TextDecoder().decode(back), 'concat a\nconcat b\n');
});

// --- untrusted-header guards (review hardening) ---

test('extractArchive rejects zip entries with corrupted payload (CRC)', { skip: !hasStreams }, async () => {
  const raw = new TextEncoder().encode('verify my crc please\n');
  const zipBuf = craftZip([{ name: 'ok.log', data: raw }]);
  // flip a payload byte inside the local entry (after the 30+name header)
  const nameLen = new TextEncoder().encode('ok.log').length;
  zipBuf[30 + nameLen + 2] ^= 0xff;
  await assert.rejects(() => ar.extractArchive('crc.zip', zipBuf), /CRC mismatch/i);
});

test('extractArchive caps archive nesting depth', { skip: !hasStreams }, async () => {
  let blob = new TextEncoder().encode('deep\n');
  for (let i = 0; i < 25; i++) blob = await ar.gzipData(blob);
  // one .gz suffix per level keeps the recursion going until the cap trips
  await assert.rejects(() => ar.extractArchive('deep' + '.gz'.repeat(25), blob), /nesting too deep/i);
});

test('extractArchive enforces the expansion budget', async () => {
  // crafted 7z header claiming a 3 GiB copy-coded folder from 4 packed bytes:
  // the guard must refuse BEFORE allocating what the header claims
  const F7 = require('../src/format-7z.js');
  const header = new Uint8Array([
    0x01, 0x04,
    0x06, 0x00, 0x01, 0x09, 0x04, 0x00, // pack info: 1 stream, 4 bytes
    0x07, 0x0b, 0x01, 0x00, 0x01, 0x01, 0x00, // 1 copy coder
    0x0c, 0xff, 0x00, 0x00, 0x00, 0xc0, 0x00, 0x00, 0x00, 0x00, // unpack size 3 GiB
    0x00, 0x00,
    0x05, 0x01, 0x11, 0x0d, 0x00, 0x61, 0x00, 0x2e, 0x00, 0x6c, 0x00, 0x6f, 0x00, 0x67, 0x00, 0x00, 0x00,
    0x00, 0x00,
  ]);
  const payload = new Uint8Array([0x41, 0x42, 0x43, 0x44]);
  const buf = new Uint8Array(32 + payload.length + header.length);
  buf.set([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0x00, 0x04], 0);
  const dv = new DataView(buf.buffer);
  dv.setBigUint64(12, BigInt(payload.length), true);
  dv.setBigUint64(20, BigInt(header.length), true);
  dv.setUint32(28, F7.crc32(header), true);
  dv.setUint32(8, F7.crc32(buf.subarray(12, 32)), true);
  buf.set(payload, 32);
  buf.set(header, 32 + payload.length);
  await assert.rejects(() => ar.extractArchive('bomb.7z', buf), /too large|safety cap/i);
});

test('boardBinToText extracts text lines from a binary board dump', async () => {
  const ar2 = require('../src/archive.js');
  const parts = [];
  const push = (s) => parts.push(Buffer.from(s, 'latin1'));
  push(Buffer.from([0, 0, 0, 1, 2, 3, 0, 255]));            // binary junk
  push('09-11 22:14:01 I VHal: gear changed to P\n');
  push(Buffer.from([255, 254, 0, 7]));                      // more junk
  push('09-11 22:14:02 W PowerManager: suspend not allowed\n');
  const bin = Buffer.concat(parts);
  const out = await ar.boardBinToText(new Uint8Array(bin), 1024 * 1024, () => {});
  const text = Buffer.from(out).toString('utf8');
  assert.match(text, /gear changed to P/);
  assert.match(text, /suspend not allowed/);
  assert.ok(!text.includes('\u0000'), 'no NUL bytes in extracted text');
});

test('boardBinToText keeps the newest text within the cap', async () => {
  const ar2 = require('../src/archive.js');
  const parts = [];
  parts.push(Buffer.from([0, 0, 0]));
  parts.push(Buffer.from('EARLY old log line that must be dropped\n', 'latin1'));
  parts.push(Buffer.from([9, 255, 3]));
  parts.push(Buffer.from('NEWEST keep me log line\n', 'latin1'));
  const bin = Buffer.concat(parts);
  const out = await ar.boardBinToText(new Uint8Array(bin), 24, () => {}); // 24 bytes of text
  const text = Buffer.from(out).toString('utf8');
  assert.ok(text.includes('NEWEST keep me log line'), 'newest line kept: ' + JSON.stringify(text));
  assert.ok(!text.includes('EARLY'), 'old line dropped: ' + JSON.stringify(text));
});

test('boardBinToText accepts ReadableStream and async-iterable sources', async () => {
  const bin = Buffer.concat([
    Buffer.from([0]),
    Buffer.from('streamed text run one\n', 'latin1'),
    Buffer.from([0]),
    Buffer.from('streamed text run two\n', 'latin1'),
  ]);
  async function* gen() {
    yield new Uint8Array(bin.subarray(0, 12));
    yield new Uint8Array(bin.subarray(12));
  }
  const fromIter = Buffer.from(await ar.boardBinToText(gen(), 1024, () => {})).toString('utf8');
  const stream = new ReadableStream({
    start(ctrl) {
      ctrl.enqueue(new Uint8Array(bin.subarray(0, 12)));
      ctrl.enqueue(new Uint8Array(bin.subarray(12)));
      ctrl.close();
    },
  });
  const fromStream = Buffer.from(await ar.boardBinToText(stream, 1024, () => {})).toString('utf8');
  assert.strictEqual(fromIter, fromStream);
  assert.match(fromIter, /streamed text run one/);
  assert.match(fromIter, /streamed text run two/);
});

test('boardBinToText trims mid-segment when a run straddles the cap', async () => {
  // run1 = 'AAAAA' (5) + 35 C's spread over chunks; run2 = 35 B's; cap 43
  const c35 = 'C'.repeat(35);
  const b35 = 'B'.repeat(35);
  async function* gen() {
    yield new Uint8Array(Buffer.from([0]));
    yield new Uint8Array(Buffer.from('AAAAA', 'latin1'));
    yield new Uint8Array(Buffer.from(c35, 'latin1'));
    yield new Uint8Array(Buffer.from([0]));
    yield new Uint8Array(Buffer.from(b35, 'latin1'));
  }
  const out = await ar.boardBinToText(gen(), 43, () => {});
  const text = Buffer.from(out).toString('utf8');
  assert.strictEqual(out.length, 43, 'kept exactly the cap: ' + out.length);
  assert.ok(text.endsWith(b35), 'newest run fully kept');
  assert.ok(text.startsWith('CCCCCCCC'), 'older run trimmed mid-segment (oldest-first): ' + JSON.stringify(text.slice(0, 12)));
  assert.ok(!text.includes('AAAAA'), 'oldest segment fully dropped');
});

test('extractArchive converts a directly dropped dumpstate_board.bin', async () => {
  const bin = Buffer.concat([
    Buffer.from([255, 0, 7]),
    Buffer.from('dropped board: direct conversion works\n', 'latin1'),
  ]);
  const out = await ar.extractArchive('dumpstate_board.bin', new Uint8Array(bin));
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].name, 'dumpstate_board.bin.log');
  assert.match(Buffer.from(out[0].data).toString('utf8'), /direct conversion works/);
});

test('extractArchive converts a giant dumpstate_board.bin entry into text', async () => {
  const enc = new TextEncoder();
  const nameB = enc.encode('dumpstate_board.bin');
  const binParts = [];
  binParts.push(Buffer.from([0, 0, 255]));
  binParts.push(Buffer.from('board log: usageMode Gear isPark\n', 'latin1'));
  binParts.push(Buffer.from([1, 2]));
  binParts.push(Buffer.from('board log: suspend entry\n', 'latin1'));
  const binData = Buffer.concat(binParts);
  // craft zip with central-directory uncompSize claimed as 600 MB (giant)
  const giant = 600 * 1024 * 1024;
  const crc = ar.crc32(new Uint8Array(binData));
  const parts = [];
  const lfh = new Uint8Array(30 + nameB.length);
  const lv = new DataView(lfh.buffer);
  lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true);
  lv.setUint32(14, crc, true); lv.setUint32(18, binData.length, true); lv.setUint32(22, binData.length, true);
  lv.setUint16(26, nameB.length, true);
  lfh.set(nameB, 30);
  parts.push(lfh, binData);
  const cd = new Uint8Array(46 + nameB.length);
  const cv = new DataView(cd.buffer);
  cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
  cv.setUint32(16, crc, true); cv.setUint32(20, binData.length, true); cv.setUint32(24, giant, true);
  cv.setUint16(28, nameB.length, true); cv.setUint32(42, 0, true);
  cd.set(nameB, 46);
  const cdOff = lfh.length + binData.length;
  parts.push(cd);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, 1, true); ev.setUint16(10, 1, true);
  ev.setUint32(12, cd.length, true); ev.setUint32(16, cdOff, true);
  parts.push(eocd);
  const zipBuf = Buffer.concat(parts);
  const out = await ar.extractArchive('bugreport.zip', new Uint8Array(zipBuf));
  assert.strictEqual(out.length, 1, 'one converted entry');
  assert.match(out[0].name, /dumpstate_board\.bin\.log$/, 'converted entry name: ' + out[0].name);
  assert.match(Buffer.from(out[0].data).toString('utf8'), /usageMode Gear isPark/, 'board log text present');
});

test('extractArchive rejects truncated tar entries', async () => {
  const tarBuf = ar.writeTar([{ name: 'a.log', data: new TextEncoder().encode('x'.repeat(1000)) }]);
  await assert.rejects(() => ar.extractArchive('cut.tar', tarBuf.subarray(0, 600)), /truncated entry/i);
});

test('extractArchive unpacks tar and nested tar.gz entries', { skip: !hasStreams }, async () => {
  const inner = await ar.gzipData(new TextEncoder().encode('nested gz inside tar\n'));
  const tarBuf = ar.writeTar([
    { name: 'plain.log', data: new TextEncoder().encode('plain tar line\n') },
    { name: 'inner.log.gz', data: inner },
  ]);
  const out = await ar.extractArchive('bundle.tar', tarBuf);
  assert.deepStrictEqual(out.map((e) => e.name).sort(), ['bundle/inner.log', 'bundle/plain.log']);
  assert.strictEqual(new TextDecoder().decode(out.find((e) => e.name === 'bundle/plain.log').data), 'plain tar line\n');
  assert.strictEqual(new TextDecoder().decode(out.find((e) => e.name === 'bundle/inner.log').data), 'nested gz inside tar\n');
});

test('extractArchive unpacks a top-level tar.gz and tgz', { skip: !hasStreams }, async () => {
  const tarBuf = ar.writeTar([{ name: 'tcam.log', data: new TextEncoder().encode('tcam backup line\n') }]);
  for (const name of ['217.tar.gz', '217.tgz']) {
    const gz = await ar.gzipData(tarBuf);
    const out = await ar.extractArchive(name, gz);
    assert.strictEqual(out.length, 1, name + ': one entry');
    assert.strictEqual(out[0].name, '217/tcam.log', name + ': path prefix kept');
    assert.strictEqual(new TextDecoder().decode(out[0].data), 'tcam backup line\n');
  }
});

test('extractArchive decompresses a gzip payload misnamed .tar', { skip: !hasStreams }, async () => {
  // some devices (e.g. TCAM kmesglog_*.tar) ship gzip bytes with a .tar name
  const tarBuf = ar.writeTar([{ name: 'kmesg.log', data: new TextEncoder().encode('kernel ring buffer line\n') }]);
  const gz = await ar.gzipData(tarBuf);
  const out = await ar.extractArchive('kmesglog_2026-05-20-17-41-41_0006.tar', gz);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].name, 'kmesglog_2026-05-20-17-41-41_0006/kmesg.log');
  assert.strictEqual(new TextDecoder().decode(out[0].data), 'kernel ring buffer line\n');
});

test('parseTar rejects headers with a bad checksum', () => {
  const tarBuf = ar.writeTar([{ name: 'a.log', data: new TextEncoder().encode('flip me\n') }]);
  tarBuf[3] ^= 0xff; // a name byte: checksum no longer matches
  assert.throws(() => ar.parseTar(tarBuf), /header checksum mismatch/i);
});

test('parseTar rejects base-256 sizes', () => {
  const tarBuf = ar.writeTar([{ name: 'a.log', data: new TextEncoder().encode('base256\n') }]);
  tarBuf[124] |= 0x80; // GNU base-256 size marker
  // restore a valid checksum so only the base-256 guard trips
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : tarBuf[i];
  tarBuf.set(new TextEncoder().encode(sum.toString(8).padStart(6, '0') + '\0 '), 148);
  assert.throws(() => ar.parseTar(tarBuf), /base-256/i);
});

test('parseTar joins the ustar prefix for long names', () => {
  // hand-built ustar header: name field + prefix field (345..499)
  const enc = new TextEncoder();
  const header = new Uint8Array(512);
  const name = 'leaf.log';
  const prefix = 'a'.repeat(50) + '/' + 'b'.repeat(50);
  header.set(enc.encode(name), 0);
  header.set(enc.encode(prefix), 345);
  header.set(enc.encode('0000644\0'), 100);
  header.set(enc.encode('00000000012\0'), 124); // size 10 octal
  header.set(enc.encode('        '), 148);
  header[156] = 48;
  header.set(enc.encode('ustar\0'), 257);
  header.set(enc.encode('00'), 263);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : header[i];
  header.set(enc.encode(sum.toString(8).padStart(6, '0') + '\0 '), 148);
  const data = new Uint8Array(512 + 512);
  data.set(header, 0);
  data.set(enc.encode('0123456789'), 512);
  const entries = ar.parseTar(data);
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].name, prefix + '/' + name);
});

test('decodeFolderSync rejects implausible 7z compression ratios', async () => {
  const F7 = require('../src/format-7z.js');
  const folder = { codec: 'copy', props: null, outSize: 1 << 30, packOffset: 0, packSize: 4, crc: null };
  assert.throws(() => F7.decodeFolderSync(new Uint8Array(8), folder), /implausible compression ratio/i);
});
