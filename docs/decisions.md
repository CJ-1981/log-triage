# Decisions

Architecture decision records (ADRs). Status values: proposed, accepted, superseded.

## ADR-0001 — Single-file HTML deliverable built from UMD src modules

- **Status:** accepted
- **Context:** The tool must be trivially distributable and usable by non-developers (email an HTML file, open it, done), while still supporting serious TDD with Node-based coverage measurement. Common bundler setups (webpack/esbuild/rollup) would add toolchain weight for a zero-dependency project, and ESM browser modules do not load cleanly from `file://` in all environments.
- **Decision:** Ship one self-contained `log-triage.html` assembled by `build.js` from UMD modules in `src/`. No bundler, no transpilation, no runtime dependencies. UMD keeps every module `require()`-able in Node for `node:test` and the coverage gate, and the same files are concatenated verbatim into the HTML. Template tokens (`__LT_VERSION__`, `/*__LT_CSS__*/`, `/*__LT_MODULES__*/`, `/*__LT_CASES__*/`, `/*__LT_DEMO__*/`) inject version, styles, modules, shared cases, and demo data at build time.
- **Consequences:** Zero-dependency distribution that works offline from `file://`; identical code paths in tests and production; no tree-shaking or minification (acceptable at this codebase size); module order in `build.js` matters and must be maintained; UMD boilerplate is repeated per module.

## ADR-0002 — PII regex set ported verbatim from the android-log-analysis skill

- **Status:** accepted
- **Context:** The android-log-analysis skill already contains a battle-tested `pii_mask.py` with 16 ordered rules tuned for Android logs (VIN, IBAN, credit card, SSN, international phone, US phone, IMEI, email, device serial `SN-`, MAC keeping OUI, private IPv4, public IPv4, IPv6 link-local/ULA, GNSS decimal pairs ≥ 3 decimals, subscriberId, hotspot SSID `AndroidShare_`). Re-deriving these in JavaScript would reintroduce subtle bugs and diverge from a proven reference.
- **Decision:** Port the regex set from `pii_mask.py` verbatim into `src/masks.js`, preserving the original rule order (order affects which rule claims an overlap). Document the deliberate false-positive guards so they are never "fixed" away: timestamp-like digit runs must not match, 13-digit epoch-milliseconds values must not match phone/IMEI rules, version numbers like `2.41.3` must not match GNSS decimal pairs, single decimal numbers (e.g. `1.5`) must not match GNSS pairs, and the IPv6 multicast address `ff02::1` must not match the IPv6 rule.
- **Consequences:** Predictable masking behavior identical to the reference implementation; a documented test matrix of true positives and guarded negatives in the shared case suite (G5); porting verbatim means some rules remain Android-specific, which matches the tool's primary use case; rule order is contractual — reordering changes results.

## ADR-0003 — External PII analysis extension (PiiProvider, Presidio/LLM)

- **Status:** proposed
- **Context:** Regex rules catch known patterns but not names, free-text addresses, or format-drift PII. External analyzers (Microsoft Presidio, LLM-based analysis) could improve recall, but they change the privacy posture: Presidio can run machine-locally as a sidecar service, while an LLM backend necessarily sends log content off the machine. The tool's core promise is "files never leave the machine", so any remote path must be impossible to trigger accidentally.
- **Decision:** Ship the `PiiProvider` interface and registry in v1 with a local regex provider and a mock provider; findings use the format `{ start, end, type, score }` as offsets into each line, and masking and the PII census tag every finding with its provider id. A future Presidio backend would run as a localhost sidecar service — still machine-local, flagged `local: true`. A future LLM backend is remote by definition: it must be explicit opt-in, off by default, and display a warning that data leaves the machine. Neither backend is wired in v1; v1 contains no network code paths at all.
- **Consequences:** The extension seam exists and is testable now (mock provider), so wiring a real backend later is additive; the `local` flag makes the privacy boundary machine-checkable (a provider that can become available without user opt-in is a bug); census results remain auditable per provider; remote backends, if ever added, require UI, consent, and warning work beyond the interface itself.

## ADR-0004 — Year-less UTC-naive timestamp model

