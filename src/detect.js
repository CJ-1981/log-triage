/* Log Triage — detect.js: per-file log format auto-detection.
 * Scoring approach: ratio of sample lines matching each format's line shape;
 * highest ratio wins, ties broken by specificity order. Below 0.5 => plain. */
(function (root, factory) { if (typeof module === 'object' && module.exports) { module.exports = factory(); } else { Object.assign((root.LT || (root.LT = {})), factory()); } }(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const RE_LOGCAT = /^(\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2}\.\d{3})\s+(\d+)\s+(\d+)\s+([VDIWEF])\s+(.+?):\s(.*)$/;
  const RE_SYSLOG = /^(?:<\d{1,3}>)?\s*[A-Za-z]{3}\s+\d{1,2}\s+([01]\d|2[0-3]):([0-5]\d):([0-5]\d)\s+\S+\s+\S+/;
  const RE_CLF = /^\S+\s+\S+\s+\S+\s+\[[0-9]{1,2}\/[A-Za-z]{3}\/\d{4}:([01]\d|2[0-3]):([0-5]\d):([0-5]\d)\s+[+-]\d{4}\]\s+"/;
  const RE_ISO = /\b(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])[T ]([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.(\d{1,3}))?/i;
  const RE_MMDD = /\b(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\s+([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.(\d{1,3}))?\b/;

  /* dlt-viewer ASCII export (qdltexporter.cpp): one message per line —
   * `[index] yyyy/mm/dd hh:mm:ss.µµ [dlt-ts s.mmmm] counter ecuid appid ctid
   * sessionid type subtype mode args payload`. The slash date + closed set of
   * type words keep this disjoint from logcat/syslog/ISO/CLF/MM-DD shapes. */
  const RE_DLT = /^(?:\d+\s+)?\d{4}\/\d{2}\/\d{2}\s+([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d{1,6})?\s+(?:\d+\.\d{1,4}\s+)?\d+\s+\S{1,10}\s+\S{1,10}\s+\S{1,10}\s+\d+\s+(?:log|app_trace|nw_trace|control|extension|junction)\s+\S+\s/;

  /* Qualcomm QXDM / QCAT text export:
   * `[date] time [LOG|MSG|EV|EVENT] [0xXXXX] payload`. Bracketed category
   * ensures disjointness from logcat/syslog/ISO/DLT formats. */
  const RE_QXDM = /^(?:(?:\d{4}\s+[A-Za-z]{3}\s+\d{1,2}|\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01]))\s+)?([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d{1,6})?\s+\[(LOG|MSG|EV|EVENT)\]/;

  const FORMATS = [
    ['logcat', RE_LOGCAT],
    ['syslog', RE_SYSLOG],
    ['clf', RE_CLF],
    ['qxdm', RE_QXDM],
    ['iso8601', RE_ISO],
    ['mmdd', RE_MMDD],
    ['dlt', RE_DLT],
  ];

  /** detectFormat(lines[], customFormats[]) -> { format, confidence, hits: {fmt: n}, samples: n } */
  function detectFormat(lines, customFormats) {
    const samples = [];
    for (let i = 0; i < lines.length && samples.length < 1000; i++) {
      const l = lines[i];
      if (l && l.trim()) samples.push(l);
    }
    if (!samples.length) return { format: 'plain', confidence: 0, hits: {}, samples: 0 };

    const activeCustom = [];
    if (Array.isArray(customFormats)) {
      for (const cf of customFormats) {
        if (!cf || cf.enabled === false) continue;
        let re = cf.regex;
        if (!re && cf.pattern) {
          try { re = new RegExp(cf.pattern); } catch (e) { /* skip invalid regex */ }
        }
        if (re) {
          activeCustom.push({
            name: cf.name,
            re,
            priority: typeof cf.priority === 'number' ? cf.priority : 10,
          });
        }
      }
      activeCustom.sort((a, b) => b.priority - a.priority);
    }

    const allFormats = [];
    for (const c of activeCustom) allFormats.push([c.name, c.re]);
    for (const f of FORMATS) allFormats.push(f);

    const hits = {};
    for (const [fmt, re] of allFormats) {
      let n = 0;
      for (const l of samples) if (re.test(l)) n++;
      hits[fmt] = n;
    }
    let best = 'plain';
    let bestRatio = 0;
    const nonContLines = samples.filter((l) => !/^\s/.test(l) && !/^%/.test(l));
    for (const [fmt] of allFormats) {
      let ratio = hits[fmt] / samples.length;
      if (fmt === 'qxdm' && nonContLines.length && (hits[fmt] / nonContLines.length) >= 0.5) {
        ratio = Math.max(ratio, hits[fmt] / nonContLines.length);
      }
      if (ratio > bestRatio) { bestRatio = ratio; best = fmt; }
    }
    if (samples.some((l) => /^%(MOBILE PARSED MESSAGE FILE|QCAT VERSION)/i.test(l))) {
      best = 'qxdm';
      bestRatio = Math.max(bestRatio, 0.9);
    }
    const format = bestRatio >= 0.5 ? best : 'plain';
    return { format, confidence: bestRatio, hits, samples: samples.length };
  }

  return { detectFormat, RE_LOGCAT, RE_ISO, RE_MMDD };
}));
