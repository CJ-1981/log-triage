/* Log Triage — archive.js: compressed archive support (FR-26).
 * Detects, decompresses and re-creates .gz / .tar / .tar.gz / .tgz / .zip /
 * .7z archives recursively so log files inside archives flow through the same
 * pipeline as regular files. gzip/zip-deflate use DecompressionStream, the
 * 7z container (incl. LZMA/LZMA2) lives in format-7z.js + lzma.js. */
(function (root, factory) { if (typeof module === 'object' && module.exports) { module.exports = factory(); } else { Object.assign((root.LT || (root.LT = {})), factory()); } }(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const LT = typeof module === 'object' && module.exports ? null : (typeof self !== 'undefined' ? self.LT : {});
  const F7 = LT && LT.parse7z ? LT : require('./format-7z.js');

  function detectArchiveType(name) {
    const n = String(name || '').toLowerCase();
    if (n.endsWith('.tar.gz') || n.endsWith('.tgz')) return 'tar.gz';
    if (n.endsWith('.tar')) return 'tar';
    if (n.endsWith('.gz')) return 'gz';
    if (n.endsWith('.zip')) return 'zip';
    if (n.endsWith('.7z')) return '7z';
    return null;
  }

  async function gunzipData(data) {
    const ds = new DecompressionStream('gzip');
    const stream = new Blob([data]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function inflateRaw(data) {
    const ds = new DecompressionStream('deflate-raw');
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
      // header checksum: sum of all bytes with the chksum field read as spaces
      let sum = 0;
      for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : header[i];
      const chkStr = dec.decode(header.subarray(148, 156)).replace(/[\0\s]/g, '');
      const chk = parseInt(chkStr, 8);
      if (chkStr && !isNaN(chk) && chk !== sum) throw new Error('tar: header checksum mismatch at offset ' + offset);
      let nameEnd = 0;
      while (nameEnd < 100 && header[nameEnd] !== 0) nameEnd++;
      let name = dec.decode(header.subarray(0, nameEnd));
      if (header[124] & 0x80) throw new Error('tar: base-256 sizes are not supported');
      const sizeStr = dec.decode(header.subarray(124, 136)).replace(/[\0\s]/g, '');
      const size = parseInt(sizeStr, 8) || 0;
      // ustar prefix extends names beyond 100 chars
      if (dec.decode(header.subarray(257, 262)) === 'ustar') {
        let pEnd = 345;
        while (pEnd < 500 && header[pEnd] !== 0) pEnd++;
        const prefix = dec.decode(header.subarray(345, pEnd));
        if (prefix) name = prefix + '/' + name;
      }
      const type = header[156];
      offset += 512;
      if (type === 0 || type === 48) {
        if (offset + size > data.length) throw new Error('tar: truncated entry ' + name);
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
    if (entries.length > 65535) throw new Error('zip: too many entries for a non-zip64 archive (' + entries.length + ')');
    const enc = new TextEncoder();
    const chunks = [];
    const central = [];
    let offset = 0;
    for (const entry of entries) {
      const nameBytes = enc.encode(entry.name);
      const data = entry.data;
      if (data.length > 0xffffffff - 1) throw new Error('zip: entry too large for a non-zip64 archive: ' + entry.name);
      if (offset > 0xffffffff - 1) throw new Error('zip: archive too large for a non-zip64 archive');
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
      cv.setUint32(16, c.crc, true);
      cv.setUint32(20, c.size, true);
      cv.setUint32(24, c.size, true);
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

  /* Untrusted-header guards: archives are attacker/user-controlled bytes, so
   * extraction caps nesting depth and cumulative output instead of allocating
   * whatever a header claims (decompression-bomb protection). */
  const MAX_DEPTH = 12;
  const MAX_INPUT_BYTES = 2 * 1024 * 1024 * 1024;   // per top-level archive file
  const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024; // cumulative per extractArchive call
  const MAX_CHILD_BYTES = 512 * 1024 * 1024;   // per extracted child entry (zip/7z/tar)
  const BOARD_TEXT_BYTES = 64 * 1024 * 1024;   // text kept from converted board dumps
  const BOARD_BIN_RE = /(^|\/)dumpstate_board\.bin$/i; // Android bugreport board dump
  let extractedBudget = MAX_TOTAL_BYTES;

  function budgetTake(n) {
    if (n > extractedBudget) throw new Error('archive expands beyond the ' + MAX_TOTAL_BYTES + ' byte safety cap');
    extractedBudget -= n;
  }

  /* A Uint8Array as a pull ReadableStream (zero-copy subarray views). */
  function u8Stream(u8, chunkSize) {
    const size = chunkSize || 1024 * 1024;
    let pos = 0;
    return new ReadableStream({
      pull(ctrl) {
        if (pos >= u8.length) { ctrl.close(); return; }
        ctrl.enqueue(u8.subarray(pos, Math.min(u8.length, pos + size)));
        pos += size;
      },
    });
  }

  /* Incremental CRC-32 (pre-final-xor form: start from 0xffffffff, finish
   * with (crc ^ 0xffffffff) >>> 0) so streamed data can be verified without
   * holding it all in memory. */
  function crc32Chunk(crc, u8) {
    for (let i = 0; i < u8.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ u8[i]) & 0xff];
    return crc;
  }

  /* dumpstate_board.bin (Android bugreports) is a binary blob that embeds the
   * board's text logs (kernel/logcat history, vendor logs) — 1.5 GB blobs are
   * common, so `src` is consumed as a stream (Uint8Array, ReadableStream or
   * iterable of chunks) and the inflated bytes are never materialized: text
   * runs (>= 8 bytes, >= 80% printable) are tallied per byte and only the
   * newest maxBytes of accepted run bytes is retained. onBytes, when given,
   * sees every decoded chunk (used for on-the-fly CRC verification). */
  async function boardBinToText(src, maxBytes, onProgress, onBytes) {
    const isTextByte = (c) => c === 9 || c === 10 || c === 13 || (c >= 32 && c !== 127);
    const msg = (m) => { if (onProgress) onProgress(m); };
    // segment deques with head indices — Array.shift() is O(n), which across
    // ~160k small decoder chunks on a 1.5 GB board dump would be quadratic
    const kept = []; let keptHead = 0; let keptTotal = 0;
    const cand = []; let candHead = 0; let candTotal = 0;
    let runLen = 0, runGood = 0; // counters over the WHOLE current run
    let scanBytes = 0;
    let lastYield = Date.now();
    let lastMsgMB = -1;

    const endRun = () => {
      if (runLen >= 8 && runGood / runLen >= 0.8) {
        while (candHead < cand.length) kept.push(cand[candHead++]);
        cand.length = 0; candHead = 0;
        keptTotal += candTotal;
        while (keptTotal > maxBytes) {
          const excess = keptTotal - maxBytes;
          const head = kept[keptHead];
          if (excess >= head.length) { keptTotal -= head.length; keptHead++; }
          else { kept[keptHead] = head.subarray(excess); keptTotal -= excess; }
        }
        if (keptHead > 8192 && keptHead * 2 > kept.length) { kept.splice(0, keptHead); keptHead = 0; }
      } else {
        cand.length = 0; candHead = 0;
      }
      candTotal = 0; runLen = 0; runGood = 0;
    };

    async function* chunks() {
      if (src instanceof Uint8Array) { yield src; return; }
      if (typeof src.getReader === 'function') {
        const reader = src.getReader();
        for (;;) {
          const r = await reader.read();
          if (r.done) return;
          yield r.value;
        }
      }
      yield* src;
    }

    for await (const chunk of chunks()) {
      if (onBytes) onBytes(chunk);
      scanBytes += chunk.length;
      let i = 0;
      while (i < chunk.length) {
        if (!isTextByte(chunk[i])) { endRun(); i++; continue; }
        let j = i, good = 0;
        while (j < chunk.length) {
          const c = chunk[j];
          if (!isTextByte(c)) break;
          if ((c >= 32 && c <= 126) || c === 9) good++;
          j++;
        }
        const seg = chunk.subarray(i, j);
        runLen += seg.length; runGood += good;
        cand.push(seg); candTotal += seg.length;
        while (candTotal > maxBytes) {
          const excess = candTotal - maxBytes;
          const head = cand[candHead];
          if (excess >= head.length) { candTotal -= head.length; candHead++; }
          else { cand[candHead] = head.subarray(excess); candTotal -= excess; }
        }
        if (candHead > 8192 && candHead * 2 > cand.length) { cand.splice(0, candHead); candHead = 0; }
        i = j;
      }
      // decoder chunks are small (~10-64 KB) — yield to the event loop and
      // repaint progress at most every ~32 ms, not once per chunk
      const now = Date.now();
      if (now - lastYield >= 32) {
        lastYield = now;
        const mb = Math.floor(scanBytes / 16777216);
        if (mb !== lastMsgMB) { lastMsgMB = mb; msg('scanning binary board dump (' + (scanBytes / 1048576).toFixed(0) + ' MB)'); }
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
    endRun();
    const out = new Uint8Array(keptTotal);
    let o = 0;
    for (let k = keptHead; k < kept.length; k++) { out.set(kept[k], o); o += kept[k].length; }
    return out;
  }

  async function extractZip(data, depth, base, onProgress) {
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let eocd = -1;
    const min = Math.max(0, data.length - 65557);
    for (let i = data.length - 22; i >= min; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('zip: end of central directory not found');
    const count = dv.getUint16(eocd + 10, true);
    let cd = dv.getUint32(eocd + 16, true);
    const dec = new TextDecoder();
    const out = [];
    for (let n = 0; n < count; n++) {
      if (cd + 46 > data.length || dv.getUint32(cd, true) !== 0x02014b50) throw new Error('zip: bad central directory');
      const flags = dv.getUint16(cd + 8, true);
      const method = dv.getUint16(cd + 10, true);
      const crc = dv.getUint32(cd + 16, true);
      const compSize = dv.getUint32(cd + 20, true);
      const uncompSize = dv.getUint32(cd + 24, true);
      const nameLen = dv.getUint16(cd + 28, true);
      const extraLen = dv.getUint16(cd + 30, true);
      const cmtLen = dv.getUint16(cd + 32, true);
      const localOff = dv.getUint32(cd + 42, true);
      const name = dec.decode(data.subarray(cd + 46, cd + 46 + nameLen));
      cd += 46 + nameLen + extraLen + cmtLen;
      if (name.endsWith('/')) continue; // directory entry
      if (flags & 1) throw new Error('zip: encrypted entries are not supported (' + name + ')');
      if (uncompSize === 0xffffffff || localOff === 0xffffffff) throw new Error('zip: zip64 entries are not supported');
      // giant entries (e.g. a 1.5 GB dumpstate_board.bin in Android bugreports)
      // are binary blobs useless for log triage and would blow the memory budget:
      // skip them with an announced message instead of allocating — except the
      // board dump, whose conversion output is capped (see below)
      if (uncompSize > MAX_CHILD_BYTES && !BOARD_BIN_RE.test(name)) {
        onProgress('skipping ' + name + ' — entry too large (' + (uncompSize / 1048576).toFixed(0) + ' MB)');
        continue;
      }
      if (localOff + 30 > data.length || dv.getUint32(localOff, true) !== 0x04034b50) throw new Error('zip: corrupt local header for ' + name);
      const lnLen = dv.getUint16(localOff + 26, true);
      const leLen = dv.getUint16(localOff + 28, true);
      const start = localOff + 30 + lnLen + leLen;
      if (start + compSize > data.length) throw new Error('zip: truncated entry ' + name);
      const isBoardBin = BOARD_BIN_RE.test(name);
      const raw = data.subarray(start, start + compSize);
      // reserve the claimed output BEFORE inflating, so a tiny deflate stream
      // claiming gigabytes is refused by the budget instead of OOM-ing first —
      // the board dump's claim is capped at the child cap (its CD may overclaim)
      budgetTake(isBoardBin ? Math.min(uncompSize, MAX_CHILD_BYTES) : uncompSize);
      // dumpstate_board.bin: a binary blob that embeds the board's text logs
      // (real bugreports carry 1.5 GB blobs). Stream-decode it straight into
      // the text-run scanner — the inflated blob is never materialized — and
      // keep the newest capped text as a virtual .log. CRC is checked on the
      // fly (streaming) instead of the size match, which an overclaiming CD
      // would fail.
      if (isBoardBin) {
        if (method !== 0 && method !== 8) throw new Error('zip: unsupported compression method ' + method);
        onProgress('converting ' + name + ' to text…');
        let crcRun = 0xffffffff;
        const stream = method === 0
          ? u8Stream(raw)
          : u8Stream(raw).pipeThrough(new DecompressionStream('deflate-raw'));
        const text = await boardBinToText(stream, BOARD_TEXT_BYTES, onProgress, (chunk) => { crcRun = crc32Chunk(crcRun, chunk); });
        if (crc !== 0 && (crcRun ^ 0xffffffff) >>> 0 !== crc) throw new Error('zip: CRC mismatch for ' + name);
        out.push({ name: base + '/' + name + '.log', data: text });
        continue;
      }
      let inner;
      if (method === 0) {
        inner = raw;
      } else if (method === 8) {
        inner = await inflateRaw(raw);
      } else {
        throw new Error('zip: unsupported compression method ' + method);
      }
      if (inner.length !== uncompSize) throw new Error('zip: size mismatch for ' + name);
      // verify whenever the central directory carries a CRC (streaming writers
      // with flags bit 3 may legally store 0 there)
      if (crc !== 0 && crc32(inner) !== crc) throw new Error('zip: CRC mismatch for ' + name);
      const sub = await extractArchive(name, inner, depth + 1, onProgress);
      for (const s of sub) { s.name = base + '/' + s.name; out.push(s); }
    }
    return out;
  }

  async function extract7z(data, depth, base, name, onProgress) {
    const parsed = F7.parse7z(data);
    const decoded = [];
    for (let i = 0; i < parsed.folders.length; i++) {
      onProgress('decompressing ' + name + ' (block ' + (i + 1) + '/' + parsed.folders.length + ')');
      if (parsed.folders[i].outSize > MAX_CHILD_BYTES) {
        // solid 7z folders bundle several files: a giant decoded folder cannot
        // be skipped per-entry, so refuse it with a readable message
        throw new Error('7z: decoded block too large (' + (parsed.folders[i].outSize / 1048576).toFixed(0) + ' MB) — re-pack smaller files without solid mode');
      }
      budgetTake(parsed.folders[i].outSize); // claimed decoded size, before allocating it
      // let the progress message paint before the (synchronous) LZMA decode
      await new Promise((resolve) => setTimeout(resolve, 0));
      decoded.push(await F7.decode7zFolder(data, parsed.folders[i]));
    }
    const real = parsed.files.filter((f) => !f.isDir);
    const out = [];
    for (let i = 0; i < real.length; i++) {
      const f = real[i];
      onProgress('extracting ' + f.name + ' (' + (i + 1) + '/' + real.length + ')');
      const blob = f.size ? decoded[f.folder].subarray(f.offset, f.offset + f.size) : new Uint8Array(0);
      if (f.crc != null && blob.length && F7.crc32(blob) !== f.crc) throw new Error('7z: CRC mismatch for ' + f.name);
      const sub = await extractArchive(f.name, blob, depth + 1, onProgress);
      for (const s of sub) { s.name = base + '/' + s.name; out.push(s); }
    }
    return out;
  }

  async function extractArchive(name, data, depth, onProgress) {
    if (!onProgress) onProgress = () => {};
    depth = depth || 0; // guard against NaN depth arithmetic if omitted
    if (depth === 0) {
      extractedBudget = MAX_TOTAL_BYTES;
      // the file the user dropped: cap its size, but against the input limit —
      // not the per-extraction budget (a large legit .gz must still open)
      if (data.length > MAX_INPUT_BYTES) throw new Error('archive file too large (' + data.length + ' bytes)');
    }
    budgetTake(data.length);
    if (depth > 0) onProgress('extracting ' + name + ' (level ' + depth + ')');
    const type = detectArchiveType(name);
    if (!type) {
      // a directly dropped board dump converts the same way as one inside a
      // zip — its text content is what the user is after
      if (BOARD_BIN_RE.test(name) && data.length) {
        onProgress('converting ' + name + ' to text…');
        const text = await boardBinToText(data, BOARD_TEXT_BYTES, onProgress);
        budgetTake(text.length);
        return [{ name: name + '.log', data: text }];
      }
      return [{ name, data }]; // plain file: fine at any depth
    }
    if (depth > MAX_DEPTH) throw new Error('archive nesting too deep (over ' + MAX_DEPTH + ' levels) at ' + name);
    const base = name.replace(/\.(tar\.gz|tgz|tar|gz|zip|7z)$/i, '');
    if (type === 'gz' || type === 'tar.gz') { // .tar.gz/.tgz gunzip to a .tar the tar branch handles
      onProgress('decompressing ' + name + '…');
      const inner = await gunzipData(data);
      const innerName = type === 'tar.gz' ? name.replace(/(\.tar\.gz|\.tgz)$/i, '.tar') : name.replace(/\.gz$/i, '');
      return extractArchive(innerName, inner, depth + 1, onProgress);
    }
    if (type === 'zip') {
      onProgress('decompressing ' + name + '…');
      return extractZip(data, depth, base, onProgress);
    }
    if (type === '7z') {
      onProgress('decompressing ' + name + '…');
      return extract7z(data, depth, base, name, onProgress);
    }
    if (type === 'tar') {
      // some devices ship gzip bytes under a .tar name (TCAM kmesglog_*.tar):
      // sniff the gzip magic and decompress before the tar parse
      if (data.length > 2 && data[0] === 0x1f && data[1] === 0x8b) {
        onProgress('decompressing ' + name + '…');
        data = await gunzipData(data);
      }
      const out = [];
      const entries = parseTar(data);
      for (let i = 0; i < entries.length; i++) {
        onProgress('extracting ' + entries[i].name + ' (' + (i + 1) + '/' + entries.length + ')');
        const sub = await extractArchive(entries[i].name, entries[i].data, depth + 1, onProgress);
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
    if (format === '7z') return F7.write7zStored(entries);
    const total = entries.reduce((s, e) => s + e.data.length, 0);
    const concat = new Uint8Array(total);
    let pos = 0;
    for (const e of entries) { concat.set(e.data, pos); pos += e.data.length; }
    return gzipData(concat);
  }

  return {
    detectArchiveType, gunzipData, gzipData, inflateRaw,
    parseTar, writeTar,
    writeZipStored, crc32,
    boardBinToText,
    extractArchive, buildArchive,
  };
}));
