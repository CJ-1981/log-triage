'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../src/highlights.js');

test('normalizes supported colors and falls back safely', () => {
  assert.equal(H.normalizeColor('#ABC'), '#aabbcc');
  assert.equal(H.normalizeColor('#12abEF'), '#12abef');
  assert.equal(H.normalizeColor('red'), H.DEFAULT_COLOR);
  assert.equal(H.normalizeColor(), H.DEFAULT_COLOR);
});

test('chooses readable text color for light and dark backgrounds', () => {
  assert.equal(H.textColor('#ffffff'), '#111111');
  assert.equal(H.textColor('#000000'), '#ffffff');
});

test('compiles regex and literal highlight rules', () => {
  const rules = H.compileHighlightRules([
    { id: 'regex', action: 'highlight', enabled: true, pattern: 'warn|error', color: '#f00', target: 'row' },
    { id: 'literal', action: 'highlight', enabled: true, pattern: 'a.b', matchMode: 'literal', color: '#00ff00' },
    { id: 'off', action: 'highlight', enabled: false, pattern: 'x' },
    { id: 'include', action: 'include', enabled: true, pattern: 'x' },
  ]);
  assert.equal(rules.length, 2);
  assert.equal(rules[0].target, 'row');
  assert.equal(rules[0].color, '#ff0000');
  assert.equal(rules[1].target, 'text');
  assert.equal(rules[1].re.test('a.b'), true);
  rules[1].re.lastIndex = 0;
  assert.equal(rules[1].re.test('axb'), false);
});

test('invalid regex is returned as a non-matching compiled error', () => {
  const [rule] = H.compileHighlightRules([{ action: 'highlight', enabled: true, pattern: '[', name: 'bad' }]);
  assert.match(rule.error, /unterminated|missing|invalid/i);
  assert.deepEqual(H.highlightText('anything', [rule]), { spans: [], row: null });
});

test('earlier text rules win overlapping spans', () => {
  const rules = H.compileHighlightRules([
    { id: 'first', name: 'first', action: 'highlight', enabled: true, pattern: 'abc', color: '#112233' },
    { id: 'second', name: 'second', action: 'highlight', enabled: true, pattern: 'bc', color: '#445566' },
    { id: 'third', name: 'third', action: 'highlight', enabled: true, pattern: 'xy', color: '#778899' },
  ]);
  const result = H.highlightText('abc xy abc', rules);
  assert.deepEqual(result.spans.map((s) => [s.start, s.end, s.id]), [[0, 3, 'first'], [4, 6, 'third'], [7, 10, 'first']]);
});

test('first matching row rule wins and text rules still apply', () => {
  const rules = H.compileHighlightRules([
    { id: 'row1', action: 'highlight', enabled: true, pattern: 'error', target: 'row', color: '#100000' },
    { id: 'row2', action: 'highlight', enabled: true, pattern: 'error', target: 'row', color: '#200000' },
    { id: 'text', action: 'highlight', enabled: true, pattern: '42', target: 'text', color: '#ffff00' },
  ]);
  const result = H.highlightText('error 42', rules);
  assert.equal(result.row.id, 'row1');
  assert.equal(result.spans[0].id, 'text');
});

test('zero-length regexes terminate and match count is bounded', () => {
  const zero = H.compileHighlightRules([{ action: 'highlight', enabled: true, pattern: '^|$' }]);
  assert.deepEqual(H.highlightText('abc', zero).spans, []);
  const many = H.compileHighlightRules([{ action: 'highlight', enabled: true, pattern: 'x' }]);
  assert.equal(H.highlightText('x'.repeat(500), many).spans.length, H.MAX_MATCHES_PER_RULE);
});
