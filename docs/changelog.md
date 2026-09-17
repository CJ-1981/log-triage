# Changelog

## Unreleased
- feat: configurable literal/regex color highlighters for matching text or complete viewer rows, with a one-click preset palette and custom color picker
- fix: refill the virtualized Viewer viewport after rules are changed from the hidden Filters tab

## 1.35.0 (2026-09-16)
- Merge pull request #13 from CJ-1981/fix/search-row-overflow
- docs: test-plan item for the files panel filter and sort
- feat: files panel filter box and sort dropdown

## 1.34.1 (2026-09-16)
- Merge pull request #12 from CJ-1981/fix/search-row-overflow
- fix: search result bands stretch uniformly like the viewer

## 1.34.0 (2026-09-16)
- Merge pull request #11 from CJ-1981/fix/search-row-overflow
- test: wait for the async go-to-line jump instead of a fixed delay
- feat: own Wrap toggle for the Search tab results

## 1.33.1 (2026-09-16)
- Merge pull request #10 from CJ-1981/fix/search-row-overflow
- fix: search results wrap long matched lines instead of overflowing

## 1.33.0 (2026-09-16)
- Merge pull request #9 from CJ-1981/feat/search-history-dropdown
- feat: search history dropdown for the rg pattern and quick filter

## 1.32.2 (2026-09-16)
- Merge pull request #8 from CJ-1981/fix/plain-file-long-path-drop
- fix: plain-file drop keeps using dataTransfer.files (long-path safe)

## 1.32.1 (2026-09-16)
- Merge pull request #7 from CJ-1981/fix/long-path-drop-reporting
- fix: folder drop reports unreadable entries instead of loading nothing
- Merge pull request #6 from CJ-1981/test/real-drop-cdp
- test: real Chromium multi-folder drop via CDP DragData.files
- Merge pull request #5 from CJ-1981/test/multi-folder-drop
- test: multi-folder drag & drop in one drop ingests everything
- Merge pull request #4 from CJ-1981/port/wip-wording
- ui: wording for the paging model (analysis-sample scope)
- Merge pull request #3 from CJ-1981/ui/files-clear-button
- ui: files panel header button reads Clear instead of ✕

## 1.32.0 (2026-09-15)
- Merge pull request #2 from CJ-1981/feature/paging-large-files
- fix: normalize build inputs to LF for cross-platform reproducible bundle
- feat: folder drag & drop ingests contained files recursively
- fix: clear stale busy text when work completes
- feat: full-file paging viewer for multi-GB logs

## 1.31.1 (2026-09-14)
- fix: extract top-level .tar.gz/.tgz and gzip payloads misnamed .tar

## 1.31.0 (2026-09-14)
- feat: convert dumpstate_board.bin board dumps to searchable text

## 1.30.0 (2026-09-14)
- feat: skip giant binary entries in archives (real bugreport validation)

## 1.29.1 (2026-09-14)
- fix: drag-and-drop created duplicate file entries
- chore: rebuild bundle at v1.29.0 (freshness check)

## 1.29.0 (2026-09-14)
- fix: customer-log investigation — robust file reading, search scope disclosure, kept-line cap
- chore(release): v1.28.0
- feat: processing indicators for slow paths (analysis placeholder, deep-scan cancel, archive paint)
- docs: describe Pages deployment in the release job (README, test-plan)
- ci: deploy Pages from the release job (bot pushes never triggered the pages job)

## 1.28.0 (2026-09-13)
- feat: processing indicators for slow paths (analysis placeholder, deep-scan cancel, archive paint)
- docs: describe Pages deployment in the release job (README, test-plan)
- ci: deploy Pages from the release job (bot pushes never triggered the pages job)

## 1.27.0 (2026-09-13)
- docs: test-plan spec list ordering (25-29) and tooltip spec 29
- feat: explanatory tooltips on the Search tab rg option controls

## 1.26.0 (2026-09-13)
- feat: severity-grouped issue scan tree; docs refresh

## 1.25.0 (2026-09-13)
- feat: drawer TID + copy buttons; universal inline ✕ clear for text inputs

## 1.24.0 (2026-09-13)
- feat: expand built-in issue-scan catalog to 14 groups (Android expert review)

## 1.23.0 (2026-09-13)
- feat: suspend-to-RAM issue group for Android logcat analysis

## 1.22.3 (2026-09-13)
- fix: post-merge review follow-ups (archive budget semantics, zip claim reserve)

## 1.22.2 (2026-09-13)
- fix: code-review hardening (review/v1.22.x)

## 1.22.1 (2026-09-13)
- fix: ★ only-bookmarked filter no longer sticks after bookmarks run out

## 1.22.0 (2026-09-13)
- feat: per-entry ✕ buttons in the bookmarks panel

## 1.21.1 (2026-09-13)
- fix: bookmarks Clear button wipes all bookmarks in one click

## 1.21.0 (2026-09-13)
- feat: theme picker as header icon button with dropdown (mobile single-line header)
- docs: bring requirements/architecture/test-plan/README up to v1.20.0 state

## 1.20.0 (2026-09-13)
- feat: bookmarks panel Clear button removes entries whose file is not loaded

## 1.19.0 (2026-09-13)
- feat: 7z archive support — pure-JS LZMA/LZMA2 decoder and 7z container (FR-26), zip extraction, archive export

## 1.18.0 (2026-09-13)
- feat: archive support (.gz/.tar/.zip recursive decompress + recompress for export), PII Providers tab wiring, progress overlay; fix: issue editor materialization

## 1.17.0 (2026-09-13)
- fix: archive test expected 'gzip' but module returns 'gz'
- feat: archive support (.gz/.tar/.tar.gz/.zip), ★ star badge chip in chips row, config tab, responsive mobile, file cache — all e2e 35/35
- feat: PII Providers tab (Presidio/LLM with CORS proxy), ★ chip filter, archive support, responsive mobile, config tab
- docs: update README, requirements and test-plan to v1.15.0 state (FR-25 implemented, 35 e2e specs)

## 1.16.0 (2026-09-13)
- chore: rebuild log-triage.html at current version
- feat: PII Providers tab — Presidio/LLM settings, CORS proxy, test connection, scan; fix missing pii-llm-timeout input causing boot crash

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
