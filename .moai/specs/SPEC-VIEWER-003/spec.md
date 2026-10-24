---
id: SPEC-VIEWER-003
title: "Markdown File (.md) Viewer with Switch and Mermaid Rendering"
version: "0.1.0"
status: implemented
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

# SPEC-VIEWER-003: Markdown File (.md) Viewer with Switch and Mermaid Rendering

## HISTORY

| Date | Version | Author | Change |
|---|---|---|---|
| 2026-10-24 | 0.1.0 | CJ-1981 | Initial draft. User-requested Markdown file (.md) support in viewer with 'Markdown: ON/OFF' switch button and pure-JS Mermaid diagram rendering. Tier S lean specification with inline acceptance criteria. |

## 1. User Story

As a user triaging logs, bugreports, and system bundles that include documentation, release notes, runbooks, or architecture diagrams formatted in Markdown (`.md`, `.markdown`), I want to view these files directly within Log Triage with rich formatted text and rendered Mermaid diagrams via a dedicated 'Markdown: ON/OFF' toolbar switch, while retaining the ability to switch back to the raw line-numbered log row view at any time without leaving the single-file offline environment.

## 2. Environment & Architecture Constraints

- **Single-file deliverable invariant**: The entire app is bundled into `log-triage.html` via `build.js` from `template.html` and `src/*.js`. No bundler, no transpiler, no external CDN requests, no WebAssembly (`.moai/project/tech.md`).
- **100% offline & zero network**: All parsing and rendering must execute strictly client-side using pure JavaScript. No external fonts, no telemetry, no remote rendering APIs.
- **Pure-JS lightweight renderer**: A new dedicated UMD module `src/markdown.js` provides both standard Markdown tokenization/rendering and a standalone pure-JS Mermaid SVG generator (supporting flowcharts/graphs and sequence diagrams) keeping the footprint small (<30 KB) rather than bundling multi-megabyte external libraries.
- **Dual view model**:
  - Raw mode (`Markdown: OFF`): The standard virtualized row viewer (`#viewer`) renders lines with line numbers, severity markers, and filtering.
  - Rendered mode (`Markdown: ON`): A dedicated styled container (`#md-viewer`) renders HTML with typography, headings, tables, blockquotes, code blocks, and inline Mermaid SVGs.
- **Toolbar integration**: `#btn-markdown` is integrated into `#vtools` (`template.html`), dynamically revealed when an active file is a markdown file, and defaults to `Markdown: OFF`.

## 3. GEARS Requirements & Inline Acceptance Criteria

### Requirement 1: Markdown File Detection
**When** a file whose filename ends with `.md` or `.markdown` (case-insensitive) is ingested or selected, the file list entry shall display `markdown` as its format badge.

- **AC-001 (Format Badge)**:
  - **Given** the user loads a file named `README.md` or `NOTES.markdown`,
  - **When** the files panel renders the entry,
  - **Then** the `.fmeta .badge.fmt` element displays `markdown`.

### Requirement 2: Toolbar Switch Visibility
**While** the active displayed file is a markdown file, the toolbar shall display the `#btn-markdown` switch button; **While** the active displayed file is NOT a markdown file, the `#btn-markdown` switch button shall be hidden.

- **AC-002 (Toolbar Switch Visibility)**:
  - **Given** multiple files are loaded including `app.log` and `doc.md`,
  - **When** `doc.md` is selected in per-file view,
  - **Then** `#btn-markdown` is visible in `#vtools`.
  - **When** `app.log` or merged timeline is selected,
  - **Then** `#btn-markdown` is hidden (`classList.contains('hidden') === true`).

### Requirement 3: Default Switch State
**When** a markdown file is initially selected or loaded, the `#btn-markdown` switch shall default to `Markdown: OFF`, and the viewer shall display raw line-numbered log rows in `#viewer`.

- **AC-003 (Default Raw View)**:
  - **Given** a new markdown file `guide.md` is loaded and selected,
  - **When** the viewer is rendered,
  - **Then** `#btn-markdown` text is `Markdown: OFF`, `#btn-markdown` does not have class `on`, `#viewer` is visible, and `#md-viewer` is hidden.

