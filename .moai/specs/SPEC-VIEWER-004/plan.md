---
id: SPEC-VIEWER-004
title: "Source Code Syntax Color Highlighter for Scripts and Config Files (.py, .sh, .bat, .json, .yaml, .js) — Plan"
version: "0.1.0"
status: draft
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

# SPEC-VIEWER-004: Implementation Plan

## A. Context & Architecture

Log Triage is a 100% offline, single-file browser application built by `build.js` from `template.html` and `src/*.js`.
This feature introduces automatic source code and configuration file detection and lightweight syntax color highlighting for Python (`.py`), Shell scripts (`.sh`, `.bash`, `.zsh`), Windows Batch (`.bat`, `.cmd`), JSON (`.json`), YAML (`.yaml`, `.yml`), and JavaScript (`.js`, `.mjs`, `.cjs`), controlled by a toolbar switch (`Syntax: ON/OFF`).

### Touching Modules
1. `src/syntax.js` (NEW): Pure-JS UMD module providing:
   - `LT.detectCodeLanguage(filename)`: Returns language key (`'python'`, `'shell'`, `'batch'`, `'json'`, `'yaml'`, `'javascript'`) or `null`.
   - `LT.tokenizeLine(text, language)`: Returns ordered, non-overlapping token spans `[{ start, end, type }]` for keywords, strings, comments, numbers, variables, and definitions.
   - `LT.highlightSyntaxHtml(text, language)`: Returns HTML-escaped text with `<span class="syn-*">` wrappers.
   - `LT.syntaxSpans(text, language)`: Fast helper returning span indices and token CSS classes for multi-layer composition.
2. `src/detect.js`:
   - Extend detection logic or file format recognition so that code/config files carry their recognized language format badge in file list metadata.
3. `template.html`:
   - Add `#btn-syntax` ("Syntax: ON") inside `#vtools`.
   - Add CSS rules for `.syn-kwd`, `.syn-str`, `.syn-cmt`, `.syn-num`, `.syn-var`, `.syn-def`, `.syn-builtin` using CSS variables.
4. `src/themes.js`:
   - Add theme-specific CSS variables for syntax tokens matching all six themes (`--syn-kwd`, `--syn-str`, `--syn-cmt`, `--syn-num`, `--syn-var`, `--syn-def`).
5. `src/app.js`:
   - Add `state.syntaxOn = true`.
   - Wire `#btn-syntax` click handler to toggle `state.syntaxOn` and re-render visible rows.
   - In `selectFile()`, `renderFiles()`, and `onKeptChanged()`: toggle visibility of `#btn-syntax` depending on whether active file is a recognized code file.
   - In `highlightedHtml(text, colored, syntaxSpans)`: integrate syntax token spans as the base presentation layer beneath user highlight rules and quick-filter `<mark>` matches.
6. `build.js`:
   - Add `'syntax.js'` to `MODULE_ORDER` (placed before `app.js`).
7. `tests/syntax.test.js` (NEW):
   - Unit tests covering language detection from extensions, tokenizer accuracy for all 6 languages, XSS escaping, error recovery, and layer priority with user highlight rules.

## B. Delta Markers

### [DELTA] Log Triage Core & Viewer
- [NEW] `src/syntax.js` — pure-JS lightweight line tokenizer and language identifier.
- [NEW] `tests/syntax.test.js` — comprehensive test suite for syntax tokenization, language detection, and XSS safety.
- [MODIFY] `template.html` — `#btn-syntax` toolbar button element and baseline `.syn-*` styles.
- [MODIFY] `src/themes.js` — syntax token color variables for all 6 themes.
- [MODIFY] `src/app.js` — state tracking (`state.syntaxOn`), toolbar toggle handler, and `highlightedHtml` integration.
- [MODIFY] `build.js` — add `syntax.js` to `MODULE_ORDER`.

## C. Task Decomposition

