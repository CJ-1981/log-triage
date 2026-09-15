# Large-log usability review

Reviewed the current source and built HTML on 2026-09-15. This is a review; application code has not been changed.

## Evidence

- Supplied file: 92,255,032 bytes (88.0 MiB), 555,930 lines. Inspected locally using streaming reads; no customer log content is included here.
- Default cap retains 105,930 lines and releases the earlier 450,000. The quoted temperature entry is line 450,002, immediately after the retained window begins.
- Longest line: 745,579 characters, at line 555,930.
- Chromium, 1440 by 900 viewport, default masking enabled: ingestion plus initial view and cache completed in approximately 1.0 seconds; enabling Wrap blocked its click handler for 6,698 ms. Clearing the quick filter while wrapped produced an approximately 6,337 ms event-loop gap. A VHalProperty filter produced an approximately 805 ms gap. These are single-run measurements, not cross-machine performance guarantees.
- Progress text was empty during wrap and filter work.
- Chromium exposed the original long-path input as a zero-byte File in this automation environment. Runtime measurements therefore used an identical short-path temporary copy, deleted after testing. This is a test limitation, not evidence that the user's original load failed.
- The reported log text in the footer was not reproduced. The offscreen measurement element remained hidden. The quoted line's position explains its proximity to the start of the retained viewer, but does not prove the cause of its reported placement.

## Findings, in priority order

### P1: Wrapping defeats virtualization by measuring every retained row

Location: `src/app.js:450–474`, called by `renderRows`, `rebuildView`, `setWrap`, and resize handling.

`measureWrap()` writes each record into a live DOM element and immediately reads `offsetHeight`. This forces layout for every row, and also masks every retained record through `displayText()`. The visible viewer has bounded row nodes, but its geometry calculation is still proportional to the entire retained dataset. Filter changes invalidate all these heights and the display cache, repeating the work. This directly reproduces the multi-second freeze.

Recommendation: maintain estimated row heights and measure only visible rows plus overscan, incrementally updating the height index and preserving the scroll anchor. Bound the display work for extremely long lines, with access to full text on demand. Do not perform a full DOM measurement pass when filtering or resizing.

### P1: Ordinary filters cannot operate on the full loaded file

Location: `src/store.js:77–97`; `src/app.js:345–369`, `src/app.js:139–145`.

`Store.add()` permanently drops filtered-out records and trims old kept records. `rebuildView()` only filters `store.kept`; it does not reread source data. Thus clearing an ingest-time filter cannot recover excluded records, and applying a new filter after an unfiltered load cannot find earlier trimmed records. On this sample, about 81% of lines are outside ordinary filtering and viewing. Deep scan rereads the source, but its results outside the cap only open a text drawer rather than a navigable source window (`src/app.js:1551–1564`).

This behavior is documented and intentionally tested, but does not satisfy full-file interactive filtering/viewing at multi-GB scale.

Recommendation: retain a sparse byte-offset line index backed by the source File and page source windows on demand. Run full-file filtering in a worker, storing compact match references rather than every raw record. Treat the in-memory cap as a page-cache limit, not the scope of the user's query.

### P1: Busy state ends before expensive rendering and is absent for filtering

Location: `src/app.js:173`, `src/app.js:221–227`, `src/app.js:345–377`, `src/app.js:1593–1599`, `src/app.js:1902–1911`.

Ingestion clears `st-progress` before `onKeptChanged()` performs filtering, sorting, index rebuilding, chip updates, and wrapping. Filter and wrap handlers do not establish a busy state or yield during their expensive work. The 200 ms quick-filter debounce postpones the blocking work; it does not make the work interruptible. Adding a spinner alone would still leave its animation frozen on the same thread.

Recommendation: give operations a lifecycle covering reading, filtering, and rendering. Show status before work begins; move scans to a worker or process bounded batches that yield. Support cancellation and discard stale results when the query changes. Clear busy state only after the current result has committed, using operation IDs and `finally` for cleanup.

### P2: Mask changes leave wrapped-row geometry stale

Location: `src/app.js:1586–1591`, `src/app.js:439–447`, `src/app.js:477–488`.

`setMask()` clears text caching and rerenders, but does not invalidate wrapped heights. Masking can shorten a long row substantially. Rendered text then uses different heights from the prefix sums driving scroll offsets, window selection, and jumps. This can cause gaps, incorrect positioning, or inaccessible rows after switching masking while Wrap is on. This is a code-level finding; it is not established as the cause of the reported footer symptom.

Recommendation: invalidate or update geometry whenever displayed text changes. With incremental measurement, remeasure affected visible rows and preserve the scroll anchor.

### P2: Stress tests permit the reported unusable behavior

Location: `tests/e2e/stress.e2e.spec.mjs`, particularly the wrap and rapid-chip tests.

The fixture is approximately 30 MB of short synthetic lines. The wrap assertion accepts up to 15 seconds, so the reproduced 6.7-second freeze passes. The rapid-chip test reloads a 44-line demo, rather than exercising the large fixture. There are no assertions for busy feedback, input responsiveness during filtering, or a hundreds-of-thousands-character row.

Recommendation: test realistic large and long-line fixtures; observe event-loop or animation-frame gaps during load, filter, wrap, resize, and mask changes. Assert busy feedback during active work, latest-query-wins behavior, and navigation across the entire source. Set explicit responsiveness targets separately from total scan throughput.

## Suggested implementation order

1. Replace eager wrap measurement and fix mask-related geometry invalidation.
2. Add operation-wide progress, cancellation, and stale-result protection with worker or time-sliced execution.
3. Introduce source-backed indexing and paging for full-file filtering and navigation.
4. Strengthen responsiveness tests before claiming multi-GB interactive support.

Reproduction helper: `tests/tmp/review-perf.cjs` accepts the source log path as its sole argument. It streams file statistics, uses a temporary short-path copy for Chromium, and prints timings and non-content diagnostics. No application fixes or broad regression-suite run were performed as part of this review.
