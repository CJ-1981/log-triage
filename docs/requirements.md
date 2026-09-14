# Requirements

Version reference: v1.22.1 (release). Requirements are numbered and testable; each functional requirement (FR) carries acceptance criteria (AC) that map directly to the shared test suite (`tests/core-cases.js`) and the Playwright e2e scope (see `docs/test-plan.md`). All requirements are implemented as of the v1.22.1 release.

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
- AC-4: External backends (Presidio, LLM) are wired via the Providers tab (FR-25) but off by default — the local regex engine is the default and the app performs no network calls unless a remote provider is explicitly enabled.

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
- Note (v1.3.0 deviation): transient filters (quick search, level chips, time range) are session-scoped and no longer persisted across sessions — a restored stale filter made freshly loaded files appear invisible (see ADR-0007). Only themes, mask/rule config, presets, and bookmarks survive a reload.

### FR-9 — Analysis tab

Status: implemented (v1.0.0).

- AC-1: The tab shows level bars, top tags, and top messages clustered via pattern normalization (numbers, hex, and UUIDs stripped so similar lines collapse).
- AC-2: A canvas time histogram renders the loaded time span.
- AC-3: Issue scan flags crash (`FATAL EXCEPTION`, tombstone), ANR (`ANR in`, `Input dispatching timed out`), process death (`has died`, `am_proc_died`, `Force stopping`), connectivity (`ConnectivityService`, `NetworkMonitor`, `DATA_DISCONNECTED`, `deactivateDataCall`), and auth (`Auth Error`, `credential`, `token`) patterns.
- AC-4: A PII census summarizes findings per rule, and a per-file comparison presents counts side by side.
- AC-5: Built-in groups (v1.23.0) also flag **suspend-to-RAM** (`PM: suspend entry/exit`, `Suspend attempt`, `failed to suspend`, `suspend not allowed`, `wake reason`, `Going to sleep`, `Waking up from`, `Freeze of tasks`/`Freezing of tasks` aborts, `abort_suspend`, `Suspend to RAM`, `early suspend`, `late resume`, `Suspended for <n>`), **native crashes** (`Fatal signal <n>`, `Abort message`, `check failed:`, `crash_dump`, kernel panic), **memory pressure** (lowmemorykiller, lmkd, OOM kills, `OutOfMemoryError`), **ANR records** (`am_anr`, `Force finishing`/`Force completing`), **binder failures** (`FAILED BINDER TRANSACTION`, `binder_alloc_buf`, `TransactionTooLargeException`), **SELinux denials** (`avc: denied`, `SecurityException`, `Permission denial`), **watchdog kills**, **thermal** critical/shutdown/throttle events, **storage exhaustion** (`ENOSPC`, `INSTALL_FAILED`, read-only fs), **boot loops and restart reasons** (RescueParty, critical-process exits, zygote restarts), and **modem subsystem restarts/ramdumps**. Generic words ("suspension", "wake-up alarm") and benign lines (successful token refresh, credential-encrypted storage, LIGHT thermal status) are false-positive-guarded by shared cases; sessions persisted before a group existed receive new built-ins via boot migration (14 groups as of v1.23.0).

### FR-10 — Virtualized log viewer

Status: implemented (v1.0.0).

- AC-1: Rendering is virtualized and stays smooth at 100k+ rows.
- AC-2: Both merged-timeline view (sorted by timestamp, file order as tiebreak) and per-file views are available.
- AC-3: A wrap toggle switches between pre-wrapped (variable row heights with a measured-height cache) and single-line modes; severity badges and W/E/F row tint are always visible.
- AC-4: Six themes switch via `body[data-theme]` CSS variables: Midnight (default), Paper, Solarized Dark, Solarized Light, Monokai, High Contrast. The header exposes them through a compact icon button that opens the theme dropdown (replacing the former inline `<select>`, so the mobile header stays on one line); the choice persists.

### FR-11 — Selection, copy, and bookmarks

