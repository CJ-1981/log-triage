---
id: SPEC-VIEWER-003
title: "Markdown File (.md) Viewer with Switch and Mermaid Rendering — Plan"
version: "0.1.0"
status: planned
created: 2026-10-24
updated: 2026-10-24
author: "CJ-1981"
priority: Medium
phase: "v1.60.0 target"
module: "src/markdown.js, src/app.js, template.html"
lifecycle: spec-anchored
tags: "viewer, markdown, mermaid, svg, ux, toolbar"
tier: S
---

# SPEC-VIEWER-003: Implementation Plan

## A. Context & Architecture

Log Triage is a 100% offline, single-file browser application built by `build.js` from `template.html` and `src/*.js`.
This feature introduces Markdown document viewing with an on/off toolbar switch and pure-JS Mermaid diagram rendering.

### Touching Modules
1. `src/markdown.js` (NEW): Pure-JS UMD module providing:
   - `LT.parseMarkdown(text)`: Lightweight token-based Markdown parser (headings, lists, quotes, code blocks, bold/italic, tables, links, horizontal rules).
   - `LT.renderMermaid(code)`: Lightweight SVG generator for flowcharts (`graph TD/LR`, `flowchart TD/LR`) and sequence diagrams (`sequenceDiagram`).
   - `LT.renderMarkdown(text)`: Unified pipeline combining Markdown parsing and Mermaid SVG insertion.
2. `template.html`:
   - Add `#btn-markdown` ("Markdown: OFF") inside `#vtools`.
   - Add `<div id="md-viewer" class="hidden"></div>` inside `#viewer-wrap`.
   - Add CSS styling for `#md-viewer`, typography, tables, blockquotes, code blocks, and SVG diagram containers.
3. `src/themes.js`:
   - Add theme-aware CSS variables and rules for Markdown content matching existing themes (Midnight, Paper, Solarized Dark, Solarized Light, Monokai, High Contrast).
4. `src/app.js`:
   - Add `state.markdownOn = false`.
   - Hook `#btn-markdown` click handler.
   - Add `isMarkdownFile(entry)` helper (`/\.(md|markdown)$/i.test(entry.name)`).
   - In `renderFiles()` / `selectFile()` / `onKeptChanged()`: reveal `#btn-markdown` when active file is markdown; hide when not.
   - When `state.markdownOn` is toggled: switch visibility between `#viewer` and `#md-viewer`, load file text, render via `LT.renderMarkdown()`.
5. `build.js`:
   - Add `'markdown.js'` to `MODULE_ORDER` (placed before `app.js`).
6. `tests/markdown.test.js` (NEW):
   - Unit tests covering Markdown syntax parsing, Mermaid flowchart/sequence diagram SVG generation, and XSS sanitization.

## B. Task Decomposition

### Unit 1: Markdown & Mermaid Parser Module (`src/markdown.js`)
- [ ] Task 1.1: Implement UMD wrapper exporting `LT.renderMarkdown`, `LT.parseMarkdown`, and `LT.renderMermaid`.
- [ ] Task 1.2: Implement safe Markdown tokenizer/parser supporting headings, blockquotes, ordered/unordered/task lists, tables, inline styling (code, strong, em), links, and fenced code blocks with HTML escaping.
- [ ] Task 1.3: Implement lightweight pure-JS Mermaid SVG generator for flowchart diagrams (`graph TD`, `graph LR`, `flowchart TD`, `flowchart LR`) with node shapes and directional links.
- [ ] Task 1.4: Implement Mermaid sequence diagram renderer (`sequenceDiagram`) with participants, lifelines, and message arrows.
- [ ] Task 1.5: Implement fallback handler for invalid or unsupported diagram syntax with warning badges.

### Unit 2: UI Templates & Theme Styling (`template.html`, `src/themes.js`)
- [ ] Task 2.1: Add `#btn-markdown` button in `#vtools` (`template.html`).
- [ ] Task 2.2: Add `#md-viewer` container in `#viewer-wrap` (`template.html`).
- [ ] Task 2.3: Add styling rules for `#md-viewer` in `src/themes.js` (or `template.html` styles) with support for all 6 color themes, responsive scrolling, monospace code blocks, and SVG diagram centering.

### Unit 3: Application Viewer Integration (`src/app.js`, `build.js`)
- [ ] Task 3.1: Add `markdown.js` to `MODULE_ORDER` in `build.js`.
- [ ] Task 3.2: Add detection of `.md` and `.markdown` files to assign format badge `'markdown'`.
- [ ] Task 3.3: Wire toolbar `#btn-markdown` visibility based on active file type.
- [ ] Task 3.4: Implement `#btn-markdown` toggle handler to switch between `#viewer` (raw lines) and `#md-viewer` (rendered markdown).
- [ ] Task 3.5: Implement file text loading and rendering invocation into `#md-viewer` when active file changes while `markdownOn` is true.

### Unit 4: Verification & Test Coverage (`tests/markdown.test.js`)
- [ ] Task 4.1: Write unit tests verifying standard Markdown elements (headings, tables, lists, code, quotes, links).
- [ ] Task 4.2: Write unit tests verifying Mermaid flowchart and sequence diagram SVG generation.
- [ ] Task 4.3: Write security tests verifying script tags and XSS payloads are properly escaped.
- [ ] Task 4.4: Run `npm run build` and `npm test` to verify build bundle freshness and zero regressions.

## C. Risk Analysis & Mitigation

| Risk | Severity | Mitigation |
|---|---|---|
| Single-file HTML size inflation | High | Keep `src/markdown.js` minimal and self-contained (<30 KB); do NOT import heavy NPM bundles. |
| XSS vulnerability from untrusted Markdown | Critical | Strictly escape all HTML special characters (`&`, `<`, `>`, `"`, `'`) before parsing; disallow unsafe URLs (`javascript:`). |
| Virtualized viewer state desynchronization | Medium | Keep raw viewer state intact when switching to `#md-viewer`; toggling OFF restores `#viewer` at the same scroll/page position. |
| Syntax errors in user-authored Mermaid diagrams | Medium | Wrap Mermaid parsing in try-catch; render clean code block with an inline warning badge if parsing fails. |
