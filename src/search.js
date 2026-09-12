/* Log Triage — search.js: ripgrep-style search core (pure logic).
 * The streaming deep-scan driver lives in the UI layer; everything testable
 * about matching semantics lives here. */
(function (root, factory) { if (typeof module === 'object' && module.exports) { module.exports = factory(); } else { Object.assign((root.LT || (root.LT = {})), factory()); } }(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function hasUppercase(s) { return /[A-Z]/.test(s); }

  /**
   * buildSearcher(pattern, opts) -> searcher
   * opts: { fixed, caseMode: 'smart'|'insensitive'|'sensitive', word, invert }
   * Empty pattern yields ok searcher with re=null (matchLine always false).
   */
  function buildSearcher(pattern, opts) {
    const o = opts || {};
    pattern = String(pattern == null ? '' : pattern);
    let src = pattern;
    if (o.fixed) src = escapeRegExp(src);
    if (o.word) src = '\\b(?:' + src + ')\\b';

    let flags = 'g';
    const mode = o.caseMode || 'smart';
    if (mode === 'insensitive' || (mode === 'smart' && !hasUppercase(pattern))) flags += 'i';

    if (!pattern) return { ok: true, pattern, re: null, opts: o };

    try {
      return { ok: true, pattern, re: new RegExp(src, flags), opts: o };
    } catch (e) {
      return { ok: false, pattern, error: e.message, opts: o };
    }
  }

  function matchLine(searcher, line) {
    if (!searcher.ok || !searcher.re) return false;
    const hit = searcher.re.test(line);
    searcher.re.lastIndex = 0; // keep stateless for .test with /g
    return searcher.opts && searcher.opts.invert ? !hit : hit;
  }

  /** [[start, end], ...] — empty when inverted or no regex. */
  function matchSpans(searcher, line) {
    if (!searcher.ok || !searcher.re || (searcher.opts && searcher.opts.invert)) return [];
    const spans = [];
    let m;
    const re = searcher.re;
    while ((m = re.exec(line)) !== null) {
      if (m[0].length === 0) { re.lastIndex++; continue; }
      spans.push([m.index, m.index + m[0].length]);
      if (spans.length >= 100) break; // sanity cap per line
    }
    re.lastIndex = 0;
    return spans;
  }

  /** Instant search over kept records: per-file counts + row indices. */
  function searchRecords(records, searcher) {
    const byFile = {};
    const rows = [];
    if (searcher.ok && searcher.re) {
      records.forEach((rec, idx) => {
        if (matchLine(searcher, rec.raw)) {
          const f = rec.file != null ? rec.file : '?';
          byFile[f] = (byFile[f] || 0) + 1;
          rows.push({ idx, file: f, spans: matchSpans(searcher, rec.raw) });
        }
      });
    }
    return { total: rows.length, byFile, rows };
  }

  /**
   * searchWithContext(lines, searcher, before, after) -> rows
   * rows: [{ idx, text, isMatch }] covering every match line plus context,
   * with overlapping/adjacent ranges merged, ascending order.
   */
  function searchWithContext(lines, searcher, before, after) {
    const rows = [];
    if (!searcher.ok || !searcher.re) return rows;
    let start = -1; // current open range start
    const pushRange = (from, to) => {
      for (let i = from; i <= to; i++) {
        rows.push({ idx: i, text: lines[i], isMatch: matchLine(searcher, lines[i]) });
      }
    };
    let lastEmitted = -1;
    for (let i = 0; i < lines.length; i++) {
      if (!matchLine(searcher, lines[i])) continue;
      const from = Math.max(0, i - (before || 0));
      const to = Math.min(lines.length - 1, i + (after || 0));
      if (from <= lastEmitted) {
        // extend the previously emitted range without touching emitted rows
        for (let j = lastEmitted + 1; j <= to; j++) {
          rows.push({ idx: j, text: lines[j], isMatch: matchLine(searcher, lines[j]) });
        }
      } else {
        pushRange(from, to);
      }
      lastEmitted = Math.max(lastEmitted, to);
    }
    return rows;
  }

  return { buildSearcher, matchLine, matchSpans, searchRecords, searchWithContext, escapeRegExp };
}));
