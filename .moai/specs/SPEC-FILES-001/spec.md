---
id: SPEC-FILES-001
title: "Files Panel Tooltips and Single-Line Name Truncation"
version: "0.1.0"
status: completed
created: 2026-10-24
updated: 2026-10-24
author: CJ-1981
priority: MEDIUM
phase: "v1.60.0 target"
module: "src/app.js, template.html"
lifecycle: spec-anchored
tags: "files-panel, tooltip, truncation, css, ux"
tier: S
related_specs: [SPEC-VIEWER-002]
---

# SPEC-FILES-001: Files Panel Tooltips and Single-Line Name Truncation

## HISTORY

| Date | Version | Author | Change |
|---|---|---|---|
| 2026-10-24 | 0.1.0 | CJ-1981 | Initial draft. Files-panel-only UX change: a native `title` tooltip carrying the full stored name on every entry (live / cached / missing), and single-line CSS ellipsis truncation replacing the multi-line `word-break: break-all` wrap. All design decisions resolved at delegation time (user clarity 10/10). |
| 2026-10-24 | 0.1.0 | CJ-1981 | Plan-audit iteration 2 (revision, all defects user-approved): new e2e spec wired into `package.json` `scripts.e2e` and `package.json` added to Touching (D1); REQ-FILES-004 mapped into AC-002/AC-005 (D2); 300+ char fixture replaced by a ~120-char runtime-generated temp fixture under OS filename limits (D3); AC-006 asserts via `getComputedStyle(…,'::after').content` (D4). REQ/AC counts unchanged (8/8). |

## User Story

As a user triaging many log files whose names exceed the files-panel width — archive members carry long intra-archive folder prefixes (`src/archive.js:397/425/481`) — I want each files-panel entry to render on a single line with an ellipsis when the name overflows, and I want the full name available on hover through a native tooltip, so the panel stays vertically compact and scannable without ever losing access to the complete name.

## Environment

- Privacy-first, browser-only log triage tool. Vanilla JS UMD modules, no framework, no network, no new dependencies (`.moai/project/tech.md`). Single self-contained HTML artifact built by `build.js` from `template.html` plus `src/` modules — the single-file build invariant must not be broken.
- Single render site for the files panel: `renderFiles()` (`src/app.js:460-538`). Three entry kinds share `#file-list` (`template.html:409`):
  - **Live entries** — DOM template `src/app.js:487-493`: `.fx` remove button (already `title="remove this file"`, line 487), `.fname` div (line 488, currently `esc(f.name)`), `.fmeta` badges (489-493).
  - **Cached entries** — `src/app.js:512-524`: container `title = 'cached — click to load'` (520), `.fname` with `esc(c.name)` (521), click-to-load handler (525).
  - **Missing entries** — `src/app.js:526-531`: container `title = 'this file could not be restored'` (528), `.fname muted` with `esc(c.name)` (529), "file not found" badge (530).
- Current truncation: NONE. `.file-item .fname { font-size: 12.5px; word-break: break-all; }` (`template.html:96`) wraps long names across multiple lines. Sibling `.file-item` rules that MUST survive: `.cached .fname::after { content: ' ↻' }` (line 92), `.missing { opacity: 0.55 }` (93), `.missing .fname { text-decoration: line-through }` (94).
- No separate path field exists: `f.name` IS the full stored name; archive members embed intra-archive folder prefixes in it.
- Tooltip house style: 100% native `title` attributes in plain-language voice (`src/app.js:817-849, 843, 848-849`); dynamic text escaped with `esc()` (= `escapeHtml`, `src/util.js:14`). `esc()` already has attribute-context precedent in this exact render function: `data-remove="' + esc(f.id) + '"` (`src/app.js:487`). No custom CSS tooltip class exists anywhere.
- Ellipsis + `title` precedent in-repo: `.vcell.fl` (`template.html:183`, `max-width:140px; overflow:hidden; text-overflow:ellipsis`) paired with `title` at `src/app.js:971`; `.sr-row .srf` (`template.html:283`) + `title` (`src/app.js:1324`); `.history-item` (`template.html:203`); `#sall-note` (`template.html:305`). This SPEC applies the same established pattern to the files panel and ONLY there.
- Tests: Node built-in runner (`node --test`, `package.json` scripts.test); Playwright e2e in `tests/e2e/` (`npm run build && npm run e2e`) — Chromium against the built single-file HTML, served by `tools/serve.mjs`, with a zero-uncaught-page-errors invariant in `afterEach` (`tests/e2e/app.e2e.spec.mjs:51-54`). Existing selectors `.file-item`, `.file-item.cached`, `.badge.fmt` are in use (`app.e2e.spec.mjs:173, 261-263, 525, 613`; `restore-repro.spec.mjs:93, 96` — the latter seeds the IDB cache and is the pattern for cached-entry fixtures).
- `src/app.js` is exempt from the coverage gate (90% line / 85% branch on core modules, `tech.md` § TESTING); e2e is the safety net for render glue.
- Development mode: tdd (`quality.yaml` `constitution.development_mode: tdd`); harness level for this SPEC: minimal.

