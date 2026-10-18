'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const LT = require('../src/selection.js');

test('click sets the anchor and the single selection', () => {
  const s = new LT.SelectionModel();
  s.click(7);
  assert.ok(s.has(7));
  assert.strictEqual(s.count, 1);
  assert.deepStrictEqual(s.indices(), [7]);
});

test('shiftClick fills the range from the anchor, ctrlClick toggles and moves the anchor', () => {
  const s = new LT.SelectionModel();
  s.click(3);
  s.shiftClick(6);
  assert.deepStrictEqual(s.indices(), [3, 4, 5, 6]);
  s.shiftClick(1); // anchor still 3: fills 1..3
  assert.deepStrictEqual(s.indices(), [1, 2, 3, 4, 5, 6]);
  s.ctrlClick(5);
  assert.deepStrictEqual(s.indices(), [1, 2, 3, 4, 6]);
  s.ctrlClick(9);
  assert.deepStrictEqual(s.indices(), [1, 2, 3, 4, 6, 9]);
  // no anchor yet: shiftClick degrades to a plain click
  const t = new LT.SelectionModel();
  t.shiftClick(4);
  assert.deepStrictEqual(t.indices(), [4]);
});

test('selectAll fills 0..n-1 and clear empties everything', () => {
  const s = new LT.SelectionModel();
  s.selectAll(3);
  assert.deepStrictEqual(s.indices(), [0, 1, 2]);
  s.clear();
  assert.strictEqual(s.count, 0);
});

test('addValues adds global ids without touching the anchor (shift-range by seq)', () => {
  const s = new LT.SelectionModel();
  s.click(101); // anchor = global id 101
  assert.strictEqual(s.anchor, 101);
  s.addValues([104, 105, 106]);
  assert.deepStrictEqual(s.indices(), [101, 104, 105, 106]);
  assert.strictEqual(s.anchor, 101);
  // anchor untouched: a later shift range still fans out from 101
  s.shiftClick(102);
  assert.deepStrictEqual(s.indices(), [101, 102, 104, 105, 106]);
  s.addValues([]);
  assert.deepStrictEqual(s.indices(), [101, 102, 104, 105, 106]);
  const t = new LT.SelectionModel();
  assert.strictEqual(t.anchor, -1);
  t.clear();
  assert.strictEqual(t.anchor, -1);
});

test('selectAllValues replaces the set with the given global ids (select-all by seq)', () => {
  const s = new LT.SelectionModel();
  s.click(5);
  s.addValues([99, 100]);
  s.selectAllValues([7, 8, 9]);
  assert.deepStrictEqual(s.indices(), [7, 8, 9]);
  s.selectAllValues([]);
  assert.strictEqual(s.count, 0);
  assert.strictEqual(s.has(7), false);
});
