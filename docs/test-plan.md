# Test plan

Version reference: v1.0.0. Development was test-driven and proceeded through quality gates G0–G8. Each gate has entry/exit criteria; coverage is mechanically enforced.

**Current status: v1.0.0 — all gates G0–G8 done.**

## Quality gates

### G0 — Scaffold, build pipeline, CI

- Entry criteria: repository initialized; `package.json` with npm scripts in place.
- Exit criteria: `node build.js` produces a working single-file `log-triage.html` from UMD `src/` modules; `node tools/coverage-gate.mjs` runs and enforces thresholds; GitHub Actions CI (`.github/workflows/ci.yml`) runs test + coverage, build, e2e, and the automatic semver bump on main; `?selftest` page runs the shared suite green.
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
- Exit criteria: ordered include (OR) / exclude / highlight regex rules with case toggle; live hit counters correct under rule edits; dynamic level chips derived from the parsed severity ladder (logcat V/D/I/W/E/F, mapped syslog severities, CLF mapped to I/W/E via status) and regenerated per load; "—" lines bypass level filters; inclusive time-range prefix compare verified across file boundaries; coverage gate green on `filters`, `levels`.
- Status: **done**.

### G4 — Ripgrep-style search

- Entry criteria: G3 complete; `File` handles retained.
- Exit criteria: instant search over kept lines with smart-case default and explicit toggle; deep scan re-streams from disk and finds lines absent from the kept store; `-F`, `-w`, `-v`, `-i`/sensitive, `-B`/`-A`, and normal/`-c`/`-l` modes all verified; results capped (default 10k), grouped as `file:lineNo:`, and exportable as rg-style text and JSON; coverage gate green on `search`.
- Status: **done**.

### G5 — Store, timeline, selection, bookmarks

- Entry criteria: G4 complete.
- Exit criteria: sequential multi-file ingestion with per-file and overall progress and cancel; 8 MB newline valve handles chunked/multibyte boundaries; global kept-line cap (default 100k, configurable) enforced with amortized FIFO trim and exact per-file counters; `File` handles retained for deep scan; merged timeline sorts by timestamp with file-order tiebreak and attaches null-timestamp (stack trace) lines to their predecessor; virtualized viewer smooth at 100k+ rows; wrap toggle with measured-height cache; selection (anchor / shift-range / ctrl-toggle / ctrl+A) copies with optional `file:lineNo:` prefixes and honors mask state; bookmarks persist by file identity and survive reload; coverage gate green on `store`, `timeline`, `selection`, `bookmarks`.
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

## Verification evidence (v1.0.0)

- **Shared cases:** 113 shared logic cases plus a theme check pass in both runners — `node --test` and the browser `?selftest` page each report **114 passed / 0 failed**.
- **Coverage gate:** green on all core `src/` modules (≥ 90% line / ≥ 85% branch enforced by `node tools/coverage-gate.mjs`).
- **E2e:** Playwright suite **8/8 green** locally (spec list below).
- **Performance / big file:** a 300 MB / 3,380,636-line synthetic log was fully streamed and counted in ~31 s in Chromium (~108 MB/s), with exact per-file counters, FIFO trim at the 100k kept-line cap, and zero page errors. Throughput in hidden/background tabs is lower because browsers throttle them; the app uses a `MessageChannel` yield (ADR-0006) to minimize this effect.

## Coverage policy

- Enforced by `node tools/coverage-gate.mjs` on Node 22 using `node:test`.
- Thresholds **per core `src/` module**: ≥ 90% line coverage and ≥ 85% branch coverage.
- Exempt from the gate: `src/app.js` (UI glue), `build.js`, and the tests themselves.
- The gate runs locally (`npm run test:gate`) and in CI; a merge below the threshold is blocked.

## Commands

| Command | Purpose |
| --- | --- |
| `npm test` | Run the Node unit tests (`node:test`, Node 22) over the shared cases. |
| `npm run test:gate` | Run unit tests with coverage and enforce ≥ 90% line / ≥ 85% branch per core module. |
| `npm run e2e` | Run the Playwright end-to-end suite (8 specs) against the built `log-triage.html`. |
| `npm run build` | Rebuild `log-triage.html` from `src/` (inlines CSS, modules, shared cases, demo log). |

## Shared-cases approach

`tests/core-cases.js` is the single source of behavioral truth: a UMD module of named cases (input → expected) consumed by both runners.

- **Node:** `node --test` executes the suite through `src/_src.js`; the coverage gate wraps the same run.
- **Browser:** `build.js` inlines the identical file into `log-triage.html`; opening it with `?selftest` executes the suite and reports pass/fail counts and failing case names.
- **Guarantee:** any behavior change must be expressed as a case update, so Node CI and the in-browser self-test can never disagree.

## E2e scope (Playwright — 8 specs)

1. `?selftest` page runs and reports green.
2. Demo load: format detection, level chips, and masking indications correct.
3. Quick filter with highlight marks applied.
4. Multi-file load of three formats rendered in the merged view.
5. Instant search and deep scan agree on results.
6. Theme persistence.
7. Bookmark persistence across reload.
8. Masked export download, byte-checked.

## Fixture inventory (`tests/fixtures/`)

| Fixture | Format | Contents |
| --- | --- | --- |
| `demo.log` | logcat threadtime | Realistic Android logcat with planted PII (VIN, email, MAC, IP, serial `SN-`, GNSS coordinates, subscriberId, `AndroidShare_` SSID) plus crash/ANR/connectivity/auth sample lines. |
| `syslog.log` | syslog RFC 3164 | Mixed-severity syslog lines exercising severity-to-level mapping. |
| `apache.log` | Apache CLF | Combined log format entries whose statuses map to I/W/E level chips. |
| `service.log` | ISO-8601 | Service log with ISO-8601 timestamps, multiline stack traces (null-timestamp lines), and plain fallback lines. |
