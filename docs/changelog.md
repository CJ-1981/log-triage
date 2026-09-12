# Changelog

## Unreleased

## 1.3.1 (2026-09-12)
- chore: rebuild log-triage.html
- fix: file-item click switches viewer (undefined refreshView handler); selection drag no longer sticks; retrospective R1/R2 — afterEach page-error assertions and interaction control map

## 1.3.0 (2026-09-12)
- chore: rebuild log-triage.html
- feat: debounce search and quick-filter inputs (250ms/200ms) so matching starts after typing pauses

## 1.2.0 (2026-09-12)
- feat: responsive mobile layout — header wraps with scrollable tabs, files panel becomes an overlay drawer (auto-collapsed on narrow screens), single-column mask grid, scrollable rules table, dynamic viewport height
- chore: rebuild log-triage.html
- test: deterministic RAREJUMPMARKER lines in the stress fixture — fixes the flaky instant-search jump spec (random fixture could hold zero kept-window hits)

## 1.1.5 (2026-09-12)
- fix: horizontal scrolling in nowrap viewer — size the scroll range from the longest line in the view (regression spec added)

## 1.1.4 (2026-09-12)
- test: make stress click-to-jump spec self-contained (fresh page, own ingest, row wait, page-error assertion)
- docs: resolve changelog history after v1.1.3 release rebase
- fix: search-results panel scrolls (flex min-height:0); same fix for file list and tab panels

- Fix: the search-results panel is now scrollable when results exceed the viewport (flex `min-height: 0` was missing, so the panel stretched to full content height inside a clipped layout); the same latent issue was fixed for the file list and the tab panels

## 1.1.3 (2026-09-12)

- chore: rebuild log-triage.html at v1.1.2
- fix: wrap mode now actually wraps long lines — the row container previously stretched to the longest single line (no wrapping, mostly-empty scroll area); windowed pages are also positioned at their true scroll offset
- fix: search results use dedicated file / line number / timestamp / text columns (deep-scan rows extract the timestamp from each line) — the file name no longer overlaps the timestamp
- fix: newly loaded files are visible immediately — stale per-file selection resets to the merged view; files panel is collapsible via the header "☰ Files" toggle
- fix: release-bot changelog insertion folds Unreleased bullets into the new version section with a single header (regression-tested)
- docs: refresh README screenshots; clean changelog structure

## 1.1.2 (2026-09-12)

- chore: rebuild log-triage.html at v1.1.2 (Pages build)
- fix: release-bot changelog insertion now folds Unreleased bullets into the new version section with a single header (regression-tested)

## 1.1.1 (2026-09-12)

- fix: wrap mode renders scrolled windows at true offset; new files visible after per-file selection; collapsible files panel; search results in file/line/timestamp/text columns; changelog structure fix in bump flow; e2e 20 specs
- docs: add screenshots (viewer dark/light, masks, analysis, search) to README; refresh stale project tree and script list
- docs: add live GitHub Pages link to README
- ci: upload site directory as the github-pages artifact (fixes deploy-pages finding no artifact)
- ci: deploy the built single-file app to GitHub Pages on main (actions/deploy-pages, served as index.html)

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
