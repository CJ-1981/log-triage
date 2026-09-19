# Full-code review fixes: implementation plan and developer guide

> **For agentic workers:** Use `superpowers:executing-plans` to implement this plan task by task, or `superpowers:subagent-driven-development` if the user chooses delegation. Checkboxes track implementation, not preparation of this document.

**Goal:** Resolve the seven findings from the full-code review without limiting the viewer's access to loaded logs.

**Architecture:** Keep full log records in the paging worker and request bounded batches. Separate export serialization from its destination, apply a global budget to analysis samples, and keep temporary navigation state separate from saved configuration. Preserve the existing UMD modules and single-file distribution.

**Tech stack:** Browser JavaScript, Web Workers, File/Blob, optional File System Access API, Node tests, Playwright, existing build script.

**Spec:** The design contract and UI examples in this document are the proposed specification; background is in `../../architecture.md` and `../../requirements.md`.

**Baseline:** `main` at `2576d06`, v1.40.1. PR #27 already masks CSV/JSON message text and carries file IDs through search navigation. Do not reimplement those fixes. Its export implementation still accumulates and joins all output strings. The latest review ran 70 browser/stress tests successfully; the earlier baseline also passed 283 unit tests. Passing existing tests does not cover the failures below.

## Global constraints

- Viewer paging and filtering must cover the complete indexed files; analysis and download fallback limits must never truncate viewer data.
- Keep the distributable as one locally usable HTML file. Do not add a server or send exports to a remote service.
- Preserve masking settings and enabled filter/highlighter rules across navigation and reload.
- Export success means the destination has closed successfully. Cancellation and write failure must never report success.
- Examples below are implementation sketches or focused tests, not an applied patch. New interfaces are explicitly identified.
- Existing source modules are UMD/CommonJS compatible. Add new core modules to `build.js`, `_src.js` where applicable, and tests; add worker-required modules to `WORKER_ORDER` as well.
- Run on the project's Node 22 CI baseline and test the built HTML. Do not hand-edit `log-triage.html`.

## Design contract and UI guide

### Export destination and lifecycle

Use an awaited writable file stream for large TXT/CSV/JSON exports when `showSaveFilePicker` is available. Invoke the picker directly from the export click handler, before worker requests, to retain user activation. Feature-detect it; do not assume every browser or `file://` environment supports it.

Offer a bounded download fallback when no writable-file API is available. Proposed limit: **32 MiB encoded output**. Accumulate `Uint8Array` chunks up to that budget and construct a Blob directly from chunks; never join the entire output. Reject before retaining a chunk that would exceed the budget. This fallback limit is explicit and affects only exports, never loaded/viewable lines. A writable destination must not share this fallback limit.

Snapshot the export scope, selection, masking policy and format when Export is clicked. Navigation, filtering, removal and ingestion must not silently change a running export. Initial implementation: lock those mutating UI actions and their keyboard handlers during export; also capture a worker query revision and reject stale page requests. The latter protects against asynchronous queries already in flight. Release locks in `finally`.

```text
Export
Scope: All 2,450,123 matching lines     Format: CSV
Mask personal data: On
[Export…]

Exporting 180,000 / 2,450,123 lines · 38.2 MiB written   [Cancel]
Export complete · 2,450,123 lines · 512 MiB written

Selection only · 0 lines
[Export… disabled]  Select one or more viewer rows to export.

Download limit reached. Use a browser with direct file saving,
or narrow the export with filters. No download was created.
```

Use a polite `aria-live` status region. Throttle progress updates to about 100 ms. Cancel sets an AbortController signal; the writer checks it between chunks and aborts the destination. A pending disk write may finish before cancellation takes effect. A cancelled save picker is normal cancellation, not an error banner. Describe partial-output behavior accurately for the chosen sink; never claim successful rollback on a sink that cannot guarantee it.

Archive exports need the same memory contract. The current ZIP/7z/tar writers build whole buffers. In the first fix, make their buffered size limit explicit and reject incrementally before joining/encoding an oversized archive. For uncapped archive exports, add a separate streaming TAR/TAR.GZ writer feeding the same sink; ZIP/7z remain bounded until they have streaming writers. Do not label the archive path “multi-GB streaming” merely because its input is paged. TAR headers require member sizes: use a first pass to count sanitized UTF-8 bytes and a second pass to write headers/data/padding, with the same frozen scope in both passes. TAR.GZ additionally pipes through `CompressionStream('gzip')` when available. Check archive format numeric limits and test readers before claiming support.

