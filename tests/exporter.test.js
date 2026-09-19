'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const LT = require('../src/exporter.js');

test('bookmark export sanitizes snippets and notes without changing storage', () => {
  const source = { identity: [{ lineNo: 1, meta: { snippet: 'alice@example.com' }, note: 'alice@example.com' }] };
  const result = LT.sanitizeBookmarkPayload(source, (s) => s.replaceAll('alice@example.com', '[EMAIL]'));
  assert.equal(result.identity[0].meta.snippet, '[EMAIL]');
  assert.equal(result.identity[0].note, '[EMAIL]');
  assert.equal(source.identity[0].meta.snippet, 'alice@example.com', 'stored payload untouched');
});

test('sanitizeBookmarkPayload returns a clone and keeps keys and line numbers', () => {
  const source = {
    'a.log|1|abc': [{ lineNo: 7, meta: { snippet: 'x' }, note: '' }],
    'b.log|1|def': [],
  };
  const result = LT.sanitizeBookmarkPayload(source, (s) => s);
  assert.deepStrictEqual(Object.keys(result).sort(), ['a.log|1|abc', 'b.log|1|def']);
  assert.equal(result['b.log|1|def'].length, 0);
  assert.equal(result['a.log|1|abc'][0].lineNo, 7);
  assert.notEqual(result, source);
  assert.notEqual(result['a.log|1|abc'][0], source['a.log|1|abc'][0]);
});

test('sanitizeBookmarkPayload handles missing snippet/note and empty payloads', () => {
  const source = { 'k|1|h': [{ lineNo: 2 }, { lineNo: 3, meta: {}, note: 'n' }] };
  const result = LT.sanitizeBookmarkPayload(source, (s) => '<' + s + '>');
  assert.equal(result['k|1|h'][0].meta.snippet, undefined, 'absent snippet stays absent');
  assert.equal(result['k|1|h'][0].note, undefined, 'absent note stays absent');
  assert.equal(result['k|1|h'][1].note, '<n>');
  assert.deepStrictEqual(LT.sanitizeBookmarkPayload({}, (s) => s), {});
});
