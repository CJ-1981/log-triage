# Product — Log Triage

Version: 1.53.2 (as of this document)
Live app: https://cj-1981.github.io/log-triage/
Product type: Web Browser App (client-side tool, single self-contained HTML file)

## MISSION

Log Triage is a privacy-first log triage tool that runs entirely in the browser. Drop one or more log files onto a single self-contained HTML page and get instant format detection, parsing, filtering, ripgrep-style search, PII masking, analysis, and sanitized export — with no server, no uploads, and no telemetry. Log files never leave the user's machine.

The mission exists because the primary workflow it serves — triaging device and service logs that often contain personally identifying information — is normally blocked by the privacy constraint itself: most log viewers and SaaS triage tools upload data somewhere. Log Triage makes "paste your whole bugreport in" safe by making the network path structurally absent, not just policy-forbidden.

## VISION

A tool anyone can hand to a support engineer, QA, or a developer without a compliance review: open one HTML file, drop the log, find the bug, export only what is safe to share. It should work on a locked-down machine, offline, from `file://`, with no installation and no account.

## CORE VALUE PROPOSITION

- Privacy by architecture: 100% client-side. There is no backend; parsing, searching, masking, analysis, and export all happen in the browser tab.
- No network by design: no CDN assets, no external fonts, no analytics, no telemetry. The tool works fully offline.
- Single-file deliverable: the entire app is one self-contained `log-triage.html` that can be emailed, attached to a ticket, or bundled with a device build.
- Scales to real logs: multi-GB files are handled via a paging worker with full-file columnar indexing (Float64 byte offsets), 500-row virtualized pages, and a head+tail analysis sample — the entire indexed file is the viewing and filtering scope, never a capped window.
- Explicit, reversible privacy: masking is lazy — raw lines stay local and unmasked inspection is always an explicit toggle (`M` key), so nothing is rewritten behind the user's back.

## TARGET USERS

- Support and field engineers who receive device logs (Android bugreports, kernel logs, syslog) from customers and must triage them without exposing PII.
- QA engineers validating device builds from compressed bundles (`.tar.gz`, `.zip`, `.7z`) produced by test farms.
- Developers diagnosing crashes, ANRs, suspend/resume failures, and connectivity issues from logcat-style logs.
- Compliance-conscious teams who need sanitized extracts (log/csv/json with masks applied) as shareable artifacts.

## CORE FEATURES

