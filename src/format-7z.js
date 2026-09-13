/* Log Triage — format-7z.js: 7z container parsing and writing (FR-26).
 * Parses the 7z header tree (pack info, unpack info/folders, substreams,
 * files info) including kEncodedHeader (compressed headers), decodes folders
 * with the copy / LZMA / LZMA2 / deflate coders, and writes .7z archives with
 * stored (copy) entries — LZMA encoding is deliberately not implemented, so
 * exported .7z files keep the container structure without recompression. */
(function (root, factory) { if (typeof module === 'object' && module.exports) { module.exports = factory(); } else { Object.assign((root.LT || (root.LT = {})), factory()); } }(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const LT = typeof module === 'object' && module.exports ? null : (typeof self !== 'undefined' ? self.LT : {});
  const LZ = LT && LT.lzmaDecode ? LT : require('./lzma.js');

  // --- crc32 (local copy: archive.js also has one, but this module must be
  // require-able standalone and archive.js depends on this one, not vice versa) ---
  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      table[i] = c;
    }
    return table;
  })();

  function crc32(data) {
    let crc = 0xffffffff;
    for (let i = 0; i < data.length; i++) {
      crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ data[i]) & 0xff];
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function is7z(data) {
    return data && data.length >= 6 &&
      data[0] === 0x37 && data[1] === 0x7a && data[2] === 0xbc &&
      data[3] === 0xaf && data[4] === 0x27 && data[5] === 0x1c;
  }

  async function inflateRaw(raw) {
    const ds = new DecompressionStream('deflate-raw');
    const stream = new Blob([raw]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  // --- header byte reader ---------------------------------------------------

  function Reader(data) {
    this.data = data;
    this.pos = 0;
  }
  Reader.prototype.byte = function () {
    if (this.pos >= this.data.length) throw new Error('7z: unexpected end of header');
    return this.data[this.pos++];
  };
  Reader.prototype.bytes = function (n) {
    if (this.pos + n > this.data.length) throw new Error('7z: unexpected end of header');
    const out = this.data.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  };
  Reader.prototype.u32 = function () {
    const b = this.bytes(4);
    return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
  };
  /* 7z variable-length number: high bits of the first byte count how many
   * little-endian bytes follow. */
  Reader.prototype.num = function () {
    const first = this.byte();
    let mask = 0x80;
    let value = 0;
    for (let i = 0; i < 8; i++) {
      if ((first & mask) === 0) return value + ((first & (mask - 1)) * Math.pow(2, 8 * i));
      value += this.byte() * Math.pow(2, 8 * i);
      mask >>= 1;
    }
    return value;
  };
  Reader.prototype.id = function () { return this.num(); };
  Reader.prototype.skipProp = function () {
    const size = this.num();
    this.bytes(size);
  };
  Reader.prototype.digests = function (count) {
    const all = this.byte();
    const defined = new Array(count).fill(false);
    if (all) {
      defined.fill(true);
    } else {
      const bits = this.bytes((count + 7) >> 3);
      for (let i = 0; i < count; i++) defined[i] = !!(bits[i >> 3] & (0x80 >> (i & 7)));
    }
    const out = new Array(count).fill(null);
    for (let i = 0; i < count; i++) if (defined[i]) out[i] = this.u32();
    return out;
  };

  // --- coders ---------------------------------------------------------------

  const AES256_SHA256 = [0x06, 0xf1, 0x07, 0x01];

  function codecName(id) {
    const is = (arr) => id.length === arr.length && arr.every((b, i) => id[i] === b);
    if (is([0x00])) return 'copy';
    if (is([0x21])) return 'lzma2';
    if (is([0x03, 0x01, 0x01])) return 'lzma';
    if (is([0x03, 0x04, 0x01])) return 'deflate';
    if (is(AES256_SHA256)) throw new Error('7z: encrypted archives are not supported (AES-256 coder)');
    throw new Error('7z: unsupported coder id ' + Array.from(id).map((b) => b.toString(16).padStart(2, '0')).join(' '));
  }

  function readFolder(R) {
    const numCoders = R.num();
    const coders = [];
    for (let i = 0; i < numCoders; i++) {
      const flags = R.byte();
      const id = R.bytes(flags & 0x0f);
      let numOut = 1;
      let props = null;
      if (flags & 0x10) { R.num(); numOut = R.num(); }
      if (flags & 0x20) props = R.bytes(R.num());
      coders.push({ id, numOut, props });
    }
    // reject unsupported setups with the most specific message available
    for (const c of coders) if (c.id.length === AES256_SHA256.length && c.id.every((b, i) => b === AES256_SHA256[i])) {
      throw new Error('7z: encrypted archives are not supported (AES-256 coder)');
    }
    if (numCoders !== 1 || coders[0].numOut !== 1) {
      throw new Error('7z: unsupported coder chain (' + numCoders + ' coders)');
    }
    return { codec: codecName(coders[0].id), props: coders[0].props, outSize: 0, packOffset: 0, packSize: 0, crc: null };
  }

  function readPackInfo(R, info) {
    info.packPos = R.num();
    const n = R.num();
    let prop = R.id();
    if (prop === 0x09) {
      for (let i = 0; i < n; i++) info.packSizes.push(R.num());
      prop = R.id();
    }
    while (prop !== 0x00) {
      if (prop === 0x0a) R.digests(n);
      else R.skipProp();
      prop = R.id();
    }
  }

  function readUnpackInfo(R, info) {
    if (R.id() !== 0x0b) throw new Error('7z: bad unpack info (missing folder section)');
    const numFolders = R.num();
    if (R.num() !== 0) throw new Error('7z: external folder data not supported');
    for (let i = 0; i < numFolders; i++) info.folders.push(readFolder(R));
    let prop = R.id();
    while (prop !== 0x00) {
      if (prop === 0x0c) { // kCodersUnpackSize: one size per folder (1 out stream each)
        for (let i = 0; i < numFolders; i++) info.folders[i].outSize = R.num();
      } else if (prop === 0x0a) { // kCRC (folder outputs)
        const crcs = R.digests(numFolders);
        for (let i = 0; i < numFolders; i++) info.folders[i].crc = crcs[i];
      } else {
        R.skipProp();
      }
      prop = R.id();
    }
  }

  function readSubStreamsInfo(R, info) {
    const counts = info.folders.map(() => 1);
    let prop = R.id();
    if (prop === 0x0d) {
      for (let i = 0; i < info.folders.length; i++) counts[i] = R.num();
      prop = R.id();
    }
    const anySplit = counts.some((c) => c > 1);
    if (anySplit) {
      if (prop !== 0x09) throw new Error('7z: missing substream sizes');
      for (let i = 0; i < info.folders.length; i++) {
        const n = counts[i];
        if (n === 0) continue;
        if (n === 1) { info.subSizes.push(info.folders[i].outSize); continue; }
        let sum = 0;
        for (let j = 0; j < n - 1; j++) {
          const s = R.num();
          info.subSizes.push(s);
          sum += s;
        }
        const last = info.folders[i].outSize - sum;
        if (last < 0) throw new Error('7z: substream sizes exceed folder size');
        info.subSizes.push(last);
      }
      prop = R.id();
    } else {
      for (let i = 0; i < info.folders.length; i++) {
        for (let j = 0; j < counts[i]; j++) info.subSizes.push(info.folders[i].outSize);
      }
    }
    if (prop === 0x0a) {
      const total = counts.reduce((s, c) => s + c, 0);
      info.subCrcs = R.digests(total);
      prop = R.id();
    }
    if (prop !== 0x00) throw new Error('7z: unexpected substream property ' + prop);
    info.counts = counts;
  }

  function readStreamsInfo(R) {
    const info = { packPos: 0, packSizes: [], folders: [], subSizes: [], subCrcs: null, counts: null };
    let prop = R.id();
    if (prop === 0x06) { readPackInfo(R, info); prop = R.id(); }
    if (prop === 0x07) { readUnpackInfo(R, info); prop = R.id(); }
    if (prop === 0x08) { readSubStreamsInfo(R, info); prop = R.id(); }
    if (prop !== 0x00) throw new Error('7z: unexpected streams info element ' + prop);
    // absent substreams info: one output stream per folder (the 7z default)
    if (!info.counts) {
      info.counts = info.folders.map(() => 1);
      if (info.subSizes.length === 0) info.subSizes = info.folders.map((f) => f.outSize);
    }
    let packOff = info.packPos;
    for (let i = 0; i < info.folders.length; i++) {
      const size = info.packSizes[i];
      if (size == null) throw new Error('7z: missing packed stream size');
      info.folders[i].packOffset = packOff;
      info.folders[i].packSize = size;
      packOff += size;
    }
    return info;
  }

  function readFilesInfo(R) {
    const numFiles = R.num();
    const fi = { numFiles, emptyStream: null, emptyFile: null, nameBytes: null };
    for (;;) {
      const prop = R.id();
      if (prop === 0x00) break;
      const size = R.num();
      const end = R.pos + size;
      if (prop === 0x0e) fi.emptyStream = R.bytes(size);
      else if (prop === 0x0f) fi.emptyFile = R.bytes(size);
      else if (prop === 0x11) {
        if (R.num() !== 0) throw new Error('7z: external file names not supported');
        fi.nameBytes = R.bytes(end - R.pos);
      }
      R.pos = end;
    }
    return fi;
  }

  function bit(bits, i) {
    // 7-Zip bitsets are MSB-first within each byte
    return !!(bits && (bits[i >> 3] & (0x80 >> (i & 7))));
  }

  function decodeNames(nameBytes, numFiles) {
    if (!nameBytes && numFiles > 0) throw new Error('7z: file names missing');
    const names = [];
    let start = 0;
    for (let i = 0; i < numFiles; i++) {
      let end = start;
      while (end + 1 < nameBytes.length && !(nameBytes[end] === 0 && nameBytes[end + 1] === 0)) end += 2;
      const chars = [];
      for (let j = start; j < end; j += 2) chars.push(nameBytes[j] | (nameBytes[j + 1] << 8));
      names.push(String.fromCharCode.apply(null, chars));
      start = end + 2;
    }
    return names;
  }

  function buildFiles(fi, info) {
    const streamMap = [];
    let s = 0;
    for (let f = 0; f < info.folders.length; f++) {
      const count = info.counts ? info.counts[f] : 1;
      let off = 0;
      for (let j = 0; j < count; j++) {
        streamMap.push({ folder: f, offset: off });
        off += info.subSizes[s++];
      }
    }
    const names = decodeNames(fi.nameBytes, fi.numFiles);
    const files = [];
    let next = 0;
    for (let i = 0; i < fi.numFiles; i++) {
      if (bit(fi.emptyStream, i)) {
        files.push({ name: names[i], isDir: !bit(fi.emptyFile, i), size: 0, folder: -1, offset: 0, crc: null });
      } else {
        const m = streamMap[next];
        if (!m) throw new Error('7z: more files than substreams');
        files.push({
          name: names[i], isDir: false, size: info.subSizes[next],
          folder: m.folder, offset: m.offset,
          crc: info.subCrcs ? info.subCrcs[next] : null,
        });
        next++;
      }
    }
    return files;
  }

  // --- decoding -------------------------------------------------------------

  function decodeFolderSync(data, folder) {
    if (folder.codec === 'deflate') throw new Error('7z: deflate coder needs async decode');
    let out;
    if (folder.codec === 'copy') {
      if (folder.packSize !== folder.outSize) throw new Error('7z: copy coder size mismatch');
      out = data.slice(folder.packOffset, folder.packOffset + folder.packSize);
    } else if (folder.codec === 'lzma2') {
      out = LZ.lzma2Decode(data, folder.packOffset, folder.packOffset + folder.packSize, folder.outSize);
    } else if (folder.codec === 'lzma') {
      if (!folder.props || !folder.props.length) throw new Error('7z: LZMA coder missing properties');
      out = LZ.lzmaDecode(data, folder.packOffset, folder.outSize, folder.props[0]);
    } else {
      throw new Error('7z: unsupported codec ' + folder.codec);
    }
    if (folder.crc != null && crc32(out) !== folder.crc) throw new Error('7z: folder CRC mismatch');
    return out;
  }

  async function decode7zFolder(data, folder) {
    if (folder.codec === 'deflate') {
      const raw = data.subarray(folder.packOffset, folder.packOffset + folder.packSize);
      const out = await inflateRaw(raw);
      if (out.length !== folder.outSize) throw new Error('7z: deflate coder size mismatch');
      if (folder.crc != null && crc32(out) !== folder.crc) throw new Error('7z: folder CRC mismatch');
      return out;
    }
    return decodeFolderSync(data, folder);
  }

  /** Parse a .7z archive into { files, folders }. Sync: only the header tree
   * is touched; folder payloads are decoded separately via decode7zFolder.
   * files: [{ name, isDir, size, folder, offset, crc }] where folder/offset
   * address the decoded folder output. */
  function parse7z(data) {
    if (!is7z(data)) throw new Error('7z: not a 7z archive (bad magic)');
    if (data.length < 32) throw new Error('7z: truncated archive (signature header)');
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (crc32(data.subarray(12, 32)) !== dv.getUint32(8, true)) throw new Error('7z: start header CRC mismatch');
    const nextOff = Number(dv.getBigUint64(12, true));
    const nextSize = Number(dv.getBigUint64(20, true));
    const nextCrc = dv.getUint32(28, true);
    const hdrStart = 32 + nextOff;
    if (hdrStart + nextSize > data.length) throw new Error('7z: truncated archive (next header)');
    if (nextSize === 0) return { files: [], folders: [] };
    let root = data.subarray(hdrStart, hdrStart + nextSize);
    if (crc32(root) !== nextCrc) throw new Error('7z: header CRC mismatch (archive corrupted)');

    let R = new Reader(root);
    let top = R.id();
    if (top === 0x17) { // kEncodedHeader: the real header is itself a stream
      const info = readStreamsInfo(R);
      if (info.folders.length !== 1) throw new Error('7z: bad encoded header');
      if (info.folders[0].codec === 'deflate') throw new Error('7z: deflate-compressed headers not supported');
      const folder = info.folders[0];
      folder.packOffset += 32; // pack offsets are relative to the data area start
      root = decodeFolderSync(data, folder);
      R = new Reader(root);
      top = R.id();
    }
    if (top !== 0x01) throw new Error('7z: unexpected header id ' + top);

    let streams = null;
    let fi = null;
    for (;;) {
      const prop = R.id();
      if (prop === 0x00) break;
      if (prop === 0x02) throw new Error('7z: archive properties not supported');
      if (prop === 0x03) throw new Error('7z: additional streams not supported');
      else if (prop === 0x04) streams = readStreamsInfo(R);
      else if (prop === 0x05) fi = readFilesInfo(R);
      else throw new Error('7z: unsupported header element ' + prop);
    }
    if (streams) for (const f of streams.folders) f.packOffset += 32;
    if (!fi) return { files: [], folders: streams ? streams.folders : [] };
    return { files: buildFiles(fi, streams || { folders: [], subSizes: [], subCrcs: null, counts: null }), folders: streams ? streams.folders : [] };
  }

  // --- writing (stored entries, copy coder) ---------------------------------

  function push(arr, b) { arr.push(b & 0xff); }
  function pushU32(arr, v) {
    arr.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
  }
  function pushNum(arr, v) {
    if (v < 0x80) { arr.push(v); return; }
    let n = 1;
    while (n < 8) {
      if ((v / Math.pow(2, 8 * n)) < (0x80 >> n)) break;
      n++;
    }
    const high = Math.floor(v / Math.pow(2, 8 * n));
    arr.push(((0xff << (8 - n)) & 0xff) | high);
    for (let i = 0; i < n; i++) arr.push(Math.floor(v / Math.pow(2, 8 * i)) & 0xff);
  }
  function utf16leNames(names) {
    const out = [];
    for (const name of names) {
      for (let i = 0; i < name.length; i++) {
        const c = name.charCodeAt(i);
        out.push(c & 0xff, (c >> 8) & 0xff);
      }
      out.push(0, 0);
    }
    return out;
  }

  function assemble(payload, headerBytes) {
    const out = new Uint8Array(32 + payload.length + headerBytes.length);
    out.set([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0x00, 0x04], 0);
    const dv = new DataView(out.buffer);
    dv.setBigUint64(12, BigInt(payload.length), true);
    dv.setBigUint64(20, BigInt(headerBytes.length), true);
    dv.setUint32(28, crc32(headerBytes), true);
    dv.setUint32(8, crc32(out.subarray(12, 32)), true);
    out.set(payload, 32);
    out.set(headerBytes, 32 + payload.length);
    return out;
  }

  /** Build a valid .7z with one copy-coded folder per entry (no recompression).
   * opts.encodeHeader wraps the header in a kEncodedHeader stream (still
   * stored); opts.digests=false omits CRC32 digests. */
  function write7zStored(entries, opts) {
    const o = opts || {};
    const files = entries.map((e) => ({ name: String(e.name), data: e.data || new Uint8Array(0) }));
    const n = files.length;
    const sizes = files.map((f) => f.data.length);
    const crcs = files.map((f) => crc32(f.data));
    const digests = o.digests !== false;

    let dataLen = 0;
    for (const s of sizes) dataLen += s;

    const h = [];
    push(h, 0x01); // kHeader
    push(h, 0x04); // kMainStreamsInfo
    push(h, 0x06); // kPackInfo
    pushNum(h, 0);
    pushNum(h, n);
    if (n > 0) { push(h, 0x09); for (const s of sizes) pushNum(h, s); }
    push(h, 0x00);
    push(h, 0x07); // kUnpackInfo
    push(h, 0x0b); // kFolder
    pushNum(h, n);
    push(h, 0x00); // external
    for (let i = 0; i < n; i++) {
      push(h, 0x01); // numCoders
      push(h, 0x01); // coder flags: idSize=1
      push(h, 0x00); // copy coder id
    }
    push(h, 0x0c); // kCodersUnpackSize (one per folder output stream)
    for (let i = 0; i < n; i++) pushNum(h, sizes[i]);
    push(h, 0x00); // kEnd (unpack info)
    if (digests && n > 0) {
      push(h, 0x08); // kSubStreamsInfo
      push(h, 0x0a); // kCRC
      push(h, 0x01);
      for (const c of crcs) pushU32(h, c);
      push(h, 0x00);
    }
    push(h, 0x00); // kEnd (streams info)
    push(h, 0x05); // kFilesInfo
    pushNum(h, n);
    if (n > 0) {
      const nameBytes = utf16leNames(files.map((f) => f.name));
      push(h, 0x11); // kName
      pushNum(h, nameBytes.length + 1);
      push(h, 0x00); // external
      for (const b of nameBytes) push(h, b);
    }
    push(h, 0x00); // kEnd (files info)
    push(h, 0x00); // kEnd (header)

    const data = new Uint8Array(dataLen);
    let off = 0;
    for (const f of files) { data.set(f.data, off); off += f.data.length; }

    if (!o.encodeHeader) return assemble(data, h);

    // kEncodedHeader: the header bytes are themselves a copy-coded stream
    // placed after the file data; the next header is a small 0x17 wrapper.
    const body = [];
    push(body, 0x06);
    pushNum(body, dataLen);
    pushNum(body, 1);
    push(body, 0x09); pushNum(body, h.length);
    push(body, 0x00);
    push(body, 0x07);
    push(body, 0x0b); pushNum(body, 1); push(body, 0x00);
    push(body, 0x01); push(body, 0x01); push(body, 0x00);
    push(body, 0x0c); pushNum(body, h.length);
    push(body, 0x00);
    push(body, 0x00);
    const outer = [0x17];
    for (const b of body) outer.push(b);
    outer.push(0x00);
    const payload = new Uint8Array(dataLen + h.length);
    payload.set(data, 0);
    payload.set(h, dataLen);
    return assemble(payload, outer);
  }

  return {
    is7z, crc32, parse7z,
    decode7zFolder, decodeFolderSync,
    write7zStored,
  };
}));