### Analysis sample

Proposed global ceilings: **100,000 records and 32 MiB of accounted strings**, whichever is reached first. Account `raw`, `msg`, and other retained strings as two bytes per UTF-16 code unit, plus a conservative fixed per-record allowance. This is an allocation budget, not a claim about exact browser heap consumption.

The worker must also bound its per-file sample before posting it to the UI. Otherwise one oversized sample can exhaust memory before the global store sees it. Preserve the head/tail sampling strategy within each file's allowance. Skip records too large for the sample budget without skipping their full-file index entries.

For a simple first implementation, evict oldest sampled records when admitting newer files. Keep an explicit per-file retained count and disclose files with no retained sample. Do not let the UI imply that an empty sample proves absence of issues. Full-file level totals remain exact; issue scans, instant search and histograms must say they use the sample.

```text
Analysis sample: 81,420 lines from 8 / 12 files · 31.8 MiB budget used
Some earlier samples were released. Viewer filters and Deep scan still cover all files.
```

### Navigation and rules

PageUp at the first page's top and PageDown at the final page's bottom are no-ops. Ctrl+Home and Ctrl+End still reach physical ends of the current result set. Preserve selection on a no-op.

For search/bookmark navigation, first change file scope and retry locate with the user's rules intact. Only if the record remains excluded, enter a **temporary focused view**. It bypasses membership filters for that file without editing their definitions or enabled flags. Highlighters continue to apply.

```text
Showing this line outside your current filters.   [Return to filtered view]
```

The return action restores the original file/merged scope and the previous logical anchor if it still matches, otherwise the closest valid page. Switching tabs alone does not discard the temporary view. A deliberate filter edit exits the temporary view and uses the edited saved filters. Temporary state is never written to localStorage or config export.

### Privacy and provider errors

Sanitize a cloned bookmark payload at export time. At minimum sanitize `meta.snippet` and user-entered `note`; explicitly audit other exported free-text metadata. Do not mutate stored notes. File identity keys are required for reimport and remain identity metadata; document that filenames/identity metadata are not anonymized by snippet masking.

For the configured Chat Completions-compatible LLM endpoint, read `choices[0].message.content` and parse findings from that content. Distinguish a valid empty findings array from malformed responses, refusal/absent content, HTTP errors and truncated/non-JSON output. Display an error for invalid responses, not “no findings.” Add each chunk's start offset when mapping findings back to input lines. Apply the same offset mapping to the existing Presidio adapter.

## Review focus

1. Filter/source changes already in flight when export starts: fail as stale, never mix datasets (Task 3).
2. A single enormous record: keep it accessible in the viewer while declining it for analysis sampling (Task 4).
3. Mask toggled or rules edited during an export: exported policy remains the initial snapshot (Tasks 2 and 3).
4. Empty results and exports spanning three batches: valid output, no lost rows, one CSV header and valid JSON separators (Task 3).
5. Navigation to another file when include/highlight rules are enabled: saved configuration stays unchanged (Task 6).

## File map and delivery order

| Task | Files | Result |
|---|---|---|
| 1 | `src/app.js`, `tests/e2e/app.e2e.spec.mjs` | Exact selection-only scope |
| 2 | `src/exporter.js`, `src/app.js`, `tests/exporter.test.js` | Sanitized bookmark snapshots |
| 3 | New `src/export-stream.js`, new `src/app-export.js`, `src/app.js`, `src/app-paging-worker.js`, `src/archive.js`, `template.html`, `build.js`, `src/_src.js`, `package.json`, export tests | Bounded export pipeline and destination UI |
| 4 | New `src/analysis-sample.js`, `src/paged.js`, `src/app-paging-worker.js`, `src/app.js`, build/test registration | Global and worker sample budgets |
| 5 | `src/app.js`, `tests/e2e/app.e2e.spec.mjs` | Correct boundary keyboard behavior |
| 6 | `src/app.js`, `template.html`, `src/themes.js`, browser tests | Temporary navigation bypass |
| 7 | `src/pii-remote.js`, `tests/pii-remote.test.js`, browser tests | Valid LLM response parsing and offsets |

