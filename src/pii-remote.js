/* Log Triage — pii-remote.js: remote PII provider adapter core (FR-25).
 * Pure logic: request building, response parsing and offset mapping for the
 * Presidio sidecar and LLM backends. HTTP itself is injected (fetchImpl) so
 * everything is testable without a network. */
(function (root, factory) { if (typeof module === 'object' && module.exports) { module.exports = factory(); } else { Object.assign((root.LT || (root.LT = {})), factory()); } }(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function joinUrl(base, path) {
    let b = String(base || '');
    if (!b.endsWith('/')) b += '/';
    return b + String(path || '').replace(/^\//, '');
  }

  /** prefix-style proxy: final url = proxyBase + '/' + target (cors-anywhere convention) */
  function withProxy(url, proxy) {
    const p = proxy || {};
    if (p.enabled && p.url) return p.url.replace(/\/+$/, '') + '/' + url;
    return url;
  }

  function chunkLines(lines, size) {
    const out = [];
    const size2 = Math.max(1, size || 200);
    for (let i = 0; i < lines.length; i += size2) {
      const slice = lines.slice(i, i + size2);
      out.push({ lines: slice, startLine: i });
    }
    return out;
  }

  /** Presidio /analyze request for one chunk; offsets map absolute->per-line */
  function buildPresidioRequest(lines, settings) {
    const s = settings || {};
    const offsets = [];
    let pos = 0;
    const textParts = [];
    lines.forEach((line, i) => {
      offsets.push({ line: i, start: pos, len: line.length });
      textParts.push(line);
      pos += line.length + 1; // + newline
    });
    const url = joinUrl(s.url, s.path || '/analyze');
    const body = JSON.stringify({
      text: textParts.join('\n'),
      language: s.language || 'en',
      score_threshold: typeof s.threshold === 'number' ? s.threshold : 0.4,
    });
    return { url, method: 'POST', headers: { 'Content-Type': 'application/json' }, body, offsets };
  }

  function parsePresidioResponse(text, offsets) {
    let arr;
    try { arr = JSON.parse(text); } catch (e) { return []; }
    if (!Array.isArray(arr)) return [];
    const findings = [];
    for (const r of arr) {
      if (!r || typeof r.start !== 'number' || typeof r.end !== 'number') continue;
      const o = offsets.find((off) => r.start >= off.start && r.start < off.start + off.len);
      if (!o) continue;
      findings.push({
        line: o.line,
        start: r.start - o.start,
        end: Math.min(r.end, o.start + o.len) - o.start,
        type: r.entityType || 'UNKNOWN',
        score: typeof r.score === 'number' ? r.score : 1,
      });
    }
    return findings;
  }

  function buildLlmRequest(lines, settings) {
    const s = settings || {};
    const numbered = lines.map((l, i) => i + ': ' + l).join('\n');
    const template = s.promptTemplate || 'Find all PII in these log lines. Return a JSON array of objects {line, start, end, type, score}:\n{lines}';
    const prompt = template.replace('{lines}', numbered);
    const url = withProxy(s.url, s.proxyUrl);
    const body = JSON.stringify({
      model: s.model || 'gpt-4o-mini',
      temperature: typeof s.temperature === 'number' ? s.temperature : 0,
      messages: [{ role: 'user', content: prompt }],
    });
    const headers = { 'Content-Type': 'application/json' };
    if (s.apiKey) headers.Authorization = 'Bearer ' + s.apiKey;
    return { url, method: 'POST', headers, body };
  }

  function parseLlmContent(content) {
    const findings = [];
    if (typeof content !== 'string') return findings;
    const m = content.match(/\[[\s\S]*\]/);
    if (!m) return findings;
    let arr;
    try { arr = JSON.parse(m[0]); } catch (e) { return []; }
    for (const e of arr) {
      if (e && typeof e.line === 'number' && typeof e.type === 'string') {
        findings.push({
          line: e.line,
          start: typeof e.start === 'number' ? e.start : 0,
          end: typeof e.end === 'number' ? e.end : 0,
          type: e.type,
          score: typeof e.score === 'number' ? e.score : 1,
        });
      }
    }
    return findings;
  }

  /** remote analyzer: async analyze(lines) -> findings (batch-relative) */
  function createRemoteAnalyzer(kind, settings, deps) {
    const s = settings || {};
    const doFetch = (deps && deps.fetchImpl) || (typeof fetch !== 'undefined' ? fetch : null);
    if (!doFetch) throw new Error('no fetch implementation available');

    if (kind === 'presidio') {
      return {
        id: 'presidio-remote',
        analyze: async (lines) => {
          const out = [];
          for (const chunk of chunkLines(lines, s.chunkLines || 200)) {
            const req = buildPresidioRequest(chunk.lines, s);
            const res = await doFetch(req.url, { method: req.method, headers: req.headers, body: req.body });
            if (!res.ok) throw new Error('Presidio request failed: HTTP ' + res.status);
            out.push(...parsePresidioResponse(await res.text(), req.offsets));
          }
          return out;
        },
      };
    }
    if (kind === 'llm') {
      return {
        id: 'llm-remote',
        analyze: async (lines) => {
          const out = [];
          const size = Math.max(1, s.maxLines || 50);
          for (const chunk of chunkLines(lines, size)) {
            const req = buildLlmRequest(chunk.lines, s);
            const res = await doFetch(req.url, { method: 'POST', headers: req.headers, body: req.body });
            if (!res.ok) throw new Error('LLM request failed: HTTP ' + res.status);
            out.push(...parseLlmContent(await res.text()));
          }
          return out;
        },
      };
    }
    throw new Error('unknown remote provider kind: ' + kind);
  }

  /** health/reachability probe: presidio -> GET /health, llm -> tiny POST */
  function testConnection(settings, proxy, fetchImpl) {
    const s = settings || {};
    const doFetch = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
    if (!doFetch) return Promise.resolve({ ok: false, message: 'no fetch available' });
    const url = withProxy(s.url, proxy);
    const target = s.kind === 'presidio' ? joinUrl(url, 'health') : url;
    if (s.kind === 'presidio') {
      return doFetch(target).then((res) => ({ ok: res.ok, status: res.status, url: target }))
        .catch((e) => ({ ok: false, url: target, message: e.message }));
    }
    if (s.kind === 'llm') {
      return doFetch(url, {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, s.apiKey ? { Authorization: 'Bearer ' + s.apiKey } : {}),
        body: JSON.stringify({ model: s.model || 'test', messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
      }).then((res) => ({ ok: res.ok, status: res.status, url }))
        .catch((e) => ({ ok: false, url, message: e.message }));
    }
    return Promise.resolve({ ok: false, url, message: 'unknown provider kind' });
  }

  return {
    joinUrl, withProxy, chunkLines,
    buildPresidioRequest, parsePresidioResponse,
    buildLlmRequest, parseLlmContent,
    createRemoteAnalyzer, testConnection,
  };
}));
