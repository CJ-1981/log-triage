'use strict';
/* 7z archive support: LZMA/LZMA2 codec decoding (src/lzma.js), 7z container
 * parsing and stored-entry writing (src/format-7z.js), and archive.js wiring.
 * Codec-level tests use embedded fixtures produced once by 7-Zip (see
 * tests/fixtures/lzma2.hex / lzma1.hex + sample7z.txt). Container-level tests
 * build real archives with the local 7-Zip CLI and are skipped when it is
 * not available (set SEVENZIP_BIN to point at it). */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const LZ = require('../src/lzma.js');
const F7 = require('../src/format-7z.js');
const ar = require('../src/archive.js');

const FX = path.join(__dirname, 'fixtures');
// normalize EOLs so a CRLF checkout (Windows autocrlf) cannot desync the
// expected text from the LF bytes the committed LZMA fixtures encode
const SAMPLE = fs.readFileSync(path.join(FX, 'sample7z.txt'), 'utf8').replace(/\r\n/g, '\n');
const hex = (f) => new Uint8Array(Buffer.from(fs.readFileSync(path.join(FX, f), 'utf8').trim(), 'hex'));
const enc = (s) => new TextEncoder().encode(s);
const dec = (b) => new TextDecoder().decode(b);

// ---------------------------------------------------------------------------
// LZMA codec level
// ---------------------------------------------------------------------------

test('lzma2Decode decompresses a real 7-Zip LZMA2 stream', () => {
  const src = hex('lzma2.hex');
  const out = LZ.lzma2Decode(src, 0, src.length, SAMPLE.length);
  assert.strictEqual(dec(out), SAMPLE);
});

test('lzmaDecode decompresses a raw LZMA1 stream with props 0x5D', () => {
  const src = hex('lzma1.hex');
  const out = LZ.lzmaDecode(src, 0, SAMPLE.length, 0x5D);
  assert.strictEqual(dec(out), SAMPLE);
});

test('lzmaDecode rejects truncated input', () => {
  const src = hex('lzma1.hex');
  assert.throws(() => LZ.lzmaDecode(src.subarray(0, 120), 0, SAMPLE.length, 0x5D), /end of stream|corrupt/i);
});

test('lzmaDecode rejects invalid properties', () => {
  assert.throws(() => LZ.lzmaDecode(hex('lzma1.hex'), 0, SAMPLE.length, 0xFF), /propert/i);
});

test('lzmaDecode rejects non-zero range coder init byte', () => {
  const src = hex('lzma1.hex');
  src[0] = 1;
  assert.throws(() => LZ.lzmaDecode(src, 0, SAMPLE.length, 0x5D), /init|corrupt/i);
});

test('lzma2Decode decodes a crafted uncompressed chunk (dict reset, 0x01)', () => {
  const msg = enc('stored chunk bytes\n');
  const stream = new Uint8Array(3 + msg.length + 1);
  stream[0] = 0x01;
  stream[1] = (msg.length - 1) >> 8;
  stream[2] = (msg.length - 1) & 0xff;
  stream.set(msg, 3);
  stream[stream.length - 1] = 0x00;
  const out = LZ.lzma2Decode(stream, 0, stream.length, msg.length);
  assert.deepStrictEqual(out, msg);
});

test('lzma2Decode decodes an uncompressed chunk without dict reset (0x02)', () => {
  const msg = enc('plain passthrough');
  const stream = new Uint8Array([0x02, 0x00, msg.length - 1, ...msg, 0x00]);
  const out = LZ.lzma2Decode(stream, 0, stream.length, msg.length);
  assert.strictEqual(dec(out), 'plain passthrough');
});

test('lzma2Decode rejects LZMA chunk with no properties yet (0x80 first)', () => {
  assert.throws(() => LZ.lzma2Decode(new Uint8Array([0x80, 0x00, 0x00, 0x00, 0x00, 0x00]), 0, 6, 1), /propert/i);
});

test('lzma2Decode rejects unexpected end of chunk data', () => {
  assert.throws(() => LZ.lzma2Decode(hex('lzma2.hex').subarray(0, 100), 0, 100, SAMPLE.length), /end of stream|corrupt/i);
});

test('lzma2Decode rejects output size mismatch', () => {
  assert.throws(() => LZ.lzma2Decode(hex('lzma2.hex'), 0, 722 / 2, SAMPLE.length + 10), /size|corrupt/i);
});