Implement each task on a `codex/` branch, with its regression tests and generated bundle in the same reviewable change. Suggested PR order: 1+2, 3, 4, 5+6, 7. Tasks 3 and 4 require distinct reviews because their resource ownership is different. No dependency requires them to ship together.

## Task 1: Selection-only export

**Interface:** `iterExportBatches(selectionOnly)` remains an async generator; selected rows are snapshotted before awaiting anything. `selectionOnly=true` yields only selected rows, including zero rows.

- [ ] Add this regression to the existing Playwright suite; run `node --test --test-name-pattern="empty selection" tests/e2e/app.e2e.spec.mjs` and observe it fail before the fix.

```js
test('empty selection cannot export every row', async () => {
  await fresh();
  await click('btn-demo');
  await page.waitForFunction(() => document.getElementById('st-shown').textContent === '44');
  await page.locator('[data-tab="export"]').click();
  await page.locator('#exp-selection').check();
  await assert.doesNotReject(() => page.waitForFunction(
    () => document.getElementById('exp-txt').disabled));
  // Disabled UI is not the only guard: generator unit/integration coverage
  // must also assert zero batches for an empty selection-only request.
});
```

- [ ] Change the generator branch and synchronize export button state whenever selection, scope, or the checkbox changes.

```js
if (selectionOnly) {
  const selected = selection.indices().map(i => view[i]).filter(Boolean);
  if (selected.length) yield selected.map(maskRec);
  return;
}
```

- [ ] Test a two-row selection exports exactly two rows, then changing page clears selection and disables selection-only export. Verify all export entry points, including archive, share the guard.
- [ ] Build, rerun the focused test, and commit as `fix: enforce selection-only export scope`.

## Task 2: Bookmark privacy

**New pure interface:** `sanitizeBookmarkPayload(payload, maskText)` returns a cloned bookmark JSON object; keys and numeric identity fields remain unchanged. The caller supplies a masking function frozen from the initial settings, or identity when masking is off.

