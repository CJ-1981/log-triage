/* Log Triage — syntax.js: lightweight client-side source code syntax color highlighting.
 * Provides per-line tokenization for scripts and configs (.py, .sh, .bat, .json, .yaml, .js).
 * Pure JavaScript, 100% offline, zero network dependencies. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    Object.assign((root.LT || (root.LT = {})), factory());
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function escapeHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  const EXT_LANG_MAP = {
    py: 'python',
    pyw: 'python',
    sh: 'shell',
    bash: 'shell',
    zsh: 'shell',
    bat: 'batch',
    cmd: 'batch',
    json: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    js: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
  };

  /**
   * Detect code language from filename extension.
   * Returns language string or null if not recognized.
   */
  function detectCodeLanguage(filename) {
    if (!filename || typeof filename !== 'string') return null;
    const clean = filename.trim().split('?')[0].split('#')[0];
    const lastDot = clean.lastIndexOf('.');
    if (lastDot < 0) return null;
    const ext = clean.slice(lastDot + 1).toLowerCase();
    return EXT_LANG_MAP[ext] || null;
  }

  /* Language Regex Definitions */
  const RE_NUM = /\b(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?\b|0x[0-9a-fA-F]+\b/g;

  // Python patterns
  const RE_PY_COMMENT = /#.*$/g;
  const RE_PY_STRING = /(?:[furbFURB]{0,2})("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/g;
  const RE_PY_KWD = /\b(def|class|import|from|return|if|elif|else|try|except|finally|with|as|for|while|pass|break|continue|lambda|async|await|yield|in|is|not|and|or|None|True|False|global|nonlocal|assert|del|raise)\b/g;
  const RE_PY_DEF = /\b(?:def|class)\s+([a-zA-Z_][a-zA-Z0-9_]*)/g;
  const RE_PY_DECORATOR = /@[a-zA-Z_][a-zA-Z0-9_.]*/g;

  // Shell patterns
  const RE_SH_COMMENT = /#.*$/g;
  const RE_SH_SINGLE_STRING = /'(?:\\.|[^'\\])*'/g;
  const RE_SH_DOUBLE_STRING = /"(?:\\.|[^"\\])*"/g;
  const RE_SH_BACKTICK_STRING = /`(?:\\.|[^`\\])*`/g;
  const RE_SH_KWD = /\b(if|then|else|elif|fi|case|esac|for|while|until|do|done|in|select|time|function)\b/g;
  const RE_SH_BUILTIN = /\b(echo|exit|export|source|cd|pwd|set|read|local|return|alias|unalias|exec|shift|trap|test|eval|printf)\b/g;
  const RE_SH_VAR = /(?:\$(?:[a-zA-Z_][a-zA-Z0-9_]*|\{[a-zA-Z_0-9_#?!@-]+\}|[0-9#?!@*-]))/g;

  // Batch patterns
  const RE_BAT_COMMENT = /(?:(?:^|[&|]\s*)\b(REM(?:\s+.*)?$)|(?:^|[&|]\s*)(::.*$))/gi;
  const RE_BAT_STRING = /"(?:\\.|[^"\\])*"/g;
  const RE_BAT_KWD = /(?:@echo\b|\b(echo|goto|call|exit|set|if|else|for|in|do|shift|pause|title|cls|color|cd|md|rd|del|copy|move)\b)/gi;
  const RE_BAT_VAR = /(?:%~[a-zA-Z]*\d|%\d|%\*|%[a-zA-Z0-9_()#@+-]+%|![a-zA-Z0-9_()#@+-]+!)/g;
  const RE_BAT_LABEL = /(?:^\s*:[a-zA-Z0-9_-]+|\bgoto\s+(:[a-zA-Z0-9_-]+))/gi;

  // JSON patterns
  const RE_JSON_KEY = /"(?:\\.|[^"\\])*"\s*(?=:)/g;
  const RE_JSON_STRING = /"(?:\\.|[^"\\])*"/g;
  const RE_JSON_LITERAL = /\b(true|false|null)\b/g;

  // YAML patterns
  const RE_YAML_COMMENT = /#.*$/g;
  const RE_YAML_KEY = /^\s*([a-zA-Z0-9_\-\.]+)\s*(?=:)/g;
  const RE_YAML_STRING = /(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/g;
  const RE_YAML_LITERAL = /\b(true|false|null|yes|no|on|off)\b/gi;

  // JavaScript patterns
  const RE_JS_COMMENT = /(?:\/\/.*$|\/\*[\s\S]*?\*\/)/g;
  const RE_JS_STRING = /(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)/g;
  const RE_JS_KWD = /\b(const|let|var|function|class|import|export|return|if|else|for|while|do|switch|case|default|break|continue|try|catch|finally|throw|async|await|new|this|super|typeof|instanceof|void|delete|in|of|yield|true|false|null|undefined|NaN)\b/g;
  const RE_JS_DEF = /\b(?:function|class)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/g;

  function collectMatches(re, text, className, groupIndex) {
    const list = [];
    if (!re) return list;
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      let start = m.index;
      let end = m.index + m[0].length;
      if (groupIndex != null && m[groupIndex] != null) {
        const prefix = m[0].indexOf(m[groupIndex]);
        if (prefix >= 0) {
          start = m.index + prefix;
          end = start + m[groupIndex].length;
        }
      }
      list.push({ start, end, className });
      if (list.length >= 200) break;
    }
    re.lastIndex = 0;
    return list;
  }

  function collectCommentMatches(re, text, className) {
    const list = [];
    if (!re) return list;
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const matchText = m[1] || m[2] || m[0];
      const offset = m[0].indexOf(matchText);
      const start = m.index + (offset >= 0 ? offset : 0);
      const end = start + matchText.length;
      list.push({ start, end, className });
      if (list.length >= 200) break;
    }
    re.lastIndex = 0;
    return list;
  }

  function collectInterpolatedStrings(reString, reVar, text) {
    const list = [];
    if (!reString) return list;
    reString.lastIndex = 0;
    let m;
    while ((m = reString.exec(text)) !== null) {
      const strStart = m.index;
      const strEnd = m.index + m[0].length;
      const strContent = m[0];

      reVar.lastIndex = 0;
      let vm;
      let cur = strStart;
      let hasVar = false;
      while ((vm = reVar.exec(strContent)) !== null) {
        hasVar = true;
        const vStart = strStart + vm.index;
        const vEnd = vStart + vm[0].length;
        if (vStart > cur) {
          list.push({ start: cur, end: vStart, className: 'syn-str' });
        }
        list.push({ start: vStart, end: vEnd, className: 'syn-var' });
        cur = vEnd;
      }
      if (hasVar) {
        if (cur < strEnd) {
          list.push({ start: cur, end: strEnd, className: 'syn-str' });
        }
      } else {
        list.push({ start: strStart, end: strEnd, className: 'syn-str' });
      }
      if (list.length >= 200) break;
    }
    reString.lastIndex = 0;
    return list;
  }

  /**
   * Tokenize line into non-overlapping ordered spans [{ start, end, className }].
   */
  function syntaxSpans(line, language) {
    if (!line || typeof line !== 'string') return [];
    if (!language || typeof language !== 'string') return [];

    let rawMatches = [];

    switch (language) {
      case 'python': {
        // Comments & strings have highest priority
        rawMatches = rawMatches.concat(
          collectMatches(RE_PY_COMMENT, line, 'syn-cmt'),
          collectMatches(RE_PY_STRING, line, 'syn-str'),
          collectMatches(RE_PY_DECORATOR, line, 'syn-var'),
          collectMatches(RE_PY_DEF, line, 'syn-def', 1),
          collectMatches(RE_PY_KWD, line, 'syn-kwd'),
          collectMatches(RE_NUM, line, 'syn-num')
        );
        break;
      }
      case 'shell': {
        rawMatches = rawMatches.concat(
          collectMatches(RE_SH_COMMENT, line, 'syn-cmt'),
          collectInterpolatedStrings(RE_SH_DOUBLE_STRING, RE_SH_VAR, line),
          collectInterpolatedStrings(RE_SH_BACKTICK_STRING, RE_SH_VAR, line),
          collectMatches(RE_SH_SINGLE_STRING, line, 'syn-str'),
          collectMatches(RE_SH_VAR, line, 'syn-var'),
          collectMatches(RE_SH_BUILTIN, line, 'syn-builtin'),
          collectMatches(RE_SH_KWD, line, 'syn-kwd'),
          collectMatches(RE_NUM, line, 'syn-num')
        );
        break;
      }
      case 'batch': {
        rawMatches = rawMatches.concat(
          collectCommentMatches(RE_BAT_COMMENT, line, 'syn-cmt'),
          collectMatches(RE_BAT_STRING, line, 'syn-str'),
          collectMatches(RE_BAT_LABEL, line, 'syn-def', 1),
          collectMatches(RE_BAT_VAR, line, 'syn-var'),
          collectMatches(RE_BAT_KWD, line, 'syn-kwd'),
          collectMatches(RE_NUM, line, 'syn-num')
        );
        break;
      }
      case 'json': {
        rawMatches = rawMatches.concat(
          collectMatches(RE_JSON_KEY, line, 'syn-def'),
          collectMatches(RE_JSON_STRING, line, 'syn-str'),
          collectMatches(RE_JSON_LITERAL, line, 'syn-kwd'),
          collectMatches(RE_NUM, line, 'syn-num')
        );
        break;
      }
      case 'yaml': {
        rawMatches = rawMatches.concat(
          collectMatches(RE_YAML_COMMENT, line, 'syn-cmt'),
          collectMatches(RE_YAML_KEY, line, 'syn-def', 1),
          collectMatches(RE_YAML_STRING, line, 'syn-str'),
          collectMatches(RE_YAML_LITERAL, line, 'syn-kwd'),
          collectMatches(RE_NUM, line, 'syn-num')
        );
        break;
      }
      case 'javascript': {
        rawMatches = rawMatches.concat(
          collectMatches(RE_JS_COMMENT, line, 'syn-cmt'),
          collectMatches(RE_JS_STRING, line, 'syn-str'),
          collectMatches(RE_JS_DEF, line, 'syn-def', 1),
          collectMatches(RE_JS_KWD, line, 'syn-kwd'),
          collectMatches(RE_NUM, line, 'syn-num')
        );
        break;
      }
      default:
        return [];
    }

    if (!rawMatches.length) return [];

    // Sort spans by start position, then by length descending
    rawMatches.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));

    // Resolve non-overlapping spans (earlier/longer match owns the span)
    const result = [];
    for (const span of rawMatches) {
      const overlaps = result.some((existing) => span.start < existing.end && span.end > existing.start);
      if (!overlaps) {
        result.push(span);
      }
    }

    result.sort((a, b) => a.start - b.start);
    return result;
  }

  /**
   * Produce HTML-escaped string with <span class="..."> tags.
   */
  function highlightSyntaxHtml(line, language) {
    if (!line) return '';
    const spans = syntaxSpans(line, language);
    if (!spans.length) return escapeHtml(line);

    let html = '';
    let cur = 0;
    for (const span of spans) {
      if (span.start > cur) {
        html += escapeHtml(line.slice(cur, span.start));
      }
      const text = escapeHtml(line.slice(span.start, span.end));
      html += '<span class="' + span.className + '">' + text + '</span>';
      cur = span.end;
    }
    if (cur < line.length) {
      html += escapeHtml(line.slice(cur));
    }
    return html;
  }

  return {
    escapeHtml,
    detectCodeLanguage,
    syntaxSpans,
    highlightSyntaxHtml,
  };
}));
