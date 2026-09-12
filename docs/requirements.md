# Requirements

Version reference: v1.0.0 (release). Requirements are numbered and testable; each functional requirement (FR) carries acceptance criteria (AC) that map directly to the shared test suite (`tests/core-cases.js`) and the Playwright e2e scope (see `docs/test-plan.md`). All requirements are implemented in the v1.0.0 release.

## Functional requirements

### FR-1 — Multi-file loading

Status: implemented (v1.0.0).

Multiple log files are ingested sequentially by streaming, with progress, cancellation, and bounded memory.

- AC-1: Files can be loaded via multi-file drag & drop and the file picker; pasted text is accepted as an in-memory file.
- AC-2: Ingestion processes files sequentially with visible per-file and overall progress, and can be cancelled at any time.
- AC-3: Reading uses `file.stream()` through a chunk buffer and newline splitter with an 8 MB valve; a 300 MB file ingests without exhausting memory.
- AC-4: Only filtered "kept" lines are retained under a configurable global cap (default 100,000); exact per-file counters (total, kept, dropped) are reported, and `File` handles are retained for later deep scans.

### FR-2 — Format autodetection and parsing

Status: implemented (v1.0.0).

Each file's log format is detected automatically and parsed into normalized records.

- AC-1: Autodetection reliably distinguishes logcat threadtime, syslog (RFC 3164), Apache CLF, ISO-8601, bare `MM-DD`, and plain text; the detected format is shown per file.
- AC-2: Parsed records carry file, line number, timestamp, level, tag/pid (where the format provides them), and message.
- AC-3: All timestamps are normalized to the year-less `MM-DD HH:MM:SS.mmm` form so records from different files sort consistently.
- AC-4: Lines that cannot be parsed are retained with level "—" rather than dropped.

### FR-3 — Instant search over kept lines

Status: implemented (v1.0.0).

- AC-1: Typing a query filters the kept lines immediately, without touching disk.
- AC-2: Smart-case is the default (case-insensitive unless the query contains uppercase); an explicit sensitive/insensitive toggle (`-i`) is available.
- AC-3: Results are capped (default 10,000) and the cap is communicated when hit.

### FR-4 — Deep scan (ripgrep-style re-streaming search)

Status: implemented (v1.0.0).

- AC-1: Deep scan re-streams the original files from disk via retained `File` handles, finding matches in lines that were dropped from the kept-line store.
- AC-2: Flags are supported: `-F` fixed strings, smart-case default with explicit `-i`/sensitive modes, `-w` whole word, `-v` invert, `-B`/`-A` context lines.
- AC-3: Modes are supported: normal output, `-c` (count per file), `-l` (files with matches).
- AC-4: Results are grouped by file as `file:lineNo:` entries, capped (default 10,000), and exportable as rg-style text or JSON.

### FR-5 — PII masking (built-in and custom rules)

Status: implemented (v1.0.0).

- AC-1: The 16 built-in rules (VIN, IBAN, credit card, SSN, international phone, US phone, IMEI, email, device serial `SN-`, MAC keeping OUI, private IPv4, public IPv4, IPv6 link-local/ULA, GNSS decimal pairs ≥ 3 decimals, subscriberId, hotspot SSID `AndroidShare_`) are each individually toggleable and applied in a fixed, documented order.
- AC-2: Custom rules map a user-supplied regex to a replacement template and compose with built-in rules.
- AC-3: Masking is lazy — raw text is stored and masking is applied at render, copy, and export time; the viewer toggles masking with the `M` key, and copied/exported text respects the current mask state.

### FR-6 — PII provider extension interface

Status: implemented (v1.0.0).

- AC-1: The `PiiProvider` interface `{ id, label, local, available(), analyze(lines) → findings[{start,end,type,score}] }` ships with a registry.
- AC-2: A mock provider demonstrates registration and the finding flow end to end.
- AC-3: Findings from any provider feed both masking and the PII census and are tagged by provider id.
- AC-4: External backends (Presidio, LLM) are documented but not wired; v1 performs no network calls.

### FR-7 — Regex filter rules

Status: implemented (v1.0.0).

- AC-1: Ordered rules of three kinds are supported: include (OR-combined), exclude (subtractive), and highlight (additive).
- AC-2: A case-sensitivity toggle applies to rule matching.
- AC-3: Live per-rule hit counters update as rules and data change.

### FR-8 — Dynamic level chips and time-range filter

Status: implemented (v1.0.0).

- AC-1: Level chips are generated dynamically from the levels observed in the current load, following the parsed severity ladder: logcat V/D/I/W/E/F, mapped syslog severities, CLF mapped to I/W/E via HTTP status, and "—" for unparseable lines.
- AC-2: Unparseable lines display as "—" and bypass level filters.
- AC-3: An inclusive time range filters by prefix comparison on normalized timestamps.
- Note (deviation from the original requirement): chips reflect the parsed severity ladder (logcat V/D/I/W/E/F, syslog severities mapped, CLF mapped to I/W/E via status, "—" for unparseable) rather than raw CLF status classes 2xx–5xx.