test('lzma2Decode rejects unknown control byte', () => {
  assert.throws(() => LZ.lzma2Decode(new Uint8Array([0x42, 0x00, 0x00, 0x00, 0x00, 0x00]), 0, 6, 1), /control|corrupt/i);
});

// ---------------------------------------------------------------------------
// 7z container: writer/parser round-trips (no external tools needed)
// ---------------------------------------------------------------------------

test('write7zStored → parse7z → decode round-trip (copy codec, CRCs)', async () => {
  const small = enc('alpha log line\nbeta log line\n');
  const big = enc(('repeat me please rssi=-50 driver timeout\n').repeat(800)); // >16 KB forces multi-byte numbers
  const entries = [
    { name: 'a.log', data: small },
    { name: 'sub/b.log', data: big },
  ];
  const buf = F7.write7zStored(entries);
  assert.ok(F7.is7z(buf), 'magic bytes');
  const parsed = F7.parse7z(buf);
  assert.strictEqual(parsed.files.length, 2);
  assert.strictEqual(parsed.files[0].name, 'a.log');
  assert.strictEqual(parsed.files[1].name, 'sub/b.log');
  assert.strictEqual(parsed.files[0].size, small.length);
  assert.strictEqual(parsed.files[1].size, big.length);
  const f0 = parsed.folders[parsed.files[0].folder];
  const d0 = await F7.decode7zFolder(buf, f0);
  assert.deepStrictEqual(d0.subarray ? d0.subarray(parsed.files[0].offset, parsed.files[0].offset + small.length) : d0, small);
  const f1 = parsed.folders[parsed.files[1].folder];
  const d1 = await F7.decode7zFolder(buf, f1);
  assert.deepStrictEqual(d1.subarray(parsed.files[1].offset, parsed.files[1].offset + big.length), big);
});

test('write7zStored with encodeHeader writes a kEncodedHeader archive that parses', async () => {
  const entries = [{ name: 'x.log', data: enc('encoded header test\n') }];
  const buf = F7.write7zStored(entries, { encodeHeader: true });
  assert.ok(F7.is7z(buf));
  const parsed = F7.parse7z(buf);
  assert.strictEqual(parsed.files.length, 1);
  assert.strictEqual(parsed.files[0].name, 'x.log');
  const folder = parsed.folders[parsed.files[0].folder];
  const data = await F7.decode7zFolder(buf, folder);
  assert.deepStrictEqual(data.subarray(parsed.files[0].offset, parsed.files[0].offset + entries[0].data.length), entries[0].data);
});

test('write7zStored handles an empty archive', () => {
  const buf = F7.write7zStored([]);
  assert.ok(F7.is7z(buf));
  const parsed = F7.parse7z(buf);
  assert.strictEqual(parsed.files.length, 0);
  assert.strictEqual(parsed.folders.length, 0);
});

test('write7zStored omits digests when asked', () => {
  const buf = F7.write7zStored([{ name: 'a.log', data: enc('x\n') }], { digests: false });
  const parsed = F7.parse7z(buf);
  assert.strictEqual(parsed.files[0].crc, null);
});

test('parse7z rejects non-7z data', () => {
  assert.throws(() => F7.parse7z(enc('this is definitely not a 7z file....')), /magic|not a 7z/i);
});

test('parse7z rejects corrupted start header', () => {
  const buf = F7.write7zStored([{ name: 'a.log', data: enc('hello\n') }]);
  buf[15] ^= 0xff;
  assert.throws(() => F7.parse7z(buf), /start header CRC/i);
});

test('parse7z rejects corrupted next header', () => {
  const entries = [{ name: 'a.log', data: enc('hello\n') }];
  const buf = F7.write7zStored(entries);
  const dataLen = entries[0].data.length;
  buf[32 + dataLen] ^= 0xff; // flip first header byte
  assert.throws(() => F7.parse7z(buf), /header CRC|corrupt/i);
});

test('parse7z rejects truncated archive', () => {
  const buf = F7.write7zStored([{ name: 'a.log', data: enc('hello\n') }]);
  assert.throws(() => F7.parse7z(buf.subarray(0, 20)), /truncat/i);
});

