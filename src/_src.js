'use strict';
/* Node-only aggregator: merges every src module into one flat object so the
 * shared test cases (tests/core-cases.js) can resolve LT.* in Node. Not part
 * of the browser bundle — in the browser the UMD modules populate window.LT. */
module.exports = Object.assign({},
  require('./util.js'),
  require('./detect.js'),
  require('./parser.js'),
);