### FR-9 — Analysis tab

Status: implemented (v1.0.0).

- AC-1: The tab shows level bars, top tags, and top messages clustered via pattern normalization (numbers, hex, and UUIDs stripped so similar lines collapse).
- AC-2: A canvas time histogram renders the loaded time span.
- AC-3: Issue scan flags crash (`FATAL EXCEPTION`, tombstone), ANR (`ANR in`, `Input dispatching timed out`), process death (`has died`, `am_proc_died`, `Force stopping`), connectivity (`ConnectivityService`, `NetworkMonitor`, `DATA_DISCONNECTED`, `deactivateDataCall`), and auth (`Auth Error`, `credential`, `token`) patterns.
- AC-4: A PII census summarizes findings per rule, and a per-file comparison presents counts side by side.

### FR-10 — Virtualized log viewer

Status: implemented (v1.0.0).

- AC-1: Rendering is virtualized and stays smooth at 100k+ rows.
- AC-2: Both merged-timeline view (sorted by timestamp, file order as tiebreak) and per-file views are available.
- AC-3: A wrap toggle switches between pre-wrapped (variable row heights with a measured-height cache) and single-line modes; severity badges and W/E/F row tint are always visible.
- AC-4: Six themes switch via `body[data-theme]` CSS variables: Midnight (default), Paper, Solarized Dark, Solarized Light, Monokai, High Contrast.

### FR-11 — Selection, copy, and bookmarks

Status: implemented (v1.0.0).

- AC-1: Multiline selection supports click anchor, shift-click range, ctrl-click toggle, and ctrl+A; copying offers optional `file:lineNo:` prefixes and respects the current mask state.
- AC-2: Bookmarks are set on the gutter (with the `B` key), listed in a panel, and support notes.
- AC-3: Bookmarks persist by file identity (name + size + first-line hash) and can be exported and imported.
- AC-4: A detail drawer shows the full raw line and its metadata.

### FR-12 — Sanitized export

Status: implemented (v1.0.0).

- AC-1: Kept, filtered, and selected lines export as `.log`/`.txt` (with `[Ln]` or `file:lineNo:` prefixes), `.csv`, and `.json`.
- AC-2: Search results export as rg-style text or JSON; bookmarks export as JSON.
- AC-3: Export honors the current mask rules (sanitized by default) and supports selection-only export.
- AC-4: Exported filenames are timestamped `YYYY-MM-DD_HHmmss`.

### FR-13 — Presets

Status: implemented (v1.0.0).

- AC-1: Named presets capture filter rules, mask rules, and search flags as a set.
- AC-2: Presets persist in localStorage and survive reloads.
- AC-3: Presets can be exported to and imported from JSON.

### FR-14 — In-browser self-test

Status: implemented (v1.0.0).

- AC-1: Opening the app with `?selftest` runs the shared case suite (`tests/core-cases.js`) — the same suite executed by `node --test`.
- AC-2: The page reports pass/fail counts and lists failing cases.
- AC-3: Browser and Node results agree (one shared suite, no divergence).

## Non-functional requirements

### NFR-1 — Performance

Status: implemented (v1.0.0).

- Streaming ingestion with bounded memory; a 300 MB file can be ingested.
- The viewer remains smooth at 100k+ kept rows via virtualization.
- Instant search and filter changes respond interactively (no full re-scan); heavy work stays off the render path.

### NFR-2 — Privacy

Status: implemented (v1.0.0).

- 100% client-side processing; no server, no uploads; files never leave the machine.
- No CDN resources, no external fonts, no telemetry.
- Future external PII providers are opt-in and off by default; remote backends must warn that data would leave the machine (ADR-0003).

### NFR-3 — Offline single-file deliverable

Status: implemented (v1.0.0).

- `log-triage.html` is fully self-contained (CSS, JS, shared cases, and demo data inlined) and works offline from `file://` in a modern browser.

### NFR-4 — Test coverage gates

Status: implemented (v1.0.0).

- Coverage is enforced per core `src/` module: ≥ 90% line and ≥ 85% branch, via `node tools/coverage-gate.mjs` (Node 22, `node:test`).
- CI blocks merges that fall below the gate. Exemptions: `src/app.js` UI glue, `build.js`, and tests themselves.

## Out of scope for v1

- Actual Presidio or LLM connectivity (interface and documentation only).
- Folder-recursive drop (multi-file selection only, no directory traversal).
- Server or CLI mode.
- Line editing.
- Custom user-defined themes (six built-in themes only).