- [ ] Add a failing unit test in `tests/exporter.test.js`; register it in `package.json`'s explicit unit command.

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeBookmarkPayload } = require('../src/exporter.js');
test('bookmark export sanitizes snippets and notes without changing storage', () => {
  const source = { identity: [{ lineNo: 1, meta: { snippet: 'alice@example.com' }, note: 'alice@example.com' }] };
  const result = sanitizeBookmarkPayload(source, s => s.replaceAll('alice@example.com', '[EMAIL]'));
  assert.equal(result.identity[0].meta.snippet, '[EMAIL]');
  assert.equal(result.identity[0].note, '[EMAIL]');
  assert.equal(source.identity[0].meta.snippet, 'alice@example.com');
});
```

- [ ] Implement and export the helper from the existing UMD factory, then use it in the bookmarks export branch.

```js
function sanitizeBookmarkPayload(payload, maskText) {
  return Object.fromEntries(Object.entries(payload).map(([key, entries]) => [key,
    entries.map(entry => ({
      ...entry,
      meta: { ...entry.meta, snippet: maskText(String(entry.meta?.snippet || '')) },
      note: maskText(String(entry.note || '')),
    })),
  ]));
}
```

- [ ] Add browser coverage: Mask off → create bookmark → Mask on → export → raw email absent, masked token present; stored bookmark unchanged. Add Mask-off export and empty payload cases.
- [ ] Run `node --test tests/exporter.test.js`, build, run the bookmark browser tests, and commit as `fix: sanitize bookmark export snapshots`.

## Task 3: Streaming export and stable scope

**New interfaces:**

```js
// export-stream.js (pure, tested in Node):
// serializeExport(batches, {format, prefix}) -> AsyncIterable<Uint8Array>
// writeChunks(chunks, sink, {signal, onBytes}) -> Promise<number>
// sink: {write(Uint8Array): Promise<void>, close(): Promise<void>, abort(error): Promise<void>}
// app-export.js (browser glue):
// openExportSink({name, mime, fallbackBytes}) -> Promise<sink>
// File picker path yields a FileSystemWritableFileStream adapter.
// Fallback path yields a byte-limited Blob-parts adapter; close downloads.
```

- [ ] Add `tests/export-stream.test.js` for incremental output and a sink that asserts sequential writes. First test the missing interface fails. Register the module in bundle/test lists.

```js
test('writer waits for each sink write and closes once', async () => {
  let active = 0, closed = 0; const output = [];
  const sink = {
    async write(bytes) {
      assert.equal(++active, 1);
      await new Promise(resolve => setImmediate(resolve));
      output.push(...bytes); --active;
    },
    async close() { closed++; },
    async abort() { assert.fail('unexpected abort'); },
  };
  async function* input() { yield Uint8Array.of(65); yield Uint8Array.of(66); }
  assert.equal(await writeChunks(input(), sink, {}), 2);
  assert.deepEqual(output, [65, 66]); assert.equal(closed, 1);
});
```

- [ ] Implement the writer with awaited writes, completion only after close, and cleanup on all failures.

```js
async function writeChunks(chunks, sink, { signal, onBytes = () => {} } = {}) {
  let written = 0;
  try {
    for await (const bytes of chunks) {
      signal?.throwIfAborted();
      await sink.write(bytes);
      written += bytes.byteLength; onBytes(written);
    }
    signal?.throwIfAborted();
    await sink.close();
    return written;
  } catch (error) {
    try { await sink.abort(error); } catch { /* retain the original error */ }
    throw error;
  }
}
```

- [ ] Implement format serialization using the existing exporter projection. JSON should retain `message` and the documented fields from `LT.toJson`; avoid exposing all worker record internals. CSV needs exactly one header, including an empty export. TXT separators must span batch boundaries correctly. Emit bytes per record or bounded text chunk, never a whole-file string.

```js
// JSON branch inside serializeExport; batches already contain sanitized rows.
const encoder = new TextEncoder();
yield encoder.encode('[\n');
let first = true;
for await (const batch of batches) {
  for (const r of batch) {
    const row = { file: r.file, lineNo: r.lineNo, ts: r.ts, level: r.level,
      tag: r.tag, pid: r.pid, message: r.msg ?? r.raw };
    yield encoder.encode((first ? '' : ',\n') + JSON.stringify(row));
    first = false;
  }
}
yield encoder.encode('\n]');
```

- [ ] Add worker `orderRevision`, incrementing whenever a query replaces `order` or sources are removed. Return it in query responses; require `expectedRevision` on export page requests and reject mismatches both before and after awaiting record reads. Normal viewer page requests retain their current behavior. Capture masking and selection before the first await. Freeze mutation controls until export finishes.
- [ ] Implement the two destinations. On fallback write, check `bytesWritten + chunk.byteLength > 32 * 1024 * 1024` before pushing; abort clears chunks; close constructs `new Blob(chunks, {type: mime})`. On writable-file write, forward each chunk and await it. Never silently switch to fallback after the user cancels a picker.
- [ ] Apply the buffered archive guard described in the design contract. Count UTF-8 payload plus archive overhead conservatively before invoking existing whole-buffer builders; reject before large joins. Do not mask archive batches twice: they arrive already sanitized from `iterExportBatches`.
- [ ] Add tests for cancellation during a write, rejected write, rejected close, limit exceeded, policy snapshot, stale query revision, three batches and zero rows. Assert no success/download on failure. Test the writable path with a fake picker/sink in Playwright and the unsupported-browser fallback separately.
- [ ] Validate memory with a generated multi-GB stream into a counting/discard sink, plus a local real-file save. Unit tests may use the discard sink; record actual browser memory measurements separately. Verify maximum in-flight buffers rather than assuming `process.memoryUsage()` equals total browser memory. An individual huge record remains a separate known allocation risk; bound encoding chunks and document any remaining worker page allocation.
- [ ] Run `node --test tests/export-stream.test.js`, browser export tests, `npm run test:gate`, build, and commit as `fix: write exports incrementally with bounded fallback`.

## Task 4: Global analysis budget

**New interface:** `AnalysisSample({maxRecords, maxBytes})` exposes `add(records)`, `removeFile(fileId)`, `clear()`, `records()`, and `stats()` returning `{count, accountedBytes, byFile}`. Use a deque/ring or batched trimming rather than an `Array.shift()` per admitted record.

- [ ] Add `tests/analysis-sample.test.js` with the following behavior and observe failure before implementing.

```js
test('budget applies across files and oversized rows are skipped', () => {
  const sample = new AnalysisSample({ maxRecords: 2, maxBytes: 4096 });
  sample.add([{ fileId: 'a', raw: 'one' }, { fileId: 'b', raw: 'two' }, { fileId: 'c', raw: 'three' }]);
  assert.equal(sample.stats().count, 2);
  sample.add([{ fileId: 'd', raw: 'x'.repeat(10000) }]);
  assert.ok(sample.stats().accountedBytes <= 4096);
  assert.ok(!sample.records().some(r => r.fileId === 'd'));
});
```

- [ ] Use the following accounting policy consistently in the worker and UI. Count metadata strings as well as message text; counting duplicate strings twice is intentionally conservative.

```js
function sampleRecordBytes(record) {
  return 256 + Object.values(record).reduce(
    (bytes, value) => bytes + (typeof value === 'string' ? value.length * 2 : 0), 0);
}
// On add: skip if one record exceeds maxBytes; otherwise evict oldest
// records until both (count + 1 <= maxRecords) and
// (accountedBytes + sampleRecordBytes(record) <= maxBytes) hold.
```

- [ ] Replace direct `store.kept.push` in ingestion with the sample manager; keep `store.kept` as a compatibility snapshot initially. Update removal/clear and their counters explicitly: exact file totals and kept totals must not be decremented by sample eviction. Audit instant-search indexes and rebuild them after sample replacement.
- [ ] Pass sample byte limits to `PagedLog.index`; preserve bounded head/tail sampling and omit oversized rows from that sample only. A posted worker sample must itself fit the byte budget. Include retained counts in analysis UI and label sample-based sections.
- [ ] Add tests for many files, variable-length lines, head/tail sampling, file removal, reset, and a huge line retrievable through `PagedLog.get` despite its omission from the sample. Verify exact viewer totals remain unchanged.
- [ ] Run sample and paged tests, browser multi-file tests, build and commit as `fix: bound analysis samples across loaded files`.

## Task 5: Boundary keyboard paging

**Interface:** Existing `loadPage(start, bottom)` is unchanged; only call it when the requested keyboard movement is valid.

- [ ] Add a browser regression using a 600-line file: PageUp at first-page top preserves `scrollTop === 0`; PageDown at last-page bottom preserves its previous bottom offset; repeat each key twice. Confirm failure on the baseline.
- [ ] Implement explicit bounds, consuming keys at the boundary without reloading.

```js
if (e.key === 'PageUp' && viewer().scrollTop <= 0) {
  e.preventDefault();
  if (pageStart > 0) loadPage(pageStart - PAGE_SIZE, true);
}
if (e.key === 'PageDown' && viewer().scrollTop + viewer().clientHeight >= viewer().scrollHeight - 2) {
  e.preventDefault();
  if (pageStart + PAGE_SIZE < filteredCount) loadPage(pageStart + PAGE_SIZE);
}
```

- [ ] Retain separate Ctrl+Home/End branches. Test middle-page navigation, one page, zero rows, wrapped rows and selection preservation at a no-op boundary. Run `node --test --test-name-pattern="keyboard" tests/e2e/app.e2e.spec.mjs`.
- [ ] Build and commit as `fix: preserve position at keyboard page boundaries`.

## Task 6: Non-destructive navigation

**New state:** `let navigationOverride = null`, outside persisted `state`. Shape: `{fileId, returnScope, returnAnchor}`. `returnScope` includes original `viewMode` and `activeFile`; `returnAnchor` is `{fileId, lineNo}` or null.

- [ ] Add a browser regression that enables one include rule and one highlighter, navigates to a record excluded by the include rule, and compares persisted rules before/after. Also test a record from another file that already matches those rules.
- [ ] Factor query construction so bypass belongs to the query, not the saved configuration.

```js
function applyNavigationOverride(spec, override) {
  if (!override) return spec;
  return { ...spec, fileId: override.fileId,
    rules: spec.rules.filter(r => r.action === 'highlight'),
    quick: null, levels: [], timeFrom: '', timeTo: '', bookmarkOnly: false };
}
// rebuildView builds its ordinary spec, then passes the result of this
// function to the worker. compileHighlightRules still uses state.rules.
```

- [ ] In `jumpToRecord`, retry in the requested file scope first. If still excluded, snapshot return context, set the override, rebuild and locate again. Remove the code assigning every rule `enabled:false` and its associated save. Use the existing view/page tokens so a stale navigation result cannot override a newer user action.
- [ ] Add the accessible banner and Return action. Clear overrides when the target file is removed; return to a valid scope. Filter edits intentionally clear the override. Keep display labels and active-file highlighting synchronized with effective query scope.
- [ ] Test saved rules byte-for-byte unchanged after entry, return, tab switch and reload; verify highlighters remain visible. Test return anchor removed/filtered out, rapid double navigation, and target-file removal. Run relevant browser tests and build.
- [ ] Commit as `fix: preserve filters during focused record navigation`.

## Task 7: LLM response parsing

**New pure interface:** `parseChatCompletionFindings(body)` returns validated content-relative findings or throws a descriptive error. A valid `[]` returns `[]`; malformed envelope/content must throw. Keep HTTP errors handled in the adapter.

- [ ] Add a test using the real envelope shape; it must fail against the current analyzer.

```js
test('LLM analyzer reads assistant content', async () => {
  const fetchImpl = async () => ({ ok: true, text: async () => JSON.stringify({
    choices: [{ message: { content: '[{"line":0,"start":0,"end":3,"type":"EMAIL"}]' } }],
  }) });
  const analyzer = createRemoteAnalyzer('llm', { url: 'https://example.invalid' }, { fetchImpl });
  assert.equal((await analyzer.analyze(['abc']))[0].type, 'EMAIL');
});
```

- [ ] Parse the envelope before findings. Change `parseLlmContent` or add a strict sibling so malformed content is distinguishable from an empty array.

```js
function parseChatCompletionFindings(body) {
  const response = JSON.parse(body);
  const content = response.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('LLM response has no assistant text');
  const text = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const findings = JSON.parse(text);
  if (!Array.isArray(findings)) throw new Error('LLM response must contain a findings array');
  for (const f of findings) {
    if (!f || !Number.isInteger(f.line) || !Number.isInteger(f.start) ||
        !Number.isInteger(f.end) || f.line < 0 || f.start < 0 ||
        f.end <= f.start || typeof f.type !== 'string') {
      throw new Error('LLM response contains an invalid finding');
    }
  }
  return findings;
}
```

- [ ] In `createRemoteAnalyzer`, validate each finding against `chunk.lines` before adding `chunk.startLine`. Reject out-of-range line indexes/offsets; define offsets as JavaScript UTF-16 positions in the prompt. Apply chunk offsets in the Presidio branch too, without changing its response schema in this task.
- [ ] Test fenced JSON, empty arrays, malformed JSON, missing content, HTTP failure, out-of-range findings, non-ASCII lines and two chunks. Confirm the second chunk maps to its original input line. Add a browser stub test that distinguishes “no findings” from “scan failed.”
- [ ] Run `node --test tests/pii-remote.test.js`, build and commit as `fix: parse LLM findings from assistant responses`.

## Release checklist

- [ ] Run `npm test`, `npm run test:gate`, `npm run build`, and `npm run e2e` after registering new modules/tests. Record real results rather than copying the baseline counts.
- [ ] Verify the generated HTML diff contains the source changes; check `?selftest` and locally opened HTML.
- [ ] Confirm no full-output string join or unbounded record accumulation remains in a path described as streaming.
- [ ] Confirm no saved filter/highlighter state changes during navigation; config round-trip remains intact.
- [ ] Update `docs/architecture.md`, `docs/requirements.md`, `docs/test-plan.md`, README and changelog with the new export capability matrix, fallback limit and global sample policy. Do not claim uncapped ZIP/7z until their writers support it.
- [ ] Review each PR's code and test evidence before merging. This document authorizes planning only; implementation and publication are separate steps.

## Planning self-review

All seven findings map to a numbered task. The export task includes source stability, cancellation and unsupported-browser behavior; the sampling task covers both worker transfer and UI retention. Code examples use the declared interfaces. The numerical budgets and eviction policy are proposed design defaults and should be reviewed before implementation. No application code was modified to create this guide.
