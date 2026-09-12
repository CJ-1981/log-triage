/* Log Triage — themes.js: single source of truth for color themes.
 * build.js generates the CSS variable blocks from this module, and the
 * theme-completeness test + ?selftest check every theme defines every
 * required variable. Each palette covers UI chrome AND log-view colors. */
(function (root, factory) { if (typeof module === 'object' && module.exports) { module.exports = factory(); } else { Object.assign((root.LT || (root.LT = {})), factory()); } }(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const REQUIRED_VARS = [
    '--bg', '--surface', '--surface2', '--border', '--fg', '--muted',
    '--accent', '--accent-fg', '--hl', '--selection',
    '--lvl-v', '--lvl-d', '--lvl-i', '--lvl-w', '--lvl-e', '--lvl-f',
    '--tint-w', '--tint-e', '--tint-f',
    '--ok', '--warn', '--err',
  ];

  const THEMES = {
    midnight: {
      label: 'Midnight (dark)',
      dark: true,
      vars: {
        '--bg': '#0a0e1a', '--surface': '#111827', '--surface2': '#182236',
        '--border': '#24304a', '--fg': '#e5e9f0', '--muted': '#8b95a9',
        '--accent': '#00d4ff', '--accent-fg': '#04121a',
        '--hl': '#ffd54a', '--selection': '#134e2f',
        '--lvl-v': '#6b7a99', '--lvl-d': '#4da6ff', '--lvl-i': '#37c98b',
        '--lvl-w': '#ffb74a', '--lvl-e': '#ff5d5d', '--lvl-f': '#ff2d95',
        '--tint-w': 'rgba(255,183,74,0.07)', '--tint-e': 'rgba(255,93,93,0.09)',
        '--tint-f': 'rgba(255,45,149,0.12)',
        '--ok': '#37c98b', '--warn': '#ffb74a', '--err': '#ff5d5d',
      },
    },
    paper: {
      label: 'Paper (light)',
      dark: false,
      vars: {
        '--bg': '#f6f7fb', '--surface': '#ffffff', '--surface2': '#eef0f6',
        '--border': '#d8dce6', '--fg': '#1c2430', '--muted': '#5f6b7d',
        '--accent': '#0b6bcb', '--accent-fg': '#ffffff',
        '--hl': '#ffe28a', '--selection': '#b7e4c7',
        '--lvl-v': '#8a93a6', '--lvl-d': '#1c6fd1', '--lvl-i': '#1e7f4f',
        '--lvl-w': '#a86a00', '--lvl-e': '#c22f2f', '--lvl-f': '#b3126b',
        '--tint-w': 'rgba(168,106,0,0.08)', '--tint-e': 'rgba(194,47,47,0.10)',
        '--tint-f': 'rgba(179,18,107,0.12)',
        '--ok': '#1e7f4f', '--warn': '#a86a00', '--err': '#c22f2f',
      },
    },
    'solarized-dark': {
      label: 'Solarized Dark',
      dark: true,
      vars: {
        '--bg': '#002b36', '--surface': '#073642', '--surface2': '#0d4453',
        '--border': '#1a4a57', '--fg': '#eee8d5', '--muted': '#93a1a1',
        '--accent': '#2aa198', '--accent-fg': '#002b36',
        '--hl': '#b58900', '--selection': '#21596b',
        '--lvl-v': '#586e75', '--lvl-d': '#268bd2', '--lvl-i': '#859900',
        '--lvl-w': '#b58900', '--lvl-e': '#cb4b16', '--lvl-f': '#d33682',
        '--tint-w': 'rgba(181,137,0,0.10)', '--tint-e': 'rgba(203,75,22,0.12)',
        '--tint-f': 'rgba(211,54,130,0.14)',
        '--ok': '#859900', '--warn': '#b58900', '--err': '#cb4b16',
      },
    },
    'solarized-light': {
      label: 'Solarized Light',
      dark: false,
      vars: {
        '--bg': '#fdf6e3', '--surface': '#fffbf0', '--surface2': '#f3ecd9',
        '--border': '#e2d9bd', '--fg': '#073642', '--muted': '#657b83',
        '--accent': '#268bd2', '--accent-fg': '#fdf6e3',
        '--hl': '#f2d675', '--selection': '#d5e8b8',
        '--lvl-v': '#93a1a1', '--lvl-d': '#268bd2', '--lvl-i': '#859900',
        '--lvl-w': '#b58900', '--lvl-e': '#cb4b16', '--lvl-f': '#d33682',
        '--tint-w': 'rgba(181,137,0,0.12)', '--tint-e': 'rgba(203,75,22,0.12)',
        '--tint-f': 'rgba(211,54,130,0.12)',
        '--ok': '#859900', '--warn': '#b58900', '--err': '#cb4b16',
      },
    },
    monokai: {
      label: 'Monokai (dark)',
      dark: true,
      vars: {
        '--bg': '#272822', '--surface': '#2f3129', '--surface2': '#3a3d33',
        '--border': '#4a4d40', '--fg': '#f8f8f2', '--muted': '#a2a492',
        '--accent': '#a6e22e', '--accent-fg': '#1d1f17',
        '--hl': '#fd971f', '--selection': '#3e5a41',
        '--lvl-v': '#75715e', '--lvl-d': '#66d9ef', '--lvl-i': '#a6e22e',
        '--lvl-w': '#e6db74', '--lvl-e': '#f92672', '--lvl-f': '#ff0058',
        '--tint-w': 'rgba(230,219,116,0.08)', '--tint-e': 'rgba(249,38,114,0.10)',
        '--tint-f': 'rgba(255,0,88,0.14)',
        '--ok': '#a6e22e', '--warn': '#e6db74', '--err': '#f92672',
      },
    },
    'high-contrast': {
      label: 'High Contrast',
      dark: true,
      vars: {
        '--bg': '#000000', '--surface': '#0d0d0d', '--surface2': '#1a1a1a',
        '--border': '#4d4d4d', '--fg': '#ffffff', '--muted': '#b3b3b3',
        '--accent': '#ffff00', '--accent-fg': '#000000',
        '--hl': '#00ffff', '--selection': '#004400',
        '--lvl-v': '#a0a0a0', '--lvl-d': '#66ccff', '--lvl-i': '#66ff99',
        '--lvl-w': '#ffcc00', '--lvl-e': '#ff6666', '--lvl-f': '#ff33cc',
        '--tint-w': 'rgba(255,204,0,0.10)', '--tint-e': 'rgba(255,102,102,0.14)',
        '--tint-f': 'rgba(255,51,204,0.18)',
        '--ok': '#66ff99', '--warn': '#ffcc00', '--err': '#ff6666',
      },
    },
  };

  const DEFAULT_THEME = 'midnight';

  function themeNames() { return Object.keys(THEMES); }

  /** Missing variables per theme — empty array means the theme map is complete. */
  function themeCompletenessErrors(themes) {
    const map = themes || THEMES;
    const errs = [];
    for (const name of Object.keys(map)) {
      const missing = REQUIRED_VARS.filter((v) => !(v in map[name].vars));
      if (missing.length) errs.push(name + ': missing ' + missing.join(', '));
    }
    return errs;
  }

  /** CSS text: :root gets the default theme; each theme gets a body[data-theme] block. */
  function generateCss(themes) {
    const map = themes || THEMES;
    const blocks = [':root { ' + varText(THEMES[DEFAULT_THEME].vars) + ' }'];
    for (const name of Object.keys(map)) {
      blocks.push('body[data-theme="' + name + '"] { ' + varText(map[name].vars) + ' }');
    }
    return blocks.join('\n');
  }

  function varText(vars) {
    return REQUIRED_VARS.filter((v) => v in vars).map((v) => v + ':' + vars[v]).join('; ') + ';';
  }

  return { THEMES, REQUIRED_VARS, DEFAULT_THEME, themeNames, themeCompletenessErrors, generateCss };
}));
