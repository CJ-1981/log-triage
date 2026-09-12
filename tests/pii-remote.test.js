'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const pr = require('../src/pii-remote.js');

const LINES = ['alpha line', 'beta has PII here', 'gamma'];
const SETTINGS = { url: 'http://p.test', path: '/analyze', language: 'en', threshold: 0.3 };

test('buildPresidioRequest builds url, body and per-line offsets', () => {
  const r = pr.buildPresidioRequest(LINES, SETTINGS);
  assert.strictEqual(r.url, 'http://p.test/analyze');
  assert.strictEqual(r.method, 'POST');
  assert.strictEqual(r.headers['Content-Type'], 'application/json');
  const body = JSON.parse(r.body);
  assert.strictEqual(body.text, 'alpha line\nbeta has PII here\ngamma');
  assert.strictEqual(body.language, 'en');
  assert.strictEqual(body.score_threshold, 0.3);
  assert.deepStrictEqual(r.offsets.map((o) => o.start), [0, 11, 29]);
  assert.deepStrictEqual(r.offsets.map((o) => o.len), [10, 17, 5]);
});

test('parsePresidioResponse maps absolute offsets back to lines', () => {
  const offsets = pr.buildPresidioRequest(LINES, SETTINGS).offsets;
  // 'beta has PII here' starts at 11; 'PII' sits at 20..23 absolute
  const body = JSON.stringify([{ start: 20, end: 23, entityType: 'EMAIL_ADDRESS', score: 0.9 }]);
  const findings = pr.parsePresidioResponse(body, offsets);
  assert.strictEqual(findings.length, 1);
  assert.deepStrictEqual(findings[0], { line: 1, start: 9, end: 12, type: 'EMAIL_ADDRESS', score: 0.9 });
});

test('parsePresidioResponse returns [] on malformed or empty input', () => {
  assert.deepStrictEqual(pr.parsePresidioResponse('not json', []), []);
  assert.deepStrictEqual(pr.parsePresidioResponse('[]', []), []);
});

test('buildLlmRequest injects prompt, auth header and model', () => {
  const s = {
    url: 'http://llm.test/v1/chat/completions', apiKey: 'sk-secret', model: 'gpt-x',
    promptTemplate: 'Find PII in:\n{lines}', temperature: 0,
  };
  const r = pr.buildLlmRequest(LINES, s);
  assert.strictEqual(r.url, 'http://llm.test/v1/chat/completions');
  assert.strictEqual(r.headers.Authorization, 'Bearer sk-secret');
  const body = JSON.parse(r.body);
  assert.strictEqual(body.model, 'gpt-x');
  assert.strictEqual(body.temperature, 0);
  assert.ok(body.messages[0].content.includes('0: alpha line'), 'numbered lines in prompt');
});

test('buildLlmRequest without apiKey omits Authorization header', () => {
  const r = pr.buildLlmRequest(LINES, { url: 'http://llm.test' });
  assert.strictEqual(r.headers.Authorization, undefined);
});

test('parseLlmContent extracts findings from fenced JSON', () => {
  const findings = pr.parseLlmContent('noise\n```json\n[{"line":1,"start":3,"end":7,"type":"EMAIL_ADDRESS","score":0.9}]\n```\n');
  assert.strictEqual(findings.length, 1);
  assert.deepStrictEqual(findings[0], { line: 1, start: 3, end: 7, type: 'EMAIL_ADDRESS', score: 0.9 });
});

test('parseLlmContent returns [] for text without JSON arrays', () => {
  assert.deepStrictEqual(pr.parseLlmContent('no json at all'), []);
});

test('withProxy only rewrites when enabled and url set', () => {
  assert.strictEqual(pr.withProxy('http://api', { enabled: true, url: 'http://proxy:8080' }), 'http://proxy:8080/http://api');
  assert.strictEqual(pr.withProxy('http://api', { enabled: false, url: 'http://proxy:8080' }), 'http://api');
  assert.strictEqual(pr.withProxy('http://api', {}), 'http://api');
});

test('createRemoteAnalyzer llm uses stub fetch and reports findings', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    return { ok: true, status: 200, text: async () => '[{"line":0,"start":0,"end":4,"type":"PERSON","score":1}]' };
  };
  const p = pr.createRemoteAnalyzer('llm', {
    url: 'http://llm.test/v1/chat/completions', apiKey: 'k', model: 'm',
    promptTemplate: 'Scan:\n{lines}', maxLines: 2,
  }, { fetchImpl });
  const findings = await p.analyze(['aaa', 'bbb', 'ccc', 'ddd']);
  assert.strictEqual(findings.length, 2, 'one finding per chunk from the fixed stub');
  assert.strictEqual(calls.length, 2, 'two chunks of two lines');
});

test('createRemoteAnalyzer presidio aggregates mapped findings', async () => {
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    const results = [];
    let pos = 0;
    for (const part of body.text.split('\n')) {
      results.push({ start: pos, end: pos + part.length, entityType: 'PERSON', score: 0.99 });
      pos += part.length + 1;
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(results) };
  };
  const p = pr.createRemoteAnalyzer('presidio', { url: 'http://p.test', path: '/analyze' }, { fetchImpl });
  const findings = await p.analyze(['ann', 'bob']);
  assert.strictEqual(findings.length, 2);
  assert.ok(findings.every((f) => f.type === 'PERSON'));
});

test('createRemoteAnalyzer surfaces HTTP failures as readable errors', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500, text: async () => 'boom' });
  const p = pr.createRemoteAnalyzer('presidio', { url: 'http://p.test' }, { fetchImpl });
  await assert.rejects(() => p.analyze(['x']), /HTTP 500/);
});

test('testConnection reports reachability for presidio and llm', async () => {
  const okFetch = async () => ({ ok: true, status: 200 });
  const presidio = await pr.testConnection({ kind: 'presidio', url: 'http://p.test', path: '/analyze' }, { enabled: false }, okFetch);
  assert.strictEqual(presidio.ok, true);
  assert.strictEqual(presidio.url, 'http://p.test/health');
  const bad = await pr.testConnection({ kind: 'presidio', url: 'http://p.test', path: '/analyze' }, { enabled: false }, async () => ({ ok: false, status: 404 }));
  assert.strictEqual(bad.ok, false);
  const llm = await pr.testConnection({ kind: 'llm', url: 'http://llm.test/v1/chat/completions', apiKey: 'k' }, { enabled: false }, okFetch);
  assert.strictEqual(llm.ok, true);
});
