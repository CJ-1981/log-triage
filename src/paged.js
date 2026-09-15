/* File-backed log index. Offsets are Float64, not 32-bit byte positions. */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(require('./parser.js'), require('./detect.js')); else Object.assign(root.LT || (root.LT = {}), factory(root.LT, root.LT)); }(typeof self !== 'undefined' ? self : this, function (parser, detector) {
  'use strict';
  const BLOCK = 65536;
  const pause = () => new Promise((resolve) => setTimeout(resolve, 0));
  class Column {
    constructor(Type) { this.Type = Type; this.blocks = []; this.length = 0; }
    push(value) { const i = this.length++; const b = Math.floor(i / BLOCK); if (!this.blocks[b]) this.blocks[b] = new this.Type(BLOCK); this.blocks[b][i % BLOCK] = value; }
    get(i) { return this.blocks[Math.floor(i / BLOCK)][i % BLOCK]; }
  }
  function timeKey(ts) { return ts ? Number(ts.replace(/[- :.]/g, '')) : 0; }
  function timeText(key) { const s = String(key).padStart(13, '0'); return s.slice(0, 2) + '-' + s.slice(2, 4) + ' ' + s.slice(4, 6) + ':' + s.slice(6, 8) + ':' + s.slice(8, 10) + '.' + s.slice(10); }

  // Split on UTF-8 LF bytes; never split a logical line at a chunk boundary.
  async function* byteLines(file, onProgress, cancelled) {
    const decoder = new TextDecoder();
    let parts = [], length = 0, start = 0, deadline = performance.now() + 8;
    for (let pos = 0; pos < file.size; pos += 1024 * 1024) {
      if (cancelled && cancelled()) return;
      const chunk = new Uint8Array(await file.slice(pos, pos + 1024 * 1024).arrayBuffer());
      let from = 0;
      for (let i = 0; i < chunk.length; i++) {
        if (chunk[i] !== 10) continue;
        const tail = chunk.subarray(from, i);
        let bytes = tail;
        if (length) { bytes = new Uint8Array(length + tail.length); let p = 0; for (const part of parts) { bytes.set(part, p); p += part.length; } bytes.set(tail, p); }
        yield { raw: decoder.decode(bytes).replace(/\r$/, ''), offset: start };
        parts = []; length = 0; from = i + 1; start = pos + from;
        if (performance.now() > deadline) { if (onProgress) onProgress(pos + from); await pause(); if (cancelled && cancelled()) return; deadline = performance.now() + 8; }
      }
      if (from < chunk.length) { const part = chunk.slice(from); parts.push(part); length += part.length; }
      if (onProgress) onProgress(Math.min(file.size, pos + chunk.length));
    }
    if (length) { const bytes = new Uint8Array(length); let p = 0; for (const part of parts) { bytes.set(part, p); p += part.length; } yield { raw: decoder.decode(bytes).replace(/\r$/, ''), offset: start }; }
  }

  class PagedLog {
    constructor(file, id, base) {
      this.file = file; this.id = id; this.base = base || 0; this.count = 0;
      this.offsets = new Column(Float64Array); this.times = new Column(Float64Array); this.levels = new Column(Uint8Array);
      this.format = 'plain'; this.counts = {}; this.firstLine = ''; this.maxLength = 0;
      this.cache = new Map(); this.cacheBytes = 0;
    }
    async index(onProgress, cancelled, sampleLimit = 2000) {
      const pending = []; let detected = false, lastTime = 0;
      // analysis sample = first half of the budget (file head: format intro,
      // boot lines) + a ring of the newest rest (crashes usually land late).
      // A first-N-only sample would miss end-of-file issues on big logs.
      const headCap = Math.ceil(sampleLimit / 2), tailCap = sampleLimit - headCap;
      const sample = [], tail = new Array(tailCap);
      let tailPos = 0, tailFilled = 0;
      const add = ({ raw, offset }) => {
        const rec = parser.parseLine(raw, this.format);
        if (!this.count) this.firstLine = raw.slice(0, 200);
        this.offsets.push(offset);
        if (rec.ts) lastTime = timeKey(rec.ts);
        this.times.push(lastTime);
        this.levels.push((rec.level ? rec.level.charCodeAt(0) : 0) | (rec.ts ? 0 : 128));
        const key = rec.level || 'null'; this.counts[key] = (this.counts[key] || 0) + 1;
        this.count++; this.maxLength = Math.max(this.maxLength, raw.length);
        if (sample.length < headCap) sample.push(this.record(this.count - 1, raw, rec));
        else { tail[tailPos] = this.record(this.count - 1, raw, rec); tailPos = (tailPos + 1) % tailCap; if (tailFilled < tailCap) tailFilled++; }
      };
      for await (const line of byteLines(this.file, onProgress, cancelled)) {
        if (!detected) { pending.push(line); if (pending.length < 1000) continue; this.format = detector.detectFormat(pending.map((r) => r.raw)).format; pending.forEach(add); pending.length = 0; detected = true; }
        else add(line);
      }
      if (cancelled && cancelled()) throw new Error('Cancelled');
      if (!detected) { this.format = detector.detectFormat(pending.map((r) => r.raw)).format; pending.forEach(add); }
      return sample.concat(tail.slice(tailPos), tail.slice(0, tailPos)).filter(Boolean);
    }
    metadata(i) {
      const code = this.levels.get(i);
      return { ts: code & 128 ? null : timeText(this.times.get(i)), level: code & 127 ? String.fromCharCode(code & 127) : null };
    }
    record(i, raw, parsed) { return Object.assign({ fileId: this.id, file: this.id, lineNo: i + 1, seq: this.base + i + 1, raw }, parsed || parser.parseLine(raw, this.format)); }
    async page(block) {
      if (this.cache.has(block)) { const value = this.cache.get(block); this.cache.delete(block); this.cache.set(block, value); return value.rows; }
      const first = block * 256, end = Math.min(this.count, first + 256);
      if (first >= end) return [];
      const a = this.offsets.get(first), b = end === this.count ? this.file.size : this.offsets.get(end);
      const bytes = new Uint8Array(await this.file.slice(a, b).arrayBuffer());
      if (bytes.length !== b - a) throw new Error('Source file changed or could not be read. Reload the file.');
      const decoder = new TextDecoder(), rows = [];
      for (let i = first; i < end; i++) {
        const from = this.offsets.get(i) - a;
        let to = (i + 1 === this.count ? this.file.size : this.offsets.get(i + 1)) - a;
        if (bytes[to - 1] === 10) to--;
        if (bytes[to - 1] === 13) to--;
        rows.push(this.record(i, decoder.decode(bytes.subarray(from, to))));
      }
      // Bound raw page caching by bytes as well as record count.
      while (this.cache.size && (this.cache.size >= 16 || this.cacheBytes + bytes.length > 8 * 1024 * 1024)) { const key = this.cache.keys().next().value; this.cacheBytes -= this.cache.get(key).bytes; this.cache.delete(key); }
      if (bytes.length <= 8 * 1024 * 1024) { this.cache.set(block, { rows, bytes: bytes.length }); this.cacheBytes += bytes.length; }
      return rows;
    }
    async get(i) { if (i < 0 || i >= this.count) return null; return (await this.page(Math.floor(i / 256)))[i % 256]; }
  }

  // Sort small runs, then merge with yields so new queries/cancellation can run.
  async function sortIds(ids, compare, cancelled, progress) {
    const RUN = 8192;
    for (let i = 0; i < ids.length; i += RUN) { ids.subarray(i, i + RUN).sort(compare); if (cancelled()) return null; if (i % (RUN * 8) === 0) { if (progress) progress(); await pause(); } }
    let src = ids, dst = new Float64Array(ids.length);
    for (let width = RUN; width < ids.length; width *= 2) {
      let deadline = performance.now() + 8;
      for (let from = 0; from < ids.length; from += width * 2) {
        let a = from, b = Math.min(from + width, ids.length); const ae = b, be = Math.min(from + width * 2, ids.length);
        for (let p = from; p < be; p++) {
          dst[p] = a < ae && (b >= be || compare(src[a], src[b]) <= 0) ? src[a++] : src[b++];
          if ((p & 4095) === 0 && performance.now() > deadline) { if (progress) progress(); await pause(); if (cancelled()) return null; deadline = performance.now() + 8; }
        }
      }
      [src, dst] = [dst, src];
    }
    return src;
  }
  return { PagedLog, Column, byteLines, sortIds, timeKey, timeText };
}));
