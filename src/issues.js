/* Log Triage — issues.js: Android logcat issue-scan rule set (FR-22).
 * DEFAULT_ISSUE_GROUPS drive the analysis tab's issue scan and its rule
 * editor; patterns are case-insensitive regex alternations matched against
 * the raw line. Pure logic — the UI (app.js) supplies record scope and the
 * file-name formatter. */
(function (root, factory) { if (typeof module === 'object' && module.exports) { module.exports = factory(); } else { Object.assign((root.LT || (root.LT = {})), factory()); } }(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULT_ISSUE_GROUPS = [
    { kind: 'crash', pattern: 'fatal exception|tombstone|beginning of crash', on: true },
    { kind: 'anr', pattern: '\\banr in |input dispatching timed out', on: true },
    { kind: 'proc-death', pattern: 'has died|am_proc_died|force stopping', on: true },
    { kind: 'connectivity', pattern: 'connectivityservice|networkmonitor|data_disconnected|wifiservice|deactivatedatacall', on: true },
    { kind: 'auth', pattern: 'auth error|auth blocked|authentication failed|token refresh|credential|failed password|password check failed', on: true },
    // suspend-to-RAM: kernel PM transitions, framework sleep/wake, wake
    // reasons, and suspend failures — tight alternations so generic words
    // like "suspension" or "wake-up alarm" do not match
    { kind: 'suspend', pattern: 'pm: suspend|suspend (entry|exit|attempt|not allowed|failed)|failed to suspend|going to sleep|waking up from|wake reason|wakeup reason|freeze of tasks|freezing of tasks|abort_suspend|suspend to ram|early suspend|late resume|suspended for \\d', on: true },
  ];

  /** Scan records against issue groups; at most one finding per line (first
   * matching group wins), capped at 200. nameOf formats a fileId for display. */
  function issueScan(records, groups, nameOf) {
    const out = [];
    const name = nameOf || ((id) => id);
    const regexes = [];
    for (const g of groups || []) {
      try { regexes.push({ kind: g.kind, re: new RegExp(g.pattern, 'i') }); } catch (e) { /* bad user pattern: skip */ }
    }
    for (const r of records || []) {
      for (const g of regexes) {
        if (g.re.test(r.raw)) {
          out.push({ kind: g.kind, snippet: (r.msg || r.raw).slice(0, 110), file: name(r.fileId), lineNo: r.lineNo, seq: r.seq, rec: r });
          break;
        }
      }
      if (out.length >= 200) break;
    }
    return out;
  }

  return { DEFAULT_ISSUE_GROUPS, issueScan };
}));
