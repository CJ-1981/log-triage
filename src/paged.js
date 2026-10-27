/* File-backed log index. Offsets are Float64, not 32-bit byte positions. */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(require('./parser.js'), require('./detect.js'), require('./decode-dlt.js')); else Object.assign(root.LT || (root.LT = {}), factory(root.LT, root.LT, root.LT)); }(typeof self !== 'undefined' ? self : this, function (parser, detector, dlt) {
  'use strict';
  const BLOCK = 65536;
  // Retained tail when the resync window slides (dltRecordLines): a boundary
  // candidate is undecided while its declared 16-bit total length (at most
  // 65535) — or the 16 storage-header bytes ahead of it — could still fit once
  // more bytes arrive, i.e. while it lies within 65551 bytes of the window
  // end. Keeping 64 KiB plus slack means every byte a slide drops was already
  // probed and can never become acceptable, so the target the scan eventually
  // picks matches a whole-buffer dltFindResync over the same bytes (R5-6).
  const RESYNC_KEEP = 65536 + 64;
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

  // Binary DLT record iterator (SPEC-DLT-BINARY-001 R2-5). Mirrors byteLines'
  // streaming contract — 1 MiB chunks, 8 ms deadline + pause(), cancellation,
  // byte-based onProgress — but walks DLT message boundaries instead of LF
  // splits, buffering a message that spans a chunk boundary. Each yielded
  // entry is one decoded message { raw: rendered line, offset: message start,
  // record: pre-parsed fields }; `offset` is the storage-header position when
  // the record carries one, else the standard header — the dltScanMessages
  // convention, so the page-time [offset, nextOffset) window re-decodes with
  // the same bytes the index-time decode saw (R5-6/AC-3.1: a leading storage
  // header is skipped as framing, a trailing next-record one is ignored via
  // the declared-length bound). Resync, truncation and loud-failure
  // semantics mirror dltScanMessages exactly so identical bytes index
  // identically (R5-6) — when no boundary exists in the buffered window the
  // scan runs as a bounded sliding window (RESYNC_KEEP): each appended chunk
  // is probed once, decided bytes are dropped, and the buffer stays ~1 MiB
  // even on boundary-free tails. Warnings accumulate into `stats` only when
  // the caller passes one — page/worker re-decodes pass none, so the
  // index-time warning count is never mutated (R5-5).
  async function* dltRecordLines(file, onProgress, cancelled, stats, headerSwap) {
    const warn = (n) => { if (stats) stats.warnings += n; };
    let buf = new Uint8Array(0), base = 0, pos = 0, indexed = 0;
    // Standard-header byte order (ADR-0021): the calibrated policy arrives
    // from the PagedLog when it has one (index calibrates on the 64 KB head);
    // standalone callers calibrate once on the first window — it starts at
    // offset 0, which is all the calibration needs. Either way one policy
    // governs every boundary so the streamed walk matches a whole-buffer
    // dltScanMessages over the same bytes (R5-6).
    let swap = headerSwap === null || headerSwap === undefined ? null : !!headerSwap;
    let deadline = performance.now() + 8;
    // Pull the next 1 MiB chunk, dropping the already-consumed prefix so the
    // buffer stays bounded; mirrors byteLines' chunking and progress reports.
    const readChunk = async () => {
      if (pos) { buf = buf.slice(pos); base += pos; pos = 0; }
      const from = base + buf.length;
      const chunk = new Uint8Array(await file.slice(from, Math.min(file.size, from + 1024 * 1024)).arrayBuffer());
      const merged = new Uint8Array(buf.length + chunk.length);
      merged.set(buf); merged.set(chunk, buf.length);
      buf = merged;
      if (onProgress) onProgress(Math.min(file.size, from + chunk.length));
    };
    // Resync state (R5-2/R5-4): `resyncing` probes each appended chunk exactly
    // once from the retained band and slides the window forward, so a
    // boundary-free tail costs one linear pass over a bounded ~1 MiB window
    // instead of a full rescan and file-sized retention per chunk.
    // `scanFrom` is the window-relative resume offset: it stays pinned just
    // past the original implausible boundary until the slide frontier passes
    // it, then reaches 0 so the retained band is re-probed in full — a
    // candidate length-blocked in an earlier round is never skipped.
    // `throwAt` anchors the loud R5-4 error at the original boundary across
    // slides.
    let resyncing = false, throwAt = 0, scanFrom = 0;
    // Drop the consumed/scanned prefix, retaining the RESYNC_KEEP band whose
    // length-blocked candidates a grown window could still accept; `limit`
    // clamps the entry slide so the band never reaches back past the
    // implausible boundary itself (nothing at or before it may be re-probed).
    const slide = (limit) => {
      const drop = Math.min(limit, Math.max(0, buf.length - RESYNC_KEEP));
      if (drop > 0) { buf = buf.slice(drop); base += drop; }
      scanFrom = Math.max(0, scanFrom - drop);
      pos = 0;
    };
    for (;;) {
      if (resyncing) {
        const at = dlt.dltFindResync(buf, scanFrom);
        if (at >= 0) { warn(1); resyncing = false; pos = at; }
        else {
          if (base + buf.length >= file.size) {
            // Every remaining byte probed, no boundary anywhere ahead: loud
            // failure anchored at the original implausible boundary (R5-4).
            throw new Error('dlt: no plausible DLT boundary found after byte ' + throwAt + ' (' + indexed + ' records indexed)');
          }
          if (cancelled && cancelled()) return;
          if (performance.now() > deadline) {
            if (onProgress) onProgress(Math.min(file.size, base + buf.length));
            await pause();
            if (cancelled && cancelled()) return;
            deadline = performance.now() + 8;
          }
          slide(Infinity);
          await readChunk();
          continue;
        }
      }
      if (pos >= buf.length) {
        if (base + buf.length >= file.size) break; // every byte consumed
        if (cancelled && cancelled()) return;
        await readChunk();
        continue;
      }
      while (pos < buf.length) {
        if (swap === null && buf.length >= 8) swap = dlt.dltHeaderSwap(buf);
        const m = dlt.dltDecodeMessage(buf.subarray(pos), swap);
        const storage = dlt.dltIsStorageMagic(buf, pos);
        if (m && m.implausible) {
          // Broken framing at this boundary: scan forward to the next
          // plausible boundary (R5-2). The scan must cover the remaining
          // bytes before failing loudly, so starve for chunks until EOF.
          const at = dlt.dltFindResync(buf, pos + 1);
          if (at >= 0) { warn(1); pos = at; continue; }
          if (base + buf.length < file.size) {
            // No boundary in this window and bytes are still pending: enter
            // the bounded resync-starve loop at the top of the outer loop.
            throwAt = base + pos;
            scanFrom = pos + 1;
            resyncing = true;
            slide(pos + 1);
            break;
          }
          throw new Error('dlt: no plausible DLT boundary found after byte ' + (base + pos) + ' (' + indexed + ' records indexed)');
        }
        if (!m || (m.truncated && base + buf.length < file.size)) break; // message spans the chunk boundary
        if (m.truncated) {
          // At EOF a declared length that overshoots the buffer is either a
          // corrupt length with a plausible boundary inside the span (R5-2
          // resync) or the truncated final message, which decodes as one
          // partial record plus a single warning (R5-1).
          const at = dlt.dltFindResync(buf, pos + 1);
          if (at >= 0) { warn(1); pos = at; continue; }
          warn(m.warnings);
          if (m.record) { indexed++; yield { raw: m.line, offset: base + pos, record: m.record }; }
          pos = buf.length;
          break;
        }
        warn(m.warnings);
        if (m.record) { indexed++; yield { raw: m.line, offset: base + pos, record: m.record }; }
        pos = Math.min(buf.length, pos + (storage ? 16 : 0) + m.consumed);
        if (performance.now() > deadline) {
          if (onProgress) onProgress(Math.min(file.size, base + pos));
          await pause();
          if (cancelled && cancelled()) return;
          deadline = performance.now() + 8;
        }
      }
      // A message ending exactly on the read boundary leaves pos ==
      // buf.length without any starvation: fall through so the tail refills
      // from the file instead of ending the stream with records still unread.
      if (base + buf.length >= file.size) break; // no more bytes will arrive
      if (cancelled && cancelled()) return;
      await readChunk();
    }
  }

  class PagedLog {
    constructor(file, id, base, customFormats, forcedFormat) {
      this.file = file; this.id = id; this.base = base || 0; this.count = 0;
      this.customFormats = customFormats || [];
      this.forcedFormat = forcedFormat || null;
      this.offsets = new Column(Float64Array); this.times = new Column(Float64Array); this.levels = new Column(Uint8Array);
      this.format = forcedFormat || 'plain'; this.counts = {}; this.firstLine = ''; this.maxLength = 0;
      this.warnings = 0; this.storageHeader = false; // dlt-binary diagnostics (R1-5, R5-5)
      this.dltSwap = false; // QNX BE standard-header policy, calibrated at index() (ADR-0021)
      this.cache = new Map(); this.cacheBytes = 0;
      this.utf8 = true; // set false by index() when the head fails strict UTF-8 validation
    }
    async index(onProgress, cancelled, sampleLimit = 2000) {
      // encoding sniff: strict-validate the first 64 KB so the UI can flag
      // files that decode with replacement characters (garbled text). A
      // sequence truncated at the slice boundary is buffered by {stream:true}
      // instead of throwing; the BOM is stripped by the decoder itself.
      // The same head feeds the dlt-binary sniff below, so only one head
      // read happens (plan.md Design Decisions).
      const head = new Uint8Array(await this.file.slice(0, 65536).arrayBuffer());
      try {
        new TextDecoder('utf-8', { fatal: true }).decode(head, { stream: true });
        this.utf8 = true;
      } catch (e) { this.utf8 = false; }
      // Binary DLT classification (R1-1/R1-2), layered above the text scorer
      // and mutually exclusive with it (R1-3/R1-4): the storage-header magic
      // classifies unconditionally; a headerless capture additionally needs
      // dltSniff's chained plausibility look-ahead AND the text veto — the
      // HTYP protocol-version bits alone pass every first byte 0x20-0x3F, so
      // a head the text scorer rates at 0.5 confidence or higher is ordinary
      // text and never dlt-binary.
      const sniffed = dlt.dltSniff(head, this.file.size);
      let binary = !this.forcedFormat && sniffed.binary;
      if (this.forcedFormat === 'dlt-binary') binary = true;
      if (binary && !sniffed.storageHeader && detector.detectFormat(new TextDecoder().decode(head).split('\n'), this.customFormats).confidence >= 0.5) binary = false;
      // analysis sample = first half of the budget (file head: format intro,
      // boot lines) + a ring of the newest rest (crashes usually land late).
      // A first-N-only sample would miss end-of-file issues on big logs.
      const headCap = Math.ceil(sampleLimit / 2), tailCap = sampleLimit - headCap;
      const sample = [], tail = new Array(tailCap);
      let tailPos = 0, tailFilled = 0, lastTime = 0;
      const add = ({ raw, offset, record }) => {
        const rec = record || parser.parseLine(raw, this.format, this.customFormats);
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
      if (binary) {
        this.format = 'dlt-binary';
        this.utf8 = true; // rendered text comes from the decoder, never enc? (R1-1)
        this.storageHeader = sniffed.storageHeader;
        // One byte-order policy, calibrated on the same head the sniff saw,
        // shared by the index walk, worker scans and page re-decode (R5-6).
        this.dltSwap = dlt.dltHeaderSwap(head);
        const stats = { warnings: 0 };
        for await (const rec of dltRecordLines(this.file, onProgress, cancelled, stats, this.dltSwap)) add(rec);
        if (cancelled && cancelled()) throw new Error('Cancelled');
        this.warnings = stats.warnings;
        return sample.concat(tail.slice(tailPos), tail.slice(0, tailPos)).filter(Boolean);
      }
      const pending = []; let detected = !!this.forcedFormat;
      if (this.forcedFormat) this.format = this.forcedFormat;
      for await (const line of byteLines(this.file, onProgress, cancelled)) {
        if (!detected) { pending.push(line); if (pending.length < 1000) continue; this.format = detector.detectFormat(pending.map((r) => r.raw), this.customFormats).format; pending.forEach(add); pending.length = 0; detected = true; }
        else add(line);
      }
      if (cancelled && cancelled()) throw new Error('Cancelled');
      if (!detected) { this.format = detector.detectFormat(pending.map((r) => r.raw), this.customFormats).format; pending.forEach(add); }
      return sample.concat(tail.slice(tailPos), tail.slice(0, tailPos)).filter(Boolean);
    }
    metadata(i) {
      const code = this.levels.get(i);
      return { ts: code & 128 ? null : timeText(this.times.get(i)), level: code & 127 ? String.fromCharCode(code & 127) : null };
    }
    record(i, raw, parsed) { return Object.assign({ fileId: this.id, file: this.id, lineNo: i + 1, seq: this.base + i + 1, raw }, parsed || parser.parseLine(raw, this.format, this.customFormats)); }
    // Format-agnostic record iterator (R3-2): the byteLines text splitter for
    // text formats, the decoded binary record iterator for dlt-binary, so the
    // worker raw-scan loops (full search, quick scan, non-highlight filter
    // rules, export archive scan) resolve their matches in the decoded record
    // index space instead of raw byte-line space.
    async *recordLines(onProgress, cancelled) {
      if (this.format === 'dlt-binary') { yield* dltRecordLines(this.file, onProgress, cancelled, null, this.dltSwap); return; }
      yield* byteLines(this.file, onProgress, cancelled);
    }
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
        if (this.format === 'dlt-binary') {
          // Per-message re-decode replaces CR/LF stripping (R3-1): the window
          // starts at the standard header and every read is bounded by the
          // declared total length, so a trailing next-record storage header
          // inside the window is ignored as framing (AC-3.1). Re-decode is a
          // pure function of the bytes and never touches this.warnings. The
          // index-time byte-order policy is passed explicitly so rows match
          // the index even when the byte-swapped length would also fit (R5-6).
          const m = dlt.dltDecodeMessage(bytes.subarray(from, to), this.dltSwap);
          rows.push(this.record(i, m && m.line != null ? m.line : '', m && m.record ? m.record : { ts: null, level: null, tag: null, pid: null, msg: '' }));
          continue;
        }
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
