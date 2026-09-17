# Test plan

Version reference: v1.35.0 plus Unreleased changes. Development was test-driven and proceeded through quality gates G0–G8. Each gate has entry/exit criteria; coverage is mechanically enforced.

**Current status: v1.35.0 plus Unreleased — all gates G0–G8 done.**

## Quality gates

### G0 — Scaffold, build pipeline, CI

- Entry criteria: repository initialized; `package.json` with npm scripts in place.
- Exit criteria: `node build.js` produces a working single-file `log-triage.html` from UMD `src/` modules; `node tools/coverage-gate.mjs` runs and enforces thresholds; GitHub Actions CI (`.github/workflows/ci.yml`) runs test + coverage, build, e2e, and the automatic semver bump on main; the release job also deploys the release-versioned bundle to GitHub Pages (the release commit is pushed with GITHUB_TOKEN, which never triggers workflow runs, so the deploy must live in the same job); `?selftest` page runs the shared suite green.
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
- Exit criteria: ordered include (OR) / exclude rules plus additive color highlighters with case toggle; highlighters support literal/regex matching, text/row targets, preset/custom colors, masked-text rendering, overlap priority, persistence, and config round-trip without changing the filtered count; live hit counters correct under rule edits; dynamic level chips derived from the parsed severity ladder (logcat V/D/I/W/E/F, mapped syslog severities, CLF mapped to I/W/E via status) and regenerated per load; "—" lines bypass level filters; inclusive time-range prefix compare verified across file boundaries; coverage gate green on `filters`, `highlights`, and `levels`.
- Status: **done**.

### G4 — Ripgrep-style search

- Entry criteria: G3 complete; `File` handles retained.
- Exit criteria: instant search over kept lines with smart-case default and explicit toggle; deep scan re-streams from disk and finds lines absent from the kept store; `-F`, `-w`, `-v`, `-i`/sensitive, `-B`/`-A`, and normal/`-c`/`-l` modes all verified; results capped (default 10k), grouped as `file:lineNo:`, and exportable as rg-style text and JSON; coverage gate green on `search`.
- Status: **done**.

### G5 — Store, timeline, selection, bookmarks

- Entry criteria: G4 complete.
- Exit criteria: sequential multi-file ingestion with per-file and overall progress and cancel; 8 MB newline valve handles chunked/multibyte boundaries; global kept-line cap (default 100k, configurable) enforced with amortized FIFO trim and exact per-file counters; `File` handles retained for deep scan; merged timeline sorts by timestamp with file-order tiebreak and attaches null-timestamp (stack trace) lines to their predecessor; virtualized viewer smooth at 100k+ rows; wrap toggle with measured-height cache; selection (anchor / shift-range / ctrl-toggle / ctrl+A) copies with optional `file:lineNo:` prefixes and honors mask state; bookmarks persist by file identity and survive reload; bookmarks-panel Clear button wipes all bookmarks in one click (`removeAll` shared case + e2e incl. ★ chip reset); coverage gate green on `store`, `timeline`, `selection`, `bookmarks`.
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

## Verification evidence (v1.20.0)

- **Shared cases:** 131 shared logic cases plus a theme check pass in both runners — `node --test` and the browser `?selftest` page each report **132 passed / 0 failed** (the suite has grown with the feature gates: archives/7z, bookmark management, the expanded issue-scan catalog).
- **Coverage gate:** green on all core `src/` modules (≥ 90% line / ≥ 85% branch enforced by `node tools/coverage-gate.mjs`); current new-module numbers: `lzma.js` 100%/93%, `format-7z.js` 100%/86%, `archive.js` 96%/89%, `bookmarks.js` 96%/87%.
- **E2e:** Playwright suite **53/53 green + real-file validations** (45 app + 8 stress) locally (spec lists below).
- **Error guard:** every e2e test ends with an `afterEach` assertion of zero uncaught page errors (`page.on(pageerror)` plus an in-page `window.__errs` tally) — the guard that would have caught the v1.1.x file-switch `ReferenceError` (see Retrospective R1).
- **Performance / big file:** a 300 MB / 3,380,636-line synthetic log was fully streamed and counted in ~31 s in Chromium (~108 MB/s), with exact per-file counters, FIFO trim at the 100k kept-line cap, and zero page errors. Throughput in hidden/background tabs is lower because browsers throttle them; the app uses a `MessageChannel` yield (ADR-0006) to minimize this effect.

## Coverage policy

