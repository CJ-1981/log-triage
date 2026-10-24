# SPEC-VIEWER-004: Compact Specification

- **ID**: SPEC-VIEWER-004
- **Title**: Source Code Syntax Color Highlighter for Scripts and Config Files (.py, .sh, .bat, .json, .yaml, .js)
- **Tier**: S
- **Status**: draft
- **Module**: `src/syntax.js`, `src/detect.js`, `src/app.js`, `template.html`, `src/themes.js`, `build.js`

## Requirements

### Requirement 1: Code and Config File Detection
**When** a file whose filename matches a supported extension (`.py`, `.pyw`, `.sh`, `.bash`, `.zsh`, `.bat`, `.cmd`, `.json`, `.yaml`, `.yml`, `.js`, `.mjs`, `.cjs`) is ingested or selected, the file list entry shall display its specific language badge in `.fmeta .badge.fmt`.

### Requirement 2: Toolbar Switch Visibility & Initial State
**While** the active displayed file is a recognized code or config file, the toolbar shall display the `#btn-syntax` switch button; **While** the active displayed file is NOT a code file, the `#btn-syntax` button shall be hidden.
**When** a code file is initially selected or loaded, the `#btn-syntax` button shall default to `Syntax: ON`.

### Requirement 3: Python Syntax Highlighting
**While** `Syntax: ON` is active for a Python file, the viewer row text shall highlight keywords, comments (`#...`), quoted strings, numbers, function/class names, and decorators with dedicated syntax token classes.

### Requirement 4: Shell Script Syntax Highlighting
**While** `Syntax: ON` is active for a Shell script (`.sh`, `.bash`, `.zsh`), the viewer row text shall highlight shell keywords, builtins, comments (`#...`), quoted strings, environment/parameter variables (`$VAR`), and numbers.

### Requirement 5: Windows Batch Script Syntax Highlighting
**While** `Syntax: ON` is active for a Windows Batch file (`.bat`, `.cmd`), the viewer row text shall highlight batch commands, comments (`REM` and `::`), environment variables (`%VAR%`, `!VAR!`), labels, and quoted strings.

### Requirement 6: JSON and YAML Syntax Highlighting
**While** `Syntax: ON` is active for JSON or YAML files, the viewer row text shall highlight object keys, string values, numbers, boolean/null literals, and YAML comments (`#...`).

### Requirement 7: JavaScript Syntax Highlighting
**While** `Syntax: ON` is active for a JavaScript file (`.js`, `.mjs`, `.cjs`), the viewer row text shall highlight keywords, comments (`//` and `/* */`), strings, numbers, and boolean/null literals.

### Requirement 8: Toolbar Switch Toggle Action
**When** the user clicks `#btn-syntax`, the application shall toggle `state.syntaxOn` between `true` and `false`:
- **While** `Syntax: ON`, rendered code lines shall display syntax token spans.
- **While** `Syntax: OFF`, the button label shall show `Syntax: OFF`, and rendered rows shall revert to raw uncolored text.

### Requirement 9: Precedence of Search Matches & User Highlight Rules
**Where** quick-filter search marks (`<mark>`) or user-configured highlight rules (`src/highlights.js`) match a text span on a line, the search mark and user highlight rule shall take visual precedence over underlying syntax highlighting.

### Requirement 10: XSS Prevention & Robustness
**The** syntax highlighter module shall escape all untrusted raw HTML input and degrade gracefully without throwing errors or truncating line text when encountering syntax errors, unterminated strings, or arbitrary unicode characters.

### Requirement 11: Theme Compatibility
**The** syntax token color palette shall be legible and contrast-compliant across all six themes (`theme-midnight`, `theme-paper`, `theme-solarized-dark`, `theme-solarized-light`, `theme-monokai`, and `theme-high-contrast`).

## Acceptance Criteria

- **AC-001**: Loading `.py`, `.sh`, `.bat`, `.json`, `.yaml`, or `.js` shows the corresponding language format badge in the files panel.
- **AC-002**: Selecting a recognized code file reveals `#btn-syntax` in `#vtools` defaulting to `Syntax: ON`. Selecting a standard log file hides `#btn-syntax`.
- **AC-003**: Python lines render with `.syn-kwd` for keywords, `.syn-cmt` for comments, `.syn-str` for strings, and `.syn-num` for numbers.
- **AC-004**: Shell script lines render with `.syn-builtin` for builtins, `.syn-var` for `$VAR`, and `.syn-str` for strings.
- **AC-005**: Windows batch lines render with `.syn-cmt` for `REM` and `::`, `.syn-var` for `%VAR%`, and `.syn-kwd` for batch commands.
- **AC-006**: JSON/YAML lines render with `.syn-def`/`.syn-kwd` for keys, `.syn-str` for strings, and `.syn-num` for numbers.
- **AC-007**: JavaScript lines render with `.syn-kwd` for keywords, `.syn-cmt` for comments, and `.syn-str` for strings.
- **AC-008**: Clicking `#btn-syntax` toggles between `Syntax: ON` and `Syntax: OFF`, immediately re-rendering visible rows.
- **AC-009**: Search match `<mark>` tags and user-defined highlight rules layer on top of syntax tokens without visual corruption.
- **AC-010**: All HTML characters are escaped, preventing XSS injection, and malformed syntax degrades gracefully without throwing.
- **AC-011**: Syntax colors maintain >= 4.5:1 contrast across Midnight, Paper, Solarized Dark/Light, Monokai, and High Contrast.

## Files to Touch
- `src/syntax.js` (NEW)
- `tests/syntax.test.js` (NEW)
- `src/detect.js` (MODIFY)
- `template.html` (MODIFY)
- `src/themes.js` (MODIFY)
- `src/app.js` (MODIFY)
- `build.js` (MODIFY)

## Exclusions
- No heavy third-party syntax highlighter engines (e.g. Prism.js, Highlight.js, Monaco, Ace).
- No multi-megabyte language definition bundles or WASM parsers.
- No source code in-place editing or syntax error linting (viewer/reading mode only).
- No syntax highlighting applied to standard logcat/syslog/dlt log lines.
