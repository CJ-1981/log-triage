---
id: SPEC-VIEWER-004
title: "Source Code Syntax Color Highlighter for Scripts and Config Files (.py, .sh, .bat, .json, .yaml, .js)"
version: "0.1.0"
status: implemented
created: 2026-10-24
updated: 2026-10-24
author: "CJ-1981"
priority: P2
phase: "v1.60.0 target"
module: "src/syntax.js, src/detect.js, src/app.js, template.html, src/themes.js"
lifecycle: spec-anchored
tags: "viewer, syntax-highlight, python, shell, batch, json, yaml, javascript, toolbar, ux"
tier: S
---

# SPEC-VIEWER-004: Source Code Syntax Color Highlighter for Scripts and Config Files

## HISTORY

| Date | Version | Author | Change |
|---|---|---|---|
| 2026-10-24 | 0.1.0 | CJ-1981 | Initial draft. User-requested syntax color highlighting for script and configuration files (.py, .sh, .bat, .json, .yaml, .js) with auto-detection, toolbar switch ('Syntax: ON/OFF'), theme-aware CSS styling, and zero external dependencies. Tier S lean specification with inline acceptance criteria. |

## 1. User Story

As a support engineer, developer, or QA analyst inspecting logs, device bugreports, test automation archives, and system bundles that include build scripts, automated hooks, and configuration files (`.py`, `.sh`, `.bash`, `.bat`, `.cmd`, `.json`, `.yaml`, `.yml`, `.js`), I want the viewer to automatically apply syntax color highlighting to keywords, strings, comments, numbers, variables, and builtins when viewing these files, with the ability to toggle syntax highlighting on or off via a toolbar switch, so that I can rapidly read, inspect, and diagnose scripts and configurations without leaving the single-file offline Log Triage environment.

## 2. Environment & Architecture Constraints

- **Single-file deliverable invariant**: The entire app is bundled into `log-triage.html` via `build.js` from `template.html` and `src/*.js`. No bundler, no transpiler, no external CDN dependencies, and no WebAssembly (`.moai/project/tech.md`).
- **100% offline & zero network**: All tokenization and highlighting must execute strictly client-side using pure JavaScript. No external fonts, no telemetry, and no remote highlighting APIs.
- **Pure-JS lightweight tokenizer**: A new dedicated UMD module `src/syntax.js` provides fast per-line regular expression tokenization for supported languages (`python`, `shell`, `batch`, `json`, `yaml`, `javascript`), maintaining a small footprint (<15 KB unminified) rather than bundling heavyweight NPM syntax engines.
- **Seamless virtualized row rendering**: Tokenization integrates directly with `renderRows` in `src/app.js` and `highlightedHtml(text, colored, syntaxSpans)`:
  - Only visible DOM rows (~50–100 rows) are highlighted on demand, preserving 60fps scrolling over multi-GB paged files.
  - User-defined highlight rules (from `src/highlights.js`) and quick-filter match marks (`<mark>`) take visual precedence over syntax tokens.
- **Theme-aware color integration**: Syntax token classes (`.syn-kwd`, `.syn-str`, `.syn-cmt`, `.syn-num`, `.syn-var`, `.syn-def`) map to theme CSS variables across all six themes (Midnight, Paper, Solarized Dark, Solarized Light, Monokai, High Contrast), ensuring high contrast and WCAG AA compliance.
- **Toolbar switch**: `#btn-syntax` is integrated into `#vtools` (`template.html`), dynamically revealed when the active file is a recognized code or config file, and defaults to `Syntax: ON`.

## 3. GEARS Requirements & Inline Acceptance Criteria

### Requirement 1: Code and Config File Detection
**When** a file whose filename matches a supported extension (`.py`, `.pyw`, `.sh`, `.bash`, `.zsh`, `.bat`, `.cmd`, `.json`, `.yaml`, `.yml`, `.js`, `.mjs`, `.cjs`) is ingested or selected, the file list entry shall display its specific language badge (e.g. `python`, `shell`, `batch`, `json`, `yaml`, `javascript`) in `.fmeta .badge.fmt`.

- **AC-001 (Language Badge Detection)**:
  - **Given** the user loads `setup.py`, `deploy.sh`, `build.bat`, `config.json`, `ci.yaml`, or `server.js`,
  - **When** the files panel renders the entries,
  - **Then** the `.fmeta .badge.fmt` element displays the detected language identifier (`python`, `shell`, `batch`, `json`, `yaml`, or `javascript`).

