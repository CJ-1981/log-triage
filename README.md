<!-- version: 1.18.0 -->

# Log Triage

**Live app: https://cj-1981.github.io/log-triage/** — open it, drop a log file, done. The page is deployed automatically by CI from `main`.

**Log Triage** is a privacy-first log triage tool that runs entirely in your browser. Drop one or more log files onto a single self-contained HTML page and get instant format detection, parsing, filtering, ripgrep-style search, PII masking, analysis, and sanitized export — with no server, no uploads, and no telemetry. Your files never leave your machine.

Current release: v1.15.0

## Screenshots

**Viewer** — virtualized log table with severity badges, dynamic level chips, quick-filter match highlighting, bookmarks, and the line detail drawer (dark "Midnight" theme):

![Log viewer — Midnight theme](docs/img/1-viewer-midnight.png)

The same viewer in the light **Paper** theme:

![Log viewer — Paper theme](docs/img/2-viewer-paper.png)

**Masks** — the 16 built-in PII rules with live input→output examples, custom regex→template rules, and a preview box:

![PII masking rules](docs/img/3-masks.png)

**Analysis** — counters, level distribution, canvas time histogram, top tags and message shapes, issue scan, and the PII census:

![Analysis dashboard](docs/img/4-analysis.png)

**Search** — ripgrep-style flags, instant results grouped by file as `file:lineNo:`, deep scan from disk, and click-to-jump:

![Ripgrep-style search](docs/img/5-search.png)

## Quick start

- **Use it:** open `log-triage.html` in any modern browser. No installation, no server, no network access required.
- **Rebuild it:** from the repository root, run:

  ```sh
  node build.js
  ```

  This concatenates the `src/` UMD modules (plus CSS, shared test cases, and demo data) into a fresh single-file `log-triage.html`.

**Browser requirements:** any modern Chromium-based browser or Firefox; Safari 16.4+ (lookbehind regexes). Node.js 22 is required **only** for building and running tests. The generated HTML file is fully self-contained and runs anywhere, including offline from `file://`.

**On mobile:** the files panel opens via the header "☰ Files" toggle and overlays the viewer; wrap mode reflows long lines to the column width.

## Features overview

- **Multi-file loading** — sequential streaming ingestion with per-file and overall progress, cancel support, an 8 MB newline valve, and exact per-file counters. Only filtered "kept" lines are retained, under a configurable global cap (default 100,000 lines).
- **Format autodetection** — Android logcat threadtime, syslog (RFC 3164), Apache CLF, ISO-8601, bare `MM-DD`, and plain text with timestamps normalized to a year-less `MM-DD HH:MM:SS.mmm` form.
- **Ripgrep-style search** — instant search over kept lines plus a deep-scan mode that re-streams files from disk with `-F` (fixed strings), smart-case default (`-i` / sensitive), `-w` whole word, `-v` invert, `-B`/`-A` context, and normal / `-c` count / `-l` files-with-matches modes. Results are capped (default 10,000), grouped by file as `file:lineNo:` in collapsible per-file groups (Collapse all / Expand all, match counts in headers), and exportable as rg-style text or JSON.
- **PII masking** — 16 built-in ordered regex rules (VIN, IBAN, credit card, SSN, international and US phone, IMEI, email, device serial `SN-`, MAC with OUI kept, private/public IPv4, IPv6 link-local/ULA, GNSS decimal pairs, subscriberId, hotspot SSID `AndroidShare_`), individually toggleable, plus custom regex-to-template rules. Masking is applied lazily over raw stored text and toggled in the viewer with the `M` key. An extensible `PiiProvider` registry supports local regex (default) and remote backends — Presidio sidecar and LLM API with CORS proxy mode are designed in the Providers tab (FR-25, ADR-0010); the local regex engine remains the default and works fully offline.
- **Filter engine** — ordered regex rules of three kinds: include (OR), exclude (subtractive), and highlight (additive), with a case toggle and live hit counters. Dynamic level chips are generated from the levels actually observed in each load, and an inclusive time range narrows the view by timestamp prefix comparison.
- **Analysis tab** — level bars, top tags, top messages via pattern normalization (numbers/hex/UUIDs stripped to cluster similar lines), a canvas time histogram with y-axis gridlines and value ticks, x-axis time labels, and a hover tooltip (count + time range; device-pixel-ratio aware), issue scanning for crashes/ANRs/process deaths/connectivity/auth problems (the auth group also detects `failed password` and `password check failed`), an issue-scan rule editor (enable, edit kind and case-insensitive pattern, delete, add-rule, restore-defaults; bad patterns skipped safely; saved in state and presets), a PII census, and per-file comparison — all scopeable via a file selector (`All files (N)` or one file), with issue entries that click-jump to the line.
- **Viewer** — virtualized rendering for 100k+ rows, merged-timeline and per-file views, wrap toggle with a measured-height cache, six themes (Midnight default, Paper, Solarized Dark, Solarized Light, Monokai, High Contrast), severity badges with W/E/F row tint, multiline selection and copy (click anchor, shift-click range, ctrl-click toggle, ctrl+A; copy with optional `file:lineNo:` prefixes), bookmarks with notes persisted by file identity, a sidebar bookmarks panel (entry list, jump-to-line, count pill; collapsible with a drag-resize handle), a ★ only-bookmarks chip in the level-chips row (★ + live bookmarked count; appears when bookmarks exist in scope, click toggles the filter; re-filters live), and a detail drawer.
- **Export sanitized** — `.log`/`.txt` (with `[Ln]` or `file:lineNo:` prefixes), `.csv`, `.json`, rg search results, bookmarks, and selection-only export. Filenames are timestamped `YYYY-MM-DD_HHmmss`.
- **Presets** — named filter/mask/search-flag sets persisted in localStorage with JSON import/export.
- **File removal** — per-file ✕ buttons in the files panel drop a file's lines, counters, and level-chip contribution (clear-all uses the same path); removing a file also clears its bookmarks and purges its cache entry.
- **File cache / session restore** — every successfully loaded file is cached in IndexedDB (`log-triage-cache`); reopening the app lists previous files — clicking a cached entry reloads it, while entries whose content is missing render greyed out with a "file not found" badge and a removable ✕.
- **Config tab** — export/import the current filter rules, time range, PII mask setup, and issue-scan rules as one JSON file, with validation, per-section application, a status line, and current-setup cards.
- **Responsive mobile layout** — header wraps with horizontally scrollable tabs, the files panel becomes an overlay drawer on narrow screens, and the mask grid stacks to a single column.
- **Debounced search and quick-filter inputs** — matching starts after typing pauses (search 250 ms, quick filter 200 ms).
- **Navigation** — click a search result, sidebar bookmark, or issue-scan entry to jump to the line: the per-file selection auto-switches to the matched file and transient filters that would hide the target (quick search, level chips, time range, ★ only-bookmarks) are auto-cleared; lines beyond the kept-line cap open an explanatory drawer; a go-to-line box in the viewer toolbar takes a line number + Enter.
- **Collapsible files panel** — toggle via the header "☰ Files" button (state persisted; auto-collapsed on narrow screens).
- **Horizontal scrolling in nowrap mode** — the scroll range is sized from the longest line in the view, so long lines are fully reachable instead of ellipsis-truncated.
- **Self-test** — `?selftest` runs the same 113-case suite in the browser that `node --test` executes (`tests/core-cases.js`).