Status: implemented (v1.0.0; bookmarks Clear button in v1.20.0).

- AC-1: Multiline selection supports click anchor, shift-click range, ctrl-click toggle, and ctrl+A; copying offers optional `file:lineNo:` prefixes and respects the current mask state.
- AC-2: Bookmarks are set on the gutter (with the `B` key), listed in a panel, and support notes.
- AC-3: Bookmarks persist by file identity (name + size + first-line hash) and can be exported and imported.
- AC-4: A detail drawer shows the full raw line and its metadata.
- AC-5: The bookmarks panel has a Clear button that removes every bookmark in one click — including bookmarks of currently loaded files (v1.22.0 behavior; it originally only pruned entries of unloaded files). The status line reports the removal ("cleared N bookmark(s)"), the count pill and status-bar counter reset, the ★ only-bookmarked chip disappears when no bookmarks remain, and the ★ only-bookmarked view re-filters if active.

### FR-12 — Sanitized export

Status: implemented (v1.0.0).

- AC-1: Kept, filtered, and selected lines export as `.log`/`.txt` (with `[Ln]` or `file:lineNo:` prefixes), `.csv`, and `.json`.
- AC-2: Search results export as rg-style text or JSON; bookmarks export as JSON.
- AC-3: Export honors the current mask rules (sanitized by default) and supports selection-only export.
- AC-4: Exported filenames are timestamped `YYYY-MM-DD_HHmmss`.
- AC-5: The extract can be re-packed as an archive mirroring the loaded file structure (`.zip`, `.tar`, `.tar.gz`, `.7z`); the `.7z` writer emits a valid stored container (see FR-26, ADR-0011).

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

### FR-15 — Responsive/mobile layout

Status: implemented (v1.3.0); extended in v1.12.1 (drawer as bottom sheet, 100dvh viewport height).

- AC-1: No page-level horizontal overflow at a 390 px viewport width.
- AC-2: At ≤ 760 px the files panel becomes an overlay drawer (auto-collapsed on narrow screens until toggled); the header wraps and tabs scroll horizontally.
- AC-3: Mask cards stack in a single column on narrow screens.
- AC-4 (v1.12.1): The drawer renders as a bottom sheet on narrow screens, and the app fills the dynamic viewport height (100dvh).

### FR-16 — Search-match horizontal scrolling

Status: implemented (v1.3.0).

- AC-1: Search-match rows use dedicated file / line / timestamp / text columns.
- AC-2: On narrow viewports the row scrolls horizontally so the full text is reachable — no ellipsis truncation.

### FR-17 — Debounced text inputs

Status: implemented (v1.3.0).

- AC-1: Instant-search matching is debounced 250 ms and runs after typing pauses.
- AC-2: The viewer quick filter is debounced 200 ms.

### FR-18 — Go-to-line and search-result click-to-jump

Status: implemented (v1.3.0).

- AC-1: A go-to-line box in the viewer toolbar accepts a line number; Enter jumps to it.
- AC-2: Clicking an instant-search result switches to the viewer and jumps to that line (selection + detail drawer).
- AC-3: Jumping to a line released by the kept-line cap reports a clear explanatory status instead of failing silently.

### FR-19 — Collapsible files panel

Status: implemented (v1.3.0).

- AC-1: The files panel toggles via the header "☰ Files" button; the collapsed state persists.
- AC-2: The panel auto-collapses on narrow screens until toggled.
- AC-3: Clicking a file in the list switches the viewer to that file.

### FR-20 — File cache / session restore

Status: implemented (v1.12.1).

- AC-1: Every successfully loaded file's content is cached in IndexedDB (database `log-triage-cache`).
- AC-2: Reopening the app lists previously loaded files; clicking an entry with cached content reloads the file.
- AC-3: Entries whose cached content is missing (quota rejected / file too large, or load failed) render greyed out with a "file not found" badge and a removable ✕.
- AC-4: Removing a file purges its cache entry and clears its bookmarks; browser-close persistence is unchanged.

### FR-21 — Analysis tab file scoping