### Requirement 2: Toolbar Switch Visibility & Initial State
**While** the active displayed file is a recognized code or config file, the toolbar shall display the `#btn-syntax` switch button; **While** the active displayed file is NOT a code file (e.g. standard logcat or syslog), the `#btn-syntax` button shall be hidden.
**When** a code file is initially selected or loaded, the `#btn-syntax` button shall default to `Syntax: ON`.

- **AC-002 (Toolbar Switch Visibility & Default)**:
  - **Given** the active file is `script.py`,
  - **When** the viewer toolbar `#vtools` is rendered,
  - **Then** `#btn-syntax` is visible with text `Syntax: ON` and active styling.
  - **Given** the user switches to `logcat.txt`,
  - **Then** `#btn-syntax` is hidden (`style.display = 'none'` or class `hidden`).

### Requirement 3: Python Syntax Highlighting
**While** `Syntax: ON` is active for a Python file, the viewer row text shall highlight:
- Keywords (`def`, `class`, `import`, `from`, `return`, `if`, `elif`, `else`, `try`, `except`, `with`, `as`, `for`, `while`, `pass`, `break`, `continue`, `lambda`, `async`, `await`, `yield`, `None`, `True`, `False`) with `.syn-kwd`,
- Comments (`#...`) with `.syn-cmt`,
- Quoted strings (single, double, and triple-quoted strings) with `.syn-str`,
- Numbers (decimal, float, hex) with `.syn-num`,
- Function and class definitions after `def`/`class` with `.syn-def`,
- Decorators (`@name`) with `.syn-var`.

- **AC-003 (Python Syntax Highlighting)**:
  - **Given** a line `def test_func(x): # comment` in a Python file with `Syntax: ON`,
  - **When** the line is rendered in the viewer,
  - **Then** `def` has class `syn-kwd`, `test_func` has class `syn-def`, and `# comment` has class `syn-cmt`.

### Requirement 4: Shell Script Syntax Highlighting
**While** `Syntax: ON` is active for a Shell script (`.sh`, `.bash`, `.zsh`), the viewer row text shall highlight:
- Shell keywords (`if`, `then`, `else`, `elif`, `fi`, `case`, `esac`, `for`, `while`, `until`, `do`, `done`, `in`, `function`, `select`, `time`) with `.syn-kwd`,
- Common builtins (`echo`, `exit`, `export`, `source`, `cd`, `pwd`, `set`, `read`, `local`, `return`) with `.syn-builtin`,
- Comments (`#...`) with `.syn-cmt`,
- Quoted strings (`"..."`, `'...'`, and backticks `` `...` ``) with `.syn-str`,
- Environment and parameter variables (`$VAR`, `${VAR}`, `$1`, `$#`, `$?`, `$@`) with `.syn-var`,
- Numbers with `.syn-num`.

- **AC-004 (Shell Syntax Highlighting)**:
  - **Given** a line `echo "Error on line $1" # alert` in a shell script with `Syntax: ON`,
  - **When** the line is rendered in the viewer,
  - **Then** `echo` has class `syn-builtin`, `"Error on line "` has class `syn-str`, `$1` has class `syn-var`, and `# alert` has class `syn-cmt`.

### Requirement 5: Windows Batch Script Syntax Highlighting
**While** `Syntax: ON` is active for a Windows Batch file (`.bat`, `.cmd`), the viewer row text shall highlight:
- Batch commands (`@echo`, `echo`, `goto`, `call`, `exit`, `set`, `if`, `else`, `for`, `in`, `do`, `shift`, `pause`, `rem`) case-insensitively with `.syn-kwd` or `.syn-builtin`,
- Comments (`REM ...`, `rem ...`, and `::...`) with `.syn-cmt`,
- Environment variables (`%VAR%`, `%~dp0`, `%1`–`%9`, `!VAR!`) with `.syn-var`,
- Labels (`:label`) with `.syn-def`,
- Quoted strings with `.syn-str`.

- **AC-005 (Batch Script Syntax Highlighting)**:
  - **Given** a line `@echo off & REM init` and `set TARGET=%~dp0\out` in a batch file with `Syntax: ON`,
  - **When** the lines are rendered,
  - **Then** `@echo` and `off` are highlighted as keywords/builtins, `REM init` has class `syn-cmt`, `set` has class `syn-kwd`, and `%~dp0` has class `syn-var`.

### Requirement 6: JSON and YAML Syntax Highlighting
**While** `Syntax: ON` is active for JSON or YAML files, the viewer row text shall highlight:
- Object keys / mapping keys with `.syn-def` or `.syn-kwd`,
- String values with `.syn-str`,
- Numeric values with `.syn-num`,
- Boolean and null literals (`true`, `false`, `null`, `yes`, `no`) with `.syn-kwd`,
- Comments in YAML (`#...`) with `.syn-cmt`.

