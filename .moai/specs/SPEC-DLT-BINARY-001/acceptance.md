# SPEC-DLT-BINARY-001 Acceptance Criteria

Given-When-Then scenarios per requirement group, edge cases, success criteria, and validation method.

## M1 — Detection and classification (R1-1 … R1-5)

### AC-1.1 Storage-header magic routes to the binary path
- Given a dropped file whose first bytes at offset 0 are the DLT storage-header magic 44 4C 54 01 (ASCII "DLT" followed by the version byte 0x01), followed by a 16-byte standard header and at least one complete message
- When `PagedLog.index` processes the file
- Then the file is classified as format `dlt-binary` (this.format is `'dlt-binary'`), the storage-header-present flag is recorded, indexing proceeds through the binary record iterator instead of the `byteLines` text splitter, the file's rows never reach the text `detectFormat` scorer, and the strict UTF-8 head flag is set to true (the worker meta carries utf8 true, so no enc? badge appears for the binary fixture — the encoding badge is a text-quality signal, and rendered binary text comes from the decoder, not TextDecoder replacement).

### AC-1.2 Storage-header-less capture still classifies
- Given a file with no storage header whose first bytes form a plausible DLT v1 standard header (an HTYP typed-flags byte whose protocol-version bits equal 0b001 and whose five flag bits UEH 0x01, MSBF 0x02, ECU 0x04, SESS 0x08, and TMSP 0x10 form a consistent combination), whose declared total length read in the MSBF-given byte order is at least the minimum header size implied by HTYP and fits within `file.size`, whose chained look-ahead holds — the boundary at offset plus the declared length itself starts a plausible header (at least two consecutive plausible boundaries), or the first message decodes to a complete typed structure — and whose head is not scored at 0.5 confidence or higher for any text format by `detectFormat`, followed by a complete message
- When indexing starts
- Then the file classifies as `dlt-binary` with storage-header absence recorded, the record iterator starts at offset 0, every message decodes on correct boundaries, and a head that fails the chained look-ahead or trips the text veto is routed to the text path instead.

### AC-1.3 Text `dlt` and `dlt-binary` classifications stay mutually exclusive
- Given the 42-line `tests/fixtures/dlt-viewer-sample.txt` dlt-viewer text export, a binary capture starting with the DLT magic, and a plain-text logcat-style head of 16 KiB or more starting `09-11 22:14:01.100` (the shape whose first bytes pass the version-bit check verbatim with a large little-endian length)
- When each file is indexed
- Then the text export detects format `dlt` via `detectFormat` and never `dlt-binary`, the binary capture detects `dlt-binary` and never any text format, the logcat-style head detects a text format and never `dlt-binary`, and repeated loads of the same bytes never swap the classifications.

### AC-1.4 Sniff lives in paged.js; detect.js stays a pure text scorer
- Given the implementation after this SPEC
- When the classification behavior is observed through unit tests (a binary head is decided before any text sampling; text files still feed `detectFormat` exactly as today)
- Then the `dlt-binary` decision is a bounded magic-byte and header-plausibility check over the already-buffered head bytes inside `src/paged.js` in the style of the `is7z` check (`src/format-7z.js:34`), and `src/detect.js` contains no byte-level magic checks and keeps scoring text lines only.

### AC-1.5 Storage header is framing, not payload
- Given a binary capture whose messages each carry the 16-byte storage header (4-byte magic 44 4C 54 01, 4-byte ECU id, uint32 seconds since epoch, int32 microseconds)
- When messages are indexed and decoded
- Then the storage header contributes no payload text and no argument bytes to any rendered line, and only its timestamp is consumed (feeding the times column per AC-2.3).