## Privacy and security

- **100% client-side.** All parsing, searching, masking, analysis, and export happen in the browser tab. There is no backend; log files never leave the machine.
- **No network by design.** No CDN assets, no external fonts, no analytics, no telemetry of any kind — the tool works fully offline.
- **Lazy masking.** Raw lines are stored locally; masking is applied only at render/copy/export time, so nothing is rewritten behind your back and unmasked inspection is always explicit.
- **Future external PII providers are opt-in and off by default.** A localhost Presidio sidecar (still machine-local) or a remote LLM backend is a documented extension point (see `docs/decisions.md`, ADR-0003 and ADR-0010). Neither is wired in v1; when they arrive, remote analysis will require an explicit opt-in with a clear warning that data would leave the machine.

## Development

Requirements: Node.js 22.

```sh
npm test          # Unit + bump suites (node:test)
npm run test:gate # Unit tests + coverage gate (>=90% line / >=85% branch on core src modules)
npm run build     # Build log-triage.html from src/
npm run e2e       # Playwright end-to-end tests (35 specs: 27 app + 8 stress)
npm run e2e:stress # Stress suite only (generated big fixture)
npm run bump      # Semver bump from conventional commits (CI runs this automatically on main)
```

- **TDD with quality gates G0–G8.** Development proceeded gate by gate (scaffold, parsing, masking, filters, search, store/timeline/selection/bookmarks, export/bump tooling, themes/UI, e2e hardening) — all complete in v1.0.0. Each gate has entry/exit criteria in `docs/test-plan.md`, and coverage is enforced per core module by `node tools/coverage-gate.mjs`.
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
│   └── …                  # masks, pii-provider, filters, levels, search, store,
│                          # timeline, selection, bookmarks, exporter, themes,
│                          # app.js + app-filecache.js (UI glue)
├── tests/
│   ├── core-cases.js      # Shared case suite — powers node --test AND ?selftest
│   ├── e2e/               # Playwright specs (app.e2e, stress.e2e)
│   └── fixtures/          # demo.log, syslog.log, apache.log, service.log
├── tools/
│   ├── coverage-gate.mjs  # Coverage enforcement (>=90% line / >=85% branch)
│   ├── bump.mjs           # Conventional-commit semver bump + tag vX.Y.Z
│   ├── genbig.mjs         # Synthetic big-log generator (stress testing)
│   ├── serve.mjs          # Tiny static server for local browser testing
│   └── shots.mjs          # Screenshot capture for docs
├── docs/
│   ├── img/               # README screenshots (generated by tools/shots.mjs)
│   ├── requirements.md    # FR-1..FR-25, NFR-1..NFR-4, out of scope
│   ├── architecture.md    # Module map, build pipeline, data flow, extension points
│   ├── test-plan.md       # Gates G0–G8, coverage policy, e2e scope, fixtures
│   ├── decisions.md       # ADR-0001..ADR-0010
│   └── changelog.md       # Maintained by tools/bump.mjs
└── .github/
    └── workflows/
        └── ci.yml         # test + coverage → build → e2e → Pages deploy → semver bump
```
