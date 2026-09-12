/* Log Triage — parser.js: per-line parsing into normalized records.
 * Timestamp model is year-less and UTC-naive: 'MM-DD HH:MM:SS.mmm'
 * (lexicographic order == chronological order). Detection order matches the
 * android-log-analysis skill: ISO -> syslog -> CLF -> bare MM-DD. */
(function (root, factory) { if (typeof module === 'object' && module.exports) { module.exports = factory(); } else { Object.assign((root.LT || (root.LT = {})), factory()); } }(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MONTHS = {
    jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
    jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
  };

  const RE_ISO = /\b(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])[T ]([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.(\d{1,3}))?/i;
  const RE_SYSLOG_TS = /\b([A-Za-z]{3})\s+(0?[1-9]|[12]\d|3[01])\s+([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.(\d{1,3}))?\b/;
  const RE_CLF_TS = /\[(0?[1-9]|[12]\d|3[01])\/([A-Za-z]{3})\/\d{4}:([01]\d|2[0-3]):([0-5]\d):([0-5]\d)/;
  const RE_MMDD = /\b(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\s+([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.(\d{1,3}))?\b/;
  const RE_LOGCAT = /^(\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2}\.\d{3})\s+(\d+)\s+(\d+)\s+([VDIWEF])\s+(.+?):\s(.*)$/;
  const RE_SYSLOG_LINE = /^(?:<(\d{1,3})>)?\s*([A-Za-z]{3})\s+(\d{1,2})\s+([01]\d|2[0-3]):([0-5]\d):([0-5]\d)\s+(\S+)\s+([^:\s\[]+)(?:\[(\d+)\])?:?\s?(.*)$/;
  const RE_CLF_LINE = /^\S+\s+\S+\s+\S+\s+\[(0?[1-9]|[12]\d|3[01])\/([A-Za-z]{3})\/\d{4}:([01]\d|2[0-3]):([0-5]\d):([0-5]\d)\s+[+-]\d{4}\]\s+"(\S+)\s+(\S+)(?:\s+([^"]*))?"\s+(\d{3})\s+(\S+)/;

  // RFC3164 severity (PRI % 8) -> logcat-style ladder
  const SEVERITY_LADDER = ['F', 'E', 'E', 'E', 'W', 'I', 'I', 'D'];

  const LEVEL_TOKENS = /\b(FATAL|CRITICAL|ERROR|ERR|WARNING|WARN|INFO|INFORMATION|DEBUG|TRACE)\b/i;
  const LEVEL_MAP = {
    fatal: 'F', critical: 'F', error: 'E', err: 'E',
    warning: 'W', warn: 'W', info: 'I', information: 'I',
    debug: 'D', trace: 'V',
  };

  function padMs(ms) { return ((ms || '0') + '000').slice(0, 3); }

  function p2(n) { return ('0' + n).slice(-2); }

  /** First successful normalization to 'MM-DD HH:MM:SS.mmm', else null. */
  function detectTs(line) {
    let m = RE_ISO.exec(line);
    if (m) return m[2] + '-' + m[3] + ' ' + m[4] + ':' + m[5] + ':' + m[6] + '.' + padMs(m[7]);
    m = RE_SYSLOG_TS.exec(line);
    if (m) {
      const mon = MONTHS[m[1].toLowerCase()];
      if (mon) return mon + '-' + p2(m[2]) + ' ' + p2(m[3]) + ':' + m[4] + ':' + m[5] + '.' + padMs(m[6]);
    }
    m = RE_CLF_TS.exec(line);
    if (m) {
      const mon = MONTHS[m[2].toLowerCase()];
      if (mon) return mon + '-' + p2(m[1]) + ' ' + p2(m[3]) + ':' + m[4] + ':' + m[5] + '.000';
    }
    m = RE_MMDD.exec(line);
    if (m) return m[1] + '-' + m[2] + ' ' + m[3] + ':' + m[4] + ':' + m[5] + '.' + padMs(m[6]);
    return null;
  }

  /** Case-insensitive severity token scan ('ERRORCODE' does not match). */
  function levelFromTokens(text) {
    const m = LEVEL_TOKENS.exec(text);
    return m ? LEVEL_MAP[m[1].toLowerCase()] : null;
  }

  function record(ts, level, tag, pid, msg) {
    return { ts: ts || null, level: level || null, tag: tag || null, pid: pid || null, msg: msg };
  }

  function parseLogcat(line) {
    const m = RE_LOGCAT.exec(line);
    if (m) return record(m[1] + ' ' + m[2], m[5], m[6], m[3], m[7]);
    return record(null, null, null, null, line); // continuation line: bypasses level filters
  }

  function parseSyslog(line) {
    const m = RE_SYSLOG_LINE.exec(line);
    if (!m) return parseFallback(line);
    const mon = MONTHS[m[2].toLowerCase()];
    if (!mon) return parseFallback(line);
    const ts = mon + '-' + p2(m[3]) + ' ' + p2(m[4]) + ':' + m[5] + ':' + m[6] + '.000';
    const sev = m[1] != null ? SEVERITY_LADDER[parseInt(m[1], 10) % 8] : 'I';
    return record(ts, sev, m[8], m[9] || null, m[10]);
  }

  function parseClf(line) {
    const m = RE_CLF_LINE.exec(line);
    if (!m) return parseFallback(line);
    const mon = MONTHS[m[2].toLowerCase()];
    if (!mon) return parseFallback(line);
    const ts = mon + '-' + p2(m[1]) + ' ' + p2(m[3]) + ':' + m[4] + ':' + m[5] + '.000';
    const status = parseInt(m[9], 10);
    const level = status >= 500 ? 'E' : status >= 400 ? 'W' : 'I';
    const msg = line.slice(line.indexOf('"'));
    return record(ts, level, m[6], null, msg);
  }

  function parseWithTs(line) {
    const m = RE_ISO.exec(line) || RE_MMDD.exec(line);
    if (!m) return parseFallback(line);
    const ts = detectTs(line);
    const msg = line.slice(m.index + m[0].length)
      .replace(/^[ \t]*(?:Z|[+-]\d{2}:?\d{2})?[ \t]*/, '') || line;
    return record(ts, levelFromTokens(msg), null, null, msg);
  }

  function parseFallback(line) {
    return record(null, levelFromTokens(line), null, null, line);
  }

  /** parseLine(line, format) -> { ts, level, tag, pid, msg } */
  function parseLine(line, format) {
    switch (format) {
      case 'logcat': return parseLogcat(line);
      case 'syslog': return parseSyslog(line);
      case 'clf': return parseClf(line);
      case 'iso8601': return parseWithTs(line);
      case 'mmdd': return parseWithTs(line);
      default: return parseFallback(line);
    }
  }

  return {
    MONTHS, detectTs, levelFromTokens, parseLine,
    RE_LOGCAT, RE_ISO, RE_SYSLOG_TS, RE_CLF_TS, RE_MMDD,
  };
}));
