<!-- version: 0.1.0-dev -->

# Log Triage

**Log Triage** is a privacy-first log triage tool that runs entirely in your browser. Drop one or more log files onto a single self-contained HTML page and get instant format detection, parsing, filtering, ripgrep-style search, PII masking, analysis, and sanitized export — with no server, no uploads, and no telemetry. Your files never leave your machine.

Current status: G0–G1 complete (scaffold, parsing); gates G2–G8 in progress.

## Quick start

- **Use it:** open `log-triage.html` in any modern browser. No installation, no server, no network access required.
- **Rebuild it:** from the repository root, run:

  ```sh
  node build.js
  ```

  This concatenates the `src/` UMD modules (plus CSS, shared test cases, and demo data) into a fresh single-file `log-triage.html`.

Node.js 22 is required **only** for building and running tests. The generated HTML file is fully self-contained and runs anywhere, including offline from `file://`.

## Features overview

- **Multi-file loading** — sequential streaming ingestion with per-file and overall progress, cancel support, an 8 MB newline valve, and exact per-file counters. Only filtered "kept" lines are retained, under a configurable global cap (default 100,000 lines).
- **Format autodetection** — Android logcat threadtime, syslog (RFC 3164), Apache CLF, ISO-8601, bare `MM-DD`, and plain text with timestamps normalized to a year-less `MM-DD HH:MM:SS.mmm` form.
- **Ripgrep-style search** — instant search over kept lines plus a deep-scan mode that re-streams files from disk with `-F` (fixed strings), smart-case default (`-i` / sensitive), `-w` whole word, `-v` invert, `-B`/`-A` context, and normal / `-c` count / `-l` files-with-matches modes. Results are capped (default 10,000), grouped by file as `file:lineNo:`, and exportable as rg-style text or JSON.
- **PII masking** — 16 built-in ordered regex rules (VIN, IBAN, credit card, SSN, international and US phone, IMEI, email, device serial `SN-`, MAC with OUI kept, private/public IPv4, IPv6 link-local/ULA, GNSS decimal pairs, subscriberId, hotspot SSID `AndroidShare_`), individually toggleable, plus custom regex-to-template rules. Masking is applied lazily over raw stored text and toggled in the viewer with the `M` key. An extensible `PiiProvider` registry ships with a mock provider; future Presidio and LLM backends are documented but not wired.
- **Filter engine** — ordered regex rules of three kinds: include (OR), exclude (subtractive), and highlight (additive), with a case toggle and live hit counters. Dynamic level chips are generated from the levels actually observed in each load, and an inclusive time range narrows the view by timestamp prefix comparison.
- **Analysis tab** — level bars, top tags, top messages via pattern normalization (numbers/hex/UUIDs stripped to cluster similar lines), a canvas time histogram, issue scanning for crashes/ANRs/process deaths/connectivity/auth problems, a PII census, and per-file comparison.
- **Viewer** — virtualized rendering for 100k+ rows, merged-timeline and per-file views, wrap toggle with a measured-height cache, six themes (Midnight default, Paper, Solarized Dark, Solarized Light, Monokai, High Contrast), severity badges with W/E/F row tint, multiline selection (anchor / shift-range / ctrl-toggle / ctrl+A / copy with optional `file:lineNo:` prefixes), bookmarks with notes, and a detail drawer.
- **Export sanitized** — `.log`/`.txt` (with `[Ln]` or `file:lineNo:` prefixes), `.csv`, `.json`, rg search results, bookmarks, and selection-only export. Filenames are timestamped `YYYY-MM-DD_HHmmss`.
- **Presets** — named filter/mask/search-flag sets persisted in localStorage with JSON import/export.
- **Self-test** — `?selftest` runs the exact same shared case suite in the browser that the Node test runner executes (`tests/core-cases.js`).

## Privacy and security

- **100% client-side.** All parsing, searching, masking, analysis, and export happen in the browser tab. There is no backend; log files never leave the machine.
- **No network by design.** No CDN assets, no external fonts, no analytics, no telemetry of any kind — the tool works fully offline.
- **Lazy masking.** Raw lines are stored locally; masking is applied only at render/copy/export time, so nothing is rewritten behind your back and unmasked inspection is always explicit.
- **Future external PII providers are opt-in and off by default.** A localhost Presidio sidecar (still machine-local) or a remote LLM backend is a documented extension point (see `docs/decisions.md`, ADR-0003). Neither is wired in v1; when they arrive, remote analysis will require an explicit opt-in with a clear warning that data would leave the machine.

## Development

Requirements: Node.js 22.

```sh
npm test          # Run the Node test suite (node:test)
npm run test:gate # Enforce coverage gates (>=90% line, >=85% branch on core src modules)
npm run build     # Build log-triage.html from src/
npm run e2e       # Run Playwright end-to-end tests
npm run bump      # Semver bump from conventional commits (CI runs this automatically on main)
```

- **TDD with quality gates G0–G8.** Development proceeds gate by gate (scaffold, parsing, ingestion, filters, search, masking, viewer, export/presets, e2e hardening). Each gate has entry/exit criteria in `docs/test-plan.md`, and coverage is enforced per core module by `node tools/coverage-gate.mjs`.
- **Conventional commits.** `feat` → minor, `fix` → patch, `!` or `BREAKING CHANGE` → major. On every push to `main`, GitHub Actions runs test + coverage, build, and e2e, then `tools/bump.mjs` bumps the version, updates `package.json`, the README version marker, and `docs/changelog.md`, and tags `vX.Y.Z`.

## Project structure

```
log-triage/
├── log-triage.html        # Built single-file app — open this in a browser
├── build.js               # Concatenates src/ UMD modules into log-triage.html
├── package.json           # npm scripts: test, test:gate, build, e2e, bump
├── src/                   # UMD modules (Node-requireable, browser-safe)
│   ├── _src.js            # Node aggregator exporting all modules for tests
│   ├── util.js            # Shared helpers
│   ├── detect.js          # Format autodetection
│   ├── parser.js          # logcat / syslog / CLF / ISO-8601 / MM-DD / plain parsers
│   └── …                  # Planned: masks, pii-provider, filters, levels, search,
│                          # store, timeline, selection, bookmarks, exporter,
│                          # themes, selftest, app-*.js (UI glue)
├── tests/
│   ├── core-cases.js      # Shared case suite — powers node --test AND ?selftest
│   └── fixtures/          # demo.log, syslog.log, apache.log, service.log
├── tools/
│   ├── coverage-gate.mjs  # Coverage enforcement (>=90% line / >=85% branch)
│   └── bump.mjs           # Conventional-commit semver bump + tag vX.Y.Z
├── docs/
│   ├── requirements.md    # FR-1..FR-14, NFR-1..NFR-4, out of scope
│   ├── architecture.md    # Module map, build pipeline, data flow, extension points
│   ├── test-plan.md       # Gates G0–G8, coverage policy, e2e scope, fixtures
│   ├── decisions.md       # ADR-0001..ADR-0005
│   └── changelog.md       # Maintained by tools/bump.mjs
└── .github/
    └── workflows/
        └── ci.yml         # test + coverage → build → e2e → automatic semver bump
```
