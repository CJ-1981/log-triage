/* Log Triage — levels.js: dynamic level tally.
 * Chips are generated from observed levels only: a level appears in the UI
 * exactly when it occurs in the loaded data. Null-level lines (stack traces,
 * unparseable lines) are tallied under '__' and bypass level filters. */
(function (root, factory) { if (typeof module === 'object' && module.exports) { module.exports = factory(); } else { Object.assign((root.LT || (root.LT = {})), factory()); } }(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const LEVEL_ORDER = ['V', 'D', 'I', 'W', 'E', 'F'];
  const UNKNOWN_KEY = '__';

  class LevelTally {
    constructor() {
      this._counts = Object.create(null);
    }

    add(level) {
      const key = level == null ? UNKNOWN_KEY : level;
      this._counts[key] = (this._counts[key] || 0) + 1;
    }

    counts() {
      return Object.assign({}, this._counts);
    }

    /** [{ id, count }] ordered V D I W E F then '__'; only observed levels. */
    chipList() {
      const order = LEVEL_ORDER.concat([UNKNOWN_KEY]);
      return order
        .filter((id) => this._counts[id])
        .map((id) => ({ id, count: this._counts[id] }));
    }
  }

  return { LevelTally, LEVEL_ORDER, UNKNOWN_KEY };
}));