test('parse7z reports unsupported coder ids', () => {
  const header = new Uint8Array([
    0x01, // kHeader
    0x04, // kMainStreamsInfo
    0x06, 0x00, 0x01, 0x09, 0x03, 0x00, // kPackInfo: pos=0 n=1 kSize=3 kEnd
    0x07, 0x0b, 0x01, 0x00, 0x01, 0x01, 0x99, // 1 coder, id 0x99
    0x0c, 0x03, // kCodersUnpackSize = 3
    0x00, // kEnd unpackInfo
    0x00, // kEnd streamsInfo
    0x00, // kEnd header
  ]);
  const buf = craftArchive(header, enc('abc'));
  assert.throws(() => F7.parse7z(buf), /unsupported.*coder|coder.*support/i);
});

test('parse7z reports unsupported encrypted coders', () => {
  const header = new Uint8Array([
    0x01,
    0x04,
    0x06, 0x00, 0x01, 0x09, 0x03, 0x00,
    0x07, 0x0b, 0x01, 0x00, 0x01, 0x04, 0x06, 0xf1, 0x07, 0x01, // AES-256+SHA-256 coder
    0x0c, 0x03,
    0x00,
    0x00,
    0x00,
  ]);
  const buf = craftArchive(header, enc('abc'));
  assert.throws(() => F7.parse7z(buf), /encrypt/i);
});

test('parse7z rejects external (out-of-stream) names', () => {
  const header = new Uint8Array([
    0x01, // kHeader
    0x04, // kMainStreamsInfo
    0x06, 0x00, 0x01, 0x09, 0x03, 0x00, // kPackInfo: pos=0 n=1 kSize=3 kEnd
    0x07, 0x0b, 0x01, 0x00, 0x01, 0x01, 0x00, // 1 copy coder
    0x0c, 0x03, // kCodersUnpackSize = 3
    0x00, // kEnd unpackInfo
    0x00, // kEnd streamsInfo
    0x05, 0x01, 0x11, 0x03, 0x01, 0x00, 0x00, // kFilesInfo: 1 file, kName block size 3, external=1
    0x00, // kEnd filesInfo
    0x00, // kEnd header
  ]);
  const buf = craftArchive(header, enc('abc'));
  assert.throws(() => F7.parse7z(buf), /external/i);
});

test('extractArchive slices substreams and verifies CRCs', async () => {
  const entries = [
    { name: 'a.log', data: enc('content a\n') },
    { name: 'b.log', data: enc('content b\n') },
  ];
  const buf = F7.write7zStored(entries);
  const out = await ar.extractArchive('logs.7z', buf);
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].name, 'logs/a.log');
  assert.strictEqual(dec(out[0].data), 'content a\n');
  assert.strictEqual(dec(out[1].data), 'content b\n');
});

test('extractArchive detects corrupt 7z payload via CRC', async () => {
  const entries = [{ name: 'a.log', data: enc('detect me corrupting this payload\n') }];
  const buf = F7.write7zStored(entries);
  buf[32 + 5] ^= 0xff;
  await assert.rejects(() => ar.extractArchive('a.7z', buf), /CRC|corrupt/i);
});

test('detectArchiveType recognises .7z', () => {
  assert.strictEqual(ar.detectArchiveType('logs.7z'), '7z');
  assert.strictEqual(ar.detectArchiveType('LOGS.7Z'), '7z');
});

test('buildArchive creates a 7z that parses back', async () => {
  const entries = [
    { name: 'masked/a.log', data: enc('masked a\n') },
    { name: 'masked/b.log', data: enc('masked b\n') },
  ];
  const buf = await ar.buildArchive(entries, '7z');
  assert.ok(F7.is7z(buf));
  const parsed = F7.parse7z(buf);
  assert.strictEqual(parsed.files.length, 2);
  const names = parsed.files.map((f) => f.name).sort();
  assert.deepStrictEqual(names, ['masked/a.log', 'masked/b.log']);
});

// ---------------------------------------------------------------------------
// codec + branch-level units
// ---------------------------------------------------------------------------

test('decode7zFolder decodes deflate-coded folder data', { skip: typeof DecompressionStream === 'undefined' }, async () => {
  const zlib = require('node:zlib');
  const raw = enc('deflate coder payload\n');
  const comp = zlib.deflateRawSync(raw);
  const data = new Uint8Array(4 + comp.length);
  data.set(comp, 4);
  const folder = { codec: 'deflate', props: null, outSize: raw.length, packOffset: 4, packSize: comp.length, crc: null };
  const out = await F7.decode7zFolder(data, folder);
  assert.strictEqual(dec(out), 'deflate coder payload\n');
});

