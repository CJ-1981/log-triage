# Requirements

Version reference: v1.35.0 plus Unreleased changes. Requirements are numbered and testable; each functional requirement (FR) carries acceptance criteria (AC) that map directly to the shared test suite (`tests/core-cases.js`) and the Playwright e2e scope (see `docs/test-plan.md`).

## Functional requirements

### FR-1 — Multi-file loading

Status: implemented (v1.0.0).

Multiple log files are ingested sequentially by streaming, with progress, cancellation, and bounded memory.

- AC-1: Files can be loaded via multi-file drag & drop and the file picker; pasted text is accepted as an in-memory file. Dropped folders are traversed recursively (`webkitGetAsEntry`, readEntries drained until empty, depth-capped at 12 and file-capped at 2000): contained files are ingested under their folder-relative names, so identically named logs from different folders stay distinct in the file list, bookmarks and exports; plain file drops keep the direct path. Entries that cannot be read (Chromium cannot resolve file entries past the Windows 260-character MAX_PATH, even with LongPathsEnabled — typical for deep RVDC log paths) are isolated: the readable remainder still loads and the drop reports the unreadable count with an actionable hint to copy the folder to a short path.
- AC-2: Ingestion processes files sequentially with visible per-file and overall progress (worker indexing reports live "Indexing… N%"), and can be cancelled at any time.
- AC-3: Every file is fully indexed by the paging worker into columnar typed arrays — Float64 line start offsets (exact past the 2 GB point), packed timestamp keys and level codes — so filtering and paging cover every line of multi-GB files without holding raw text in memory; pages of 500 records are materialized on demand from `File.slice` with a byte-bounded LRU cache, and a source that shrinks behind its index surfaces a readable "changed" error instead of garbage.
- AC-4: The analysis tab works on a bounded per-file sample (configurable "analysis sample limit", default 100,000 lines) taken as the file head plus a ring of the newest lines, so issue scans on big files see both boot-time and end-of-file behavior; exact per-file line/level counters cover the whole file regardless of the sample, and `File` handles are retained for later deep scans.

### FR-2 — Format autodetection and parsing

Status: implemented (v1.0.0).

Each file's log format is detected automatically and parsed into normalized records.

- AC-1: Autodetection reliably distinguishes logcat threadtime, syslog (RFC 3164), Apache CLF, ISO-8601, bare `MM-DD`, and plain text; the detected format is shown per file.
- AC-2: Parsed records carry file, line number, timestamp, level, tag/pid (where the format provides them), and message.
- AC-3: All timestamps are normalized to the year-less `MM-DD HH:MM:SS.mmm` form so records from different files sort consistently.
- AC-4: Lines that cannot be parsed are retained with level "—" rather than dropped.
- AC-5 (v1.46.0): Text is decoded as UTF-8 with a leading BOM stripped (verified end-to-end: a BOM'd file's first record parses with its real timestamp). During indexing the first 64 KB is strict-validated; a file that fails gets an `enc?` warning badge in the files panel (live and cached entries) explaining that undecodable bytes became replacement characters, so garbled text is announced instead of silent. Line splitting stays byte-oriented (LF), which is safe for UTF-8 and all ASCII-transparent 8-bit encodings; non-UTF-8 files still load and search, with the badge as the signal. Exports always re-encode to UTF-8.

### FR-3 — Instant search over the analysis sample

Status: implemented (v1.0.0); scope redefined by full-file paging (v1.32.0).

- AC-1: Typing a query filters the analysis-sample lines immediately, without touching disk; the status discloses the sample scope and notes that viewer filtering searches the complete indexed files.
- AC-2: Smart-case is the default (case-insensitive unless the query contains uppercase); an explicit sensitive/insensitive toggle (`-i`) is available.
- AC-3: Results are capped (default 10,000) and the cap is communicated when hit.

### FR-4 — Deep scan (ripgrep-style re-streaming search)

Status: implemented (v1.0.0).

