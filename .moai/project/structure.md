# Structure — Log Triage

Product type: Web Browser App (single self-contained HTML file, built from UMD modules)

## OVERALL ARCHITECTURE OVERVIEW

Log Triage is a single-file browser application assembled from small, Node-requireable UMD modules. The identical module code runs in three contexts:

- The Node test suite (`node --test`) and the coverage gate.
- The in-browser `?selftest` page (the shared case suite is inlined at build time).
- The live UI (modules populate `window.LT` in the browser; `src/_src.js` provides the flat Node-only export object).

All state is local: the kept-line store, bookmarks, and presets live in memory or `localStorage`, loaded files are cached in IndexedDB for session restore, and the original `File` handles are retained so deep scan can re-stream from disk.

The pipeline is: streaming ingestion (per-file format autodetect, parse) → global filter engine (levels, time range, include/exclude rules) → paging worker (full-file columnar index, 500-row pages on demand, analysis sample) → lazy masking engine (16 built-in rules + custom, `PiiProvider` registry) → virtualized themed UI → sanitized export. Ripgrep-style search runs instant (over the sample) and deep-scan (re-streaming from disk) modes in parallel paths.

A dedicated Web Worker owns the full-file indexes, matching, timeline ordering, and page caches; it is spawned from a Blob URL built from an inlined pure-logic bundle (no UI glue), and the browser talks to it through a small RPC wrapper with progress-aware promises and cancellation tokens.

## DIRECTORY STRUCTURE

```
log-triage/
├── log-triage.html        # Built single-file app — the deliverable; open in a browser
├── template.html          # Build template; tokens replaced by build.js
├── build.js               # Concatenates src/ UMD modules into log-triage.html
├── package.json           # npm scripts: test, test:gate, build, e2e, bump; MIT; private
├── README.md              # Feature documentation, version marker, project structure
├── src/                   # UMD modules (Node-requireable, browser-safe)
├── tests/                 # node:test suites, shared case suite, e2e, fixtures
├── tools/                 # Build/QA/dev helper scripts (Node)
├── docs/                  # Requirements, architecture, test plan, ADRs, changelog, images
└── .github/workflows/ci.yml  # test + coverage → build → e2e → Pages deploy → semver bump
```

## SOURCE MODULES (src/)

Each `src/*.js` is a UMD module: requireable in Node for TDD, loadable in the browser, and concatenated by `build.js` in dependency order.

Core logic modules (all covered by the coverage gate):

- `util.js` — small pure helpers shared by every module.
- `detect.js` — format autodetection (logcat threadtime, syslog RFC 3164, Apache CLF, ISO-8601, bare MM-DD, dlt-viewer, plain).
- `parser.js` — parsers for the six formats; normalized records (`file · lineNo · ts · level · tag · pid · msg`).
- `masks.js` — the 16 built-in ordered PII regex rules plus custom regex-to-template rules; lazy mask application.
- `pii-provider.js` — `PiiProvider` interface, registry, and local provider (extension point per ADR-0003).
- `pii-remote.js` — Presidio/LLM request builders, response parsers, offset mapping; HTTP injected (`fetchImpl`) so everything is testable without a network.
- `filters.js` — ordered include/exclude filtering, rule compilation, case toggle, live hit counters.
- `highlights.js` — presentation-only literal/regex highlighter compilation, bounded non-overlapping text spans, whole-row matches, readable foreground selection.
- `levels.js` — dynamic level tally and chip generation from observed levels.
- `search.js` — ripgrep-style search building blocks (`-F -i -w -v`, `-B/-A`, `-c/-l`), capped results; matcher shared by the search tab and the paging worker.
- `paged.js` — full-file log index: columnar typed arrays (Float64 byte offsets, packed timestamp keys, level codes), streaming line splitter, on-demand pages over `File.slice` with a byte-bounded LRU cache, head+tail analysis sampling, async merge sort.
- `store.js` — analysis-sample store and exact per-file counters (total/kept/bytes, level tally).
- `timeline.js` — merged-timeline ordering (timestamp sort, file-order tiebreak, stack-trace anchoring) and histogram data.
- `selection.js` — selection model (anchor / shift-range / ctrl-toggle / ctrl+A); masked copy with optional prefixes.
- `bookmarks.js` — bookmarks keyed by file identity (name + size + first-line hash), notes, export/import.
- `exporter.js` — sanitized export builders (pure string builders); all exports receive already-masked text and the exporter never unmasks.
- `export-stream.js` — streaming serialization: async record batches to encoded chunks without holding the whole output in memory.
- `export-archive.js` — streaming archive assembly for exports (zip with data descriptors, tar two-pass entries, stored-entry 7z).
- `archive.js` — archive support: detection and recursive extraction of `.gz/.tar/.tar.gz/.tgz/.zip/.7z`, gzip via `DecompressionStream`, zip and tar readers/writers.
- `format-7z.js` — 7z container parsing and writing, including compressed headers, CRC32 verification, Copy/LZMA/LZMA2/Deflate folder decoding; stored-entry writer only.
- `lzma.js` — pure-JS LZMA1/LZMA2 decoder (no WASM, no external code, per ADR-0011).
- `themes.js` — single source of truth for the six themes; the build generates CSS variable blocks from it.
- `issues.js` — issue-scan groups (crash/ANR/suspend/memory/etc.) and rule editor support.
- `droptree.js` — recursive dropped-folder walking with folder-relative entry names.
- `_src.js` — Node-only aggregator exporting all modules for tests and the coverage gate (not in the browser bundle).

