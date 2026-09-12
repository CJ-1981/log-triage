'use strict';
/* Node runner for the shared logic cases (the same cases power ?selftest). */
const { test } = require('node:test');
const CASES = require('./core-cases.js').CASES || require('./core-cases.js');

for (const c of CASES) {
  test(`[${c.group}] ${c.name}`, c.fn);
}
