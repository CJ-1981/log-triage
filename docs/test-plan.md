# Test plan

Version reference: v1.3.0. Development was test-driven and proceeded through quality gates G0–G8. Each gate has entry/exit criteria; coverage is mechanically enforced.

**Current status: v1.3.0 — all gates G0–G8 done.**

## Quality gates

### G0 — Scaffold, build pipeline, CI

- Entry criteria: repository initialized; `package.json` with npm scripts in place.
- Exit criteria: `node build.js` produces a working single-file `log-triage.html` from UMD `src/` modules; `node tools/coverage-gate.mjs` runs and enforces thresholds; GitHub Actions CI (`.github/workflows/ci.yml`) runs test + coverage, build, e2e, and the automatic semver bump on main; `?selftest` page runs the shared suite green.
- Status: **done**.

### G1 — Format autodetection and parsers

- Entry criteria: G0 exit criteria met.
- Exit criteria: `detect.js` distinguishes all six formats (logcat threadtime, syslog RFC 3164, Apache CLF, ISO-8601, bare MM-DD, plain); `parser.js` produces normalized records with year-less `MM-DD HH:MM:SS.mmm` timestamps; unparseable lines map to level "—"; shared cases cover all formats including edge cases; coverage gate green on `util`, `detect`, `parser`.
- Status: **done**.

### G2 — PII masking and PiiProvider registry

- Entry criteria: G1 complete.
- Exit criteria: all 16 built-in rules pass shared cases with documented false-positive guards (timestamps, 13-digit epoch ms, version numbers like `2.41.3`, single decimals, `ff02::1` multicast); rules individually toggleable and applied in fixed order; custom regex → template rules work; masking is lazy (raw stored, masked at render/copy/export); `M` toggle affects viewer and copies; `PiiProvider` registry + mock provider round-trip findings `{start,end,type,score}`; census counts tagged by provider; coverage gate green on `masks`, `pii-provider`.
- Status: **done**.

### G3 — Filter engine and dynamic level tally

- Entry criteria: G2 complete.
- Exit criteria: ordered include (OR) / exclude / highlight regex rules with case toggle; live hit counters correct under rule edits; dynamic level chips derived from the parsed severity ladder (logcat V/D/I/W/E/F, mapped syslog severities, CLF mapped to I/W/E via status) and regenerated per load; "—" lines bypass level filters; inclusive time-range prefix compare verified across file boundaries; coverage gate green on `filters`, `levels`.
- Status: **done**.

### G4 — Ripgrep-style search

- Entry criteria: G3 complete; `File` handles retained.
- Exit criteria: instant search over kept lines with smart-case default and explicit toggle; deep scan re-streams from disk and finds lines absent from the kept store; `-F`, `-w`, `-v`, `-i`/sensitive, `-B`/`-A`, and normal/`-c`/`-l` modes all verified; results capped (default 10k), grouped as `file:lineNo:`, and exportable as rg-style text and JSON; coverage gate green on `search`.
- Status: **done**.

### G5 — Store, timeline, selection, bookmarks

- Entry criteria: G4 complete.
- Exit criteria: sequential multi-file ingestion with per-file and overall progress and cancel; 8 MB newline valve handles chunked/multibyte boundaries; global kept-line cap (default 100k, configurable) enforced with amortized FIFO trim and exact per-file counters; `File` handles retained for deep scan; merged timeline sorts by timestamp with file-order tiebreak and attaches null-timestamp (stack trace) lines to their predecessor; virtualized viewer smooth at 100k+ rows; wrap toggle with measured-height cache; selection (anchor / shift-range / ctrl-toggle / ctrl+A) copies with optional `file:lineNo:` prefixes and honors mask state; bookmarks persist by file identity and survive reload; coverage gate green on `store`, `timeline`, `selection`, `bookmarks`.
- Status: **done**.

### G6 — Exporters and bump tooling