Browser-only glue modules (exempt from the coverage gate):

- `app.js` — main UI glue, tabs, viewer, search panel, presets UI, `?selftest` runner.
- `app-filecache.js` — IndexedDB file cache wrapper for session restore; degrades gracefully when IndexedDB is unavailable.
- `app-paging.js` — worker RPC client (Blob-URL Worker from the inlined worker bundle).
- `app-paging-worker.js` — the paging worker itself: owns indexes, matching, timeline ordering, page fetches, locate, removal; emits throttled progress and honors cancellation.
- `app-export.js` — export orchestration glued to the UI.

Build-time module sets defined in `build.js`:

- `MODULE_ORDER` — the 26 application modules concatenated into the page bundle.
- `WORKER_ORDER` — the pure-logic subset (`util`, `detect`, `parser`, `filters`, `search`, `paged`, `app-paging-worker`) inlined as a string for the Blob-URL worker; the worker must run standalone without UI glue.

## TESTS (tests/)

- `core-cases.js` — shared UMD case suite (input → expected) powering both `node --test` and the in-browser `?selftest` page.
- Unit suites: `core.test.js`, `scaffold.test.js`, `bump.test.js`, `archive.test.js`, `format-7z.test.js`, `pii-remote.test.js`, `paged.test.js`, `selection.test.js`, `droptree.test.js`, `highlights.test.js`, `exporter.test.js`, `export-stream.test.js`, `export-archive.test.js`.
- `e2e/app.e2e.spec.mjs` — Playwright end-to-end specs (99 app specs).
- `e2e/stress.e2e.spec.mjs` — stress suite (8 specs) over a generated big fixture.
- `fixtures/` — `demo.log`, `syslog.log`, `apache.log`, `service.log`, `suspend.log`, `dlt-viewer-sample.txt`, `sample7z.txt`, and LZMA hex fixtures. The 7z/zip container tests build real archives with the local 7-Zip CLI when available (`p7zip-full` in CI; `SEVENZIP_BIN` override on Windows) and skip cleanly without it.

## TOOLS (tools/)

- `coverage-gate.mjs` — coverage enforcement (90% line / 85% branch minimum on core src modules); fails loudly if any gated module produces no coverage row.
- `bump.mjs` — conventional-commit semver bump: updates `package.json`, the README version marker, `docs/changelog.md`, tags `vX.Y.Z` (CI runs this on `main`).
- `genbig.mjs` — synthetic big-log generator emitting deterministic RAREJUMPMARKER lines every 100k lines for stable stress assertions.
- `serve.mjs` — tiny static server for local browser testing.
- `shots.mjs` — screenshot capture for the README images.
- `debug-*.mjs`, `tmp-replace-histo.cjs` — dev/debug probes and one-off helpers; contribute no runtime code.

## DOCS (docs/)

- `requirements.md` — FR-1..FR-26, NFR-1..NFR-4, out-of-scope list.
- `architecture.md` — module map, build pipeline, data flow, extension points.
- `test-plan.md` — gates G0–G8 with entry/exit criteria, coverage policy, e2e scope.
- `decisions.md` — ADR-0001..ADR-0018.
- `changelog.md` — maintained automatically by `tools/bump.mjs`.
- `img/` — README screenshots generated by `tools/shots.mjs`.
- `performance-review-2026-09-15.md`, `superpowers/plans/` — point-in-time performance review and planning notes.

## BUILD ASSEMBLY

`build.js` produces `log-triage.html` from `template.html` plus module sources by simple concatenation — no bundler, no transpilation, no external dependencies. Template tokens replaced at build time:

- `__LT_VERSION__` — the current version string (kept in sync with `package.json` and the README marker by `tools/bump.mjs`).
- `/*__LT_CSS__*/` — the inlined stylesheet.
- `/*__LT_MODULES__*/` — the concatenated UMD modules in `MODULE_ORDER`.
- `/*__LT_WORKER__*/` — the inlined worker bundle in `WORKER_ORDER`.
- `/*__LT_CASES__*/` — the shared case suite inlined for `?selftest`.
- `/*__LT_DEMO__*/` — an inline demo log so the tool is explorable without local files.

Every input is LF-normalized before injection so a Windows CRLF checkout produces a byte-identical bundle to CI (the committed-bundle freshness check depends on this). Function replacers are mandatory for token substitution so `$`-sequences inside module sources are not expanded. The build throws if any template token is missing.

## EXTERNAL INTEGRATIONS

None by default. The application makes zero network calls with the default local PII provider. Opt-in remote providers (Presidio sidecar, LLM API) route through `src/pii-remote.js` with injected HTTP; the API key is stored only locally and never exported in config files. Deployment integration is GitHub Pages via CI.

## ARCHITECTURE DECISIONS AND CONSTRAINTS

- Single-file deliverable drives everything: modules must be UMD, self-contained, and order-concatenatable; no framework, no runtime dependencies.
- The worker bundle must stay free of UI glue so it can be inlined as a standalone string.
- Coverage gates apply to all core modules; only the three browser-only glue modules are exempt.
- Detailed rationale lives in `docs/decisions.md` (ADR-0001..ADR-0011) and `docs/architecture.md`.