## Assumptions

- The `↻` suffix on cached entries may become invisible when a cached name overflows, because the `::after` glyph participates in the same clipped inline box as the ellipsized text. This is an accepted consequence of the user decision that the ellipsis is THE truncation indicator; the full name remains on the tooltip. Non-overflowing cached names keep a visible `name ↻` (AC-FILES-006). Confidence: High (CSS inline-box semantics).
- `esc()` output is safe in a double-quoted attribute context (it escapes `"`), per the existing `data-remove` attribute usage at `src/app.js:487`. Confidence: High (in-repo precedent); re-verified during implementation.
- Native title precedence: when hovering the `.fname` text, the inner element's tooltip (the full name) wins over the container tooltip; the container tooltip still applies elsewhere on the row. Both affordances coexist without JS. Confidence: High (browser-native behavior).
- The CSS truncation triplet is width-agnostic, so it holds unchanged in the mobile overlay-drawer form of the files panel. Confidence: High.

## Requirements (GEARS)

### Truncation

- REQ-FILES-001 [Ubiquitous] The files panel shall render every file entry's name element (`.file-item .fname`) on exactly one line, clipping horizontal overflow with the CSS triplet `white-space: nowrap; overflow: hidden; text-overflow: ellipsis`; the ellipsis is the sole truncation indicator and no additional visual accent shall be added.
- REQ-FILES-002 [Unwanted] The files panel shall not wrap file names across multiple lines: the `word-break: break-all` declaration on `.file-item .fname` (`template.html:96`) shall be removed, and no replacement declaration that permits multi-line wrapping (e.g. `overflow-wrap`, a retained `word-break` value) shall be introduced on that element.

### Full-name tooltip

- REQ-FILES-003 [Ubiquitous] Every entry rendered in `#file-list` — live files, cached entries (`.file-item.cached`), and missing entries (`.file-item.missing`) — shall carry a native `title` tooltip on its `.fname` element whose value is exactly the entry's full stored name as held in state (`f.name` for live entries, `c.name` for cached and missing entries, including any intra-archive folder prefixes), HTML-escaped with the app's `esc()` convention.
- REQ-FILES-004 [Unwanted] The `.fname` tooltip shall not duplicate metadata already visible on the entry (size, line counts, format badge, warning badges); and the stored name value itself shall not be shortened, rewritten, or truncated by JavaScript — clipping is display-only.

### Behavior preservation

- REQ-FILES-005 [State-driven] While a files-panel entry is a cached entry (`.file-item.cached`), the entry shall retain every existing affordance unchanged: the `↻` suffix decoration (`.file-item.cached .fname::after`, `template.html:92`), the container tooltip "cached — click to load" (`src/app.js:520`), and the click-to-load behavior (`src/app.js:525`).
- REQ-FILES-006 [State-driven] While a files-panel entry is a missing entry (`.file-item.missing`), the entry shall retain its existing presentation unchanged: the line-through on the name (`template.html:94`), the 0.55 opacity (`template.html:93`), the "file not found" badge, and the container tooltip "this file could not be restored" (`src/app.js:528`).

### Scope enforcement

- REQ-FILES-007 [Unwanted] The implementation shall not introduce a custom tooltip component, a CSS tooltip class, or JavaScript-based name truncation or text-measurement logic; files-panel tooltips remain native `title` attributes per the app's tooltip house style.
- REQ-FILES-008 [Unwanted] The implementation shall not alter truncation or tooltip behavior on any surface outside the files panel — the viewer value cells (`.vcell.fl`), search-all rows (`.sr-row .srf`), history items, tab labels, headers, and the files-panel remove buttons (`.fx`, including their existing titles) keep their current behavior.