- Entry criteria: G5 complete.
- Exit criteria: `.log`/`.txt` (both `[Ln]` and `file:lineNo:` prefixes), `.csv`, `.json` exports byte-verified against expected output; search-result and bookmark exports; selection-only export; masked export; filenames match `YYYY-MM-DD_HHmmss`; presets persist to localStorage and round-trip JSON import/export; `tools/bump.mjs` updates `package.json`, the README version marker, and `docs/changelog.md`, tagging `vX.Y.Z`; coverage gate green on `exporter`.
- Status: **done**.

### G7 — Themes and full UI

- Entry criteria: G2–G6 complete.
- Exit criteria: six themes switch via `body[data-theme]` CSS variables — Midnight (default), Paper, Solarized Dark, Solarized Light, Monokai, High Contrast — and the choice persists; full UI assembled in `src/app.js` (file list, viewer, analysis tab, search results panel, presets UI, detail drawer, inline demo log); severity badges and W/E/F row tint.
- Status: **done**.

### G8 — E2e suite, big-file verification, review fixes

- Entry criteria: G2–G7 complete.
- Exit criteria: full Playwright suite (8 specs) green; `?selftest` parity verified in Chromium; 300 MB synthetic-log performance verification passes; code-review fixes landed (build token replacer P0, quick-regex cache, amortized trim, MessageChannel yield — see ADR-0006); docs regenerated by `tools/bump.mjs`; release tagged `v1.0.0` by CI.
- Status: **done**.

## Verification evidence (v1.3.0)

- **Shared cases:** 113 shared logic cases plus a theme check pass in both runners — `node --test` and the browser `?selftest` page each report **114 passed / 0 failed**.
- **Coverage gate:** green on all core `src/` modules (≥ 90% line / ≥ 85% branch enforced by `node tools/coverage-gate.mjs`).
- **E2e:** Playwright suite **26/26 green** (18 app + 8 stress) locally (spec lists below).
- **Error guard:** every e2e test ends with an `afterEach` assertion of zero uncaught page errors (`page.on(pageerror)` plus an in-page `window.__errs` tally) — the guard that would have caught the v1.1.x file-switch `ReferenceError` (see Retrospective R1).
- **Performance / big file:** a 300 MB / 3,380,636-line synthetic log was fully streamed and counted in ~31 s in Chromium (~108 MB/s), with exact per-file counters, FIFO trim at the 100k kept-line cap, and zero page errors. Throughput in hidden/background tabs is lower because browsers throttle them; the app uses a `MessageChannel` yield (ADR-0006) to minimize this effect.

## Coverage policy

- Enforced by `node tools/coverage-gate.mjs` on Node 22 using `node:test`.
- Thresholds **per core `src/` module**: ≥ 90% line coverage and ≥ 85% branch coverage.
- Exempt from the gate: `src/app.js` (UI glue), `build.js`, and the tests themselves.
- The gate runs locally (`npm run test:gate`) and in CI; a merge below the threshold is blocked.

## Commands

| Command | Purpose |
| --- | --- |
| `npm test` | Run the Node unit suites (`node:test`, Node 22): shared logic cases + bump-tooling suite. |
| `npm run test:gate` | Run unit tests with coverage and enforce ≥ 90% line / ≥ 85% branch per core module. |
| `npm run e2e` | Run the Playwright end-to-end suite (26 specs: 18 app + 8 stress) against the built `log-triage.html`. |
| `npm run e2e:stress` | Run only the stress suite against the generated big fixture (`tools/genbig.mjs`). |
| `npm run build` | Rebuild `log-triage.html` from `src/` (inlines CSS, modules, shared cases, demo log). |

## Shared-cases approach

`tests/core-cases.js` is the single source of behavioral truth: a UMD module of named cases (input → expected) consumed by both runners.

- **Node:** `npm test` (`node --test`) runs the shared logic suite through `src/_src.js` alongside the bump-tooling suite; the coverage gate wraps the shared-case run.
- **Browser:** `build.js` inlines the identical file into `log-triage.html`; opening it with `?selftest` executes the suite and reports pass/fail counts and failing case names.
- **Guarantee:** any behavior change must be expressed as a case update, so Node CI and the in-browser self-test can never disagree.

## E2e scope (Playwright — 26 specs: 18 app + 8 stress)