### Unit 1: Syntax Tokenizer Module (`src/syntax.js`)
- [ ] Task 1.1: Implement UMD module wrapper exporting `LT.detectCodeLanguage`, `LT.tokenizeLine`, `LT.syntaxSpans`, and `LT.highlightSyntaxHtml`.
- [ ] Task 1.2: Implement language detector matching file extensions (`.py`, `.sh`, `.bat`, `.cmd`, `.json`, `.yaml`, `.yml`, `.js`, etc.).
- [ ] Task 1.3: Implement Python tokenizer (keywords, strings, comments, numbers, def/class names, decorators).
- [ ] Task 1.4: Implement Shell tokenizer (keywords, builtins, strings, comments, variables, numbers).
- [ ] Task 1.5: Implement Batch tokenizer (commands, REM/:: comments, %vars%, labels, strings).
- [ ] Task 1.6: Implement JSON and YAML tokenizers (keys, strings, numbers, booleans, null, comments).
- [ ] Task 1.7: Implement JavaScript tokenizer (keywords, strings, comments, numbers, literals).
- [ ] Task 1.8: Implement HTML escaping and span non-collision validation.

### Unit 2: UI Templates & Theme Styling (`template.html`, `src/themes.js`)
- [ ] Task 2.1: Add `#btn-syntax` button to `#vtools` in `template.html`.
- [ ] Task 2.2: Define base `.syn-kwd`, `.syn-str`, `.syn-cmt`, `.syn-num`, `.syn-var`, `.syn-def`, `.syn-builtin` CSS classes in `template.html`.
- [ ] Task 2.3: Configure theme-specific CSS variables in `src/themes.js` for Midnight, Paper, Solarized Dark, Solarized Light, Monokai, and High Contrast.

### Unit 3: Viewer Integration (`src/app.js`, `build.js`)
- [ ] Task 3.1: Register `'syntax.js'` in `MODULE_ORDER` in `build.js`.
- [ ] Task 3.2: Initialize `state.syntaxOn = true` in `src/app.js`.
- [ ] Task 3.3: Reveal `#btn-syntax` when active file is a recognized code file; hide when it is a standard log file.
- [ ] Task 3.4: Wire click listener on `#btn-syntax` to toggle state and refresh visible rows via `renderRows()`.
- [ ] Task 3.5: Update `highlightedHtml()` in `src/app.js` to accept syntax spans, ensuring `<mark>` and custom highlight rules layer on top.

### Unit 4: Verification & Test Suite (`tests/syntax.test.js`)
- [ ] Task 4.1: Write unit tests verifying language detection for all supported extensions.
- [ ] Task 4.2: Write unit tests verifying token span extraction for Python, Shell, Batch, JSON, YAML, and JS.
- [ ] Task 4.3: Write security unit tests verifying HTML escaping and XSS safety in syntax highlighting.
- [ ] Task 4.4: Write integration test verifying multi-layer rendering precedence (search mark > highlight rule > syntax token).
- [ ] Task 4.5: Run `npm run build` and `npm test` to verify build bundle freshness and zero regressions.

## D. Risk Analysis & Mitigation

| Risk | Severity | Mitigation |
|---|---|---|
| Single-file HTML bundle size inflation | High | Keep `src/syntax.js` small (<15 KB), concise regexes; do NOT import Prism/Highlight.js. |
| Scrolling performance regression in virtualized viewer | High | Only tokenize visible rows (~50–100 lines) during `renderRows()`. Never tokenize whole files ahead of time. |
| XSS vulnerability from untrusted code files | Critical | Always HTML-escape text before inserting into DOM; spans slice character positions from raw text before escaping. |
| Highlighting collision with user rules & search marks | Medium | Establish strict 3-tier precedence: `<mark>` (quick search) > `.rule-highlight-text` (user rules) > `.syn-*` (syntax tokens). |
| Theme contrast failure on light or high-contrast themes | Medium | Explicitly define contrast-verified variables for all 6 themes; test with High Contrast and Paper themes. |
