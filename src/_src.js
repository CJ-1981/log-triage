'use strict';
/* Node-only aggregator: merges every src module into one flat object so the
 * shared test cases (tests/core-cases.js) can resolve LT.* in Node. Not part
 * of the browser bundle — in the browser the UMD modules populate window.LT. */
module.exports = Object.assign({},
  require('./util.js'),
  require('./detect.js'),
  require('./parser.js'),
  require('./masks.js'),
  require('./pii-provider.js'),
  require('./filters.js'),
  require('./levels.js'),
  require('./search.js'),
  require('./store.js'),
  require('./timeline.js'),
  require('./selection.js'),
  require('./bookmarks.js'),
  require('./exporter.js'),
  require('./themes.js'),
);

// Register the built-in local provider on load (idempotent).
const pp = require('./pii-provider.js');
if (!pp.getProvider('local-regex')) {
  pp.makeLocalRegexProvider(require('./masks.js').buildBuiltinMaskRules);
}