test('decodeFolderSync rejects the deflate coder (needs async decode)', () => {
  const folder = { codec: 'deflate', props: null, outSize: 4, packOffset: 0, packSize: 4, crc: null };
  assert.throws(() => F7.decodeFolderSync(new Uint8Array(8), folder), /async/i);
});

test('decode7zFolder verifies the folder CRC', async () => {
  const data = enc('corrupt me\n');
  const folder = { codec: 'copy', props: null, outSize: data.length, packOffset: 0, packSize: data.length, crc: 0xdeadbeef };
  await assert.rejects(() => F7.decode7zFolder(data, folder), /CRC/i);
});

test('parse7z treats a zero-length next header as an empty archive', () => {
  const out = new Uint8Array(32);
  out.set([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0x00, 0x04], 0);
  const dv = new DataView(out.buffer);
  dv.setUint32(8, F7.crc32(out.subarray(12, 32)), true);
  const parsed = F7.parse7z(out);
  assert.deepStrictEqual(parsed.files, []);
  assert.deepStrictEqual(parsed.folders, []);
});

test('write7zStored round-trips non-ASCII names', () => {
  const buf = F7.write7zStored([{ name: 'loglärm/ünïcode.log', data: enc('x\n') }]);
  const parsed = F7.parse7z(buf);
  assert.strictEqual(parsed.files[0].name, 'loglärm/ünïcode.log');
});

test('parse7z reads partial substream digest masks (allAreDefined=0)', () => {
  const header = new Uint8Array([
    0x01, 0x04,
    0x06, 0x00, 0x01, 0x09, 0x03, 0x00,
    0x07, 0x0b, 0x01, 0x00, 0x01, 0x01, 0x00,
    0x0c, 0x03,
    0x00,
    0x08, 0x0a, 0x00, 0x80, 0x12, 0x34, 0x56, 0x78, 0x00, // kCRC allDefined=0, mask 0x80 → stream 0 defined
    0x00, // kEnd streamsInfo
    0x05, 0x01, 0x11, 0x0d, 0x00, 0x61, 0x00, 0x2e, 0x00, 0x6c, 0x00, 0x6f, 0x00, 0x67, 0x00, 0x00, 0x00, // 1 file "a.log"
    0x00, // kEnd filesInfo
    0x00, // kEnd header
  ]);
  const buf = craftArchive(header, enc('abc'));
  const parsed = F7.parse7z(buf);
  assert.strictEqual(parsed.files.length, 1);
  assert.strictEqual(parsed.files[0].crc, 0x78563412); // LE u32 of 12 34 56 78
});

test('parse7z reads pack-stream digests and skips unknown unpack-info props', () => {
  const header = new Uint8Array([
    0x01, 0x04,
    0x06, 0x00, 0x01, 0x09, 0x03, 0x0a, 0x01, 0xaa, 0xbb, 0xcc, 0xdd, 0x00, // packinfo + pack CRC
    0x07, 0x0b, 0x01, 0x00, 0x01, 0x01, 0x00,
    0x0c, 0x03,
    0x19, 0x02, 0x00, 0x00, // unknown/dummy unpack-info prop (size-prefixed skip)
    0x00,
    0x00,
    0x00,
  ]);
  const buf = craftArchive(header, enc('abc'));
  const parsed = F7.parse7z(buf);
  assert.strictEqual(parsed.files.length, 0); // no FilesInfo
  assert.strictEqual(parsed.folders.length, 1);
});

test('parse7z rejects substream sizes that exceed the folder size', () => {
  const header = new Uint8Array([
    0x01, 0x04,
    0x06, 0x00, 0x01, 0x09, 0x03, 0x00,
    0x07, 0x0b, 0x01, 0x00, 0x01, 0x01, 0x00,
    0x0c, 0x03,
    0x00,
    0x08, 0x0d, 0x02, 0x09, 0x0a, 0x00, // 2 substreams, first size 10 > folder size 3
    0x00,
    0x00,
  ]);
  const buf = craftArchive(header, enc('abc'));
  assert.throws(() => F7.parse7z(buf), /exceed/i);
});