### AC-1.6 DLTv2 storage-header version never classifies dlt-binary
- Given a capture whose first bytes are 44 4C 54 02 (ASCII "DLT" followed by the DLTv2 variable-length storage-header version byte 0x02)
- When `PagedLog.index` sniffs the file
- Then the file is never classified as format `dlt-binary` (the magic check is version-exact and rejects version 0x02 per the R1-5 non-goal), it routes to the text path with expected format `plain` instead of entering the binary decode path, and no decode error surfaces for the v2 capture.

## M2 — Indexing and record iteration (R2-1 … R2-7)

### AC-2.1 Header walk follows the HTYP flags exactly
- Given messages whose standard headers exercise each typed-flags combination — with and without the UEH, MSBF, ECU, SESS, and TMSP bits, hence with and without the 4-byte ECU id, a 4-byte session id, and the uint32 TMSP relative timestamp, and with and without the fixed 10-byte extended header carrying msin, the argument count, APID, and CTID
- When the record iterator walks the file
- Then each message boundary lands exactly on the next standard header (offsets advance by the total length read in the byte order given by the MSBF bit — big-endian for dlt-daemon captures that set MSBF, little-endian otherwise), optional fields are read only when their bits are set, the extended header decodes as the msin bit fields VERB 0x01, MSTP bits 1-3, and MTIN bits 4-7 followed by the mandatory argument-count byte, APID, and CTID, and the extended header is read only when UEH is set.

### AC-2.2 Offsets point at message starts
- Given a binary capture with messages at known byte offsets
- When indexing completes
- Then `this.offsets` holds each message's START byte offset in index order (the storage-header offset for records preceded by a storage header, offset 0 for the first record when there is none), no offset points into the middle of a message, and slicing at consecutive offsets reproduces exactly those records.

### AC-2.3 Header timestamps land in the times column
- Given messages carrying storage-header timestamps (uint32 seconds since epoch plus int32 microseconds), and separately messages whose only timestamp is the TMSP standard-header relative counter
- When indexing completes
- Then `this.times` holds the normalized numeric values pushed via `timeKey` for the storage-header timestamps, `PagedLog.metadata` decodes them, `sortIds` orders them chronologically, and the time-range filter behaves exactly as it does for text formats, while TMSP-only messages never contribute a `times` value of their own and instead follow the AC-2.4 carry-forward.

### AC-2.4 Timestamp-less messages follow continuation semantics
- Given a message carrying no timestamp in either header, positioned after a message that has one
- When indexing and rendering complete
- Then the record follows the existing carry-forward behavior of `add()` (`src/paged.js:66-68`): `this.times` receives the predecessor's time key rather than a null or zero key, bit 128 in `this.levels` records the null-timestamp state for `metadata()` (`src/paged.js:82-84`), and the record attaches to the preceding parsed line's context as text records do today under ADR-0004.

### AC-2.5 Binary indexing stays cooperative and cancellable
- Given a large binary capture and the `onProgress` and `cancelled` parameters of `index(onProgress, cancelled, sampleLimit)`
- When indexing runs
- Then the record iterator yields cooperatively under the same 8 ms deadline plus `pause()` contract as `byteLines`, a `cancelled` callback returning true stops indexing without throwing, and progress is reported through `onProgress`.

### AC-2.6 Analysis sample keeps the text shape
- Given a binary capture indexed with the default `sampleLimit`
- When indexing completes
- Then the returned head+tail analysis sample array has the same shape the text path returns, its entries are decoded message lines (never raw binary), and `issues.js` consumes it without any format-specific handling.

### AC-2.7 Decoder is registered in the worker bundle correctly
- Given the new pure decoder module (for example `src/decode-dlt.js`) listed in `build.js` WORKER_ORDER ahead of the `paged.js` entry
- When `node build.js` builds and `tests/scaffold.test.js` runs
- Then the bundle assertion passes (every non-glue src module appears in MODULE_ORDER union WORKER_ORDER and every listed name exists on disk), bundle order keeps `util.js` first and the decoder before its consumer, the paging-worker bundle still runs standalone from a Blob URL with no UI glue, and the single-file HTML remains self-contained.

