/* Log Triage — filters.js: global filter engine.
 * Semantics (evaluated in order):
 *   1. time range  — inclusive prefix compare; null-ts lines bypass
 *   2. level chips — OR of selected levels; null-level lines bypass
 *   3. includes    — enabled include rules (+ quick search) OR together;
 *                    if any valid include exists, line must match one
 *   4. excludes    — any match drops the line
 *   5. highlights  — additive only, never affects kept
 * Invalid regexes surface in errors() and act as absent rules. */
(function (root, factory) { if (typeof module === 'object' && module.exports) { module.exports = factory(); } else { Object.assign((root.LT || (root.LT = {})), factory()); } }(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function compile(pattern, caseSensitive) {
    try {
      return { ok: true, re: new RegExp(pattern, caseSensitive ? '' : 'i') };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /** Inclusive prefix compare: '15:37' matches 15:37:00.000, '19:22' matches 19:22:59.999. */
  function tsInRange(ts, from, to) {
    if (!ts) return true;
    if (from) {
      if (!(ts.startsWith(from) || ts > from)) return false;
    }
    if (to) {
      if (!(ts.startsWith(to) || ts < to)) return false;
    }
    return true;
  }

  class FilterEngine {
    constructor() {
      this.rules = [];
      this.quick = null;        // { pattern, fixed, caseSensitive } | null
      this.timeFrom = '';
      this.timeTo = '';
      this._levels = new Set(); // empty = all pass
      this._compiled = [];
      this._quickRe = null;
      this._hits = {};
    }

    setRules(rules) {
      this.rules = rules.slice();
      this._compiled = this.rules.map((r) => {
        const pattern = r.action === 'highlight' && r.matchMode === 'literal' ? escapeRegExp(r.pattern) : r.pattern;
        const c = compile(pattern, !!r.caseSensitive);
        return { def: r, ok: c.ok, re: c.re, error: c.error || null };
      });
    }

    errors() {
      const errs = this._compiled.filter((c) => !c.ok).map((c) => ({ id: c.def.id, error: c.error }));
      if (this._quickCache && !this._quickCache.ok && this.quick && this.quick.pattern) {
        errs.push({ id: '__quick', error: this._quickCache.error });
      }
      return errs;
    }

    setLevels(levels) {
      this._levels = new Set(levels || []);
    }

    get levels() { return Array.from(this._levels); }

    /** Compile the quick pattern eagerly. Paged rendering matches in the
     * worker, but the main thread still needs _quickRe for <mark> spans —
     * and clearing quick must reset it or stale highlights stay visible. */
    compileQuick() { this._compileQuick(); }

    _compileQuick() {
      if (this._quickCache && this._quickCache.ref === this.quick) return; // cached
      if (!this.quick || !this.quick.pattern) {
        this._quickRe = null;
        this._quickCache = { ref: this.quick, ok: true, error: null };
        return;
      }
      const p = this.quick.fixed
        ? escapeRegExp(this.quick.pattern)
        : this.quick.pattern;
      const c = compile(p, !!this.quick.caseSensitive);
      this._quickRe = c.ok ? c.re : null;
      this._quickCache = { ref: this.quick, ok: c.ok, error: c.error || null };
    }

    _bump(id) { this._hits[id] = (this._hits[id] || 0) + 1; }

    _match(re, raw) {
      return re ? re.test(raw) : false;
    }

    evaluate(rec) {
      const raw = rec.raw != null ? rec.raw : rec.msg || '';

      if (!tsInRange(rec.ts, this.timeFrom, this.timeTo)) return { kept: false, highlights: [] };

      if (this._levels.size > 0 && rec.level != null) {
        if (!this._levels.has(rec.level)) return { kept: false, highlights: [] };
      }

      this._compileQuick();
      const highlights = [];
      let hasInclude = false;
      let includeMatched = false;

      if (this._quickRe) {
        hasInclude = true;
        if (this._match(this._quickRe, raw)) { includeMatched = true; this._bump('__quick'); }
      }
      for (const c of this._compiled) {
        if (!c.def.enabled || !c.ok) continue;
        if (c.def.action === 'include') {
          hasInclude = true;
          if (this._match(c.re, raw)) { includeMatched = true; this._bump(c.def.id); }
        }
      }
      if (hasInclude && !includeMatched) return { kept: false, highlights: [] };

      for (const c of this._compiled) {
        if (!c.def.enabled || !c.ok) continue;
        if (c.def.action === 'exclude' && this._match(c.re, raw)) {
          this._bump(c.def.id);
          return { kept: false, highlights: [] };
        }
      }
      for (const c of this._compiled) {
        if (!c.def.enabled || !c.ok) continue;
        if (c.def.action === 'highlight' && this._match(c.re, raw)) {
          this._bump(c.def.id);
          highlights.push(c.def.id);
        }
      }
      return { kept: true, highlights };
    }

    get hits() { return Object.assign({}, this._hits); }
  }

  return { FilterEngine, compile, escapeRegExp, tsInRange };
}));
