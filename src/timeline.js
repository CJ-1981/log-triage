/* Log Triage — timeline.js: merged-timeline construction (ADR-0004).
 * Null-timestamp lines (stack traces) attach to the nearest preceding parsed
 * line of their own file; leading unparsed lines anchor to '' and thus sort
 * before that file's first parsed line. Stable sort: ts, then file order of
 * first appearance, then insertion sequence. */
(function (root, factory) { if (typeof module === 'object' && module.exports) { module.exports = factory(); } else { Object.assign((root.LT || (root.LT = {})), factory()); } }(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function mergeTimeline(records) {
    const fileOrder = [];
    const lastTs = {};   // fileId -> last seen non-null ts

    const withEff = records.map((r) => {
      if (fileOrder.indexOf(r.fileId) === -1) fileOrder.push(r.fileId);
      let effTs = r.ts;
      if (effTs == null) {
        effTs = lastTs[r.fileId] != null ? lastTs[r.fileId] : '';
      } else {
        lastTs[r.fileId] = effTs;
      }
      return Object.assign({ effTs }, r);
    });

    const orderOf = (fileId) => fileOrder.indexOf(fileId);
    return withEff.slice().sort((a, b) => {
      if (a.effTs !== b.effTs) return a.effTs < b.effTs ? -1 : 1;
      const fo = orderOf(a.fileId) - orderOf(b.fileId);
      if (fo !== 0) return fo;
      return (a.seq != null ? a.seq : 0) - (b.seq != null ? b.seq : 0);
    });
  }

  return { mergeTimeline };
}));