Status: implemented (v1.12.1).

- AC-1: The analysis tab has a file selector — "All files (N)" plus one option per loaded file — and the heading shows the current scope.
- AC-2: The scope applies to every section: overview cards, level bars, histogram, top tags/messages, issue scan, and PII census.
- AC-3: Clicking an issue entry jumps to the line, auto-switching the per-file selection to the matched file and auto-clearing transient filters that would hide it.

### FR-22 — Issue-scan rule editor

Status: implemented (v1.12.1).

- AC-1: The five built-in keyword groups are listed with enable checkboxes, editable kind and case-insensitive pattern, delete, add-rule, and restore-defaults.
- AC-2: Rule changes are saved in state and included in presets.
- AC-3: Invalid regex patterns are skipped safely (no crash, no partial application).
- AC-4: The built-in auth group also detects "failed password" and "password check failed".

### FR-23 — Responsive mobile layout refinements

Status: implemented (v1.12.1). Base responsive layout: FR-15.

- AC-1: The files-panel drawer renders as a bottom sheet on narrow screens.
- AC-2: The app fills the dynamic viewport height (100dvh) on mobile.
- AC-3: All FR-15 behavior holds at ≤ 760 px (overlay drawer via "☰ Files", auto-collapse with persisted state, single-column mask grid, scrollable rules table).

### FR-24 — Config export/import tab

Status: implemented (v1.12.1).

- AC-1: The Config tab exports the current filter rules, time range, PII mask setup, and issue-scan rules as one JSON file.
- AC-2: Import validates the JSON and applies it per section, reporting the outcome in a status line.
- AC-3: Current-setup cards show what will be exported/applied before confirming.

### FR-25 — External PII analysis providers (Presidio / LLM)

Status: implemented (v1.17.x — Providers tab with Presidio/LLM adapters, test connection, sample scan, CORS proxy mode). Design: ADR-0010.

A "PII Providers" tab routes PII analysis beyond the built-in local regex engine to a Presidio sidecar or an LLM API, with the privacy safeguards from ADR-0003/ADR-0010.

- AC-1: A provider dropdown offers Local regex engine (default, always available, fully offline) / Presidio sidecar / LLM API; switching providers is instant and applies per load.
- AC-2: Presidio settings: service URL (default `http://127.0.0.1:3000`), analyze endpoint path, language, score threshold (0–1), entity-type filter list, and request timeout.
- AC-3: LLM settings: endpoint URL (e.g. `https://api.openai.com/v1/chat/completions`), API key (password-style input, stored in localStorage, never exported in config files), model name, prompt template with a `{lines}` placeholder, max lines per request, and temperature 0.
- AC-4: A proxy mode toggle with a proxy base URL: when enabled, provider HTTP requests go through the configured proxy prefix to avoid browser CORS errors (Presidio on localhost typically needs no proxy; remote LLM APIs usually do unless they allow browser origins).
- AC-5: A "Test connection" button per provider with a status display; an explicit red warning banner appears whenever a remote (non-local) provider is active — data leaves the machine; config export never includes the API key.
- AC-6: Findings from the active provider use the shape `{line, start, end, type, score}` and merge into the PII census and can drive masking.
- AC-7: Invalid endpoints and timeouts surface readable errors; the local regex engine remains the default and works fully offline.

### FR-26 — Compressed archives (.gz / .tar / .tar.gz / .zip / .7z)

Status: implemented (v1.17.x). Zip extraction was completed and 7z support added in the same gate.

Log files often arrive packed, so the ingestion pipeline transparently looks inside archives: when a loaded file's name ends in `.gz`, `.tar`, `.tar.gz`/`.tgz`, `.zip`, or `.7z`, it is decompressed and each contained file flows through the same pipeline (detection, parsing, filtering, masking) as a regular file. Extraction is recursive without a depth limit — a `.7z` containing a `.tar.gz` containing a `.log` is unpacked fully — with per-entry progress shown in the archive progress overlay and the global cancel honored.

