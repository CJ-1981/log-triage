/* Log Triage — store.js: kept-line store with exact counters.
 * Only filtered-kept lines are retained (FIFO trim at cap), but every counter
 * (total lines, kept, dropped, bytes, level tally) stays exact for the whole
 * file so chips and stats never lie about trimmed data. */
(function (root, factory) { if (typeof module === 'object' && module.exports) { module.exports = factory(); } else { Object.assign((root.LT || (root.LT = {})), factory()); } }(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const LT = typeof module === 'object' && module.exports ? null : (root.LT || {});
  const LevelTally = LT ? LT.LevelTally : require('./levels.js').LevelTally;

  class Store {
    constructor(cap) {
      this.cap = cap || 100000;
      // amortized trim: allow a small overshoot, then splice once instead of
      // shift()-ing per line (O(cap) memmove per add at the cap)
      this._batch = Math.max(1, Math.floor(this.cap / 10));
      this.kept = [];          // kept records, FIFO-trimmed
      this._keptTotal = 0;
      this._trimmed = 0;
      this._files = {};        // id -> { name, size, total, kept, dropped, bytes }
      this.tally = new LevelTally();
    }

    _file(id) {
      if (!this._files[id]) this._files[id] = { name: id, size: 0, total: 0, kept: 0, dropped: 0, bytes: 0 };
      return this._files[id];
    }

    setFileInfo(id, name, size) {
      const f = this._file(id);
      f.name = name;
      f.size = size || 0;
    }

    addBytes(fileId, n) {
      this._file(fileId).bytes += n;
    }

    /** add(fileId, lineNo, raw, rec, kept) — rec: {ts, level, tag, pid, msg} */
    add(fileId, lineNo, raw, rec, kept) {
      const f = this._file(fileId);
      const r = rec || {};
      f.total++;
      this.tally.add(r.level != null ? r.level : null);
      if (!kept) { f.dropped++; return; }
      f.kept++;
      this._keptTotal++;
      const entry = {
        fileId, file: fileId, lineNo, raw,
        ts: r.ts || null, level: r.level || null, tag: r.tag || null,
        pid: r.pid || null, msg: r.msg != null ? r.msg : raw,
        seq: this._keptTotal,
      };
      this.kept.push(entry);
      if (this.kept.length >= this.cap + this._batch) {
        const cut = this.kept.length - this.cap;
        this.kept.splice(0, cut);
        this._trimmed += cut;
      }
    }

    stats() {
      return {
        files: JSON.parse(JSON.stringify(this._files)),
        totalLines: Object.values(this._files).reduce((a, f) => a + f.total, 0),
        keptTotal: this._keptTotal,
        keptInMemory: this.kept.length,
        dropped: Object.values(this._files).reduce((a, f) => a + f.dropped, 0),
        bytes: Object.values(this._files).reduce((a, f) => a + f.bytes, 0),
        trimmed: this._trimmed,
      };
    }
  }

  return { Store };
}));
