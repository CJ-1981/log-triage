/* Log Triage — selection.js: index-based multiline selection model.
 * Index-based by design, so selection survives virtualization and re-renders.
 * Callers may pass any stable integer row ids (the viewer passes global seq
 * values so selections survive paging and window mutation).
 * click = anchor+single · shiftClick = range from anchor · ctrlClick = toggle
 * (and moves the anchor) · selectAll/clear operate on the whole view. */
(function (root, factory) { if (typeof module === 'object' && module.exports) { module.exports = factory(); } else { Object.assign((root.LT || (root.LT = {})), factory()); } }(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  class SelectionModel {
    constructor() {
      this._set = new Set();
      this._anchor = -1;
    }

    clear() {
      this._set.clear();
      this._anchor = -1;
    }

    click(idx) {
      this._set.clear();
      this._set.add(idx);
      this._anchor = idx;
    }

    shiftClick(idx) {
      if (this._anchor < 0) { this.click(idx); return; }
      const [a, b] = this._anchor <= idx ? [this._anchor, idx] : [idx, this._anchor];
      for (let i = a; i <= b; i++) this._set.add(i);
    }

    ctrlClick(idx) {
      if (this._set.has(idx)) this._set.delete(idx);
      else this._set.add(idx);
      this._anchor = idx;
    }

    selectAll(n) {
      this._set.clear();
      for (let i = 0; i < n; i++) this._set.add(i);
    }

    // bulk add for id sets computed by the caller (e.g. a shift range mapped
    // to global seqs) — never touches the anchor
    addValues(values) {
      for (const v of values) this._set.add(v);
    }

    // bulk replace (e.g. select-all over the current window's global seqs)
    selectAllValues(values) {
      this._set.clear();
      this.addValues(values);
    }

    has(idx) { return this._set.has(idx); }

    // id of the anchor row (or -1) so callers can map a shift range
    get anchor() { return this._anchor; }

    indices() {
      return Array.from(this._set).sort((a, b) => a - b);
    }

    get count() { return this._set.size; }
  }

  return { SelectionModel };
}));
