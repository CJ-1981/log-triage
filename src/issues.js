/* Log Triage — issues.js: Android logcat issue-scan rule set (FR-22).
 * DEFAULT_ISSUE_GROUPS drive the analysis tab's issue scan and its rule
 * editor; patterns are case-insensitive regex alternations matched against
 * the raw line. Pure logic — the UI (app.js) supplies record scope and the
 * file-name formatter. */
(function (root, factory) { if (typeof module === 'object' && module.exports) { module.exports = factory(); } else { Object.assign((root.LT || (root.LT = {})), factory()); } }(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULT_ISSUE_GROUPS = [
    // native + Java crashes: debuggerd signals, ART aborts, kernel panics
    { kind: 'crash', pattern: 'fatal exception|tombstone|beginning of crash|fatal signal \\d|abort message|check failed:|crash_dump|kernel panic|bug: unable to handle', on: true },
    // ANRs: framework text, event-log record, and the forced finish/completion
    { kind: 'anr', pattern: '\\banr in |input dispatching timed out|am_anr|force finishing|force completing', on: true },
    // system_server / subsystem watchdogs (before proc-death so the kill line
    // is classified as a watchdog event)
    { kind: 'watchdog', pattern: 'watchdog (kill|timeout|expired)|blocked in monitor|\\bwdog\\b', on: true },
    // memory pressure: lmkd/kernel-LMK kills, OOM, allocation failures
    { kind: 'mem', pattern: 'lowmemorykiller|lmkd|oom.?kill|out of memory|outofmemoryerror|cannot allocate memory|\\benomem\\b', on: true },
    // binder buffer exhaustion and oversized transactions
    { kind: 'binder', pattern: 'failed binder transaction|binder_alloc_buf|transactiontoolargeexception|undelivered transaction', on: true },
    { kind: 'selinux', pattern: 'avc:\\s*denied|securityexception|permission denial', on: true },
    // thermal: only severity/critical/throttle events, not status polling
    { kind: 'thermal', pattern: 'thermal.*(critical|shutdown|throttl)|critical temperature|over.?temp', on: true },
    { kind: 'storage', pattern: 'enospc|no space left|install_failed|insufficient storage|too many open files|read-only file system|buffer i/o error', on: true },
    // modem / subsystem restarts and ramdumps (connectivity loss with no
    // framework-side pattern)
    { kind: 'subsys', pattern: 'subsys.?restart|subsystem restart|ramdump|modem (crash|reset|restart)', on: true },
    // boot loops, restart/shutdown reasons, rescue-party mitigations
    { kind: 'boot', pattern: 'critical process.*exited|too many crashes|rescueparty|service .zygote.|reboot(ing)?, reason|shutdown, reason|restart reason|boot reason|entering recovery|factory reset|wipe data', on: true },
    { kind: 'proc-death', pattern: 'has died|am_proc_died|force stopping|service .+ died|received signal (9|11)', on: true },
    { kind: 'connectivity', pattern: 'connectivityservice|networkmonitor|data_disconnected|wifiservice|deactivatedatacall|data stall|dns resolution failed|network lost', on: true },
    // auth: failures only — bare "token refresh"/"credential" matched every
    // successful silent refresh and benign credential-storage lines
    { kind: 'auth', pattern: 'auth error|auth blocked|authentication failed|token refresh failed|token expired|token revoked|credential rejected|credential expired|invalid credential|failed password|password check failed', on: true },
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
