/* Log Triage — app-export.js: browser sink for streaming exports.
 * Prefers the File System Access API (showSaveFilePicker → writable file
 * stream, uncapped); falls back to a bounded in-memory Blob download when
 * the picker is unavailable (file://, older browsers) or the user cancels
 * a picker error. Browser-only glue. */
(function () {
  'use strict';
  if (typeof window === 'undefined') return;
  const FALLBACK_BYTES = 32 * 1024 * 1024;

  async function openExportSink(opts) {
    const o = opts || {};
    const name = o.name || 'export.txt';
    const mime = o.mime || 'text/plain';
    const limit = o.fallbackBytes || FALLBACK_BYTES;
    const onDownload = o.onDownload || (() => {});
    if (typeof window.showSaveFilePicker === 'function') {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: name,
          types: [{ description: 'Log Triage export', accept: { [mime]: ['.' + (name.split('.').pop() || 'txt')] } }],
        });
        const w = await handle.createWritable();
        let bytes = 0;
        return {
          kind: 'file',
          async write(b) { await w.write(b); bytes += b.byteLength; return bytes; },
          async close() { await w.close(); },
          async abort() { try { await w.abort(); } catch (e) { /* destination may already be closed */ } },
        };
      } catch (err) {
        // the user cancelling the picker is normal cancellation, surfaced via
        // err.cancelled; any other picker error falls back to the download sink
        if (err && err.name === 'AbortError') { const cancel = new Error('export cancelled'); cancel.cancelled = true; throw cancel; }
      }
    }
    let bytes = 0; const chunks = [];
    return {
      kind: 'fallback',
      async write(b) {
        if (bytes + b.byteLength > limit) {
          const err = new Error('Download limit reached. Use a browser with direct file saving, or narrow the export with filters. No download was created.');
          err.limit = true; throw err;
        }
        bytes += b.byteLength; chunks.push(b); return bytes;
      },
      async close() { onDownload(new Blob(chunks, { type: mime }), name); chunks.length = 0; },
      async abort() { chunks.length = 0; },
    };
  }

  Object.assign((window.LT || (window.LT = {})), { openExportSink });
}());