test('parse7z rejects deflate-compressed headers', () => {
  const header = new Uint8Array([
    0x17, // kEncodedHeader
    0x06, 0x00, 0x01, 0x09, 0x03, 0x00,
    0x07, 0x0b, 0x01, 0x00, 0x01, 0x03, 0x03, 0x04, 0x01, 0x0c, 0x03, 0x00,
    0x00,
  ]);
  const buf = craftArchive(header, enc('abc'));
  assert.throws(() => F7.parse7z(buf), /deflate-compressed/i);
});

test('extractArchive decodes deflate-coded 7z folders', { skip: typeof DecompressionStream === 'undefined' }, async () => {
  const zlib = require('node:zlib');
  const content = enc('deflate folder payload\n');
  const comp = zlib.deflateRawSync(content);
  assert.ok(comp.length < 0x80, 'compact fixture keeps header numbers single-byte');
  const nameBytes = [0x61, 0x00, 0x2e, 0x00, 0x6c, 0x00, 0x6f, 0x00, 0x67, 0x00, 0x00, 0x00]; // "a.log\0"
  const header = new Uint8Array([
    0x01, 0x04,
    0x06, 0x00, 0x01, 0x09, comp.length, 0x00, // packinfo: 1 stream, size comp.length
    0x07, 0x0b, 0x01, 0x00, 0x01, 0x03, 0x03, 0x04, 0x01, // 1 deflate coder (id 03 04 01)
    0x0c, content.length, 0x00, // unpack size + kEnd unpackInfo
    0x00, // kEnd streamsInfo
    0x05, 0x01, 0x11, nameBytes.length + 1, 0x00, ...nameBytes, // kFilesInfo + kName "a.log"
    0x00, // kEnd filesInfo
    0x00, // kEnd header
  ]);
  const buf = craftArchive(header, comp);
  const out = await ar.extractArchive('defl.7z', buf);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(dec(out[0].data), 'deflate folder payload\n');
});

test('parse7z reads long-form (multi-byte) numbers and rejects coder chains', () => {
  // packPos encoded in long form (0xFF prefix + 8 little-endian bytes) = 0
  const header = new Uint8Array([
    0x01, 0x04,
    0x06, 0xff, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x09, 0x03, 0x00,
    0x07, 0x0b, 0x01, 0x00, 0x02, 0x01, 0x01, 0x00, 0x01, 0x01, 0x00, // 2 coders → unsupported chain
    0x0c, 0x03,
    0x00,
    0x00,
    0x00,
  ]);
  const buf = craftArchive(header, enc('abc'));
  assert.throws(() => F7.parse7z(buf), /coder chain \(2 coders\)/i);
});

test('parse7z skips unknown pack-info properties', () => {
  const header = new Uint8Array([
    0x01, 0x04,
    0x06, 0x00, 0x01, 0x09, 0x03, 0x19, 0x02, 0x00, 0x00, 0x00, // dummy pack-info prop
    0x07, 0x0b, 0x01, 0x00, 0x01, 0x01, 0x00,
    0x0c, 0x03,
    0x00,
    0x00,
    0x00,
  ]);
  const buf = craftArchive(header, enc('abc'));
  const parsed = F7.parse7z(buf);
  assert.strictEqual(parsed.folders.length, 1);
});

test('decodeFolderSync rejects unknown codecs', () => {
  const folder = { codec: 'delta', props: null, outSize: 4, packOffset: 0, packSize: 4, crc: null };
  assert.throws(() => F7.decodeFolderSync(new Uint8Array(8), folder), /unsupported codec/i);
});

test('parse7z rejects unknown header elements', () => {
  const header = new Uint8Array([0x01, 0x7f, 0x00, 0x00]); // 0x7f = reserved id
  const buf = craftArchive(header, enc('abc'));
  assert.throws(() => F7.parse7z(buf), /unsupported header element 127/i);
});

// ---------------------------------------------------------------------------
// Real 7-Zip CLI fixtures (skipped when the CLI is unavailable)
// ---------------------------------------------------------------------------

let SEVENZIP = null;
let TMP = null;