- **Status:** accepted
- **Context:** Log sources use heterogeneous, often year-less timestamps: logcat threadtime (`MM-DD HH:MM:SS.mmm`), bare `MM-DD`, syslog (`MMM DD HH:MM:SS`), plus full ISO-8601 and CLF. Sessions being triaged rarely span a year boundary, and carrying per-file year inference would create false ordering across files with guessed years.
- **Decision:** Normalize every parsed timestamp to a year-less, UTC-naive `MM-DD HH:MM:SS.mmm` string. Because the format is zero-padded and fixed-width, lexicographic string comparison is exactly chronological order — enabling cheap prefix-compare time-range filtering and simple merged-timeline sorting with file order as tiebreak. Cross-year sessions are out of scope for v1. Lines without timestamps (stack traces, continuations) are null-timestamp records that attach to the preceding parsed line's timestamp when merging timelines, preserving their logical grouping.
- **Consequences:** Trivially correct and fast ordering/filtering with no timezone machinery; cross-year sessions sort incorrectly at the boundary (accepted, documented limitation); a future year-aware mode would require widening the model, not changing existing data; null-timestamp attachment is deterministic — a stack trace always follows its trigger line in merged view.

## ADR-0005 — TDD with shared case suite and coverage gates

- **Status:** accepted
- **Context:** The deliverable is browser-only, but browser-only testing is slow and hard to gate in CI. Conversely, Node tests can silently drift from browser behavior if the browser has its own test paths. Coverage targets need mechanical enforcement or they decay.
- **Decision:** Develop test-first against a single shared case suite, `tests/core-cases.js`: a UMD module of named input → expected cases consumed by `node --test` (Node 22) and, via the `/*__LT_CASES__*/` build token, by the in-page `?selftest` runner — one suite, two runners, no drift. Coverage is enforced per core `src/` module at ≥ 90% line and ≥ 85% branch by `node tools/coverage-gate.mjs`, run locally and in CI. UI glue (`src/app-*.js`), `build.js`, and tests are exempt. Progress is structured as gates G0–G8 with explicit entry/exit criteria (see `docs/test-plan.md`); CI runs test + coverage, build, and Playwright e2e, then bumps the version from conventional commits on main.
- **Consequences:** Every behavior change lands as a case first, keeping specs and code synchronized; the `?selftest` page doubles as a user-run diagnostic on any machine; coverage exemptions are explicit so UI glue cannot hide untested logic that belongs in core modules; gate discipline adds process overhead per feature, which is accepted as the cost of a trustworthy privacy-focused tool.

## ADR-0006 — Timer-throttle-resistant streaming

- **Status:** accepted
- **Context:** Streaming ingestion must yield to the UI thread periodically so progress rendering and cancellation stay responsive during long reads. The original implementation used `setTimeout` for these yields, but browsers clamp timers in hidden/background tabs to ≥ 1 s, which stalled ingestion of large files whenever the tab was not visible — turning a ~30 s load into many minutes.
- **Decision:** Periodic UI yields during ingestion use `MessageChannel` instead of `setTimeout`. MessageChannel postMessage dispatches as a macrotask that browsers do not subject to timer clamping, so ingestion keeps making progress regardless of tab visibility.
- **Consequences:** Yields are cheap and unthrottled in all tab states; the cost is one MessageChannel per batch (creation/dispatch overhead). Background tabs can still show somewhat lower throughput for other browser-scheduling reasons, but no longer suffer order-of-magnitude timer clamping; confirmed by the big-file performance evidence in `docs/test-plan.md`.

## ADR-0007 — Transient view filters are session-scoped

- **Status:** accepted
- **Context:** The app originally persisted quick search, level chips, time range, and the search pattern across sessions alongside themes, mask/rule config, presets, and bookmarks. A restored stale filter made freshly loaded files appear empty or nearly empty — the "new files are invisible" bug reported against v1.1.x — even though ingestion had succeeded. The fault was in persistence policy, not in ingestion or rendering.
- **Decision:** Transient view filters — quick search, level chips, time range, and the search pattern — are intentionally not persisted across sessions. Rules, masks, presets, themes, and bookmarks remain persisted because they describe durable user configuration rather than a moment's investigative focus.
- **Consequences:** Reloading the page always starts with an unfiltered view of whatever is loaded, so newly loaded files are immediately visible; users who need a filter across a reload must reapply it — accepted friction, far cheaper than misdiagnosing "lost" logs. The persistence specs and the `fresh()` e2e helper (which clears localStorage before app boot) cover this behavior.

## ADR-0008 — Debounced text inputs

