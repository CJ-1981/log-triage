# Changelog

## Unreleased

<<<<<<< HEAD
## 1.1.3 (2026-09-12)
- chore: rebuild log-triage.html at v1.1.2
- fix: wrap mode actually wraps long lines (spacer width root cause) with true-offset windowed rendering; refresh README screenshots; clean changelog after v1.1.1

=======
- Fix: the search-results panel is now scrollable when results exceed the viewport (flex `min-height: 0` was missing, so the panel stretched to full content height inside a clipped layout); the same latent issue was fixed for the file list and the tab panels
>>>>>>> 85d911f (fix: search-results panel scrolls (flex min-height:0); same fix for file list and tab panels)
- Fix: wrap mode now actually wraps long lines — the row container previously stretched to the longest single line (no wrapping, mostly-empty scroll area); windowed pages are also positioned at their true scroll offset

## 1.1.2 (2026-09-12)
- fix: release-bot changelog insertion now folds Unreleased bullets into the new version section with a single header (regression-tested)

## 1.1.1 (2026-09-12)
- fix: wrap mode renders scrolled windows at true offset; new files visible after per-file selection; collapsible files panel; search results in file/line/timestamp/text columns; changelog structure fix in bump flow; e2e 20 specs
- docs: add screenshots (viewer dark/light, masks, analysis, search) to README; refresh stale project tree and script list
- docs: add live GitHub Pages link to README
- ci: upload site directory as the github-pages artifact (fixes deploy-pages finding no artifact)
- ci: deploy the built single-file app to GitHub Pages on main (actions/deploy-pages, served as index.html)
# Changelog

## Unreleased

- Files panel is collapsible via the header "☰ Files" toggle (state persisted; wrapped line heights re-measured on toggle)
- Fix: newly loaded files are visible immediately — loading no longer leaves the viewer stuck on a previous file's per-file selection, and a stale per-file selection falls back to the merged view
- Fix: wrap mode positions rendered pages at their true scroll offset (previously all windowed rows stacked at the container top, so long wrapped logs appeared as a single page)
- Fix: search results use dedicated file / line number / timestamp / text columns (deep-scan rows extract the timestamp from each line) — the file name no longer overlaps the timestamp
- Search-result click-to-line jump, go-to-line control, and the stress e2e suite (wheel scroll, line jumps, deep-scan full coverage, wrap/chip stress); deep scan reports scanned lines on completion
- e2e suite now 20 specs (12 app + 8 stress)

## 1.1.0 (2026-09-12)

- feat: search-result click-to-line jump, go-to-line control, stress e2e suite (wheel scroll, line jumps, deep-scan full coverage, wrap/chip stress); deep-scan completion message reports scanned lines

## 1.0.0 (2026-09-11)

- G0: scaffold, build pipeline, coverage gate, CI workflow
- G1: format autodetection and parsers (logcat, syslog, CLF, ISO-8601, MM-DD, plain)
- G2: 16-rule PII masking with custom regex→template rules and the PiiProvider registry (mock provider included)
- G3: filter engine (include/exclude/highlight, live counters) with the dynamic level tally and chips
- G4: ripgrep-style search — instant over kept lines plus deep scan re-streaming files from disk (-F -i -w -v, -B/-A, -c/-l)
- G5: kept-line store (streaming ingestion, 8 MB valve, 100k cap with FIFO trim, exact per-file counters), merged timeline, virtualized viewer, selection model, bookmarks
- G6: sanitized exporters (.log/.txt, .csv, .json, rg results, bookmarks) and tools/bump.mjs version tooling
- G7: six themes (Midnight, Paper, Solarized Dark/Light, Monokai, High Contrast) and full UI assembly
- G8: Playwright e2e suite, 300 MB big-file verification, review fixes (build token replacer P0, quick-regex cache, amortized trim, MessageChannel yield)