- Enforced by `node tools/coverage-gate.mjs` on Node 22 using `node:test`.
- Thresholds **per core `src/` module**: ≥ 90% line coverage and ≥ 85% branch coverage.
- Exempt from the gate: the UI glue modules (`src/app.js`, `src/app-filecache.js` — never loaded under `node --test`), `build.js`, and the tests themselves. Every other `src/` module must produce a coverage row; a module no test loads fails the gate instead of vanishing silently. Small modules where the never-taken browser fork of the UMD header dominates the branch count (`pii-remote.js`, `issues.js`) carry explicit per-module thresholds in the gate's OVERRIDES table.
- The gate runs locally (`npm run test:gate`) and in CI; a merge below the threshold is blocked.

## Commands

| Command | Purpose |
| --- | --- |
| `npm test` | Run the Node unit suites (`node:test`, Node 22): shared logic cases + bump-tooling suite. |
| `npm run test:gate` | Run unit tests with coverage and enforce ≥ 90% line / ≥ 85% branch per core module. |
| `npm run e2e` | Run the Playwright end-to-end suite (53 specs: 45 app + 8 stress) against the built `log-triage.html`. |
| `npm run e2e:stress` | Run only the stress suite against the generated big fixture (`tools/genbig.mjs`). |
| `npm run build` | Rebuild `log-triage.html` from `src/` (inlines CSS, modules, shared cases, demo log). |

## Shared-cases approach

`tests/core-cases.js` is the single source of behavioral truth: a UMD module of named cases (input → expected) consumed by both runners.

- **Node:** `npm test` (`node --test`) runs the shared logic suite through `src/_src.js` alongside the bump-tooling suite; the coverage gate wraps the shared-case run.
- **Browser:** `build.js` inlines the identical file into `log-triage.html`; opening it with `?selftest` executes the suite and reports pass/fail counts and failing case names.
- **Guarantee:** any behavior change must be expressed as a case update, so Node CI and the in-browser self-test can never disagree.

## E2e scope (Playwright — 53 specs: 45 app + 8 stress)

