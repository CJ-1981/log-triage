# SPEC-DLT-BINARY-001 Implementation Plan

Related: `spec.md` (EARS requirements R1-1 through R5-6), `acceptance.md` (scenarios).

## Milestones (priority-based)

- Primary goal: binary `.dlt` captures index and page end-to-end — magic/plausibility classification in `PagedLog.index` (M1 — Detection and classification), the record iterator with offsets at message starts (M2 — Indexing and record iteration), and per-page re-decode into the existing record shape (M3 — Page decoding and rendering) using the decoder subset needed for headers, basic arguments, and hex-dump fallback.
- Secondary goal: full verbose argument fidelity — the complete typed argument set including 128-bit BigInt integers, float16, and ASCII/UTF-8 string encodings (M4 — Argument decoding) with rendering vocabulary parity to the `dlt` text path.
- Final goal: resilience and diagnostics — truncated final messages, resynchronization, loud failure, and warning surfacing (M5 — Resilience and diagnostics) with determinism pinned by tests.
- Mandatory with the final goal: the binary `.dlt` drop scenario in e2e next to the dlt text export spec — acceptance.md's Validation Method relies on it for the end-to-end edge cases (AC-E.1, plus the AC-E.8 filter, search, mask, and export flow), so it is not optional.
- Optional goal: a FIBEX seam (a single WHERE-absent branch point) without any dictionary loading.

Dependency note: implementation runs in six phases in dependency order. Phase 1 is the pure decoder module `src/decode-dlt.js`, developed test-first, with its worker-bundle registration landing in the same change (phase 4 of the SPEC work plan collapses into phase 1 because `tests/scaffold.test.js:80-90` hard-fails from the moment a non-glue `src/*.js` exists unregistered in `MODULE_ORDER` union `WORKER_ORDER`). Phase 2 integrates the record iterator into `src/paged.js` indexing; phase 3 is per-page decode plus the detection-distinctness and fixture/test work (phase 5 of the work plan is threaded through every phase per ADR-0005 TDD, with a consolidation task); phase 6 is the bundle rebuild and coverage-gate verification. The decoder is the foundation: indexing consumes it, paging consumes the offsets the iterator produces, and resilience extends the decoder's message walker.

## Design Decisions (locked)