- AC-1: Deep scan re-streams the original files from disk via retained `File` handles, finding matches across every indexed line — independent of the analysis sample.
- AC-2: Flags are supported: `-F` fixed strings, smart-case default with explicit `-i`/sensitive modes, `-w` whole word, `-v` invert, `-B`/`-A` context lines.
- AC-3: Modes are supported: normal output, `-c` (count per file), `-l` (files with matches).
- AC-4: Results are grouped by file as `file:lineNo:` entries, capped (default 10,000), and exportable as rg-style text or JSON.
- AC-5 (v1.47.0, shared by instant and deep result rows): a match row shows the matched span(s) with an inline `<mark>` computed on the DISPLAYED text — masked and preview-truncated — so a mark always wraps exactly what is visible and a match hidden by masking draws no misleading mark; `-F`/`-w`/case flags are honored by the marking (it reuses the same compiled searcher), and inverted (`-v`) rows carry no marks by definition. Match rows use a faint per-theme `--hit` tint, visually distinct from the viewer's `--selection` green, so "selected" and "matched" never look alike (ADR-0016).

### FR-5 — PII masking (built-in and custom rules)

Status: implemented (v1.0.0).

- AC-1: The 16 built-in rules (VIN, IBAN, credit card, SSN, international phone, US phone, IMEI, email, device serial `SN-`, MAC keeping OUI, private IPv4, public IPv4, IPv6 link-local/ULA, GNSS decimal pairs ≥ 3 decimals (v1.44.2: the pair separator also accepts lat/lon key tokens, so `lat=48.858400 lon=2.294500` masks to `lat=[coords]`; v1.44.3: a pair never starts directly after a clock colon, so DLT `HH:MM:SS.micros` + relative-timestamp columns are no longer eaten; v1.44.4 guards: the card rule requires a plausible IIN first digit (2-6), the VIN rule requires a letter within its first 8 characters, and the IMEI rule rejects 15 identical digits — ECUC config bitmaps and OTA storage timestamps stay intact), subscriberId, hotspot SSID `AndroidShare_`) are each individually toggleable and applied in a fixed, documented order.
- AC-2: Custom rules map a user-supplied regex to a replacement template and compose with built-in rules.
- AC-3: Masking is lazy — raw text is stored and masking is applied at render, copy, and export time; the viewer toggles masking with the `M` key, and copied/exported text respects the current mask state.

### FR-6 — PII provider extension interface

Status: implemented (v1.0.0).

- AC-1: The `PiiProvider` interface `{ id, label, local, available(), analyze(lines) → findings[{start,end,type,score}] }` ships with a registry.
- AC-2: A mock provider demonstrates registration and the finding flow end to end.
- AC-3: Findings from any provider feed both masking and the PII census and are tagged by provider id.
- AC-4: External backends (Presidio, LLM) are wired via the Providers tab (FR-25) but off by default — the local regex engine is the default and the app performs no network calls unless a remote provider is explicitly enabled.

### FR-7 — Regex filter rules

Status: implemented (v1.0.0); color-highlighter editor enhanced in Unreleased.

