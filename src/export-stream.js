/* Log Triage — export-stream.js: pure serialization and chunk writing for
 * exports. Converts an async iterable of already-masked record batches into
 * encoded chunks and writes them to a sink without ever holding the whole
 * output in memory. No browser or worker APIs here — fully unit-testable. */
(function (root, factory) { if (typeof module === 'object' && module.exports) { module.exports = factory(); } else { Object.assign((root.LT || (root.LT = {})), factory()); } }(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function prefixLine(rec, prefix) {
    if (prefix === 'ln') return '[L' + rec.lineNo + '] ' + rec.raw;
    if (prefix === 'file:line') return rec.file + ':' + rec.lineNo + ': ' + rec.raw;
    return rec.raw;
  }

  function csvField(s) {
    s = String(s == null ? '' : s);
    if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function exportRow(r) {
    return {
      file: r.file, lineNo: r.lineNo, ts: r.ts, level: r.level,
      tag: r.tag, pid: r.pid, message: r.msg != null ? r.msg : r.raw,
    };
  }

  /** Serialize masked record batches into encoded chunks. Zero rows produce a
   * valid empty output for every format (CSV keeps its header). */
  function serializeExport(batches, opts) {
    const o = opts || {};
    const format = o.format || 'txt';
    const prefix = o.prefix || 'none';
    const encoder = new TextEncoder();
    async function* gen() {
      if (format === 'json') yield encoder.encode('[\n');
      else if (format === 'csv') yield encoder.encode('file,lineNo,ts,level,tag,pid,message\n');
      let first = true;
      for await (const batch of batches) {
        for (const r of batch) {
          if (format === 'txt') yield encoder.encode(prefixLine(r, prefix) + '\n');
          else if (format === 'csv') {
            yield encoder.encode([r.file, r.lineNo, r.ts || '', r.level || '', r.tag || '', r.pid || '', r.msg != null ? r.msg : r.raw]
              .map(csvField).join(',') + '\n');
          } else if (format === 'json') {
            yield encoder.encode((first ? '' : ',\n') + JSON.stringify(exportRow(r)));
          }
          first = false;
        }
      }
      if (format === 'json') yield encoder.encode('\n]');
    }
    return gen();
  }

  /** Await each sink write in order, count bytes, close on success and abort
   * on failure (keeping the original error). Returns the bytes written. */
  async function writeChunks(chunks, sink, opts) {
    const o = opts || {};
    const signal = o.signal || null;
    const onBytes = o.onBytes || (() => {});
    let written = 0;
    try {
      for await (const bytes of chunks) {
        if (signal && signal.aborted) throw new Error('export cancelled');
        await sink.write(bytes);
        written += bytes.byteLength;
        onBytes(written);
      }
      if (signal && signal.aborted) throw new Error('export cancelled');
      await sink.close();
      return written;
    } catch (error) {
      try { await sink.abort(error); } catch (e) { /* keep the original error */ }
      throw error;
    }
  }

  return { serializeExport, writeChunks, csvField, prefixLine };
}));
