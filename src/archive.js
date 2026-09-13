/* Log Triage — archive.js: compressed archive support (FR-26).
 * Detects, decompresses and re-creates .gz / .tar / .tar.gz / .tgz / .zip
 * archives recursively so log files inside archives flow through the same
 * pipeline as regular files. Browser-only for gzip (DecompressionStream). */
(function (root, factory) { if (typeof module === 'object' && module.exports) { module.exports = factory(); } else { Object.assign((root.LT || (root.LT = {})), factory()); } }(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function detectArchiveType(name) {
    const n = String(name || '').toLowerCase();
    if (n.endsWith('.tar.gz') || n.endsWith('.tgz')) return 'tar.gz';
    if (n.endsWith('.tar')) return 'tar';
    if (n.endsWith('.gz')) return 'gz';
    if (n.endsWith('.zip')) return 'zip';
    return null;
  }

  async function gunzipData(data) {
    const ds = new DecompressionStream('gzip');
    const stream = new Blob([data]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function gzipData(data) {
    const cs = new CompressionStream('gzip');
    const stream = new Blob([data]).stream().pipeThrough(cs);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

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

  function parseTar(data) {
    const entries = [];
    const dec = new TextDecoder();
    let offset = 0;
    while (offset + 512 <= data.length) {
      const header = data.subarray(offset, offset + 512);
      let allZero = true;
      for (let i = 0; i < 512; i++) { if (header[i] !== 0) { allZero = false; break; } }
      if (allZero) break;
      let nameEnd = 0;
      while (nameEnd < 100 && header[nameEnd] !== 0) nameEnd++;
      const name = dec.decode(header.subarray(0, nameEnd));
      const sizeStr = dec.decode(header.subarray(124, 136)).replace(/[\0\s]/g, '');
      const size = parseInt(sizeStr, 8) || 0;
      const type = header[156];
      offset += 512;
      if (type === 0 || type === 48) {
        entries.push({ name, data: new Uint8Array(data.subarray(offset, offset + size)) });
      }
      offset += Math.ceil(size / 512) * 512;
    }
    return entries;
  }

  function writeTar(entries) {
    const blocks = [];
    for (const entry of entries) {
      const header = new Uint8Array(512);
      const nameBytes = new TextEncoder().encode(entry.name);
      header.set(nameBytes.subarray(0, Math.min(100, nameBytes.length)), 0);
      header.set(new TextEncoder().encode('0000644\0'), 100);
      const sizeOct = entry.data.length.toString(8).padStart(11, '0') + '\0';
      header.set(new TextEncoder().encode(sizeOct), 124);
      header.set(new TextEncoder().encode('        '), 148);
      header[156] = 48;
      header.set(new TextEncoder().encode('ustar\0'), 257);
      header.set(new TextEncoder().encode('00'), 263);
      let sum = 0;
      for (const b of header) sum += b;
      const chk = sum.toString(8).padStart(6, '0') + '\0 ';
      header.set(new TextEncoder().encode(chk), 148);
      blocks.push(header);
      blocks.push(entry.data);
      const pad = (512 - (entry.data.length % 512)) % 512;
      if (pad) blocks.push(new Uint8Array(pad));
    }
    blocks.push(new Uint8Array(1024));
    const total = blocks.reduce((s, b) => s + b.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const b of blocks) { out.set(b, off); off += b.length; }
    return out;
  }

  function writeZipStored(entries) {
    const enc = new TextEncoder();
    const chunks = [];
    const central = [];
    let offset = 0;
    for (const entry of entries) {
      const nameBytes = enc.encode(entry.name);
      const data = entry.data;
      const crc = crc32(data);
      const lfh = new Uint8Array(30 + nameBytes.length);
      const lv = new DataView(lfh.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, data.length, true);
      lv.setUint32(22, data.length, true);
      lv.setUint16(26, nameBytes.length, true);
      lfh.set(nameBytes, 30);
      chunks.push(lfh); chunks.push(data);
      central.push({ nameBytes, crc, size: data.length, offset });
      offset += 30 + nameBytes.length + data.length;
    }
    const cdStart = offset;
    for (const c of central) {
      const cd = new Uint8Array(46 + c.nameBytes.length);
      const cv = new DataView(cd.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
      cv.setUint16(28, c.nameBytes.length, true);
      cv.setUint32(42, c.offset, true);
      cd.set(c.nameBytes, 46);
      chunks.push(cd);
      offset += cd.length;
    }
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, central.length, true);
    ev.setUint16(10, central.length, true);
    ev.setUint32(12, offset - cdStart, true);
    ev.setUint32(16, cdStart, true);
    chunks.push(eocd);
    const total = chunks.reduce((s, c) => s + c.length, 0);
    const result = new Uint8Array(total);
    let pos = 0;
    for (const c of chunks) { result.set(c, pos); pos += c.length; }
    return result;
  }

  async function extractArchive(name, data, depth) {
    if (depth > 3) return [{ name, data }];
    const type = detectArchiveType(name);
    if (!type) return [{ name, data }];
    const base = name.replace(/\.(tar\.gz|tgz|tar|gz|zip)$/i, '');
    if (type === 'gz') {
      const inner = await gunzipData(data);
      const innerName = name.replace(/\.gz$/i, '');
      return extractArchive(innerName, inner, depth + 1);
    }
    if (type === 'tar') {
      const out = [];
      for (const entry of parseTar(data)) {
        const sub = await extractArchive(entry.name, entry.data, depth + 1);
        for (const s of sub) { s.name = base + '/' + s.name; out.push(s); }
      }
      return out;
    }
    return [{ name, data }];
  }

  async function buildArchive(entries, format) {
    if (format === 'zip') return writeZipStored(entries);
    if (format === 'tar') return writeTar(entries);
    if (format === 'tar.gz') return gzipData(writeTar(entries));
    const total = entries.reduce((s, e) => s + e.data.length, 0);
    const concat = new Uint8Array(total);
    let pos = 0;
    for (const e of entries) { concat.set(e.data, pos); pos += e.data.length; }
    return gzipData(concat);
  }

  return {
    detectArchiveType, gunzipData, gzipData,
    parseTar, writeTar,
    writeZipStored, crc32,
    extractArchive, buildArchive,
  };
}));
