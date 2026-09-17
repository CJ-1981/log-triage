/* Log Triage — highlights.js: presentation-only log highlighting.
 * Rules are evaluated in list order. Earlier text rules own overlapping spans;
 * the first matching row rule owns the row background. */
(function (root, factory) { if (typeof module === 'object' && module.exports) { module.exports = factory(); } else { Object.assign((root.LT || (root.LT = {})), factory()); } }(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULT_COLOR = '#ffd166';
  const MAX_MATCHES_PER_RULE = 100;

  function escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function normalizeColor(value) {
    const s = String(value || '').trim();
    if (/^#[0-9a-f]{6}$/i.test(s)) return s.toLowerCase();
    if (/^#[0-9a-f]{3}$/i.test(s)) return ('#' + s.slice(1).split('').map((c) => c + c).join('')).toLowerCase();
    return DEFAULT_COLOR;
  }

  function textColor(background) {
    const c = normalizeColor(background);
    const r = parseInt(c.slice(1, 3), 16);
    const g = parseInt(c.slice(3, 5), 16);
    const b = parseInt(c.slice(5, 7), 16);
    return (r * 299 + g * 587 + b * 114) / 1000 >= 150 ? '#111111' : '#ffffff';
  }

  function compileHighlightRules(rules) {
    return (rules || []).map((rule, index) => {
      if (!rule || rule.action !== 'highlight' || !rule.enabled || !rule.pattern) return null;
      const source = rule.matchMode === 'literal' ? escapeRegExp(rule.pattern) : rule.pattern;
      try {
        return {
          id: rule.id || 'r' + index,
          name: rule.name || 'highlight',
          color: normalizeColor(rule.color),
          target: rule.target === 'row' ? 'row' : 'text',
          re: new RegExp(source, (rule.caseSensitive ? '' : 'i') + 'g'),
        };
      } catch (error) {
        return { id: rule.id || 'r' + index, error: error.message };
      }
    }).filter(Boolean);
  }

  function matches(re, text) {
    const spans = [];
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(text)) !== null) {
      if (!match[0].length) { re.lastIndex++; continue; }
      spans.push([match.index, match.index + match[0].length]);
      if (spans.length >= MAX_MATCHES_PER_RULE) break;
    }
    re.lastIndex = 0;
    return spans;
  }

  function highlightText(text, compiled) {
    text = String(text == null ? '' : text);
    const owned = [];
    let row = null;
    for (const rule of compiled || []) {
      if (rule.error || !rule.re) continue;
      const spans = matches(rule.re, text);
      if (!spans.length) continue;
      if (rule.target === 'row') {
        if (!row) row = { id: rule.id, name: rule.name, color: rule.color };
        continue;
      }
      for (const span of spans) {
        if (owned.some((x) => span[0] < x.end && span[1] > x.start)) continue;
        owned.push({ start: span[0], end: span[1], id: rule.id, name: rule.name, color: rule.color });
      }
    }
    owned.sort((a, b) => a.start - b.start || a.end - b.end);
    return { spans: owned, row };
  }

  return { DEFAULT_COLOR, MAX_MATCHES_PER_RULE, normalizeColor, textColor, compileHighlightRules, highlightText };
}));