## Acceptance Criteria (summary)

Full Given-When-Then enumeration with evidence commands: `acceptance.md`. Eight criteria, all binary-testable:

| ID | One-line contract | Verifies |
|---|---|---|
| AC-FILES-001 | Long live-entry name renders single-line with the ellipsis CSS triplet | REQ-001/002 |
| AC-FILES-002 | Live `.fname` `title` equals the stored full name | REQ-003/004 |
| AC-FILES-003 | Cached `.fname` `title` equals stored name; `↻` rule, container tooltip, click-to-load intact | REQ-003/005 |
| AC-FILES-004 | Missing `.fname` `title` equals stored name; line-through, opacity, container tooltip intact | REQ-003/006 |
| AC-FILES-005 | Name with HTML-special characters: `title` decodes to the exact raw name, no markup injected | REQ-003/004 |
| AC-FILES-006 | Short (non-overflowing) names are visually unchanged; cached `name ↻` still visible | REQ-001/005 |
| AC-FILES-007 | Regression: existing files-panel behaviors and e2e specs pass; `npm test` exit 0 | REQ-005..008 |
| AC-FILES-008 | `template.html` carries the ellipsis triplet and no `word-break` on `.fname`; `npm run build && npm run e2e` passes incl. the new spec | REQ-001/002/007 |

## Constraints

Technical constraints:
- No new dependencies; vanilla JS UMD modules only; no network access; single self-contained `build.js` output intact.
- The built bundle must be rebuilt and committed with the source change — CI fails on a stale bundle (`git diff --exit-code -- log-triage.html`).
- Colors and typography unchanged: the only CSS delta is the truncation declaration change on `.file-item .fname`; no new CSS values, no new classes.
- LF normalization per the build pipeline; `$`-safe token replacement unaffected (no template tokens touched).
- `src/app.js` exempt from the coverage gate; no new pure-function helper is warranted (the tooltip value is `esc(name)` inline — extracting a one-line wrapper would add an abstraction without a consumer), so verification is e2e-level plus the existing unit suites staying green.
- Conventional commits mandatory. Priority-based milestones only; no time estimates.

Business constraints:
- The panel must remain vertically compact for large file lists — one line per entry is the point of the change.
- The full name must never be unreachable: tooltip always carries exactly what is stored.

## Out of Scope

### Out of Scope — Non-files-panel surfaces

- Viewer value cells (`.vcell.fl`), search-all result rows (`.sr-row .srf`), history items, tab labels, headers, and breadcrumbs keep their current truncation/tooltip behavior — no unification pass in this SPEC.
- The empty-filter message ("no files match the filter") is untouched.

### Out of Scope — Tooltip implementation

- No custom tooltip component, no CSS tooltip class, no JS hover handling — native `title` attributes only.
- The `.fname` tooltip carries the full name ONLY — no size/lines/format/warnings metadata duplication.
- Existing container tooltips on cached ("cached — click to load") and missing ("this file could not be restored") rows, and the `.fx` remove-button titles, are unchanged.

### Out of Scope — Name data and interaction changes

- The stored name value is never rewritten, shortened, or normalized — display clipping only; no JS truncation.
- No changes to files-panel filter, sort, remove, click-to-load, active-highlight, or cache/restore behavior.

## Traceability

- Requirement groups: Truncation (REQ-001/002), Full-name tooltip (REQ-003/004), Behavior preservation (REQ-005/006), Scope enforcement (REQ-007/008).
- Touching: `template.html` (one CSS rule), `src/app.js` (three `.fname` templates inside `renderFiles()`), `package.json` (one `scripts.e2e` entry), `tests/e2e/` (one new spec file), `log-triage.html` (rebuilt bundle).
- Not touching: `src/app-paging-worker.js`, `src/paged.js`, `src/filters.js`, `src/archive.js`, `build.js`, `tests/e2e/app.e2e.spec.mjs` (existing assertions unchanged), all non-files-panel surfaces listed above.
- Related: SPEC-VIEWER-002 (tooltip copy/house-style precedent, completed); no dependencies.