- **AC-006 (JSON & YAML Syntax Highlighting)**:
  - **Given** a line `"port": 8080,` in a JSON file, or `timeout: 30 # seconds` in a YAML file,
  - **When** rendered with `Syntax: ON`,
  - **Then** `"port"` and `timeout` are highlighted as keys, `8080` and `30` have class `syn-num`, and `# seconds` has class `syn-cmt`.

### Requirement 7: JavaScript Syntax Highlighting
**While** `Syntax: ON` is active for a JavaScript file (`.js`, `.mjs`, `.cjs`), the viewer row text shall highlight:
- Keywords (`const`, `let`, `var`, `function`, `class`, `import`, `export`, `return`, `if`, `else`, `for`, `while`, `try`, `catch`, `async`, `await`, `new`, `this`, `typeof`, `instanceof`) with `.syn-kwd`,
- Comments (`//...` and `/*...*/`) with `.syn-cmt`,
- Quoted strings and template literals (`"..."`, `'...'`, `` `...` ``) with `.syn-str`,
- Numbers with `.syn-num`,
- Literals (`true`, `false`, `null`, `undefined`, `NaN`) with `.syn-kwd`.

- **AC-007 (JavaScript Syntax Highlighting)**:
  - **Given** a line `const maxRetries = 5; // retry count` in a JS file,
  - **When** rendered with `Syntax: ON`,
  - **Then** `const` has class `syn-kwd`, `5` has class `syn-num`, and `// retry count` has class `syn-cmt`.

### Requirement 8: Toolbar Switch Toggle Action
**When** the user clicks `#btn-syntax`, the application shall toggle `state.syntaxOn` between `true` and `false`:
- **While** `Syntax: ON`, rendered code lines shall display syntax token spans.
- **While** `Syntax: OFF`, the button label shall show `Syntax: OFF`, and rendered rows shall revert to raw uncolored text (or normal filter-rule colors only).

- **AC-008 (Toggle Switch Behavior)**:
  - **Given** `script.py` is open with `Syntax: ON`,
  - **When** the user clicks `#btn-syntax`,
  - **Then** `#btn-syntax` displays `Syntax: OFF`, and visible rows are immediately re-rendered without syntax token spans. Clicking `#btn-syntax` again restores `Syntax: ON` and colored tokens.

### Requirement 9: Precedence of Search Matches & User Highlight Rules
**Where** quick-filter search marks (`<mark>`) or user-configured highlight rules (`src/highlights.js`) match a text span on a line, the search mark and user highlight rule shall take precedence over underlying syntax highlighting.

- **AC-009 (Highlighting Layer Precedence)**:
  - **Given** a line contains `def process_data(file):` and the user searches for `process`,
  - **When** the line is rendered,
  - **Then** `process` is highlighted inside `<mark>process</mark>` without collision, while `def` retains `.syn-kwd`.

### Requirement 10: XSS Prevention & Robustness
**The** syntax highlighter module shall escape all untrusted raw HTML input and degrade gracefully without throwing errors or truncating line text when encountering syntax errors, unterminated strings, or arbitrary unicode characters.

- **AC-010 (XSS Prevention & Malformed Fallback)**:
  - **Given** a script file containing HTML tags `<div><script>alert(1)</script></div>` or an unterminated string `"unterminated string`,
  - **When** highlighted and rendered in the DOM,
  - **Then** HTML characters are properly escaped (`&lt;script&gt;`), no script executes, and the line renders fully without throwing unhandled exceptions.

### Requirement 11: Theme Compatibility
**The** syntax token color palette shall be legible and contrast-compliant across all six themes (`theme-midnight`, `theme-paper`, `theme-solarized-dark`, `theme-solarized-light`, `theme-monokai`, and `theme-high-contrast`).

- **AC-011 (Theme Styling)**:
  - **Given** any of the 6 application themes is selected,
  - **When** a highlighted code file is displayed,
  - **Then** keyword, string, comment, and number tokens maintain contrast ratio >= 4.5:1 against the theme's row background.

## Out of Scope

### Out of Scope — Feature Boundaries

- No heavy third-party syntax highlighter engines (e.g. Prism.js, Highlight.js, Monaco, Ace).
- No multi-megabyte language definition bundles or WASM parsers.
- No source code in-place editing or syntax error linting (viewer/reading mode only).
- No syntax highlighting applied to standard logcat/syslog/dlt log lines.
- No remote code evaluation or language server protocol (LSP) connectivity.

