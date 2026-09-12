# Changelog

## Unreleased
## 1.1.0 (2026-09-12)
- feat: search-result click-to-line jump, go-to-line control, stress e2e suite (wheel scroll, line jumps, deep-scan full coverage, wrap/chip stress); deep-scan completion message reports scanned lines
# Changelog

## 1.0.0 (2026-09-11)

- G0: scaffold, build pipeline, coverage gate, CI workflow
- G1: format autodetection and parsers (logcat, syslog, CLF, ISO-8601, MM-DD, plain)
- G2: 16-rule PII masking with custom regex→template rules and the PiiProvider registry (mock provider included)
- G3: filter engine (include/exclude/highlight, live counters) with the dynamic level tally and chips
- G4: ripgrep-style search — instant over kept lines plus deep scan re-streaming files from disk (-F -i -w -v, -B/-A, -c/-l)
- G5: kept-line store (streaming ingestion, 8 MB valve, 100k cap with FIFO trim, exact per-file counters), merged timeline, virtualized viewer, selection model, bookmarks
- G6: sanitized exporters (.log/.txt, .csv, .json, rg results, bookmarks) and tools/bump.mjs version tooling
- G7: six themes (Midnight, Paper, Solarized Dark/Light, Monokai, High Contrast) and full UI assembly
- G8: Playwright e2e suite (8 specs), 300 MB big-file verification, review fixes (build token replacer P0, quick-regex cache, amortized trim, MessageChannel yield)

## Unreleased

- Clicking an instant-search result now jumps to the line in the viewer (auto-switches tab, selects and opens the detail drawer); results referencing lines beyond the kept-line cap show the matched text with an explanatory note instead
- New "go to line" control in the viewer toolbar (type a line number, press Enter); lines outside the current view are reported with the reason (filtered out or released by the kept-line cap)
- Stress e2e suite (tests/e2e/stress.e2e.spec.mjs, `npm run e2e:stress`): 30 MB / ~338k-line ingest timing + exact counters vs the fixture on disk, real mouse-wheel scrolling of the virtualized viewer, go-to-line inside and outside the kept window, search-result line jump, uncapped deep-scan full-file coverage assertion, wrap-toggle responsiveness over the full kept set, and rapid chip toggling
- Deep-scan progress message now reports the number of lines scanned when the scan completes (`deep scan: N match(es) over M lines`)
