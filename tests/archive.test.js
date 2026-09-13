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
  const file = { name: 'deflated.log', raw: enc('deflate me, deflate me, deflate me\n'.repeat(10)) };
  const comp = zlib.deflateRawSync(file.raw);
  // hand-build a minimal zip: local header + data + central dir + EOCD (method 8)
  const nameB = enc(file.name);
  const parts = [];
  const lfh = new Uint8Array(30 + nameB.length);
  const lv = new DataView(lfh.buffer);
  lv.setUint32(0, 0x04034b50, true);
  lv.setUint16(4, 20, true);
  lv.setUint16(8, 0, true); // flags
  lv.setUint16(10, 8, true); // method deflate
  lv.setUint32(14, ar.crc32(file.raw), true);
  lv.setUint32(18, comp.length, true);
  lv.setUint32(22, file.raw.length, true);
  lv.setUint16(26, nameB.length, true);
  lfh.set(nameB, 30);
  parts.push(lfh, comp);
  const cd = new Uint8Array(46 + nameB.length);
  const cv = new DataView(cd.buffer);
  cv.setUint32(0, 0x02014b50, true);
  cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
  cv.setUint16(10, 8, true);
  cv.setUint32(20, comp.length, true);
  cv.setUint32(24, file.raw.length, true);
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
  assert.deepStrictEqual(out[0].data, file.raw);
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