- Module path `src/decode-dlt.js` exactly as pinned in `spec.md` Technical Notes and Traceability. Naming echoes the pure-decoder precedent (`src/format-7z.js`) in spirit but keeps the SPEC's pinned path so spec, plan, and future acceptance stay traceable one-to-one.
- Detection lives in `src/paged.js`, not `src/detect.js` (R1-4): the sniff runs over the already-buffered 64 KiB head inside `PagedLog.index` next to the UTF-8 sniff (`src/paged.js:50-54`), reusing that head slice so only one head read happens. Storage-header magic 44 4C 54 01 at offset 0 classifies `dlt-binary` (R1-1). Without it, classification requires ALL of the following (R1-2): a plausible DLT v1 standard header at offset 0 (HTYP protocol-version bits 0b001 with a consistent combination of the UEH, MSBF, ECU, SESS, and TMSP flag bits, any mcnt counter value, and a total length read in the MSBF-given byte order); the declared length at least the minimum header size implied by HTYP and within `file.size`; a chained look-ahead — the boundary at offset plus the declared length must itself start a plausible header (at least two consecutive plausible boundaries), or the first message decodes to a complete typed structure; and a text veto — a head that `detectFormat` scores at 0.5 confidence or higher for any text format is not classified `dlt-binary`. The single-header check alone is insufficient: the version bits are bits 5-7, so every first byte 0x20-0x3F passes them, and a logcat head like `09-11 22:...` forms a consistent TMSP-only header with a large little-endian length. `src/detect.js` stays a pure text scorer; the veto only reads its head score, preserving the R1-3 layering. A positive classification also sets `this.utf8 = true`, so the encoding badge never appears for binary captures (rendered text comes from the decoder, not TextDecoder replacement).
- The decoder is pure: it takes `Uint8Array` input and returns plain record objects; it performs no `file.slice`, no IO, no timers. The byteLines-mirroring record iterator (1 MiB chunks, 8 ms deadline, `pause()`, `cancelled`, `onProgress`) lives in `src/paged.js` next to `byteLines` (`src/paged.js:15`) — this is ADR-0014's "swap `byteLines` for a record iterator" at the same layer. Testability and the 90/85 coverage gate both favor an IO-free module.
- One pure `decodeMessage(bytes)` entry is used by BOTH the index iterator and `page()`, so index-time and page-time rendered lines cannot diverge (R5-6, R3-1). Caller contract: offsets point at standard-header starts (AC-2.2), so page windows always begin with the standard header, while index-time windows on storage-header captures begin with the storage header; `decodeMessage` skips a leading storage header only when the window begins with the 44 4C 54 01 magic, and bounds every read by the declared total length so the trailing next-record storage header inside a page window is ignored as framing (AC-3.1). Resynchronization and warning counting run at index time only; page re-decode of an `[offset, nextOffset)` slice is a deterministic function of bytes.
- Decoder output matches the `parser.parseLine` field vocabulary (`ts`, `level`, `tag`, `pid`, `msg`), so `add()` (`src/paged.js:65`), `record()` (`src/paged.js:86`), `metadata()` (`src/paged.js:82`), and `sortIds` (`src/paged.js:111`) consume binary records unchanged. `add()` gains an optional pre-parsed-record parameter; the text path passes nothing and behaves as today.
- Timestamps: storage-header epoch seconds+microseconds convert to the year-less UTC-naive MM-DD HH:MM:SS.mmm model (ADR-0004) with microseconds truncated to milliseconds (deterministic floor). The standard-header TMSP field is a uint32 counter in 0.1 ms units relative to system start with no epoch base, so it is decoded for framing but is never a time-column source and is not normalized into the times model (R2-3, R3-3). When the storage header carries no timestamp, the record carry-forwards the previous record's time — which the existing `add()` `lastTime` behavior already implements, with bit 128 in `levels` marking nullness (`src/paged.js:66-68`, `src/paged.js:82-84`) (R2-4).
- Rendering targets the dlt-viewer vocabulary of the `dlt` text path: level letters F/E/W/I/D/V from the MTIN nibble (the high nibble, bits 4-7, of the msin byte — not the low nibble), keywords app_trace/nw_trace/control/extension from MSTP values 1-4 with a deterministic `mstp=N` literal for reserved values 5-7 (the text path's `RE_DLT` at `src/detect.js:17` already renders `extension` lines), tag as `appid:ctid` with the ECU id as fallback, session id as pid (R3-4, R3-5). Verbose arguments render space-separated; non-verbose payloads render as a hex dump line with a stable literal prefix token, pinned by a unit test in `tests/core-cases.js` so filter, search, and masking have one predictable surface (R4-4).
- `page()` binary branch reuses the exact slice arithmetic of the text path (`offsets.get(first)` through `offsets.get(end)` or `file.size`, `src/paged.js:87-105`) and replaces CR/LF stripping with per-message decode; cache bounds (16 entries / 8 MiB) and `get()` (`src/paged.js:107`) are untouched (R3-1).
- Bundle order: `'decode-dlt.js'` is inserted into `WORKER_ORDER` between `'search.js'` and `'paged.js'` (`build.js:42-50`), so UMD order-concatenation has the producer before its consumer and the worker stays UI-glue-free and Blob-URL-standalone (R2-7). `MODULE_ORDER` is untouched.
- Warning surfacing: a `warnings` counter on the index, populated during indexing only and never mutated by page re-decode, surfaced alongside the existing index summary that `metadata()`/status already read (R5-5). The passthrough is part of the change, not a contingency: add `warnings` to the `emit(id, {...})` index-meta payload at `src/app-paging-worker.js:78` (the payload whitelists fields explicitly), and read it in the worker index-result handler in `src/app.js`, which already consumes `result.format`, `result.utf8`, and `result.counts` at lines 325-328, so the status surface shows the lossy-decode count.

## Out of Scope

- FIBEX signal-dictionary loading or parsing (R4-6 stays at the WHERE-absent hex-dump baseline; only a seam may exist).
- Non-verbose semantic decoding of any kind — the hex dump is the committed rendering for non-verbose payloads.
- DLT over network transports: serial, UDP, or TCP framing and any reassembly of segmented/network-trace payloads.
- Encoding or writing `.dlt` files — this SPEC is decode-only.
- Year restoration in timestamps (ADR-0004 year-less model is kept), and any change to `src/detect.js`, text `dlt` parsing, or the dlt text e2e assertions.

## File-by-file Changes

### src/decode-dlt.js (new; gated module)

1. UMD wrapper on `root.LT` like `src/paged.js:1`; no imports required beyond what `util.js` already provides ahead of it in the bundle.
2. Sniff helpers (R1-1, R1-2, R1-4): storage-header magic check (44 4C 54 01) and the storage-header-less plausibility gate over the first bytes — HTYP protocol-version bits 0b001 with a consistent combination of the five flag bits; a total length read in the MSBF-given byte order that is at least the minimum header size implied by HTYP and within the size bound; a chained look-ahead requiring at least two consecutive plausible boundaries (or a complete first-message decode); and a text veto for heads `detectFormat` scores at 0.5 confidence or higher. The single-header check alone is not shippable: every first byte 0x20-0x3F passes the version bits, so plain text heads pass it verbatim.
3. Header walking (R2-1): optional 16-byte storage header (magic 44 4C 54 01, 4-byte ECU id, uint32 seconds, int32 microseconds; version 0x01 only per ADR-0014 — the variable-length DLTv2 storage header is a documented non-goal); standard header — 4-byte fixed part (HTYP typed flags, mcnt counter, 16-bit total length in the MSBF-given byte order) plus the optional 4-byte ECU id (ECU bit), optional 4-byte session id (SESS bit), and optional uint32 TMSP timestamp in 0.1 ms units relative to system start; extended header when UEH is set — fixed 10 bytes (msin with VERB 0x01, MSTP bits 1-3, MTIN high nibble bits 4-7; a mandatory 1-byte argument count immediately after msin; APID; CTID).
4. Verbose argument decoding (R4-1 through R4-3, R4-5): 32-bit type-info word handling (type code, TLEN, variable-length flag, string-encoding bits) read in the MSBF-given byte order; boolean; signed/unsigned 8/16/32/64/128-bit with BigInt for 64/128; float16/32/64; ASCII and UTF-8 strings (each invalid UTF-8 byte renders as a lowercase two-digit `\xNN` hex escape, the pinned visible lossless placeholder per AC-4.3); raw; every read bounded by the declared total length and remaining payload.
5. Rendering (R3-2 through R3-5, R4-4): one text line per message — header fields to tag/pid/ts/level, arguments space-separated, hex dump with stable prefix for non-verbose and undecodable payloads.
6. Resynchronization (R5-1, R5-2, R5-3, R5-4, R5-6): forward scan to the next plausible boundary, truncated-EOF partial decode, invalid-argument hex fallback, warning counts, loud descriptive failure naming byte offset and records indexed so far; no clocks, no randomness, fixed iteration order.
7. Exports on `root.LT`: sniff helpers, message scanner/decoder, and renderer — consumed by `src/paged.js` and the shared case suite.

### src/paged.js

1. `index()` (`src/paged.js:45`): hoist the 64 KiB head slice so the UTF-8 sniff (`src/paged.js:50-54`) and the new `dlt-binary` sniff share one read; on a positive sniff set `this.format = 'dlt-binary'`, set `this.utf8 = true` (the worker meta then carries utf8 true and the enc? badge never appears for binary captures — pinned by a unit assertion on the meta payload), store storage-header presence (R1-5), and branch into the binary path before the `byteLines` + `detectFormat` text flow (`src/paged.js:74-79`) (R1-1, R1-2, R1-3).
2. New record-iterator generator beside `byteLines` (`src/paged.js:15`): same 1 MiB chunking, 8 ms deadline + `pause()` (`src/paged.js:5`), `cancelled` checks, and `onProgress` reporting; buffers partial messages across chunk boundaries and yields decoded records with message-start offsets (R2-5); exposed through one format-agnostic iterator entry point that yields `byteLines` for text formats and decoded records for `dlt-binary`, so the worker raw-scan loops iterate the correct space per format (R3-2).
3. `add()` (`src/paged.js:65`): optional pre-parsed record parameter; offsets, times via `timeKey`, levels, counts, `maxLength`, and the head+tail sample ring stay shared with the text path so the binary sample has the identical shape (R2-2, R2-3, R2-4, R2-6, R3-6).
4. `page()` (`src/paged.js:87`): `dlt-binary` branch — same slice bounds, per-message `decodeMessage` over `bytes.subarray(from, to)` instead of CR/LF stripping, pre-parsed fields passed to `record()`; cache bounds and `get()` unchanged (R3-1, R3-2, R3-3).
5. `this.warnings` counter set by the binary path and exposed next to the existing index summary (R5-5). `metadata()`, `record()`, `sortIds()`, `Column`, and the cache need no structural change — validated by tests.

### src/parser.js

1. No happy-path change: both call sites pass pre-parsed fields (`add()` receives the decoder's record; `page()` feeds pre-parsed fields straight to `record()`), so `parseLine` never sees a `dlt-binary` line during indexing or paging.
2. Pure defensive fallback only: the `parseLine` dispatch gains a `dlt-binary` case that returns `record(null, null, null, null, line)` — the existing continuation-line shape (`src/parser.js:84`) — so any future re-parse of a rendered binary line degrades to a null-field record instead of running the `dlt` text regex over binary-rendered text; a unit test asserts no `ts` or `level` is hallucinated for a hex-dump line.

### src/app-paging-worker.js

1. Switch both `rawNeeded` scans to the format-agnostic iterator: the query loop at line 49 and the `exportInit` loop at line 110 iterate `LT.byteLines(s.file, ...)` directly and pair each byte-line with `metadata(i)` in byte-line index space; replace the direct `byteLines` call with the `PagedLog` format-agnostic iterator entry (byteLines for text formats, the record iterator for `dlt-binary`), so matches on a binary capture resolve to decoded records in the correct index space (R3-2). No other query or export logic changes.
2. Add `warnings` to the index-meta `emit(id, {...})` payload at line 78 so the lossy-decode count reaches the UI (R5-5).

### src/app.js (status surface only)

1. In the worker index-result handler (the code reading `result.format`, `result.utf8`, and `result.counts` at lines 325-328), consume `result.warnings` and surface the count on the file entry so the status/file-list surface shows that binary decoding was lossy (R5-5). No other app.js behavior changes.

### src/detect.js

1. No change, per R1-4. `detectFormat` (`src/detect.js:29`), `FORMATS` (`src/detect.js:19-26`), and the internal `RE_DLT` (`src/detect.js:17`) are untouched; binary classification never reaches `detectFormat`.

### build.js

1. Insert `'decode-dlt.js'` into `WORKER_ORDER` (`build.js:42-50`) before `'paged.js'`, keeping `util.js` first; the bundle comment (`build.js:39-41`) and injection path (`build.js:84`, 98-99) need no change. `MODULE_ORDER` untouched.

### package.json

1. Append `tests/decode-dlt.test.js` to the explicit `node --test` file list (`package.json:8`) in the same change that creates the file, or the coverage gate hard-fails on a module no test requires.

### tests/decode-dlt.test.js (new)

1. `node:test` unit file for the pure decoder: sniff matrix, header walking, argument matrix, string encodings, hex fallback, boundary violations, truncation, resync, determinism, and timestamp normalization. Written test-first per ADR-0005.

### tests/paged.test.js

1. Extend with `new Blob([uint8array])` cases (makeFile precedent, `tests/paged.test.js:9`): binary index produces offsets at message starts, times/levels columns, sample shape, page re-decode equality with index-time lines, cache behavior, and cancellation/progress flow.

### tests/core-cases.js

1. Add `dlt-binary` cases to the shared suite (ADR-0005, `/*__LT_CASES__*/`): sniff true/false pairs (fixture head, text `dlt` sample, plain text), ts normalization round-trips, level/MSTP mapping parity with the text parse group (`tests/core-cases.js:185-222`) including MSTP 4 rendering as `extension` and a reserved value rendering as the deterministic `mstp=N` literal, hex-dump prefix stability, and a resync case. Detect-group additions (`tests/core-cases.js:71-99`) assert exclusion both ways: a dlt-viewer text export still scores `dlt`, and binary bytes are never scored a text format. Include the misclassification guard: a 16 KiB or larger logcat-style head starting `09-11 22:14:01.100` never classifies `dlt-binary` (the version bits alone would pass it). Include the DLTv2 negative classification case: a head beginning 44 4C 54 02 never classifies `dlt-binary` and routes to the text path as plain (AC-1.6).

### tests/fixtures (new fixtures)

1. `tests/fixtures/dlt-binary-sample.hex` — hand-built binary capture committed as ASCII hex text following the `lzma*.hex` precedent (`tests/format-7z.test.js:23`): storage-header variant mixing verbose messages across argument types, one non-verbose message, one control message, and ASCII plus UTF-8 strings.
2. `tests/fixtures/dlt-binary-nostorage.hex` — the no-storage-header variant (R1-2).
3. `tests/fixtures/dlt-binary-sample-expected.txt` — expected rendered lines embedded alongside, mirroring `sample7z.txt`.
4. Edge shapes (truncated final message, length-mismatched framing, invalid TLEN, the AC-E.6 header-only shapes — a bare 16-byte storage header and a lone self-consistent standard header whose declared total length exactly equals its own header size, both indexing zero records cleanly — and a mixed capture alternating storage-header-prefixed and headerless messages for AC-E.9) are built in-test with byte builders rather than committed, keeping fixtures readable.

### tests/e2e/app.e2e.spec.mjs (mandatory)

1. Binary drop scenario near the dlt text spec (`tests/e2e/app.e2e.spec.mjs:2286`): decode the hex fixture at runtime and pass a `{ name, mimeType, buffer }` payload to `page.setInputFiles`, keeping the fixtures directory text-only; assert, per acceptance.md's Validation Method mandate: the badge `dlt-binary`, the total count, the drawer fields, the level chips, hex-dump row visibility, the AC-E.5 keyword rows, the AC-5.5 warning-count surface, and the full AC-E.8 flow — apply a level chip, apply a full search term matching a hex-dump row, apply a mask rule, then open the Export tab and assert the downloaded export equals the rendered binary lines with masking applied, mirroring `tests/e2e/app.e2e.spec.mjs:377-502` — all via the `fresh()`/`click()`/`status()` helpers.

### Gated-module note

- `src/decode-dlt.js` is gated by `tools/coverage-gate.mjs` at 90 percent line / 85 percent branch (lines 12-13; only `src/app*.js` is exempt, line 18). A module with no coverage row is a hard GATE FAIL (lines 75-82), so the `package.json:8` registration and the unit file land with the module. `tests/scaffold.test.js:80-90` passes automatically once `WORKER_ORDER` lists the file. Node 22 is required for the gate (project memory).

## Task Decomposition (with dependencies)

1. Task A (no deps; phase 1 + phase 4): scaffold `src/decode-dlt.js` — UMD wrapper, constants, sniff helpers — and register it in `build.js` WORKER_ORDER before `paged.js` and in `package.json:8`, all in one change, with failing sniff tests first. [M1, R1-4; M2, R2-7]
2. Task B (depends on A; phase 1): header walking and message framing — storage header, standard header bit flags with the total length read in the MSBF-given byte order, extended header; pure message decoder; implausible-length detection. [M2, R2-1; M4, R4-5]
3. Task C (depends on B; phase 1): verbose typed-argument decoding — boolean, integers 8 through 128 bits (BigInt for 64/128), float16/32/64, ASCII/UTF-8 strings, raw; space-separated rendering; boundary-bounded reads. [M4, R4-1, R4-2, R4-3, R4-5]
4. Task D (depends on B; phase 1): non-verbose hex-dump rendering with stable prefix, MSTP keyword and MTIN level-letter mapping, rendered-line vocabulary (tag, pid, ts). [M3, R3-2, R3-4, R3-5; M4, R4-4, R4-6]
5. Task E (depends on B; phase 1): resynchronization scan, truncated-EOF partial decode, invalid-argument fallback, warning counts, loud failure, determinism pins. [M5, R5-1, R5-2, R5-3, R5-4, R5-6]
6. Task F (depends on A-E; phase 2): `src/paged.js` indexing integration — sniff and routing in `index()` with the full R1-2 gate (HTYP-implied minimum length, chained look-ahead, text veto), storage-header flag, `this.utf8` pinned true on classification, record iterator with the byteLines yield contract plus the format-agnostic iterator entry point, `add()` pre-parsed parameter, shared sample ring, `this.warnings`. [M1, R1-1, R1-2, R1-5; M2, R2-2, R2-3, R2-4, R2-5, R2-6; M3, R3-2, R3-6; M5, R5-5]
7. Task G (depends on F; phase 3): `page()` binary branch with per-message decode, parser.js defensive fallback, the `app-paging-worker.js` rawNeeded switch to the format-agnostic iterator plus the `warnings` field in the index meta, the `app.js` status-surface consumption of that field, and validation that `metadata`/`record`/`sortIds` hold unchanged. [M3, R3-1, R3-2, R3-3, R3-6; M5, R5-5]
8. Task H (depends on F and G; phase 3 + phase 5): detection distinctness cases (R1-3 mutual exclusion), committed hex fixtures and expected text, in-test byte builders for the edge shapes including the mixed storage-header/headerless alternating builder for AC-E.9, core-cases additions. [M1, R1-3; M4; M5]
9. Task I (depends on H; phase 6): `node build.js` bundle rebuild, `npm test`, `npm run test:gate`, `npm run e2e`, scaffold assertion check, and the mandatory binary-drop e2e scenario; verify the single-file build invariant and that the text `dlt` e2e still passes untouched. [M5; whole-SPEC verification]

## Test Plan

Unit (node --test) — write failing specs before the implementation tasks they cover (TDD, ADR-0005):

- Sniff matrix: storage magic classifies `dlt-binary`; a no-storage head classifies `dlt-binary` only under the full R1-2 gate — plausible header, declared length at least the HTYP-implied minimum and within `file.size`, a second consecutive plausible boundary (or a complete first-message decode), and a head `detectFormat` does not score at 0.5 confidence or higher for a text format; a dlt-viewer text export, plain text, 7z, and gzip bytes do not classify; headers with wrong protocol-version bits or implausible lengths are rejected; a 16 KiB or larger logcat-style head starting `09-11 22:14:01.100` never classifies `dlt-binary`; a file whose first bytes are 44 4C 54 02 (the DLTv2 storage-header version byte) is never classified `dlt-binary` and routes to the text path as plain without a decode error, pinning R1-5's version-exact non-goal (R1-1, R1-2, R1-3, R1-5).
- Framing: each standard/extended header field decodes (including the msin bit layout, the mandatory argument count, and the MTIN high nibble); storage header treated as framing not payload (R1-5, R2-1); the total length is honored in the HTYP MSBF byte order; message count equals expected for the fixtures.
- Argument matrix: every supported type decodes exactly, including u64/i64/u128/i128 via BigInt, float16 edge values, ASCII one-byte-per-char, UTF-8 with each invalid byte replaced by the pinned lowercase `\xNN` escape, raw bytes (R4-1, R4-2, R4-3).
- Boundaries: an argument read past the declared total length is invalid and handled per M5, never reading into the next message (R4-5).
- Resilience: truncated final message yields a partial record plus one warning and completes; implausible framing resyncs forward with a warning; an invalid type-info/TLEN hex-dumps the remainder and leaves later messages intact; an exhausted resync fails loudly naming offset and record count; decoding twice yields identical offsets, lines, and warnings (R5-1 through R5-4, R5-6).
- Timestamps: storage-header seconds+micros normalize to the year-less MM-DD HH:MM:SS.mmm model with millisecond truncation; the TMSP relative counter is framing-only and never reaches the times column; `timeKey`/`timeText` round-trip; carry-forward when the storage header carries no timestamp, asserted against the `add()` `lastTime` plus levels bit-128 mechanism (R2-3, R2-4, R3-3).
- Rendering parity: level letters and MSTP keywords match the `dlt` text mapping in `tests/core-cases.js:185-222`, extended with MSTP 4 rendering as `extension` (the text path's `RE_DLT` already matches that keyword) and a reserved MSTP value 5-7 rendering as the stable `mstp=N` literal with no hallucinated fields (R3-4, R3-5).
- Paged integration (Blob-based): offsets land at message starts; page re-decode equals index-time lines; sample shape matches the text path; cancellation and progress callbacks fire; cache bounds hold; the worker index meta carries `utf8: true` for a binary fixture (no enc? badge driver) and `warnings` for a lossy one; a search hit and a quick-scan hit on a binary capture resolve to decoded records in the correct index space, not byte-lines (R2-2, R2-5, R2-6, R3-1, R3-2, R5-5).

Fixtures:

- Committed hex fixtures cover the happy shapes (storage and no-storage variants, verbose across argument types, one non-verbose, one control, ASCII and UTF-8 strings); in-test byte builders cover truncation, length mismatch, invalid TLEN, resync bait, and the AC-E.6 header-only shapes (a bare 16-byte storage header, and a lone standard header whose declared total length equals its own header size — both return zero records cleanly with no error and no warning, mirroring the spec.md M5 precedence note). Expected rendered text is embedded alongside per the `sample7z.txt` pattern.

E2E (Playwright) — after the unit suite is green, mandatory for the AC-E.1 end-to-end coverage and the AC-E.8 filter, search, mask, and export flow:

- Decode `dlt-binary-sample.hex` in-spec and drop it via an input buffer; assert format badge `dlt-binary`, correct total, the decoded drawer fields, the level chips, hex-dump row visibility, the AC-E.5 keyword rows, the AC-5.5 warning-count surface, and that quick scan finds a rendered token — that assertion exercises the worker raw-scan path over the format-agnostic record iterator, so it doubles as the end-to-end R3-2 index-space check — then carry the full AC-E.8 sequence in the same scenario: apply a level chip, apply a full search term matching a hex-dump row, apply a mask rule, and assert the downloaded export equals the rendered binary lines with masking applied, mirroring `tests/e2e/app.e2e.spec.mjs:377-502`, so the scenario satisfies acceptance.md's Validation Method mandate in full; verify the dlt text spec (`tests/e2e/app.e2e.spec.mjs:2286`) still passes unchanged.

## Risks and Mitigations

1. Type-info bit-layout variants (TLEN presence, variable-length flag, FB/FL string-encoding bits) differ across DLT producers. Mitigation: decode strictly from documented bits, treat unknown combinations as invalid-argument per R5-3 rather than guessing, and pin each documented combination with a hand-built vector.
2. Byte order: the HTYP most-significant-byte-first bit governs more than argument endianness — it also determines the standard header's 16-bit total length and its 32-bit extra fields (session id, TMSP timestamp), plus the payload's 32-bit type-info words and multi-byte argument values. Mitigation: plumb the header bit into length, extra-field, and argument decoding, and test both orders with byte builders; default to little-endian when unset.
3. String encodings mislabeled by producers (UTF-8 declared, ASCII actual, or vice versa). Mitigation: decode per the declared bits but validate UTF-8 strictly with the lossless placeholder (R4-3), so mislabels render visibly instead of corrupting adjacent bytes.
4. Length handling: the 16-bit total length travels in the MSBF-given byte order (big-endian in dlt-daemon captures, which always set MSBF, matching qdlt's byte-swapped reads of the length and extra fields), and a length below the minimum header size implied by HTYP, or overshooting `file.size`, is the main desync trigger. Mitigation: decode the length with the same MSBF plumbing as the plausibility check, check it against the HTYP-derived minimum and remaining bytes before trusting it, then resync per R5-2 with bounded scan windows.
5. Resync false positives: a plausible magic sequence inside a payload could be mistaken for a boundary. Mitigation: require the full multi-field plausibility check (not magic alone) for recovered boundaries, cap the scan window, and make the scan deterministic so identical bytes resync identically (R5-6).
6. Interaction with wrap/selection/analysis-sample paths: binary rendered lines flow into wrapping, selection, masking, and the head+tail sample. Mitigation: the sample ring and record shape are shared with the text path by construction (Task F), and unit tests assert sample-shape equality; wrap/selection need no format-specific branches per R3-2.
7. Coverage-gate failure on the new module (no coverage row is a hard GATE FAIL; branch minimum 85 needs both BigInt and non-BigInt paths exercised). Mitigation: registration in `package.json:8` lands with the module (Task A) and the argument matrix drives both code paths from the start.
8. Text `dlt` regression: any accidental change to `detect.js` or the text parser would break the existing e2e. Mitigation: `src/detect.js` is explicitly untouched, the binary sniff lives in `src/paged.js`, and the dlt text unit cases (`tests/core-cases.js:71-99`) plus e2e (`tests/e2e/app.e2e.spec.mjs:2286`) run as regression gates in Task I.
9. Large captures with many warnings could make the warning surface noisy or nondeterministic if page re-decode recounted. Mitigation: warnings are counted once during indexing; page re-decode never mutates the counter.
10. Text-file misclassification by the storage-header-less gate: every first byte 0x20-0x3F passes the HTYP version bits, so plain text heads (digits, dashes) form consistent single headers with large little-endian lengths, and real logcat dumps exceed any such length. Mitigation: the full R1-2 gate — HTYP-implied minimum length, chained look-ahead of two consecutive plausible boundaries or a complete first-message decode, and the `detectFormat` text veto — pinned by a core-cases guard on a 16 KiB or larger logcat-style head and by the sniff-matrix negative cases.

## Conventional Commits (planned series)

- `feat(dlt): pure binary .dlt decoder module with typed args, hex fallback, and resync`
- `feat(paging): classify and index binary .dlt captures via record iterator`
- `feat(paging): per-page binary decode and lossy-decode warning surfacing`
- `test(dlt): hex fixtures, unit matrix, and shared-case coverage for dlt-binary`
- `test(e2e): binary .dlt drop scenario beside the dlt text export spec`