App suite (55 specs) — coverage includes:

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
11. Search-results wrap at a 420 px viewport (rows fit the panel, no horizontal overflow, text cell usable; Wrap: OFF gives one scrollable line per match).
12. Mobile layout at 390×844: no page overflow, files panel as overlay drawer, mask cards stacked.
13. Wrap geometry: no horizontal overflow in wrap mode, tall wrapped rows measured correctly, correct scroll position after jumps.
14. Horizontal scrolling in the nowrap viewer, sized from the longest line.
15. File cache: a cached previous-session file reloads from IndexedDB on click; an entry without cached content renders greyed with a "file not found" badge and a removable ✕.
16. Analysis file selector: scoping to one file or all updates every section; issue entries click-jump with auto-switch.
17. ★ only-bookmarks chip in the level-chips row: appears with a live bookmarked count when bookmarks exist in scope, click toggles the filter, hidden otherwise.
18. `.7z` ingest: a real 7-Zip-built archive (solid LZMA2, subfolder, file names with directories) is loaded through the file input; both extracted entries appear in the file list, the inner log is detected as logcat, and line counts match (skips when no 7-Zip CLI; CI installs `p7zip-full`).
19. Archive export: the export tab re-packs the extract as `.7z` (format dropdown) — the download's first bytes are the 7z signature `37 7A BC AF 27 1C` and the status line confirms (same skip condition).
20. Bookmarks-panel Clear button: a live demo bookmark plus an injected stale entry (unloaded `ghost.log`) are both listed; Clear wipes **all** bookmarks — count pill and status-bar counter reset to 0, the ★ chip disappears, and the status line reports "cleared 2 bookmark(s)"; a second click is a clean no-op.
21. Bookmarks per-entry ✕: removing one entry leaves the other untouched, updates the pill and status counters, and never triggers the click-to-jump drawer; removing the last entry drops the ★ chip.
22. Theme 🎨 icon dropdown: opens from the header icon, applies the picked theme and persists across reload, closes on selection and outside click; at a 390px viewport the icon keeps the header on a single line.
23. ★ filter release: with ★ only-bookmarked active, Clear (and removing the last bookmark via its ✕) auto-deactivates the filter so all lines show again — reloading the same file keeps the viewer usable; the selected ★ chip can always be clicked off.
24. Providers tab (FR-25 guard): local engine is the default with no remote banner; switching to Presidio shows the warning banner and settings; Test connection against an unroutable port yields a readable status with zero uncaught page errors (the assertion class that would have caught the once-unbundled `pii-remote.js`).
25. Suspend issue group: a `suspend.log` fixture (kernel `PM: suspend entry/exit`, wake reason, freeze aborts, suspend-not-allowed) yields 12 flagged issues in the analysis tab, all attributed to the suspend group; `SleepScheduled` and the filesystem-sync line stay unflagged as false-positive guards.
26. Issue-groups migration: a persisted five-group session (pre-suspend) receives the suspend rule on boot via the boot migration, with the legacy groups preserved.
27. Expanded issue catalog (14 groups): shared cases pin native crash signals (`Fatal signal`, kernel panic), lmkd/OOM memory pressure, binder transaction failures, SELinux denials, watchdog kills, thermal critical/shutdown, storage exhaustion, boot-loop/reason lines, modem subsystem restarts, ANR `am_anr`/`Force finishing`, and the auth tightening (successful token refresh / credential-encrypted storage / LIGHT thermal status are NOT flagged).
28. Issue list tree + severity colors: findings group into collapsible per-kind details sorted crit / high / med / low (demo: crash first, auto-open; others collapsed), summary counts match leaves, and a leaf click still jumps to the line.
29. Search-tab rg tooltips: every ripgrep option control (fixed-strings, whole-word, invert, case-sensitivity select, result-mode select, context-before/after, Deep scan) carries an explanatory hover tooltip; asserted by e2e so future controls cannot silently ship without one.
30. Processing indicators: the analysis tab paints an analyzing placeholder before its deferred heavy render (MutationObserver-verified); the deep-scan cancel control is present-but-hidden while idle; archive block progress yields so messages paint before synchronous LZMA decode.
31. Ingest robustness: with `File.stream()` deliberately broken, a file still ingests fully over the FileReader fallback (44 demo lines, logcat badge); a 120k-line file loads with exact totals and instant search discloses its analysis-sample scope ("match(es) in analysis sample") and makes clear that viewer filtering searches the complete indexed files (Deep scan remains available for context matches beyond the sample).
31.1 Search history dropdown: typing a quick-filter term and an rg pattern records them (deduped case-insensitively, capped at 20, persisted in localStorage); after a reload, focusing either field lists the recorded terms and picking one re-runs the search (input filled, counts update).
31.2 Files panel: a name filter box narrows the list (live files and cached entries, case-insensitive) and a sort dropdown reorders it by load order, name, size, or lines (ascending/descending); an unmatched filter shows a "no files match" hint, and Clear-all resets the filter.
31.3 Zen mode: the toolbar Zen button hides header, sidebar, chips, toolbar, pager and status bar and the viewer fills the window with rows still rendered; a hint and the floating ✕ Zen button appear on entry; Esc exits (and does not clear the selection while in Zen), the floating button exits, and the mode never survives a reload.
32. Drag-and-drop of a file onto the dropzone ingests it exactly once (the drop handler stops propagation; the body-level drop handler is for drops elsewhere on the page). Drag-and-drop of a FOLDER ingests the contained files recursively (mocked `webkitGetAsEntry` tree with a nested subfolder and batched `readEntries`): folder-relative names are kept, the folder pseudo-entry itself is not ingested. Dropping MULTIPLE folders plus a loose file in one drop ingests all of them (two folders, a nested subfolder, and a loose file = 5 files / 5 lines).
33. Real Android bugreport zip (local file, not in CI): 155 MB zip with 315 entries incl. a 1.5 GB dumpstate_board.bin — the board dump is stream-converted to a capped 64 MB `dumpstate_board.bin.log` text entry (newest text, CRC verified, no NUL bytes), ~314 text entries load recursively (301+ file items), and the bugreport text is searchable (verified locally against bugreport-gecko_gas zips; also validated in Node: 555,930-line 88 MB merged logcat batch ingests with exact counts; Node re-verification of the 1.6 GB board dump: 328 entries in ~35 s, ~900 MB peak RSS, 666k log lines extracted).
34. Real TCAM log set (local folder, not in CI): 241 archives (`backup/*.tar.gz` × 172, `umdplog/kmesglog_*.tar` × 68 misnamed-gzip, plus 1) all extract in Node — 4,502 entries / 6.88 GB expanded text in ~26 s, zero failures; the kmesglog tars decompress via gzip-magic sniffing and yield kernel ring-buffer logs.
35. Real 88 MB / 555,930-line logcat through the actual paging-worker code path (Node harness, `tests/tmp/large-file-check.cjs`): index in ~2.5 s with exact level counters; unfiltered view = all 555,930 lines (previously capped at ~100k); quick filter re-stream returns every match (236 for the reported SEAT_OCCU/Bluetooth pattern) in ~2 s; page fetch ~20 ms; go-to-line 450002 resolves to its view position in ~0.7 s.
36. Color highlighter editor: the pattern field accepts real click/typing input and retains focus; literal matching colors text, row mode tints the complete row, a one-click palette color is visibly selected, the shown-line count is unchanged, and the rule/color survive reload.
37. Highlighter config round trip: JSON export preserves every rule field (`name`, `pattern`, `caseSensitive`, `action`, `enabled`, `matchMode`, `target`, `color`) and import restores the same editor state.
38. Rule-editor layout regressions: disabling a rule while Filters is visible must return to a Viewer filled beyond the five hidden-tab overscan rows, and repeated pattern-field focus/edit/rerender cycles must not change the input or column width.

