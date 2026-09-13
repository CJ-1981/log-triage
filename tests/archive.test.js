'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const ar = require('../src/archive.js');

const hasStreams = typeof DecompressionStream !== 'undefined';

test('detectArchiveType recognises supported formats', () => {
  assert.strictEqual(ar.detectArchiveType('app.log.gz'), 'gzip');
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
