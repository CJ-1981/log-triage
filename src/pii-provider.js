/* Log Triage — pii-provider.js: PiiProvider extension point (ADR-0003).
 * A provider analyzes lines and returns findings with offsets; findings feed
 * the analysis census and can drive masking. v1 ships only the local regex
 * provider — external Presidio (localhost sidecar) or LLM (remote, opt-in)
 * backends plug in here later without touching the pipeline. */
(function (root, factory) { if (typeof module === 'object' && module.exports) { module.exports = factory(); } else { Object.assign((root.LT || (root.LT = {})), factory()); } }(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const providers = new Map();

  /**
   * defineProvider({ id, label, local, available?, analyze }) -> provider
   * analyze(lines: string[]) must return [{ line, start, end, type, score }]
   */
  function defineProvider(def) {
    if (!def || typeof def.id !== 'string' || !def.id) throw new Error('provider.id is required');
    if (typeof def.analyze !== 'function') throw new Error('provider.analyze must be a function');
    const p = {
      id: def.id,
      label: def.label || def.id,
      local: def.local !== false,
      available: typeof def.available === 'function' ? def.available : () => true,
      analyze: def.analyze,
    };
    providers.set(p.id, p);
    return p;
  }

  function getProvider(id) {
    return providers.get(id) || null;
  }

  function listProviders() {
    return Array.from(providers.values());
  }

  function resetProviders() { providers.clear(); }

  /* Built-in local provider: exposes the built-in mask rules as findings. */
  function makeLocalRegexProvider(buildRules) {
    return defineProvider({
      id: 'local-regex',
      label: 'Built-in regex engine',
      local: true,
      analyze(lines) {
        const findings = [];
        for (const rule of buildRules()) {
          lines.forEach((line, i) => {
            let m;
            const re = new RegExp(rule.re.source, rule.re.flags);
            while ((m = re.exec(line)) !== null) {
              findings.push({ line: i, start: m.index, end: m.index + m[0].length, type: rule.id, score: 1 });
              if (m.index === re.lastIndex) re.lastIndex++;
            }
          });
        }
        return findings;
      },
    });
  }

  return { defineProvider, getProvider, listProviders, resetProviders, makeLocalRegexProvider };
}));
