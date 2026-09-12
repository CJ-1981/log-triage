# Changelog

## Unreleased

## 1.15.0 (2026-09-12)
- feat: per-file ✕ removal with cache purge; collapsible search groups; issue-scan editor; analysis file scoping; ★ bookmark badge chip; auto-switch on search/bookmark jump; responsive mobile layout; config tab; coverage gate per-file overrides
- feat: collapsible per-file search result groups; analysis tab file selector scoping; per-file bookmark cleanup on file removal; stress suite port-detection and server-lifecycle fixes
- docs: v1.13.0 state and plan for PII Providers tab (Presidio/LLM) — FR-25, ADR-0010, proxy-mode design, future test areas

- Planned: PII Providers tab (Presidio sidecar / LLM) — design documented (ADR-0010, FR-25)

## 1.14.0 (2026-09-12)
- feat: star badge chip in the chips row for only-bookmarks filtering with live count (replaces toolbar button)
- docs: add missing v1.12.x feature bullets (issue editor, Config tab, file cache) to changelog
- Planned: PII Providers tab (Presidio sidecar / LLM) — design documented (ADR-0010, FR-25)

## 1.13.0 (2026-09-12)
- chore: rebuild log-triage.html
- feat: Config tab — export/import filter, mask and issue-scan configuration as JSON with validation and setup summary

## 1.12.1 (2026-09-12)
- chore: rebuild log-triage.html
- fix: materialize issue-scan rule groups at boot (analysis tab crashed when state.issueGroups was unset); e2e diagnostics for panel render
- feat: file cache (IndexedDB) — previously loaded files are listed after reopening the app; cached ones reload on click, uncached ones show greyed as "file not found"
- feat: Config tab — export/import filter rules, time range, PII mask setup and issue-scan rules as one JSON file

## 1.12.0 (2026-09-12)
- chore: rebuild log-triage.html
- feat: analysis tab file selector scopes every section to one file or all; auth issue scan detects failed password lines
- feat: issue-scan rule editor — enable/disable, edit, add or delete keyword groups with a how-it-works note

## 1.11.1 (2026-09-12)
- chore: rebuild log-triage.html
- fix: search-result and bookmark clicks auto-switch the per-file selection and clear hiding filters before jumping; file list active highlight refreshes on programmatic view switches (regression specs)

## 1.11.0 (2026-09-12)
- chore: rebuild log-triage.html at current version
- feat: time histogram axes — y gridlines with value ticks, x time tick labels, hover tooltip with count and time range (DPR-aware canvas)

## 1.10.0 (2026-09-12)
- chore: rebuild log-triage.html
- feat: collapsible bookmarks panel section in sidebar with drag-resize handle; per-file removal clears that file's bookmarks

## 1.9.0 (2026-09-12)
- chore: rebuild log-triage.html
- feat: per-file ✕ removal now purges the file cache entry; duplicate removeFileById declarations merged (cache-aware path restored)

## 1.8.0 (2026-09-12)
- chore: rebuild log-triage.html
- feat: star toggle in viewer toolbar to show only bookmarked lines (with hint when none exist; re-filters live when bookmarks change)

## 1.7.0 (2026-09-12)
- chore: rebuild log-triage.html
- feat: bookmarks panel in the sidebar under Files (entry list, jump-to-line, count pill; replaces the drawer-based panel)

## 1.6.0 (2026-09-12)
- chore: rebuild log-triage.html at current version
- feat: level chips rescope to the active file in per-file view (store.tallyFor); merged view keeps the all-files sum

## 1.5.0 (2026-09-12)
- chore: rebuild log-triage.html
- feat: per-file ✕ remove buttons in the files panel (drops lines, counters and tally contribution; clear-all uses the same path); level tally remove/clamp

## 1.4.0 (2026-09-12)
- feat: collapsible per-file search result groups with collapse-all/expand-all
- chore: rebuild log-triage.html at current version
- docs: update README and docs to v1.3.0 state (new features, FR-15..FR-19, ADR-0007 session-scoped filters, test counts and evidence)

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
