/* Log Triage — exporter.js: sanitized export builders (pure string builders).
 * All exports receive already-masked text from the caller; the exporter never
 * unmasks. rg-style text distinguishes match lines (file:line:) from context
 * lines (file:line-). */
(function (root, factory) { if (typeof module === 'object' && module.exports) { module.exports = factory(); } else { Object.assign((root.LT || (root.LT = {})), factory()); } }(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function prefixLine(rec, prefix) {
    if (prefix === 'ln') return '[L' + rec.lineNo + '] ' + rec.raw;
    if (prefix === 'file:line') return rec.file + ':' + rec.lineNo + ': ' + rec.raw;
    return rec.raw;
  }

  function toText(records, opts) {
    const o = opts || {};
    return records.map((r) => prefixLine(r, o.prefix || 'none')).join('\n');
  }

  function csvField(s) {
    s = String(s == null ? '' : s);
    if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function toCsv(records) {
    const head = 'file,lineNo,ts,level,tag,pid,message';
    const rows = records.map((r) => [
      r.file, r.lineNo, r.ts || '', r.level || '', r.tag || '', r.pid || '', r.msg != null ? r.msg : r.raw,
    ].map(csvField).join(','));
    return [head].concat(rows).join('\n');
  }

  function toJson(records) {
    return JSON.stringify(records.map((r) => ({
      file: r.file, lineNo: r.lineNo, ts: r.ts, level: r.level,
      tag: r.tag, pid: r.pid, message: r.msg != null ? r.msg : r.raw,
    })), null, 2);
  }

  function toRgText(rows) {
    return rows.map((r) => (r.isMatch === false
      ? r.file + ':' + r.lineNo + '- ' + r.text
      : r.file + ':' + r.lineNo + ': ' + r.text)).join('\n');
  }

  function searchToJson(rows) {
    return JSON.stringify(rows.map((r) => ({
      file: r.file, lineNo: r.lineNo, match: r.isMatch !== false, text: r.text,
    })), null, 2);
  }

  function bookmarksToJson(bookmarkStore) {
    return JSON.stringify(bookmarkStore.toJSON(), null, 2);
  }

  /** Cloned, sanitized bookmark JSON for export: snippets and user notes are
   * masked via the supplied function; stored bookmarks are never mutated and
   * identity keys/line numbers stay intact for reimport (ADR: filenames and
   * identity metadata are not anonymized). */
  function sanitizeBookmarkPayload(payload, maskText) {
    const clean = (v) => (v ? maskText(String(v)) : v);
    return Object.fromEntries(Object.entries(payload || {}).map(([key, entries]) => [key,
      (entries || []).map((entry) => Object.assign({}, entry, {
        meta: Object.assign({}, entry.meta, { snippet: clean(entry.meta && entry.meta.snippet) }),
        note: clean(entry.note),
      })),
    ]));
  }

  return { toText, toCsv, toJson, toRgText, searchToJson, bookmarksToJson, sanitizeBookmarkPayload, csvField };
}));
