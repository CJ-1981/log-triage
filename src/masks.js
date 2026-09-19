/* Log Triage — masks.js: PII masking engine.
 * The 16 built-in rules are ported verbatim (regex + order) from the
 * android-log-analysis skill's pii_mask.py. Order matters: contextual rules
 * (private IPv4) must run before generic ones (public IPv4), VIN before IBAN.
 * Masking is deterministic partial masking — no hashing, no random tokens. */
(function (root, factory) { if (typeof module === 'object' && module.exports) { module.exports = factory(); } else { Object.assign((root.LT || (root.LT = {})), factory()); } }(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const VIN_CH = 'A-HJ-NPR-Z0-9'; // VIN alphabet: no I, O, Q

  function buildBuiltinMaskRules() {
    return [
      {
        id: 'vin', label: 'VIN', hint: 'keeps first 3 + last 4 (e.g. YV4**********4567)',
        re: new RegExp('(?<![A-Za-z0-9])([' + VIN_CH + ']{3})([' + VIN_CH + ']{10})([' + VIN_CH + ']{4})(?![A-Za-z0-9])', 'g'),
        repl: (m, g1, g2, g3) => g1 + '**********' + g3,
      },
      {
        id: 'iban', label: 'IBAN', hint: 'keeps country + check digits (e.g. DE89**********)',
        re: /\b([A-Z]{2}\d{2})[A-Z0-9]{10,26}\b/g,
        repl: (m, g1) => g1 + '**********',
      },
      {
        id: 'card', label: 'Credit card', hint: 'replaced with [card]',
        re: /\b\d{4}(?:[ -]?\d{4}){3}\b/g,
        repl: () => '[card]',
      },
      {
        id: 'ssn', label: 'SSN', hint: 'keeps area number (123-**-****)',
        re: /\b(\d{3})-(\d{2})-(\d{4})\b/g,
        repl: (m, g1) => g1 + '-**-****',
      },
      {
        id: 'phoneIntl', label: 'Phone (intl)', hint: 'keeps country code (+46 ***)',
        re: /(?<!\d)(\+\d{1,3})[\s.-]?(?:\(?\d{1,4}\)?[\s.-]?)?\d{2,4}(?:[\s.-]?\d{2,4}){1,3}(?!\d)/g,
        repl: (m, g1) => g1 + ' ***',
      },
      {
        id: 'phoneUs', label: 'Phone (US)', hint: 'keeps area code ((555) ***-****)',
        re: /(?<!\d)(\(\d{3}\))[ -]?\d{3}[ -]?\d{4}(?!\d)/g,
        repl: (m, g1) => g1 + ' ***-****',
      },
      {
        id: 'imei', label: 'IMEI', hint: 'exactly 15 digits -> [IMEI]',
        re: /(?<!\d)\d{15}(?!\d)/g,
        repl: () => '[IMEI]',
      },
      {
        id: 'email', label: 'Email', hint: 'first local char + TLD kept (u***@***.com)',
        re: /\b([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+)\.([A-Za-z]{2,})\b/g,
        repl: (m, g1, g2, g3) => g1 + '***@***.' + g3,
      },
      {
        id: 'serial', label: 'Serial (SN-)', hint: 'SN-***',
        re: /\b(SN-)[0-9A-Fa-f]{6,}\b/g,
        repl: (m, g1) => g1 + '***',
      },
      {
        id: 'mac', label: 'MAC', hint: 'keeps OUI (aa:bb:cc:**:**:**)',
        re: /\b([0-9A-Fa-f]{2}:[0-9A-Fa-f]{2}:[0-9A-Fa-f]{2})(?::[0-9A-Fa-f]{2}){3}\b/g,
        repl: (m, g1) => g1 + ':**:**:**',
      },
      {
        id: 'ipv4Private', label: 'Private IPv4', hint: 'last octet -> x (192.168.1.x)',
        re: /\b((?:10\.\d+\.\d+|192\.168\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+))\.(\d{1,3})\b/g,
        repl: (m, g1) => g1 + '.x',
      },
      {
        id: 'ipv4Public', label: 'Public IPv4', hint: 'last two octets -> x.x (203.0.x.x)',
        re: /\b(\d{1,3}\.\d{1,3})\.\d{1,3}\.\d{1,3}\b/g,
        repl: (m, g1) => g1 + '.x.x',
      },
      {
        id: 'ipv6', label: 'IPv6 (link-local/ULA)', hint: 'fe80::/fd00:: -> IPv6-masked',
        re: /\b(?:fe80::[0-9A-Fa-f:]{2,}|fd[0-9A-Fa-f]{2}::[0-9A-Fa-f:]{2,})/g,
        repl: () => 'IPv6-masked',
      },
      {
        id: 'gnss', label: 'GNSS coordinates', hint: 'decimal pairs >= 3 decimals -> [coords]',
        re: /(?<![\d.])-?(?:[0-8]?\d|90)\.\d{3,7}\s*\u00b0?\s*[NS]?\s*,?\s*-?(?:1?[0-7]?\d|180)\.\d{3,7}(?![\d.])/g,
        repl: () => '[coords]',
      },
      {
        id: 'subscriberId', label: 'subscriberId', hint: 'subscriberId=***',
        re: /(subscriberId[=:])\s*\d+/g,
        repl: (m, g1) => g1 + '***',
      },
      {
        id: 'ssid', label: 'Hotspot SSID', hint: 'AndroidShare_****',
        re: /(AndroidShare_)\d+/g,
        repl: (m, g1) => g1 + '****',
      },
    ];
  }

  let nextCustomId = 1;

  class MaskEngine {
    constructor() {
      this.rules = buildBuiltinMaskRules();
      this.enabled = {};
      for (const r of this.rules) this.enabled[r.id] = true;
      this.custom = [];
      this._hits = {};
    }

    setEnabled(id, on) {
      if (!(id in this.enabled)) throw new Error('unknown mask rule: ' + id);
      this.enabled[id] = !!on;
    }

    addCustom({ name, pattern, replacement, enabled }) {
      const rule = {
        id: 'custom-' + (nextCustomId++),
        custom: true,
        name: name || 'custom',
        pattern: String(pattern == null ? '' : pattern),
        replacement: replacement == null ? '' : String(replacement),
        enabled: enabled !== false,
        error: null,
        re: null,
      };
      this._compileCustom(rule);
      this.custom.push(rule);
      return rule;
    }

    removeCustom(id) {
      this.custom = this.custom.filter((r) => r.id !== id);
    }

    recompileCustom(id) {
      const rule = this.custom.find((r) => r.id === id);
      if (rule) this._compileCustom(rule);
      return rule;
    }

    _compileCustom(rule) {
      rule.error = null;
      rule.re = null;
      try {
        rule.re = new RegExp(rule.pattern, 'g');
      } catch (e) {
        rule.error = e.message;
      }
    }

    maskLine(line) {
      let s = String(line);
      for (const r of this.rules) {
        if (!this.enabled[r.id]) continue;
        let n = 0;
        s = s.replace(r.re, (...args) => { n++; return r.repl(...args); });
        if (n) this._hits[r.id] = (this._hits[r.id] || 0) + n;
      }
      for (const r of this.custom) {
        if (!r.enabled || !r.re) continue;
        let n = 0;
        s = s.replace(r.re, (...args) => {
          n++;
          // native-style $1..$9 expansion against this match
          return r.replacement.replace(/\$(\d)/g, (_, d) => {
            const v = args[Number(d)];
            return v == null ? '' : v;
          });
        });
        if (n) this._hits[r.id] = (this._hits[r.id] || 0) + n;
      }
      return s;
    }

    maskLines(lines) {
      return lines.map((l) => this.maskLine(l));
    }

    hitCounts() {
      return Object.assign({}, this._hits);
    }
  }

  function maskLine(line) { return new MaskEngine().maskLine(line); }
  function builtinRuleIds() { return buildBuiltinMaskRules().map((r) => r.id); }

  /** Pure PII census over an analysis sample. Counts EVERY match (a line with
   * two emails counts twice) while keeping at most maxSamplesPerType example
   * lines per rule; each sample carries the caller-masked preview, so the
   * text never leaks regardless of the viewer's mask toggle. Rules without a
   * compiled regex (broken custom rules) are skipped; zero-count rules are
   * omitted; rule order is preserved. */
  function collectPiiCensus(records, rules, { maxSamplesPerType = 25, maskText } = {}) {
    const mask = maskText || ((s) => s);
    const groups = new Map();
    for (const rule of rules) {
      groups.set(rule.id, {
        type: rule.id,
        label: rule.label || rule.name || rule.id,
        count: 0,
        samples: [],
      });
    }
    for (const record of records) {
      for (const rule of rules) {
        if (!rule.re) continue;
        const group = groups.get(rule.id);
        const re = new RegExp(rule.re.source, rule.re.flags);
        let match;
        let matchedLine = false;
        while ((match = re.exec(record.raw)) !== null) {
          group.count++;
          matchedLine = true;
          if (match.index === re.lastIndex) re.lastIndex++; // zero-length guard
        }
        if (matchedLine && group.samples.length < maxSamplesPerType) {
          group.samples.push({
            fileId: record.fileId,
            file: record.file,
            lineNo: record.lineNo,
            maskedText: mask(record.raw),
          });
        }
      }
    }
    return [...groups.values()].filter((g) => g.count > 0);
  }

  return { buildBuiltinMaskRules, MaskEngine, maskLine, builtinRuleIds, collectPiiCensus };
}));