App suite (18 specs) — coverage includes:

1. `?selftest` page runs and reports green.
2. Demo load: format detection, level chips, and masking indications correct.
3. Quick filter with highlight marks applied.
4. Multi-file load of three formats rendered in the merged view.
5. Instant search and deep scan agree on results.
6. Theme persistence.
7. Bookmark persistence across reload.
8. Masked export download, byte-checked.
9. Files-panel collapse/expand and persistence of the collapsed state.
10. File-item click switches the viewer between loaded files.
11. Search-results horizontal scrolling at a 420 px viewport (full text reachable).
12. Mobile layout at 390×844: no page overflow, files panel as overlay drawer, mask cards stacked.
13. Wrap geometry: no horizontal overflow in wrap mode, tall wrapped rows measured correctly, correct scroll position after jumps.
14. Horizontal scrolling in the nowrap viewer, sized from the longest line.

Stress suite (`tests/e2e/stress.e2e.spec.mjs`, `npm run e2e:stress`), run against a generated 30 MB / ~338k-line fixture (`tools/genbig.mjs`):

1. Ingest timing (<60 s) with total-line count asserted against the fixture on disk.
2. Real mouse-wheel scrolling of the virtualized viewer (bounded window, monotonic line numbers).
3. Go-to-line inside the kept window (viewer scrolls, drawer shows the exact line).
4. Go-to-line for a line released by the kept-line cap (clear explanatory status).
5. Clicking an instant-search result jumps to the line (tab switch, selection, drawer).
6. Uncapped deep scan covers every line on disk (`deep scan: N match(es) over M lines` with M = fixture lines) and finds matches the kept cap hides.
7. Wrap toggle over the full kept set stays responsive; rapid chip toggling stays consistent and error-free.

## Fixture inventory (`tests/fixtures/`)

| Fixture | Format | Contents |
| --- | --- | --- |
| `demo.log` | logcat threadtime | Realistic Android logcat with planted PII (VIN, email, MAC, IP, serial `SN-`, GNSS coordinates, subscriberId, `AndroidShare_` SSID) plus crash/ANR/connectivity/auth sample lines. |
| `syslog.log` | syslog RFC 3164 | Mixed-severity syslog lines exercising severity-to-level mapping. |
| `apache.log` | Apache CLF | Combined log format entries whose statuses map to I/W/E level chips. |
| `service.log` | ISO-8601 | Service log with ISO-8601 timestamps, multiline stack traces (null-timestamp lines), and plain fallback lines. |

## Retrospectives

### R1 (2026-09-12) — file switching shipped broken despite green tests

- **Bug**: clicking a file in the list threw `ReferenceError: refreshView is not defined`; the viewer never switched files. Shipped in v1.1.x because no spec drove the file-item click and no spec asserted page errors.
- **Why the tests missed it**: (1) the multi-file spec validated the merged view but never clicked a file item; (2) uncaught page exceptions were captured (`page.on(pageerror)`) but never asserted; (3) unit tests cannot catch boot-time DOM wiring.
- **Actions taken**:
  - every e2e test now ends with an `afterEach` assertion that zero uncaught page errors occurred (`page.on(pageerror)` + in-page `window.__errs`);
  - interaction control map: every clickable control must be driven by at least one spec (file item, view-mode select, wrap/mask/follow toggles, bookmark gutter, search-result click, go-to-line, presets, exports);
  - `fresh()` test helper now clears localStorage **before** the app boots (clear-after-boot leaked the previous test persisted filters into the next test — masked by a second bug: transient filters are no longer persisted at all, see changelog).

### R2 (2026-09-12) — selection stuck in drag mode

- **Bug**: after one click, merely moving the mouse over rows kept extending the selection (the drag flag survived, and re-rendered rows re-fired synthetic `mouseover` events, looping the handler).
- **Actions**: drag extension now requires the primary button to be genuinely held (`e.buttons & 1`) and ignores repeated hover on the same row; drag state resets on `mouseup`, viewer `mouseleave`, and after a completed jump. Regression spec dispatches hover events with no button and asserts the selection cannot change.