### Requirement 4: Markdown Rendering Toggle
**When** the user clicks `#btn-markdown`, the application shall toggle between `Markdown: ON` and `Markdown: OFF`:
- **While** `Markdown: ON`, `#viewer` shall be hidden, `#md-viewer` shall be visible, and the full content of the file shall be parsed and rendered as formatted HTML.
- **While** `Markdown: OFF`, `#md-viewer` shall be hidden, `#viewer` shall be visible, and the standard virtualized row viewer shall display the raw lines.

- **AC-004 (Toggle Execution)**:
  - **Given** `doc.md` is displayed in raw mode,
  - **When** the user clicks `#btn-markdown`,
  - **Then** `#btn-markdown` text becomes `Markdown: ON`, class `on` is added, `#viewer` is hidden, `#md-viewer` is visible and contains rendered HTML tags (`<h1>`, `<p>`, `<ul>`, `<table>`).
  - **When** the user clicks `#btn-markdown` again,
  - **Then** `#btn-markdown` text becomes `Markdown: OFF`, class `on` is removed, `#md-viewer` is hidden, and `#viewer` displays rows.

### Requirement 5: Mermaid Diagram Rendering
**Where** a fenced code block has language identifier `mermaid`, the markdown renderer shall parse the diagram syntax and render it as an inline responsive `<svg class="mermaid-diagram">` element. Supported diagram types shall include flowcharts (`graph TD`, `graph LR`, `flowchart TD`, `flowchart LR`) with labeled nodes and directional arrows, and sequence diagrams (`sequenceDiagram`) with participants and message arrows.

- **AC-005 (Mermaid Rendering)**:
  - **Given** a markdown file contains:
    ```markdown
    ```mermaid
    graph TD
      A[Start] --> B[Process]
      B --> C[End]
    ```
    ```
  - **When** rendered with `Markdown: ON`,
  - **Then** `#md-viewer` contains an `<svg>` element representing the diagram with text nodes `Start`, `Process`, `End` and connector lines.

- **AC-006 (Sequence Diagram Rendering)**:
  - **Given** a markdown file contains:
    ```markdown
    ```mermaid
    sequenceDiagram
      Alice->>Bob: Hello
      Bob-->>Alice: Hi
    ```
    ```
  - **When** rendered with `Markdown: ON`,
  - **Then** `#md-viewer` contains an `<svg>` element with participant lifelines for `Alice` and `Bob` and directional message arrows with text `Hello` and `Hi`.

### Requirement 6: Malformed Diagram Recovery
**When** a `mermaid` fenced code block contains syntax errors or unsupported diagram keywords, the renderer shall gracefully fall back to rendering a styled code block with an informative warning banner, rather than crashing or throwing unhandled exceptions.

- **AC-007 (Mermaid Fallback on Syntax Error)**:
  - **Given** a markdown file contains invalid or incomplete Mermaid syntax,
  - **When** rendered in `Markdown: ON`,
  - **Then** no uncaught exception is thrown, and a readable formatted code block is rendered with a warning note.

### Requirement 7: XSS Prevention & Safe Output
**The** markdown module shall escape all untrusted raw HTML input and disallow unsafe attributes/schemes (such as `javascript:` links or arbitrary `<script>` tags), ensuring that rendered markdown is safe from cross-site scripting.

- **AC-008 (Security Sanitization)**:
  - **Given** a markdown file contains `<script>alert(1)</script>` or `<img src=x onerror=alert(1)>`,
  - **When** rendered in `Markdown: ON`,
  - **Then** script tags are escaped or stripped, no external requests are made, and no script execution occurs.

## 4. Exclusions (What NOT to Build)

- No external network fetches or CDN script loaders (all logic must live in `src/markdown.js`).
- No full 3MB official Mermaid.js bundle; only the lightweight pure-JS diagram generator.
- No editing or live markdown editor functionality (this feature is viewer-only).
- No markdown rendering in merged timeline mode across heterogeneous log files; markdown mode activates for per-file viewing of markdown files.