- **Status:** accepted
- **Context:** Instant search and the viewer quick filter originally re-ran their match pass on every keystroke. Over a large kept-line store each pass is O(lines), so fast typing queued expensive intermediate runs — the input felt laggiest exactly when the dataset was biggest.
- **Decision:** Text inputs are debounced: the search pattern matches 250 ms after typing pauses, the viewer quick filter 200 ms. Keystrokes only update input state; matching starts after the pause.
- **Consequences:** Results appear about a quarter-second after typing stops — imperceptible for triage workflows — while per-keystroke cost drops to nothing; the delays are small enough to feel responsive but long enough to skip entire bursts of intermediate queries. Deep scan remains an explicit action and is unaffected.

## ADR-0009 — Loaded-file content cache in IndexedDB

- **Status:** accepted
- **Context:** `File` handles and the kept-line store do not survive a browser session, so reopening the app meant re-dragging every file the user had just been working on. localStorage cannot hold file bytes comfortably, and only filtered lines are kept in memory by design.
- **Decision:** On every successful load, the file's bytes are cached in IndexedDB (database `log-triage-cache`) keyed by file identity. Reopening the app lists previously loaded files; clicking an entry with cached content reloads it. Entries without cached content — quota exceeded / file too large, or a failed load — are listed greyed out with a "file not found" badge and a removable ✕. Removing a file purges its cache entry and clears its bookmarks (removal is intentional; browser-close persistence is unchanged).
- **Consequences:** Session restore is one click and stays 100% local — IndexedDB is same-origin and on-device, so the privacy posture is unchanged. Quota limits degrade gracefully to a greyed "file not found" entry instead of an error; the cache key matches the bookmark file identity so the two stay consistent; storage use grows only with the files the user actually loads, bounded by the browser's quota.

## ADR-0010 — External PII providers with optional CORS proxy

- **Status:** accepted (design; implementation targeted for v1.14.0, FR-25)
- **Context:** The built-in regex engine catches known patterns but not names, free-text addresses, or format-drift PII. External analyzers (Presidio sidecar, LLM APIs) improve recall, but two constraints shape any design: browsers cannot call services that lack CORS headers directly (remote LLM APIs usually require a proxy; localhost Presidio usually does not), and any remote provider breaks the "files never leave the machine" guarantee — the boundary established in ADR-0003 and ADR-0007's persistence rules.
- **Decision:** Extend the existing `PiiProvider` registry with one adapter per backend (Presidio REST, LLM REST) surfaced in a new "PII Providers" tab; the local regex engine remains the default and always available. A proxy-mode toggle with a configurable base URL prefixes provider HTTP requests when enabled. The API key is entered password-style, stored only in localStorage, and never included in Config-tab exports. A red warning banner is shown whenever a remote (non-local) provider is active, stating that data leaves the machine. Findings from any provider normalize to `{line, start, end, type, score}` and merge into the PII census and masking.
- **Consequences:** Recall improves for unstructured PII without changing the store, viewer, or masking pipeline; the privacy boundary stays explicit and auditable (local flag + banner + key never exported). Users run their own Presidio sidecar or supply their own LLM endpoint and key — the tool still ships with zero network calls and remains fully offline on the default local provider. New failure modes are network-shaped, so invalid endpoints, timeouts, and proxy misconfigurations must surface readable errors rather than raw console traces.

## ADR-0011 — Pure-JS LZMA decode for 7z; stored-only 7z export

- **Status:** accepted
- **Context:** Users receive logs packed as `.7z`, but the format requires LZMA/LZMA2 decoding, which no browser exposes natively (`DecompressionStream` covers gzip/deflate only). The candidates were a WASM build of 7-Zip (~1 MB, breaks the single-file ethos and the no-binary-deliverable rule), dropping 7z support (users would pre-extract by hand), or embedding a pure-JS LZMA decoder in `src/`.
- **Decision:** Implement a pure-JS decoder in two small UMD modules: `src/lzma.js` (canonical range decoder + probability model, LZMA1 raw streams and the chunked LZMA2 wrapper) and `src/format-7z.js` (7z container: signature/CRC verification, plain and compressed (`kEncodedHeader`) headers, pack/folder/substream/file-info parsing, plus a writer). The chunk semantics were derived and pinned by tests against real 7-Zip output: `0x01/0x02` are stored chunks, `0x80–0xDF` are LZMA chunks that keep properties *and* decoder state across chunk boundaries, `0xE0–0xFF` reset state with a fresh properties byte; header bitsets (empty streams, digest masks) are MSB-first. Unsupported corners fail loudly: encrypted (AES) archives, coder chains (delta/BCJ), zip64. On the write side, `buildArchive(…, '7z')` emits a valid `.7z` with Copy (stored) coders — verified openable by the real 7-Zip — because implementing LZMA *encoding* is out of proportion for an export path where `.zip`/`.tar.gz` already compress.
- **Consequences:** .7z joins .gz/.tar/.zip with zero external code and the deliverable stays one HTML file (~9 KB of decoder). Codec-level fixtures (`tests/fixtures/lzma*.hex`) make the decoder testable without the CLI, while container fixtures are generated by the system 7-Zip when present (CI installs `p7zip-full`; tests skip cleanly elsewhere). Exports in `.7z` form are uncompressed containers — documented in the UI — and a bad payload is caught by the archive's own CRC32 digests rather than surfacing as garbage lines.