- Multi-file loading: drag & drop of loose files, whole folders (walked recursively with folder-relative names), compressed archives (`.gz`, `.tar`, `.tar.gz`, `.tgz`, `.zip`, `.7z`), with recursive depth-capped extraction, CRC32 digest verification for 7z/zip, per-file progress and cancel support. Special handling for Android bugreport `dumpstate_board.bin` ramdumps (stream-converted to a capped 64 MB text entry).
- Format autodetection: Android logcat threadtime, syslog (RFC 3164), Apache CLF, ISO-8601, bare `MM-DD`, dlt-viewer text exports (AUTOSAR DLT), binary `.dlt` captures, Markdown files (`.md`, `.markdown`), and plain text; timestamps normalized to a year-less `MM-DD HH:MM:SS.mmm` form. UTF-8 decoding with BOM stripping and an `enc?` warning badge for non-strict-UTF-8 files.
- Viewer: virtualized rendering over every indexed line with seamless continuous scrolling (wheel extends a bounded 5-page sliding window; pager buttons, keyboard paging and jumps load a single page), start/end-of-log bands, merged-timeline and per-file views, wrap toggle, severity badges with W/E/F row tint, multiline selection and copy (persistent across scrolling and paging, keyed to line identity, with optional `file:lineNo:` prefixes), bookmarks with notes persisted by file identity, a bookmarks sidebar panel, a detail drawer with on/off toggle, dedicated Markdown document view with 'Markdown: ON/OFF' toolbar switch and pure-JS Mermaid diagram rendering (flowchart and sequence diagrams via SVG), and a session-only Zen mode.
- Filter engine and color highlighters: ordered include (OR) and exclude (subtractive) rules plus additive literal/regex highlighters that color matching text or whole rows, with eight preset swatches and custom colors; dynamic level chips generated from levels actually observed; inclusive time-range narrowing.
- Ripgrep-style multifile search: instant search over the per-file analysis sample plus a deep-scan mode that re-streams files from disk, with `-F` fixed strings, smart-case default, `-w`, `-v`, `-B`/`-A` context, normal/`-c`/`-l` modes, results capped (default 10,000) and grouped by file as `file:lineNo:`, exportable as rg-style text or JSON. Every flag control carries a plain-language tooltip. The viewer's "Search all" panel lists every quick-filter match across loaded files with click-to-jump and lazy page loading.
- PII masking: 16 built-in ordered regex rules (VIN, IBAN, credit card, SSN, international and US phone, IMEI, email, device serial, MAC with OUI kept, private/public IPv4, IPv6 link-local/ULA, GNSS pairs, subscriberId, hotspot SSID), individually toggleable, plus custom regex-to-template rules. An extensible `PiiProvider` registry supports the local regex engine (default, fully offline) plus opt-in remote backends — a localhost Presidio sidecar and an LLM API with CORS proxy mode (FR-25, ADR-0010, ADR-0003).
- Analysis dashboard: level bars, canvas time histogram (device-pixel-ratio aware, hover tooltip), top tags, top messages via pattern normalization, a 14-group issue scan (crashes, ANRs, suspend/resume, native crashes, memory pressure, binder failures, SELinux denials, watchdog, thermal, storage, boot loops, modem restarts, auth problems) with an editable rule editor, an interactive clickable PII census, and per-file comparison — all scopeable to one file or all files.
- Sanitized export: `.log`/`.txt` (with `[Ln]` or `file:lineNo:` prefixes), `.csv`, `.json`, rg search results, bookmarks, and selection-only export — covering every matching line of the current filtered view, not just the rendered page. Extracts can be re-packed as `.zip`, `.tar.gz`, `.tar` (streamed, any size) or `.7z` (stored container, bounded).
- Presets and Config tab: named filter/mask/search-flag sets persisted in localStorage with JSON import/export; the Config tab exports/imports the complete rule setup as one validated JSON file and sets the per-file analysis sample limit.
- Session restore: every loaded file is cached in IndexedDB; reopening the app lists previous files with per-file reload, one-click full restore, and greyed-out entries when the source file is missing.
- Themes: six themes (Midnight default, Paper, Solarized Dark, Solarized Light, Monokai, High Contrast) via CSS variables.
- Self-test: `?selftest` runs the same 153-case suite in the browser that `node --test` executes.

## SUCCESS INDICATORS

- Zero network calls with the default provider — verified by architecture (no fetch in the offline path) and by test.
- Whole-file fidelity: filtering, paging, and search cover every indexed line of files of any size; only the analysis tab is bounded by the sample limit, which is configurable and announced.
- Safe sharing: export output always contains masked text when masks are on; the exporter never unmasks (enforced by module contract in `src/exporter.js`).
- Release cadence: automated semver bumps from conventional commits (feat/fix/breaking) on every push to `main`, with tagged releases deployed to GitHub Pages.

## OUT OF SCOPE

Per `docs/requirements.md`: no server component, no accounts, no telemetry, no bundled redistribution of external runtimes (the 7z/LZMA support is pure JS, no WASM, no CDN). Remote PII providers are opt-in and off by default, with a red warning that data would leave the machine.

## RELATED DOCUMENTS

- `.moai/project/structure.md` — repository and module layout
- `.moai/project/tech.md` — technology decisions and constraints
- `docs/requirements.md` — FR-1..FR-26, NFR-1..NFR-4, out-of-scope list
- `docs/architecture.md` — module map, build pipeline, data flow, extension points
- `docs/decisions.md` — ADR-0001..ADR-0018
- `docs/test-plan.md` — gates G0–G8, coverage policy, e2e scope