Stress suite (`tests/e2e/stress.e2e.spec.mjs`, `npm run e2e:stress`), run against a generated 30 MB / ~338k-line fixture (`tools/genbig.mjs`, which plants deterministic RAREJUMPMARKER lines every 100k lines so stress tests 5–6 can assert stable click-to-jump and full-coverage deep-scan behavior):

1. Ingest timing (<60 s) with total-line count asserted against the fixture on disk; every indexed line is the view scope (no kept-window trim).
2. Real mouse-wheel paging across the 500-row page edges (line numbers advance across page boundaries, bounded rendered window, error-free).
3. Go-to-line late in the file (viewer loads the page, drawer shows the exact line).
4. Go-to-line for a line the old kept cap used to release (line 150000 of ~338k) — the viewer loads its page and opens the drawer.
5. Clicking an instant-search result jumps to the line (tab switch, selection, drawer).
6. Uncapped deep scan covers every line on disk (`deep scan: N match(es) over M lines` with M = fixture lines).
7. Wrap toggle over the full view stays responsive; rapid chip toggling stays consistent and error-free.

## Fixture inventory (`tests/fixtures/`)

| Fixture | Format | Contents |
| --- | --- | --- |
| `demo.log` | logcat threadtime | Realistic Android logcat with planted PII (VIN, email, MAC, IP, serial `SN-`, GNSS coordinates, subscriberId, `AndroidShare_` SSID) plus crash/ANR/connectivity/auth sample lines. |
| `syslog.log` | syslog RFC 3164 | Mixed-severity syslog lines exercising severity-to-level mapping. |
| `apache.log` | Apache CLF | Combined log format entries whose statuses map to I/W/E level chips. |
| `service.log` | ISO-8601 | Service log with ISO-8601 timestamps, multiline stack traces (null-timestamp lines), and plain fallback lines. |
| `lzma1.hex` / `lzma2.hex` | LZMA streams | Raw pack streams extracted from 7-Zip-built archives (LZMA1 with props `0x5D`, LZMA2 chunked), paired with `sample7z.txt` as the exact expected output — they exercise `src/lzma.js` byte-for-byte without needing the 7-Zip CLI. |
| `sample7z.txt` | log-style text | The plaintext counterpart to the LZMA fixtures; also the content used for CLI-built container fixtures. |

Container-level tests (`tests/format-7z.test.js`, zip extraction in `tests/archive.test.js`) build real archives at test time with the local 7-Zip CLI (solid, non-solid, copy, LZMA1, compressed header, encrypted) and **skip cleanly when no CLI is found** — set `SEVENZIP_BIN` to point at one. CI installs `p7zip-full` on ubuntu so the fixtures (and their coverage) run there; the crafted-buffer tests cover the remaining branches machine-independently.

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

## Future work (planned test areas)

- **Archive deep-dive fuzzing**: malformed 7z/zip containers (random byte mutations, truncated chunk frames, hostile header trees) decoded without unbounded memory or hangs; the CRC and size checks are the current guards.
- **More codecs**: xz/bzip2-compressed tar members and `.tar.zst` if demand appears — same pattern as 7z (pure-JS or a vetted decoder), each with embedded fixture coverage.
- **Large-archive memory strategy**: solid 7z folders decode fully into memory; a chunked/streaming path would lift the practical archive-size ceiling (mirrors NFR-1's streaming posture).
- **Cross-browser e2e**: the suite runs in Chromium; a Firefox/Safari pass would lock in `DecompressionStream('deflate-raw')` behavior everywhere it is supported.