## ADR-0012 — Persisted search-term history (local only, capped)

- **Status:** accepted (v1.33.0)
- **Context:** Triage sessions repeat the same patterns across files and days, but the search fields started empty every time (ADR-0007 deliberately keeps the active filters transient). Keeping a small list of previously used terms gives that convenience back without restoring any filter.
- **Decision:** The rg pattern field and the viewer quick filter each keep a term history (capped at 20, case-insensitive dedupe, most recent first) shown as a dropdown on focus/typing; picking an entry fills the input and re-runs the search through the normal debounced path. Terms are recorded only when a search actually executes with a non-empty value. The lists live in the regular localStorage state (`searchHistory`, `quickHistory`) and are not in ADR-0007's transient exclusion list — the active filters stay session-scoped, the history list persists.
- **Consequences:** Re-running a favorite pattern is two clicks. Privacy note: the terms themselves persist on-device exactly like the rest of the state — the tool never sends them anywhere (ADR-0003/ADR-0007 posture unchanged) — and clearing site data removes them. There is currently no dedicated in-UI clear for the history (clearing site data is the reset); add one if it is ever missed.

## ADR-0013 — Search-match rows wrap by default, with a per-tab Wrap toggle

- **Status:** accepted (v1.33.1 wrap, v1.34.0 toggle)
- **Context:** Long matched lines rendered as single ~15,000 px flex rows: the row highlight band and sticky group header only covered the visible width, so text appeared to overflow a fixed-width background. The earlier design (horizontal scrolling, "full text reachable") traded readability for reachability.
- **Decision:** Search-match rows wrap by default (`pre-wrap`, text cell `flex: 1 1 auto` with `overflow-wrap: anywhere`), with the rendered text bounded to the same 2,000-character preview + click-to-open-full-text used in the viewer. Hit rows use the visible selection tint. A Search-tab-local **Wrap: ON/OFF** toggle (independent of the viewer's wrap) switches to one horizontally scrollable line per match; row/group bands always stretch uniformly across the widest line via a max-content inner wrapper (mirroring the viewer's `#vspacer`).
- **Consequences:** No text visually overflows its background in either mode, and reachability is preserved (wrap shows everything; OFF restores scroll). The per-tab toggle means the viewer and search wrap preferences do not fight each other. Deep-scan context rows inherit the same treatment automatically.

## ADR-0014 — DLT support starts with text-converted exports; binary .dlt and FIBEX are deferred

- **Status:** accepted (v1.43.0)
- **Context:** AUTOSAR DLT logs reach us in two shapes: binary `.dlt` capture files (storage-header `44 4C 54 01` framing, typed verbose arguments) and text conversions produced by the dlt-viewer ASCII exporter. The real workload supplies text conversions; decoding binary non-verbose messages additionally requires a FIBEX signal dictionary, and the paging architecture re-parses raw text per rendered page, which binary records cannot flow through unchanged.
- **Decision:** Support the dlt-viewer ASCII export as a regular auto-detected text format (`dlt`) with a tolerant line parser pinned to the exporter layout from `qdlt/qdltexporter.cpp` — no new module, no worker change. Binary `.dlt` decoding and FIBEX support are deferred. When binary support becomes a requirement, the design is: sniff the `DLT\x01` magic in `PagedLog.index`, swap `byteLines` for a record iterator that decodes each DLT message and renders it to one text line, and point the columnar offsets at the binary record starts so `page()` re-decodes only the ~256 records of a page — the bounded-memory model is preserved. Non-verbose payloads without FIBEX would render as hex dumps; skipping them loses data.
- **Consequences:** DLT text triage works today through every existing feature (mask, filter, search, export) with zero architectural cost. Binary .dlt files ingested today still surface as garbled text (magic bytes make detection trivial for the follow-up), and the deferred design is recorded here so it does not need to be re-derived.
