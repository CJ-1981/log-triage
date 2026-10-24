/* Log Triage — custom-format.js: user-defined custom log format definitions (SPEC-FORMAT-001).
 * Supports regex patterns with named capture groups (?<ts>...), (?<level>...),
 * (?<tag>...), (?<pid>...), (?<tid>...), (?<msg>...), timestamp format normalization,
 * and custom severity level mappings. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    Object.assign((root.LT || (root.LT = {})), factory());
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function p2(n) { return ('0' + (n || 0)).slice(-2); }
  function padMs(ms) { return ((ms || '0') + '000').slice(0, 3); }

  const LEVEL_TOKENS = /\b(FATAL|CRITICAL|ERROR|ERR|WARNING|WARN|INFO|INFORMATION|DEBUG|TRACE|VERBOSE)\b/i;
  const DEFAULT_LEVEL_MAP = {
    fatal: 'F', critical: 'F', error: 'E', err: 'E',
    warning: 'W', warn: 'W', info: 'I', information: 'I',
    debug: 'D', trace: 'V', verbose: 'V',
  };

  const DEFAULT_CUSTOM_FORMAT_EXAMPLES = [
    {
      name: 'springboot',
      label: 'Spring Boot Application Log',
      pattern: '^(\\[)?(?<ts>\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,6})?)(?:\\])?\\s+(?<level>[A-Z]{4,5})\\s+(?<pid>\\d+)\\s+---\\s+\\[(?<tag>[^\\]]+)\\]\\s+\\S+?\\s*:\\s+(?<msg>.*)$',
      tsFormat: 'YYYY-MM-DD HH:mm:ss.SSS',
      levelMap: { TRACE: 'V', DEBUG: 'D', INFO: 'I', WARN: 'W', ERROR: 'E', FATAL: 'F' },
      priority: 10,
      enabled: true,
    },
    {
      name: 'nginx-err',
      label: 'Nginx Error Log',
      pattern: '^(?<ts>\\d{4}/\\d{2}/\\d{2} \\d{2}:\\d{2}:\\d{2})\\s+\\[(?<level>\\w+)\\]\\s+(?<pid>\\d+)#\\d+:\\s+(?<msg>.*)$',
      tsFormat: 'YYYY/MM/DD HH:mm:ss',
      levelMap: { debug: 'D', info: 'I', notice: 'I', warn: 'W', error: 'E', crit: 'F', alert: 'F', emerg: 'F' },
      priority: 10,
      enabled: true,
    },
  ];

  /** Normalize timestamp string to year-less 'MM-DD HH:MM:SS.mmm'. */
  function normalizeCustomTs(rawTs, tsFormat) {
    if (!rawTs || typeof rawTs !== 'string') return null;
    const str = rawTs.trim();
    const fmt = (tsFormat || '').trim();

    // Unix epoch seconds
    if (fmt === 'epoch_s' || fmt === 'X') {
      const num = Number(str);
      if (isNaN(num)) return null;
      const d = new Date(num * 1000);
      if (isNaN(d.getTime())) return null;
      return p2(d.getUTCMonth() + 1) + '-' + p2(d.getUTCDate()) + ' ' +
             p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes()) + ':' + p2(d.getUTCSeconds()) + '.' + padMs(d.getUTCMilliseconds());
    }

    // Unix epoch milliseconds
    if (fmt === 'epoch_ms' || fmt === 'x') {
      const num = Number(str);
      if (isNaN(num)) return null;
      const d = new Date(num);
      if (isNaN(d.getTime())) return null;
      return p2(d.getUTCMonth() + 1) + '-' + p2(d.getUTCDate()) + ' ' +
             p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes()) + ':' + p2(d.getUTCSeconds()) + '.' + padMs(d.getUTCMilliseconds());
    }

    // Standard ISO-like or YYYY-MM-DD
    const mIso = /\b(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])[T ]([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.(\d{1,6}))?/i.exec(str);
    if (mIso) {
      return mIso[2] + '-' + mIso[3] + ' ' + mIso[4] + ':' + mIso[5] + ':' + mIso[6] + '.' + padMs(mIso[7]);
    }

    // Slash dates YYYY/MM/DD
    const mSlash = /\b(\d{4})\/(0[1-9]|1[0-2])\/(0[1-9]|[12]\d|3[01])\s+([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.(\d{1,6}))?/.exec(str);
    if (mSlash) {
      return mSlash[2] + '-' + mSlash[3] + ' ' + mSlash[4] + ':' + mSlash[5] + ':' + mSlash[6] + '.' + padMs(mSlash[7]);
    }

    // MM/DD or MM-DD without year
    const mShort = /\b(0[1-9]|1[0-2])[\/-](0[1-9]|[12]\d|3[01])\s+([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.(\d{1,6}))?/.exec(str);
    if (mShort) {
      return mShort[1] + '-' + mShort[2] + ' ' + mShort[3] + ':' + mShort[4] + ':' + mShort[5] + '.' + padMs(mShort[6]);
    }

    return null;
  }

  /** Validate a custom format definition. */
  function validateFormatDef(def) {
    const errors = [];
    if (!def || typeof def !== 'object') {
      return { valid: false, errors: ['Definition must be an object'], groups: [] };
    }
    const name = String(def.name || '').trim();
    if (!name) {
      errors.push('Format name is required');
    } else if (!/^[a-z0-9_-]+$/i.test(name)) {
      errors.push('Format name must contain only letters, numbers, hyphens, and underscores');
    }

    const pattern = String(def.pattern || '');
    if (!pattern) {
      errors.push('Pattern regex is required');
    }

    let groups = [];
    if (pattern) {
      try {
        const re = new RegExp(pattern);
        const m = re.exec('');
        if (m && m.groups) {
          groups = Object.keys(m.groups);
        } else {
          // Extract named groups from pattern string
          const gMatches = pattern.matchAll(/\(\?<([a-zA-Z0-9_]+)>/g);
          groups = Array.from(gMatches, (m) => m[1]);
        }
      } catch (err) {
        errors.push('Invalid regular expression: ' + err.message);
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      groups,
    };
  }

  /** Compile a custom format definition into an executable parser. */
  function compileCustomFormat(def) {
    const validation = validateFormatDef(def);
    if (!validation.valid) {
      return { ok: false, error: validation.errors.join('; '), name: def ? def.name : '' };
    }

    try {
      const regex = new RegExp(def.pattern);
      const normalizedLevelMap = {};
      if (def.levelMap && typeof def.levelMap === 'object') {
        for (const [k, v] of Object.entries(def.levelMap)) {
          if (typeof v === 'string') {
            normalizedLevelMap[k.toLowerCase()] = v.toUpperCase();
            normalizedLevelMap[k.toUpperCase()] = v.toUpperCase();
          }
        }
      }

      return {
        ok: true,
        name: def.name,
        label: def.label || def.name,
        pattern: def.pattern,
        regex,
        groups: validation.groups,
        tsFormat: def.tsFormat || 'YYYY-MM-DD HH:mm:ss.SSS',
        levelMap: normalizedLevelMap,
        priority: typeof def.priority === 'number' ? def.priority : 10,
        enabled: def.enabled !== false,
        original: def,
      };
    } catch (err) {
      return { ok: false, error: err.message, name: def.name };
    }
  }

  /** Parse a single line with a compiled custom format. Returns record or null. */
  function parseCustomLine(line, compiled) {
    if (!compiled || !compiled.regex) return null;
    const m = compiled.regex.exec(line);
    if (!m || !m.groups) return null;

    const g = m.groups;
    const ts = g.ts ? normalizeCustomTs(g.ts, compiled.tsFormat) : null;

    let level = null;
    if (g.level) {
      const trimmed = g.level.trim();
      level = compiled.levelMap[trimmed.toLowerCase()] ||
              compiled.levelMap[trimmed.toUpperCase()] ||
              DEFAULT_LEVEL_MAP[trimmed.toLowerCase()] ||
              null;
      if (!level) {
        const mTok = LEVEL_TOKENS.exec(trimmed);
        if (mTok) level = DEFAULT_LEVEL_MAP[mTok[1].toLowerCase()] || null;
      }
    }

    const tag = g.tag ? g.tag.trim() : null;
    const pid = g.pid ? g.pid.trim() : null;
    const tid = g.tid ? g.tid.trim() : null;
    const msg = g.msg != null ? g.msg : line;

    return {
      ts: ts || null,
      level: level || null,
      tag: tag || null,
      pid: pid || null,
      tid: tid || null,
      msg,
    };
  }

  return {
    normalizeCustomTs,
    validateFormatDef,
    compileCustomFormat,
    parseCustomLine,
    DEFAULT_CUSTOM_FORMAT_EXAMPLES,
    DEFAULT_LEVEL_MAP,
  };
}));