function find7z() {
  const candidates = [
    process.env.SEVENZIP_BIN, '7z', '7za',
    'C:\\Program Files\\7-Zip\\7z.exe',
    'C:\\Program Files (x86)\\7-Zip\\7z.exe',
  ];
  for (const c of candidates) {
    if (!c) continue;
    try {
      const r = spawnSync(c, ['i'], { encoding: 'utf8' });
      if (r.status === 0 || /7-?zip/i.test((r.stdout || '') + (r.stderr || ''))) return c;
    } catch { /* not present */ }
  }
  return null;
}

function z7(args, opts = {}) {
  const r = spawnSync(SEVENZIP, args, { cwd: TMP, encoding: 'utf8', ...opts });
  if (!opts.expectFail) {
    assert.strictEqual(r.status, 0, '7z ' + args.join(' ') + ' failed: ' + (r.stderr || r.stdout));
  }
  return r;
}

// Extract the single packed stream of a one-file -mhc=off -ms=off archive.
function packStream(archive) {
  const raw = fs.readFileSync(path.join(TMP, archive));
  const slt = z7(['l', '-slt', archive]).stdout;
  const packedSize = Number(/Packed Size = (\d+)/.exec(slt)[1]);
  return raw.subarray(32, 32 + packedSize);
}

async function extractParsed(buf) {
  const parsed = F7.parse7z(buf);
  const decoded = [];
  for (const folder of parsed.folders) decoded.push(await F7.decode7zFolder(buf, folder));
  return parsed.files
    .filter((f) => !f.isDir)
    .map((f) => ({
      name: f.name,
      size: f.size,
      data: f.size ? decoded[f.folder].subarray(f.offset, f.offset + f.size) : new Uint8Array(0),
    }));
}

before(() => {
  SEVENZIP = find7z();
  if (!SEVENZIP) {
    console.log('  # 7-Zip CLI not found — container fixtures skipped (set SEVENZIP_BIN)');
    return;
  }
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-7z-'));
  fs.writeFileSync(path.join(TMP, 'a.log'), SAMPLE);
  fs.mkdirSync(path.join(TMP, 'sub'));
  fs.writeFileSync(path.join(TMP, 'sub', 'b.log'), enc(('rotating tag dump rssi=-50\n').repeat(600)));
  fs.writeFileSync(path.join(TMP, 'empty.log'), '');
  z7(['a', '-t7z', '-y', 'solid.7z', 'a.log', 'sub', 'sub/b.log', 'empty.log']);
  z7(['a', '-t7z', '-y', '-mhc=on', 'enchead.7z', 'a.log', 'sub/b.log']);
  z7(['a', '-t7z', '-y', '-ms=off', 'nonsolid.7z', 'a.log', 'sub/b.log', 'empty.log']);
  z7(['a', '-t7z', '-y', '-m0=LZMA', 'lzma1.7z', 'a.log']);
  z7(['a', '-t7z', '-y', '-mx=0', 'copy.7z', 'a.log', 'sub/b.log']);
  z7(['a', '-t7z', '-y', '-pSecret123', 'secret.7z', 'a.log']);
  z7(['a', '-tgzip', '-y', 'a.log.gz', 'a.log']);
  z7(['a', '-t7z', '-y', 'nested.7z', 'a.log.gz']);
  z7(['a', '-tzip', '-y', 'packed.zip', 'a.log', 'sub/b.log']);
});

after(() => {
  if (TMP) fs.rmSync(TMP, { recursive: true, force: true });
});

const withCli = { skip: !find7z() };

test('CLI: solid default archive (LZMA2, subfolder, empty file)', withCli, async () => {
  const buf = fs.readFileSync(path.join(TMP, 'solid.7z'));
  const files = await extractParsed(buf);
  const byName = Object.fromEntries(files.map((f) => [f.name, f]));
  assert.deepStrictEqual(Object.keys(byName).sort(), ['a.log', 'empty.log', 'sub/b.log']);
  assert.strictEqual(dec(byName['a.log'].data), SAMPLE);
  assert.strictEqual(byName['empty.log'].size, 0);
  assert.ok(byName['sub/b.log'].data.length > 1000);
});

test('CLI: compressed header (-mhc=on) parses via kEncodedHeader', withCli, async () => {
  const buf = fs.readFileSync(path.join(TMP, 'enchead.7z'));
  const files = await extractParsed(buf);
  assert.deepStrictEqual(files.map((f) => f.name).sort(), ['a.log', 'sub/b.log']);
  assert.strictEqual(dec(files.find((f) => f.name === 'a.log').data), SAMPLE);
});