## M3 — Page decoding and rendering (R3-1 … R3-6)

### AC-3.1 Per-page decode touches only the page's slice
- Given an indexed binary capture with more than 256 messages
- When `PagedLog.page` serves 256-row blocks and `PagedLog.get` serves single records
- Then each page reads one `file.slice` spanning `this.offsets.get(first)` through the last offset of that page and re-decodes only those messages (the whole file is never decoded or held in memory), binary pages replace CR/LF stripping with per-message decode, the 16-entry / 8 MiB page cache bounds still apply, and the shared `decodeMessage(bytes)` caller contract holds: page windows start at the record's stored offset (per AC-2.2: the storage-header position on storage-header captures, else the standard header), a leading storage header is skipped only when the window begins with the 44 4C 54 01 magic (the index-time case on storage-header captures), and all reads are bounded by the declared total length so the trailing next-record storage header inside the window is ignored as framing.

### AC-3.2 One rendered line per message through the normal record shape
- Given decoded binary messages
- When records are built by `PagedLog.record`
- Then each message renders to exactly one text line and every record exposes the normal shape (`fileId`, `file`, `lineNo`, `seq`, `raw`, plus parsed `ts`, `level`, `tag`, `pid`, `msg`), so `PagedLog.get`, `metadata`, filters, search, masking, quick scan, the drawer, and export operate with no format-specific branches.

### AC-3.3 Header timestamps normalize to the year-less model
- Given a message whose header timestamp is seconds and microseconds since epoch
- When the record renders
- Then `ts` is the year-less UTC-naive MM-DD HH:MM:SS.mmm text produced through the existing `timeText` round-trip, microseconds supply the sub-second field, no year appears anywhere in the rendered line, and lexicographic order equals chronological order across the capture per ADR-0004.

### AC-3.4 Level nibble maps onto F/E/W/I/D/V
- Given messages whose MTIN log-level nibbles take each DLT level value
- When the records render
- Then each nibble maps to the shared severity vocabulary — fatal F, error E, warn W, info I, debug D, verbose V — with the same level letters, chips, and colors the `dlt` text parser produces for its subtype strings, and level-chip filtering treats binary records identically.