- AC-1: Ordered rules of three kinds are supported: include (OR-combined), exclude (subtractive), and highlight (additive).
- AC-2: A case-sensitivity toggle applies to rule matching.
- AC-3: Live per-rule hit counters update as rules and data change.
- AC-4: Highlight rules support literal or regex matching, text or whole-row targets, eight one-click preset colors, and a custom color picker; the active preset is visibly and accessibly selected.
- AC-5: Visual highlighting operates on the masked display text, does not change the filtered line count, and persists through local state, presets, and config export/import with `name`, `pattern`, `caseSensitive`, `action`, `enabled`, `matchMode`, `target`, and `color` preserved.
- AC-6: Editing, adding, disabling, or deleting a rule while the Viewer tab is hidden must not truncate its virtualized window: returning to Viewer fills the viewport and paging still covers the complete filtered result set. Rule text fields retain stable widths through repeated focus/edit/rerender cycles.

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
- AC-4a: Census cards are interactive (v1.44.0): each visible category renders as a real `<button>` with `aria-expanded` (keyboard-operable), and opening one reveals an inline sample panel beneath the cards (the panel scrolls so the summary line and the sample rows are visible — aligning the panel top with the viewport when it is taller than the space below, respecting prefers-reduced-motion) — one category open at a time. Counts cover every match in the retained analysis sample (a line with two hits of the same rule counts twice) while the example list shows at most 25 lines per category, labeled "… matches · showing N example lines (capped at N)". Example text is always the masked preview (never raw, regardless of the viewer's mask toggle), custom rules join the census under their configured names, categories with zero matches render no card, each example's "Show in viewer" jumps via `fileId` + `lineNo` (selection + drawer), and the open category survives an analysis file-scope change when it still has matches.
- AC-5: Built-in groups (v1.23.0) also flag **suspend-to-RAM** (`PM: suspend entry/exit`, `Suspend attempt`, `failed to suspend`, `suspend not allowed`, `wake reason`, `Going to sleep`, `Waking up from`, `Freeze of tasks`/`Freezing of tasks` aborts, `abort_suspend`, `Suspend to RAM`, `early suspend`, `late resume`, `Suspended for <n>`), **native crashes** (`Fatal signal <n>`, `Abort message`, `check failed:`, `crash_dump`, kernel panic), **memory pressure** (lowmemorykiller, lmkd, OOM kills, `OutOfMemoryError`), **ANR records** (`am_anr`, `Force finishing`/`Force completing`), **binder failures** (`FAILED BINDER TRANSACTION`, `binder_alloc_buf`, `TransactionTooLargeException`), **SELinux denials** (`avc: denied`, `SecurityException`, `Permission denial`), **watchdog kills**, **thermal** critical/shutdown/throttle events, **storage exhaustion** (`ENOSPC`, `INSTALL_FAILED`, read-only fs), **boot loops and restart reasons** (RescueParty, critical-process exits, zygote restarts), and **modem subsystem restarts/ramdumps**. Generic words ("suspension", "wake-up alarm") and benign lines (successful token refresh, credential-encrypted storage, LIGHT thermal status) are false-positive-guarded by shared cases; sessions persisted before a group existed receive new built-ins via boot migration (14 groups as of v1.23.0).
- AC-6 (v1.46.1): Every analysis text surface honors the viewer mask toggle — issue-scan snippets and top-message shapes are rendered from masked source when Mask is ON, so no analysis screen (the one people screenshot into tickets) ever shows raw PII while masking is on. Masking runs on the FULL text before the snippet's 110-character slice, so a PII token straddling the slice boundary cannot leak a raw fragment. Issue detection itself still matches raw lines, so findings are identical in both mask states; toggling the mask while the analysis tab is visible re-renders it live.

### FR-10 — Virtualized log viewer

Status: implemented (v1.0.0).

- AC-1: Rendering is virtualized over the complete index and stays smooth at any size — the viewer renders bounded 500-row windows (start/end-of-log bands mark the edges) rather than materializing all rows.
- AC-2: Both merged-timeline view (sorted by timestamp, file order as tiebreak) and per-file views are available.
- AC-3: A wrap toggle switches between pre-wrapped (variable row heights with a measured-height cache) and single-line modes; severity badges and W/E/F row tint are always visible.
- AC-4: Six themes switch via `body[data-theme]` CSS variables: Midnight (default), Paper, Solarized Dark, Solarized Light, Monokai, High Contrast. The header exposes them through a compact icon button that opens the theme dropdown (replacing the former inline `<select>`, so the mobile header stays on one line); the choice persists.
- AC-5: Zen mode (viewer toolbar button) hides the header, files panel, level chips, viewer toolbar, pager and status bar so the log viewer fills the window; on entry a brief hint explains the exits; a faint floating "✕ Zen" button (full opacity on hover/focus) and the Esc key exit it, as does clicking the toolbar Zen button again. The mode is session-only (never persisted), and Esc in Zen mode exits Zen instead of clearing the selection.
- AC-6: The viewer marks the boundaries of the log inside the scroll area: a "start of …" band on the first page and an "end of …" band (with the line count) on the last page, labeled per displayed file or for the merged timeline; middle pages carry no bands. With any active filter the bands describe the matching results instead ("first match in … — source line N" / "last match in … — N matches"), never the physical file bounds. The bands participate in the row layout as fixed-height offsets so scrolling, jumping and wrap measurement stay exact, and their labels stay pinned into the visible viewport when long lines widen the scroll canvas.

### FR-11 — Selection, copy, and bookmarks

Status: implemented (v1.0.0; bookmarks Clear button in v1.20.0).

- AC-1: Multiline selection supports click anchor, shift-click range, ctrl-click toggle, and ctrl+A; copying offers optional `file:lineNo:` prefixes and respects the current mask state.
- AC-2: Bookmarks are set on the gutter (with the `B` key), listed in a panel, and support notes.
- AC-3: Bookmarks persist by file identity (name + size + first-line hash) and can be exported and imported.
- AC-4: A detail drawer — gated by a viewer-toolbar toggle that is on by default (v1.41.0) — shows the clicked line's metadata: timestamp, level, tag, and `pid / tid` on one shared line. When masking actually changed the line, the body shows the masked text labeled "masked" plus a ▸/▾ chevron that lazily expands the raw line (collapsed by default, and its text leaves the DOM when collapsed); otherwise the body shows the raw line labeled "raw" with no chevron.
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

Status: implemented (v1.3.0); extended in v1.12.1 (drawer as bottom sheet, 100dvh viewport height) and v1.48.0 (phone-width chrome compaction, files-overlay scrim).

- AC-1: No page-level horizontal overflow at a 390 px viewport width.
- AC-2: At ≤ 760 px the files panel becomes an overlay drawer (auto-collapsed on narrow screens until toggled); the header wraps and tabs scroll horizontally.
- AC-3: Mask cards stack in a single column on narrow screens.
- AC-4 (v1.12.1): The drawer renders as a bottom sheet on narrow screens, and the app fills the dynamic viewport height (100dvh).
- AC-5 (v1.48.0): At ≤ 560 px the viewer toolbar collapses to one row — quick filter, Mask toggle, and a ⋯ overflow button (`aria-expanded`-synced) that reveals the secondary controls (go-to-line, wrap, follow, view mode, copy + prefix, zen, drawer); the level-chips row becomes a single horizontally scrollable line; the header hides the version tag; and the tab strip gains a right-edge fade as its scroll affordance. A fresh boot (no persisted state) at ≤ 560 px defaults Wrap ON, and while Wrap is off at ≤ 760 px the viewer shows a right-edge fade hinting horizontal overflow. The files overlay dims the content behind a tap-outside scrim and the panel header carries a ✕ close button; both close the overlay (restored sessions keep their persisted wrap choice at any width).

### FR-16 — Search-match display: wrap or scroll (per-tab preference)

Status: wrap default implemented (v1.33.1); toggle implemented (v1.34.0).

- AC-1: Search-match rows use dedicated file / line / timestamp / text columns.
- AC-2: Long matched lines wrap inside the panel by default — the row's highlight band covers the full wrapped block and no text extends past the panel edge; the rendered text is bounded to a 2,000-character preview with click-to-open-full-text in the drawer.
- AC-3: A Wrap: ON/OFF toggle next to Deep scan switches between wrapped rows (ON) and one horizontally scrollable line per match (OFF, full text reachable — no ellipsis truncation); the preference is per-tab (independent of the viewer's wrap setting) and persists.
- AC-4: Hit rows carry a visible highlight tint (distinct from the page background) and context rows a muted style.

### FR-17 — Debounced text inputs and search-term history

Status: debounce implemented (v1.3.0); history dropdown implemented (v1.33.0).

- AC-1: Instant-search matching is debounced 250 ms and runs after typing pauses.
- AC-2: The viewer quick filter is debounced 200 ms.
- AC-3: Both fields keep a search-term history shown as a dropdown on focus/typing: substring-filtered, most recent first, capped at 20, deduped case-insensitively, persisted in localStorage. Picking an entry (click or ↑/↓ + Enter) fills the input and re-runs the search. Terms are recorded only when a search executes with a non-empty value; the active filters themselves stay transient (ADR-0012).

### FR-18 — Go-to-line and search-result click-to-jump

Status: implemented (v1.3.0).

- AC-1: A go-to-line box in the viewer toolbar accepts a line number; Enter jumps to it.
- AC-2: Clicking an instant-search result switches to the viewer and jumps to that line (selection + detail drawer).
- AC-3: Jumps resolve through the paging worker and load the page containing the target — any indexed line is reachable, in files of any size (there is no kept-line cap anymore); a bookmark jump resolves the bookmark's file-identity key to the currently loaded file first, and a target that truly cannot be found (source changed on disk) reports a clear explanatory status instead of failing silently.

### FR-19 — Collapsible files panel, with name filter and sort

Status: collapse implemented (v1.3.0); filter and sort implemented (v1.35.0).

- AC-1: The files panel toggles via the header "☰ Files" button; the collapsed state persists.
- AC-2: The panel auto-collapses on narrow screens until toggled.
- AC-3: Clicking a file in the list switches the viewer to that file.
- AC-4: A text box filters the list by file name — live files and cached entries, case-insensitive substring; an unmatched filter shows a "no files match the filter" hint, and Clear-all resets it.
- AC-5: A dropdown sorts the list by load order (default), name A→Z / Z→A, size ↑/↓, or line count ↑/↓ (using per-file totals); sorting reorders only the rendered list, not the underlying load order.
- AC-6: The list mirrors the viewer scope: in merged-timeline mode every loaded file entry is highlighted; in per-file mode only the displayed file is. Switching modes keeps the invariant (per-file always has exactly one displayed file; loading a file while in per-file mode makes it the displayed one), and cached-not-loaded entries are never highlighted.

### FR-20 — File cache / session restore

Status: implemented (v1.12.1).

- AC-1: Every successfully loaded file's content is cached in IndexedDB (database `log-triage-cache`).
- AC-2: Reopening the app lists previously loaded files; clicking an entry with cached content reloads the file.
- AC-3: Entries whose cached content is missing (quota rejected / file too large, or load failed) render greyed out with a "file not found" badge and a removable ✕.
- AC-5: While restorable cached files exist that are not currently loaded, the files panel header shows a Reload button (left of Clear) that re-ingests every such cached file in one click; it hides again once nothing is pending.
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
- AC-4a: `dumpstate_board.bin` (Android bugreport board ramdump, typically a 1.5 GB deflate entry) is converted to text instead of skipped: the entry is stream-inflated (the inflated blob is never materialized), text runs of ≥ 8 bytes with ≥ 80% printable content are extracted (well-formed UTF-8 multi-byte sequences count as printable, so CJK text runs survive — v1.46.0), the newest 64 MB of extracted text is kept as a virtual `<path>/dumpstate_board.bin.log` entry, and the entry's CRC32 is verified incrementally while streaming. A directly dropped `dumpstate_board.bin` file converts the same way.
- AC-5: The export tab can re-pack the sanitized extract as an archive that mirrors the loaded structure: `.zip` (stored entries with CRCs), `.tar`, `.tar.gz`, and `.7z`. The `.7z` writer produces a valid container with Copy (stored) coders — structure fidelity without implementing LZMA encoding (ADR-0011); real 7-Zip opens the result (`7z t` passes).
- AC-6 (v1.45.0): `.zip`, `.tar.gz`, and `.tar` archive exports stream straight to the export sink — one archive entry per source file, paged from the worker with the current filter AND view scope (per-file view exports only the displayed file, matching the text exports), nothing buffered whole; only one export runs at a time (a second click is refused while one is in flight) and Cancel also stops the worker prepare scan — so exports of any size work when direct file saving is available. ZIP entries use data descriptors (flag bit 3) so sizes/CRCs are written after the data; tar headers get their sizes from a two-pass entry serialization (ADR-0015). `.7z` (whose header requires total sizes up front) and selection-only archives keep the bounded buffered writer, with an explicit note telling the user to pick a streaming format for large exports. The streaming zip is verified by extracting it with the app's own zip reader, and the no-picker fallback remains capped at 32 MiB with a clear message.

### FR-27 — Text-converted DLT (dlt-viewer ASCII export)

Status: implemented (v1.43.0). Binary `.dlt` files and FIBEX/non-verbose payload decoding are explicitly deferred (ADR-0014).

AUTOSAR DLT logs converted to text by the dlt-viewer ASCII exporter are a first-class format: they are auto-detected, parsed into the shared record model, and flow through the whole pipeline (paging, filters, masking, search, analysis, export) like any other text format. The export line shape is `<index> <yyyy/mm/dd hh:mm:ss>.<µs> <dlt-ts> <counter> <ecuid> <appid> <ctid> <sessionid> <type> <subtype> <mode> <args> <payload>` (authoritative source: dlt-viewer `qdlt/qdltexporter.cpp`).

- AC-1: A file whose sampled lines are majority dlt-viewer export lines is detected as format `dlt` (badge `dlt`); the line shape is disjoint from logcat/syslog/ISO/CLF/MM-DD, and false positives are pinned in both directions by shared self-test cases.
- AC-2: Records map as: timestamp `MM-DD HH:MM:SS.mmm` (year dropped, microseconds truncated to milliseconds), level from the log subtype word (`fatal`→F, `error`→E, `warn`/`warning`→W, `info`→I, `debug`→D, `verbose`→V; `default` and unknown → null), non-log types to trace/control levels (`app_trace`/`nw_trace`→D, `control`→I), tag = `appid:ctid`, pid = session id. The leading index and DLT relative-timestamp columns are optional; the payload is never corrupted by digit-leading text because the mode word fixes the arg-count column.
- AC-3: Non-dlt lines inside a dlt file (wrapped fragments, header notes) fall back to continuation records that stay visible and bypass level filters, like every other format.
- AC-4: Masking, quick filter, search, selection copy, and sanitized export apply to DLT payload text unchanged (VIN/email/IP payloads are masked in the viewer, the drawer, and exports).

## Non-functional requirements

### NFR-1 — Performance

Status: implemented (v1.0.0).

- Streaming indexing with bounded memory: raw text is never held for the whole file (columnar offsets only, ~17 bytes per line in the worker), so multi-hundred-MB files and multi-GB archives are practical on desktop; a conservative ceiling is ~4-8 GB per load set.
- The viewer renders paged 500-row windows (bounded row count at any scroll position) over files with millions of lines; wrap mode estimates heights and measures only rendered rows.
- Filtering and quick search run in the paging worker (cancellable, stale results discarded) and report live percentage progress; the UI thread only renders the active page.
- Instant level/time/bookmark-only filters scan the in-worker columns without re-reading the file; text-bearing filters (quick/rules) re-stream from the source `File` with progress.

### NFR-2 — Privacy

Status: implemented (v1.0.0).

- 100% client-side processing; no server, no uploads; files never leave the machine.
- No CDN resources, no external fonts, no telemetry.
- External PII providers are opt-in and off by default; the local regex engine is the default and performs no network calls; remote backends warn that data would leave the machine (ADR-0003, FR-25).
- Persisted local state (themes, presets, bookmarks, and the per-field search-term history per ADR-0012) stays on-device; clearing site data removes it — nothing is synced or transmitted.

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
