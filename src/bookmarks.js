/* Log Triage — bookmarks.js: per-line bookmarks, persisted in localStorage.
 * Persistence key is the file identity (name + size + first-line hash), so
 * bookmarks survive reloading the same file across sessions. */
(function (root, factory) { if (typeof module === 'object' && module.exports) { module.exports = factory(); } else { Object.assign((root.LT || (root.LT = {})), factory()); } }(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const LT = typeof module === 'object' && module.exports ? null : (root.LT || {});
  const U = LT ? LT : require('./util.js');

  class BookmarkStore {
    constructor() {
      this._byKey = {}; // key -> Map(lineNo -> {lineNo, meta, note})
    }

    toggle(key, lineNo, meta) {
      if (!this._byKey[key]) this._byKey[key] = new Map();
      const m = this._byKey[key];
      if (m.has(lineNo)) { m.delete(lineNo); return false; }
      m.set(lineNo, { lineNo, meta: meta || {}, note: '' });
      return true;
    }

    has(key, lineNo) {
      const m = this._byKey[key];
      return !!(m && m.has(lineNo));
    }

    setNote(key, lineNo, note) {
      const m = this._byKey[key];
      if (m && m.has(lineNo)) m.get(lineNo).note = note;
    }

    remove(key, lineNo) {
      const m = this._byKey[key];
      if (m) m.delete(lineNo);
    }

    list(key) {
      const m = this._byKey[key];
      return m ? Array.from(m.values()) : [];
    }

    all() {
      const out = [];
      for (const key of Object.keys(this._byKey)) {
        for (const entry of this._byKey[key].values()) out.push(Object.assign({ key }, entry));
      }
      return out;
    }

    toJSON() {
      const out = {};
      for (const key of Object.keys(this._byKey)) {
        out[key] = Array.from(this._byKey[key].values());
      }
      return out;
    }

    fromJSON(json) {
      this._byKey = {};
      if (!json || typeof json !== 'object') return;
      for (const key of Object.keys(json)) {
        const m = new Map();
        for (const e of json[key] || []) {
          if (e && typeof e.lineNo === 'number') {
            m.set(e.lineNo, { lineNo: e.lineNo, meta: e.meta || {}, note: e.note || '' });
          }
        }
        this._byKey[key] = m;
      }
    }
  }

  function bookmarkFileKey(name, size, firstLine) {
    return name + '|' + size + '|' + U.fnv1a32(String(firstLine || ''));
  }

  return { BookmarkStore, bookmarkFileKey };
}));
