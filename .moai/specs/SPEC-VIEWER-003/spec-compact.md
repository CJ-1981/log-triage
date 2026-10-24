# SPEC-VIEWER-003: Compact Specification

- **ID**: SPEC-VIEWER-003
- **Title**: Markdown File (.md) Viewer with Switch and Mermaid Rendering
- **Tier**: S
- **Status**: planned
- **Module**: `src/markdown.js`, `src/app.js`, `template.html`, `build.js`

## Requirements

### Requirement 1: Markdown File Detection
**When** a file whose filename ends with `.md` or `.markdown` (case-insensitive) is ingested or selected, the file list entry shall display `markdown` as its format badge.

### Requirement 2: Toolbar Switch Visibility
**While** the active displayed file is a markdown file, the toolbar shall display the `#btn-markdown` switch button; **While** the active displayed file is NOT a markdown file, the `#btn-markdown` switch button shall be hidden.

### Requirement 3: Default Switch State
**When** a markdown file is initially selected or loaded, the `#btn-markdown` switch shall default to `Markdown: OFF`, and the viewer shall display raw line-numbered log rows in `#viewer`.

### Requirement 4: Markdown Rendering Toggle
**When** the user clicks `#btn-markdown`, the application shall toggle between `Markdown: ON` and `Markdown: OFF`:
- **While** `Markdown: ON`, `#viewer` shall be hidden, `#md-viewer` shall be visible, and the full content of the file shall be parsed and rendered as formatted HTML.
- **While** `Markdown: OFF`, `#md-viewer` shall be hidden, `#viewer` shall be visible, and the standard virtualized row viewer shall display the raw lines.

### Requirement 5: Mermaid Diagram Rendering
**Where** a fenced code block has language identifier `mermaid`, the markdown renderer shall parse the diagram syntax and render it as an inline responsive `<svg class="mermaid-diagram">` element (supporting flowcharts `graph TD`/`LR`, `flowchart TD`/`LR`, and sequence diagrams `sequenceDiagram`).

### Requirement 6: Malformed Diagram Recovery
**When** a `mermaid` fenced code block contains syntax errors or unsupported diagram keywords, the renderer shall gracefully fall back to rendering a styled code block with an informative warning banner, rather than crashing or throwing unhandled exceptions.

### Requirement 7: XSS Prevention & Safe Output
**The** markdown module shall escape all untrusted raw HTML input and disallow unsafe attributes/schemes (such as `javascript:` links), ensuring that rendered markdown is safe from cross-site scripting.

## Acceptance Criteria

- **AC-001**: Loading a `.md` file shows the `markdown` format badge in the files list.
- **AC-002**: Selecting a `.md` file reveals `#btn-markdown` in `#vtools`, displaying `Markdown: OFF`. Selecting a non-markdown file hides it.
- **AC-003**: Initial load of a markdown file defaults to `Markdown: OFF` with raw lines in `#viewer`.
- **AC-004**: Clicking `#btn-markdown` toggles between `Markdown: ON` (showing `#md-viewer` with rendered HTML) and `Markdown: OFF` (restoring `#viewer`).
- **AC-005**: Mermaid flowchart code blocks render as responsive SVG diagrams with labeled nodes and arrows.
- **AC-006**: Mermaid sequence diagram code blocks render as SVG diagrams with participants and message lines.
- **AC-007**: Invalid Mermaid syntax falls back gracefully to formatted code block with warning without throwing.
- **AC-008**: Raw HTML `<script>` tags and unsafe links are escaped/sanitized to prevent XSS.

## Files to Touch
- `src/markdown.js` (NEW)
- `template.html`
- `src/themes.js`
- `src/app.js`
- `build.js`
- `tests/markdown.test.js` (NEW)

## Exclusions
- No external network or CDN dependencies.
- No heavy official Mermaid.js bundle (>2MB).
- No markdown file editing (viewer-only).
- No markdown rendering in merged timeline mode.