- AC-1: gzip is decoded with the native `DecompressionStream`; tar is parsed and written by a pure-JS implementation; zip entries are read from the central directory with stored (method 0) and deflate (method 8) payloads inflated via `DecompressionStream('deflate-raw')`. Top-level `.tar.gz`/`.tgz` archives gunzip into the tar parser, and a `.tar` payload that is actually gzip (misnamed by the device, e.g. TCAM `kmesglog_*.tar`) is detected by its `1f 8b` magic and decompressed before the tar parse.
- AC-2: `.7z` archives are parsed by a pure-JS container reader (`src/format-7z.js`): signature header with CRC32 verification, plain and `kEncodedHeader` (compressed) headers, pack info, folder/coder descriptions, substream sizes, CRC digests, file names (UTF-16), and empty files/directories. Codec support: Copy, LZMA (`03 01 01`), LZMA2 (`21`, via `src/lzma.js`), and Deflate (`03 04 01`). Encrypted (AES) archives, coder chains (delta/BCJ), and zip64 entries fail with explicit, readable errors.
- AC-3: The LZMA decoder is pure JavaScript (no WASM, no CDN, single-file constraint preserved): a canonical range decoder and probability model for LZMA1 raw streams plus the chunked LZMA2 wrapper (stored chunks `0x01/0x02`, continuation chunks `0x80..0xDF` that carry decoder state across chunks, and full-reset chunks `0xE0..0xFF` with a fresh properties byte).
- AC-4: Every extracted entry keeps its archive-relative path (`bundle/a.log`, `bundle/sub/b.log`) and recurses; CRC32 digests defined by the archive are verified after decoding, so corrupt payloads surface a CRC error instead of silent garbage. Entries other than board dumps larger than 512 MB uncompressed are skipped with an announced progress message instead of exhausting memory.
- AC-4a: `dumpstate_board.bin` (Android bugreport board ramdump, typically a 1.5 GB deflate entry) is converted to text instead of skipped: the entry is stream-inflated (the inflated blob is never materialized), text runs of ≥ 8 bytes with ≥ 80% printable content are extracted, the newest 64 MB of extracted text is kept as a virtual `<path>/dumpstate_board.bin.log` entry, and the entry's CRC32 is verified incrementally while streaming. A directly dropped `dumpstate_board.bin` file converts the same way.
- AC-5: The export tab can re-pack the sanitized extract as an archive that mirrors the loaded structure: `.zip` (stored entries with CRCs), `.tar`, `.tar.gz`, and `.7z`. The `.7z` writer produces a valid container with Copy (stored) coders — structure fidelity without implementing LZMA encoding (ADR-0011); real 7-Zip opens the result (`7z t` passes).

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
- External PII providers are opt-in and off by default; the local regex engine is the default and performs no network calls; remote backends warn that data would leave the machine (ADR-0003, FR-25).

### NFR-3 — Offline single-file deliverable

Status: implemented (v1.0.0).

- `log-triage.html` is fully self-contained (CSS, JS, shared cases, and demo data inlined) and works offline from `file://` in a modern browser.

### NFR-4 — Test coverage gates

Status: implemented (v1.0.0).

- Coverage is enforced per core `src/` module: ≥ 90% line and ≥ 85% branch, via `node tools/coverage-gate.mjs` (Node 22, `node:test`).
- CI blocks merges that fall below the gate. Exemptions: `src/app.js` UI glue, `build.js`, and tests themselves.

## Out of scope

- Actual Presidio or LLM *hosting* — the adapters and Providers tab ship, but users run their own sidecar or supply their own endpoint and API key (ADR-0010).
- LZMA *encoding* for `.7z` export — exported `.7z` files are stored (copy-coded) containers (ADR-0011).
- Encrypted-archive (AES-7z, password-zip) extraction.
- Folder-recursive drop (multi-file selection only, no directory traversal).
- Server or CLI mode.
- Line editing.
- Custom user-defined themes (six built-in themes only).