### AC-3.5 Non-log MSTP types keep the text-path keywords
- Given messages whose MSTP bits identify APP_TRACE, NW_TRACE, CONTROL, or EXTENSION (MSTP values 1 through 4), and separately a message whose MSTP value is a reserved value 5 through 7
- When the records render
- Then each line carries the same stable keyword prefix the `dlt` text path uses (app_trace, nw_trace, control, extension — the text path's `RE_DLT` at `src/detect.js:17` already renders extension lines), the reserved value renders the deterministic literal prefix `mstp=N` with no hallucinated fields, and every 3-bit MSTP value therefore has exactly one pinned rendering, so issue patterns, chips, and drawer fields stay uniform across both DLT ingest paths.

### AC-3.6 The analysis sample sees the rendered text
- Given `sampleLimit` rows collected while indexing a binary capture
- When the sample feeds `issues.js` patterns, masking, and quick scan
- Then the sample lines are the decoded rendered lines (the same text a page would show), so masks and quick scan match binary records exactly as they match `dlt` text records.

## M4 — Argument decoding (R4-1 … R4-6)

### AC-4.1 Verbose typed arguments render space-separated
- Given a verbose message (UEH set, verbose flag set) whose payload is a sequence of typed arguments — a 32-bit unsigned integer, a float32, a UTF-8 string, and a raw argument, each headed by its 32-bit type info word with its TLEN length honored
- When the record renders
- Then the arguments decode to their natural values (the exact integer, the float32 value, the decoded string, and the raw bytes) and render space-separated into one dlt-viewer-like text line carrying the ecu:appid:ctid fields and the shared level vocabulary.

### AC-4.2 Full type set decodes exactly, BigInt integers included
- Given arguments of every supported type: boolean, signed and unsigned integers of 8, 16, 32, 64, and 128 bits, float16, float32, float64, ASCII and UTF-8 strings, and raw
- When each argument decodes
- Then every value renders exactly — 64- and 128-bit integers above 2^53 (for example 2^63 plus 1) round-trip through BigInt without Float64 precision loss, and float16 half-precision values decode to their exact float64 equivalents.

### AC-4.3 String encodings: UTF-8 with placeholder, ASCII one byte per char
- Given one string argument whose encoding bits select UTF-8 containing multi-byte characters and one deliberately invalid byte sequence, and another string argument whose bits select ASCII
- When the arguments decode
- Then the UTF-8 argument decodes through a UTF-8 decoder with each invalid byte rendered as a lowercase two-digit `\xNN` hex escape — the pinned visible lossless placeholder, so the test asserts a concrete expected value and filter and search behavior over the placeholder is predictable — and the ASCII argument decodes one byte per character.

### AC-4.4 Argument reads stop at the message boundary
- Given a verbose message whose final argument declares a TLEN that would read past the message's declared total length
- When the decoder reaches that argument
- Then the read is bounded by the message length and remaining payload, the invalid argument triggers the M5 handling (hex dump of the remaining payload plus one warning), and no byte of the next message is consumed by this message's decode.

### AC-4.5 No FIBEX dictionary means hex dump; dictionary stays optional
- Given a non-verbose message whose APID and CTID are not covered by any loaded FIBEX signal dictionary (the baseline: this SPEC ships no dictionary)
- When the message renders
- Then the payload renders as the hex dump line per AC-E.4 and no dictionary lookup is attempted; WHERE a dictionary covering the APID and CTID exists, the system may instead render dictionary signal interpretations, and only then.

## M5 — Resilience and diagnostics (R5-1 … R5-6)

### AC-5.1 Truncated final message does not abort indexing
- Given a binary capture whose final message is cut off at end of file (a valid leading portion followed by fewer bytes than the declared total length)
- When indexing completes
- Then the leading valid portion is decoded as a partial record, exactly one warning is counted, the index finishes normally, and all preceding messages are intact.

### AC-5.2 Implausible length framing resynchronizes
- Given a message whose length framing is implausible — a total length below the minimum header size implied by HTYP, or one overshooting `file.size`
- When the iterator hits that boundary
- Then it resynchronizes by scanning forward to the next plausible storage-header magic or plausible standard header, counts the desynchronization as a warning, and continues indexing from the recovered boundary with subsequent messages decoding intact.

### AC-5.3 Invalid argument decoding degrades to hex dump
- Given a verbose message whose payload contains an argument with an invalid type info or an invalid TLEN
- When the decoder reaches that argument
- Then the remaining payload of that message renders as a hex dump, exactly one warning is counted, and every subsequent message decodes untouched.

### AC-5.4 Resync failure fails loudly
- Given a file classified as `dlt-binary` where resynchronization cannot find any plausible next boundary within the remaining bytes
- When indexing reaches that point
- Then the system fails with a descriptive error naming the byte offset and the number of records indexed so far, instead of silently producing a partial or empty index.

### AC-5.5 Lossy decoding is surfaced
- Given a `dlt-binary` index that completed with one or more resynchronization or decode warnings
- When the status bar and metadata surfaces render
- Then the warning count is visible through the existing status/metadata surfaces, so users can see that decoding was lossy.

### AC-5.6 Decoding is deterministic
- Given the same binary bytes indexed twice, and pages re-decoded after scrolling away and back
- When the results are compared
- Then record offsets, rendered lines, and warning counts are identical across every index and page re-decode.

## Edge-Case Scenarios (cross-cutting)

### AC-E.1 Message stream without storage headers, end to end
- Given a storage-header-less capture (plausible standard header at offset 0) with several valid messages
- When the file is indexed, paged, and inspected in the drawer
- Then offsets start at 0, rendered lines equal the payload text of the equivalent storage-header capture, the format badge shows the `dlt-binary` family, and no storage-header bytes leak into any rendered line.

### AC-E.2 Mid-file corruption plus truncated tail in one file
- Given a capture containing one mid-file message with an implausible length field AND a final message truncated at end of file
- When indexing completes
- Then records before the corruption are intact, resynchronization recovers at the next plausible boundary, the truncated tail decodes as one partial record, the warning count reflects both problems (resync plus truncation), and the loud-failure threshold of AC-5.4 is not reached.

### AC-E.3 Resync skips only the damaged span
- Given two valid messages separated by a run of garbage bytes that contains no plausible header
- When indexing runs
- Then the desynchronization warning is counted once, the recovered boundary lands exactly on the second valid message, no garbage bytes appear in any rendered line, and the second message's fields decode correctly.

### AC-E.4 Non-verbose payload renders as a hex dump, never skipped
- Given a non-verbose message (verbose flag clear, no FIBEX dictionary)
- When the record renders
- Then the payload renders as a hex dump line with a stable prefix showing every captured byte in order, the record still appears in the total and shown counts, and filter, search, and export can match and retrieve bytes from that line — the message is never dropped or skipped.

### AC-E.5 Control and non-log MSTP messages render with keywords
- Given messages whose MSTP bits identify CONTROL, APP_TRACE, NW_TRACE, and EXTENSION (including a control message with no APID or CTID), and a message with a reserved MSTP value
- When the records render
- Then each renders with the matching keyword prefix (control, app_trace, nw_trace, extension), the reserved value renders the deterministic `mstp=N` literal, a control message lacking extended-header fields still renders one well-formed line with the available fields, and search for the keyword finds all of them.

### AC-E.6 Empty or header-only file
- Given a zero-byte file, separately a file consisting only of the 16-byte storage header, and separately a pinned byte-built fixture consisting only of a standard header whose declared total length exactly equals its own header size (a self-consistent lone header leaving zero payload bytes)
- When each file is dropped
- Then indexing completes cleanly with zero records and no error (a header with no following message is a clean empty capture, not a resync failure; the lone self-consistent header completes as framing, and an empty message is not a record — the partial-record rule of AC-5.1 applies only when at least the header itself is complete and never converts a header-only tail into a record or a warning), the status shows zero shown without crashing, and the loud-failure path of AC-5.4 is reserved for files where a desync actually stalls.

### AC-E.7 Mixed dlt-binary and text files loaded together
- Given a drop containing a binary .dlt capture together with text files (for example `service.log` and `dlt-viewer-sample.txt`)
- When all files index
- Then each file classifies independently (dlt-binary, its own text format, dlt respectively), records from all files interleave correctly in the merged time sort via their `timeKey` values, filters and search span binary and text records with no format branches, and no text file's detection changes because a binary file is present.

### AC-E.8 Format flows through filter, search, mask, and export unchanged
- Given an indexed binary capture whose records use the normal record shape
- When the user applies level chips, an exclude rule, a full search, a mask rule (for example a VIN-like pattern), quick scan, and then exports
- Then every feature computes over the rendered lines exactly as it does for text records, the export contains the same rendered lines with masking applied, worker-side scans (full search, quick scan, non-highlight filter rules, and the export archive scan) resolve their matches in the decoded record index space — never over raw byte-lines (the format-agnostic iterator of AC-3.2) — and no code path outside indexing, paging, and decoding branches on the `dlt-binary` format id.

### AC-E.9 Mixed storage-header and headerless messages in one capture
- Given a byte-built capture that alternates storage-header-prefixed messages and storage-header-less messages within one file (both shapes in the same stream, not one per file)
- When the capture is indexed and paged
- Then each record's offset lands on that record's message start — the storage-header position when the record carries one, else the standard-header position (the 16-byte storage header, where present, is framing that precedes its record's offset and is never an offset itself, per AC-1.5), storage-header timestamps apply only to the records that carry them while the others carry forward per AC-2.4, no magic, ECU id, or timestamp bytes leak into any rendered line, and no spurious resynchronization warnings fire despite the record shape changing between adjacent records — per-record shape tolerance per the R1-5 advisory-flag clause, not an always-or-never per-file skip.

## Performance and Quality Gates

- Coverage gate: the new decoder module is gated at 90 percent line / 85 percent branch by `tools/coverage-gate.mjs`; a gated module with no coverage row is a hard gate failure, and the gate must pass with the new module included.
- Bounded memory: indexing and paging must never hold the whole binary file in memory — indexing streams via the record iterator with cooperative yields, and each 256-row page decodes only its own slice; the blocked `Column` storage, 256-row pages, and the 16-entry / 8 MiB page cache bounds remain unchanged (AC-2.5, AC-3.1).
- No regression: the existing `dlt` text behavior (detection, parsing, chips, masking) and the `tests/fixtures/dlt-viewer-sample.txt` e2e assertions must pass unchanged, as must all existing unit and e2e suites.
- Determinism: identical bytes must produce identical offsets, lines, and warning counts on every index and page re-decode (AC-5.6).

## Success Criteria

- All EARS requirements R1-1 through R5-6 are implemented and covered by at least one scenario above.
- Detection is exclusive and layered correctly: a dlt-viewer text export always detects `dlt`, a binary capture always detects `dlt-binary`, and `src/detect.js` stays a pure text-line scorer (AC-1.1 through AC-1.4).
- Binary records are indistinguishable consumers of the record shape: filter, search, masking, quick scan, drawer, and export run without format-specific branches (AC-3.2, AC-E.8).
- Data is never lost silently: non-verbose payloads render as hex dumps with every byte visible (AC-E.4), truncation and desync degrade gracefully with surfaced warning counts (AC-5.1, AC-5.2, AC-5.5), and unrecoverable input fails loudly with offset and record-count context (AC-5.4).
- Timestamps and levels land in the shared model: year-less MM-DD HH:MM:SS.mmm ordering per ADR-0004 (AC-3.3) and the F/E/W/I/D/V vocabulary (AC-3.4), so all existing time and level features work unchanged.
- Integer decoding is exact at 64 and 128 bits via BigInt, with no Float64 precision loss (AC-4.2).
- The bounded-memory model is preserved end to end (Performance and Quality Gates above), and the single-file build invariant holds with the decoder in WORKER_ORDER (AC-2.7).

## Validation Method

- `npm run test:gate` — the node --test suites plus the coverage gate (90 line / 85 branch, Node 22). Validates: header walking and flag handling (AC-2.1), offsets at message starts (AC-2.2), the storage header treated as framing rather than payload (AC-1.5, plan.md Framing unit test), times-column population and metadata decode (AC-2.3, plan.md Timestamps unit test), carry-forward of timestamp-less messages (AC-2.4, same test), cancellation and progress callbacks (AC-2.5, plan.md Paged integration Blob tests), analysis-sample shape equality (AC-2.6, the same Blob tests), the no-FIBEX hex-dump baseline (AC-4.5, the WHERE-absent branch of the AC-E.4 hex-dump test), typed-argument decoding including BigInt exactness (AC-4.1, AC-4.2), string encodings (AC-4.3), argument bounding (AC-4.4), hex dump rendering (AC-E.4), truncation, resync, loud failure, determinism (AC-5.1 through AC-5.6), the storage-header-less capture indexed and paged end to end with a drawer-field assertion (AC-E.1), and zero-byte plus header-only Blob cases returning zero records cleanly (AC-E.6) — those last two as Blob-based unit tests in the extended `tests/paged.test.js` so they do not depend on the e2e scenario — plus binary indexing/paging via `new Blob([uint8array])` in the same file (AC-1.1, AC-1.2, AC-3.1, AC-3.2) and a mixed-file Blob test asserting per-file classification and merged `timeKey` sort (AC-E.7), and a byte-built Blob capture alternating storage-header-prefixed and storage-header-less messages within one file, asserting each offset lands on that record's message start (the storage-header offset where present, else the standard header, per the AC-2.2 offsets contract), storage-header timestamps applied only where present with carry-forward for the others, no leaked magic, ECU, or timestamp bytes in any rendered line, and no spurious resynchronization warnings (AC-E.9). Also in this layer: a byte-built Blob case combining one mid-file implausible framing and a truncated tail whose warning count equals exactly 2 (AC-E.2's combined warning count); search and quick-scan hit assertions over a binary capture resolving to decoded records in the correct index space, never byte-lines (AC-3.2, AC-E.8's index-space half); the worker meta carrying utf8 true for the binary fixture (AC-1.1's no-enc? half); the sniff-matrix negative case of a 16 KiB or larger logcat-style head never classifying `dlt-binary` (AC-1.3); the sniff-matrix negative case of a file whose first bytes are 44 4C 54 02 (DLTv2 storage-header version) never classifying `dlt-binary` and routing to the text path as plain without a decode error (AC-1.6); and the self-consistent lone-header Blob case returning zero records (AC-E.6). The gate result itself validates the coverage threshold criterion.
- `tests/core-cases.js` (shared case suite, ADR-0005) — new `dlt-binary` detect/ts/parse/mask cases land here first and run in both `node --test` and the in-page ?selftest runner; validates detection exclusivity with text `dlt`, the logcat-style head misclassification guard, and the DLTv2 negative classification case where a 44 4C 54 02 head never classifies `dlt-binary` (AC-1.3, AC-1.6), the ts-group additions for timestamp normalization and carry-forward (AC-2.3, AC-2.4, AC-3.3), level and MSTP keyword mapping including extension and the reserved-value literal (AC-3.4, AC-3.5), and masking over rendered binary lines (AC-3.6).
- `tests/scaffold.test.js` — the bundle assertion validates WORKER_ORDER registration and module existence (AC-2.7) and, together with source inspection plus the AC-1.1 and AC-1.3 unit cases, validates AC-1.4's structural half: the sniff lives in `src/paged.js` and `src/detect.js` stays a pure text scorer.
- `node build.js` — build succeeds with the decoder listed before `paged.js`; validates the single-file HTML invariant and worker-bundle standalone property (AC-2.7).
- `npm run e2e` — Playwright run including a mandatory binary .dlt drop scenario loading a hex-encoded binary fixture via `page.setInputFiles` with `join(root, 'tests', 'fixtures', ...)`: badge `dlt-binary`, total count, level chips, drawer fields, hex-dump row visibility, and warning surfacing (AC-E.1, AC-E.4, AC-E.5, AC-E.6, AC-5.5). The scenario additionally carries AC-E.8 end to end: after the binary-drop assertions, apply a level chip, apply a full search term matching a hex-dump row, apply a mask rule, then open the Export tab and assert the downloaded text equals the rendered binary lines with masking applied, mirroring the existing export assertions in the range `tests/e2e/app.e2e.spec.mjs:377-502`. The existing dlt-viewer text export spec at `tests/e2e/app.e2e.spec.mjs:2286` must stay green (no-regression criterion), and the mixed-file drop scenario (AC-E.7) can be covered here in addition to its Blob-based unit mapping above.
- Manual spot-check — drop a real-world binary .dlt capture (with and without storage header) beyond the committed fixtures and byte-built test cases, and verify rendered lines, hex dumps, warning counts, and the filter/search round-trip (AC-E.2, AC-E.3). AC-E.8 is no longer in scope here: its filter, search, mask, quick-scan, and export flow is asserted automatically by the e2e scenario above and the Blob-based index-space unit tests.
