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