test('CLI: non-solid archive (-ms=off, one folder per file)', withCli, async () => {
  const buf = fs.readFileSync(path.join(TMP, 'nonsolid.7z'));
  const files = await extractParsed(buf);
  assert.strictEqual(files.length, 3);
  assert.strictEqual(dec(files.find((f) => f.name === 'a.log').data), SAMPLE);
});

test('CLI: LZMA1 codec (-m0=LZMA)', withCli, async () => {
  const buf = fs.readFileSync(path.join(TMP, 'lzma1.7z'));
  const files = await extractParsed(buf);
  assert.strictEqual(files.length, 1);
  assert.strictEqual(dec(files[0].data), SAMPLE);
});

test('CLI: copy codec (-mx=0)', withCli, async () => {
  const buf = fs.readFileSync(path.join(TMP, 'copy.7z'));
  const files = await extractParsed(buf);
  assert.strictEqual(dec(files.find((f) => f.name === 'a.log').data), SAMPLE);
});

test('CLI: encrypted archive reports a clear error', withCli, () => {
  const buf = fs.readFileSync(path.join(TMP, 'secret.7z'));
  assert.throws(() => F7.parse7z(buf), /encrypt/i);
});

test('CLI: corrupt packed stream is detected', withCli, async () => {
  const buf = new Uint8Array(fs.readFileSync(path.join(TMP, 'solid.7z')));
  buf[40] ^= 0xff; // inside the packed stream (starts at 32)
  await assert.rejects(() => ar.extractArchive('solid.7z', buf), /CRC|corrupt|lzma|end of stream/i);
});

test('CLI: 7-Zip accepts our stored 7z writer output', withCli, () => {
  const buf = F7.write7zStored([
    { name: 'a.log', data: enc('writer output\n') },
    { name: 'sub/b.log', data: enc('second file\n') },
  ]);
  const probe = path.join(TMP, 'writer.7z');
  fs.writeFileSync(probe, buf);
  const r = z7(['t', 'writer.7z']);
  assert.ok(/Everything is Ok/i.test(r.stdout || ''));
});

test('CLI: extractArchive recurses .7z → .gz → log', withCli, async () => {
  const buf = fs.readFileSync(path.join(TMP, 'nested.7z'));
  const out = await ar.extractArchive('nested.7z', buf);
  const log = out.find((e) => e.name === 'nested/a.log');
  assert.ok(log, 'expected nested/a.log in ' + out.map((e) => e.name).join(', '));
  assert.strictEqual(dec(log.data), SAMPLE);
});

test('CLI: extractArchive unpacks deflate zip entries', withCli, async () => {
  const buf = fs.readFileSync(path.join(TMP, 'packed.zip'));
  const out = await ar.extractArchive('packed.zip', buf);
  const log = out.find((e) => e.name === 'packed/a.log');
  assert.ok(log, 'expected packed/a.log, got ' + out.map((e) => e.name).join(', '));
  assert.strictEqual(dec(log.data), SAMPLE);
});

test('CLI: multi-chunk LZMA2 stream (unpacked > 2 MB)', withCli, async () => {
  const big = enc(('09-11 10:10:22.123  1234  5678 D AudioService: poll round %i state=CONNECTED rssi=-50 tag=AudioService\n').repeat(40000)); // ~3.9 MB
  fs.writeFileSync(path.join(TMP, 'big.txt'), big);
  z7(['a', '-t7z', '-y', '-mhc=off', '-ms=off', 'big.7z', 'big.txt']);
  const stream = packStream('big.7z');
  const out = LZ.lzma2Decode(stream, 0, stream.length, big.length);
  assert.deepStrictEqual(out, big);
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function craftArchive(headerBytes, payload) {
  const total = 32 + payload.length + headerBytes.length;
  const out = new Uint8Array(total);
  out.set([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0x00, 0x04], 0);
  const dv = new DataView(out.buffer);
  dv.setBigUint64(12, BigInt(payload.length), true);
  dv.setBigUint64(20, BigInt(headerBytes.length), true);
  dv.setUint32(28, F7.crc32(headerBytes), true);
  dv.setUint32(8, F7.crc32(out.subarray(12, 32)), true);
  out.set(payload, 32);
  out.set(headerBytes, 32 + payload.length);
  return out;
}
