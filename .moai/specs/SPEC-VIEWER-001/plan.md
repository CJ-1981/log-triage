# SPEC-VIEWER-001 Implementation Plan

Related: `spec.md` (EARS requirements R1-1 through R6-10), `acceptance.md` (scenarios).

## Milestones (priority-based)

- Primary goal: seamless wheel scrolling across page boundaries (M1 + M2 + M3) with the stress test updated in the same change.
- Secondary goal: selection persistence by global id (M6), including loadPage no-clear behavior change.
- Final goal: platform-aware Search-all kbd hint (M5) plus full e2e scenario coverage.
- Optional goal: `overflow-anchor` tuning for Chromium native scroll anchoring, if manual compensation alone proves insufficient.

Dependency note: M1/M2/M3 land together (one coherent view-window change). M6 depends on the window model existing (append/prepend/evict remapping). M5 is independent and can land in any commit order.

## Design Decisions (locked)

- One SPEC for all three requirement groups (M1-M3 cohesive; M5 trivial; M6 depends on M1-M3).
- Window cap: 5 pages (2,500 rows), named constant `MAX_WINDOW_PAGES = 5`. Rationale: anchor may drift up to 2 pages in either direction while always keeping adjacent context; memory and wrap-recalculation cost stay trivial.
- Eviction: trim the farthest page on the side opposite the scroll direction; compensate scrollTop by the trimmed rows' total height.
- Pager: anchor-page semantics (window's first page); `updatePager` needs essentially no change.
- Keyboard paging stays as explicit `loadPage` jumps; only the wheel is seamless.
- Hint: static two-state text via one-time platform detection; no reactive re-detection.
- Selection: re-keyed by global `seq` at the app.js call sites; `src/selection.js` keeps its generic integer-set semantics.

## File-by-file Changes

### src/app.js (browser-only glue; exempt from coverage gate)

1. View model (lines 85-114):
   - Add `viewStart` (global row ordinal of `view[0]`) alongside `pageStart` (anchor page start).
   - Add `appendPage()` and `prependPage()`: fetch via `paging.request('page', { start, size: PAGE_SIZE })`, concatenate into `view`, rebuild `seqToIdx` and `viewMaxLen` for the new window, keep displayCache for surviving rows, reuse `viewToken`/`pageToken` guards and the busy pattern.
   - Remove `selection.clear()` from `loadPage` (line 108) per M6 (deliberate behavior change).
2. Window management (M3):
   - After extension, if `view.length > MAX_WINDOW_PAGES * PAGE_SIZE`, trim the opposite end: splice the farthest page, rebuild `seqToIdx`, adjust `viewStart`, and apply scrollTop compensation equal to the trimmed rows' total height (ROW_H arithmetic in non-wrap mode; prefix-sum delta in wrap mode).
3. Virtualization (lines 692-857):
   - Rework `showStartMark` / `showEndMark` (703-704) to key on window bounds vs the global first/last line instead of single-page bounds.
   - `totalHeight()` and `findIndexAtOffset()` unchanged algorithmically (already operate over the full view).
   - `renderRows()` windowed rendering and overscan unchanged.
4. Wheel handler (lines 2595-2601):
   - Replace the two `loadPage(...)` calls at the edges with `appendPage()` / `prependPage()`; keep `wheelPaging`, the 150 ms cooldown, and the `#viewer-busy` gating.
5. Prepend scroll anchoring:
   - Capture scrollTop and scrollHeight before DOM/spacer mutation; restore offset after `invalidateHeights()` and `renderRows()`.
   - Evaluate `overflow-anchor: none` on the viewer element so Chromium's native scroll anchoring does not fight manual compensation.
6. Selection re-keying (M6):
   - Click handlers (944-960): pass `view[idx].seq` into the SelectionModel; shift-range computed over window index range, then mapped to seqs.
   - Rendering (810, 819): `selection.has(view[idx].seq)`.
   - Copy (1067-1068), export (1773, 1837), status count (910): map selected seqs to window indices; off-window selected rows excluded (graceful degradation per R6-8).
   - Keyboard (2892-2895): B targets the first selected in-window row; Esc clears all; Ctrl+A selects the current window's seqs.
   - Wrap-mode heights and displayCache: selection does not key these; no additional invalidation needed.
7. Platform hint constant (M5):
   - One-time resolution: `navigator.userAgentData.platform` when available, else `navigator.platform`; match /mac|ipad/i to choose "⌘Enter", else "Ctrl+Enter"; any absence or unrecognized value falls back to "Ctrl+Enter". Render into the kbd element at init.

### template.html

- Line 432: place a `<kbd>` hint element inside `#btn-sall` after the label text (inside the button so the existing `.vt-sec` hiding at ≤560 px covers it automatically).
- Line 329: the existing `kbd` rule is reused as-is; add at most a small margin tweak.
- No new media queries; no changes to #find-hint prose (line 465) required, though it may gain a kbd span for consistency (optional, do in the same commit only if trivial).

### src/selection.js (coverage-gated core module — minimize)

- Preferred outcome: zero changes (the model already stores integers; app.js passes seq values).
- If a helper is unavoidable (for example a bulk-add for select-all-as-seqs), keep it tiny and add/extend unit tests so the 90/85 gate stays green.

### Not changed

- `src/app-paging-worker.js` (stateless page handler already supports arbitrary fetches).
- `src/paged.js` (block LRU independent of view windowing).
- `build.js` (single-file build flow untouched).

## Task Decomposition (with dependencies)

1. Task A (no deps): window state model — `viewStart`, `appendPage`, `prependPage`, `seqToIdx`/`viewMaxLen` rebuilds, token guards. [M1, M2]
2. Task B (depends on A): eviction at `MAX_WINDOW_PAGES` with scrollTop compensation and index rebuilds. [M3]
3. Task C (depends on A): mark rework (`showStartMark`/`showEndMark`) to window bounds. [M2]
4. Task D (depends on A, B): wheel handler swap to append/prepend; keep cooldown and busy gating. [M1, M2]
5. Task E (depends on A, B): prepend scroll anchoring including wrap-mode height recalculation order; evaluate `overflow-anchor: none`. [M2]
6. Task F (depends on A, B): selection re-keying to seq across click/render/copy/export/status/keyboard call sites; remove selection.clear() from loadPage. [M6]
7. Task G (no deps): platform detection constant plus kbd element in #btn-sall. [M5]
8. Task H (depends on D): update `tests/e2e/stress.e2e.spec.mjs:105-120` for the new behavior (same commit as D).
9. Task I (depends on E, F, G): new e2e scenarios (see Test Plan) and Search-all hint assertions (including Mac platform emulation and narrow viewport).

## Test Plan

Unit (node --test):
- If `src/selection.js` is touched: extend `tests/selection.test.js` (or equivalent) for the new helper; the coverage gate (90/85) must stay green.
- No gated module otherwise changes; `tests/paged.test.js` unaffected.

E2E (Playwright):
- Stress spec update (same commit as the wheel change): after sustained wheel-down, assert sequence continuity across the old 500-row boundary, no scroll jump, stable pager; verify what `state().rows` counts (rendered DOM rows stay bounded by the render window; if it counts view rows, raise the bound to the 5-page cap) and update the assertion accordingly.
- New continuous-scroll scenarios (about 6-8): append seam; prepend anchoring with exact first-visible-line preservation; wrap-mode prepend; eviction at cap (view rows never exceed 2,500; visible lines unchanged); collapse on filter change; collapse on pagination jump; start/end marks correct mid-window; pager shows anchor page.
- M5 assertions: default hint text on the host platform; Mac variant via a fresh context with `navigator.platform` / `userAgentData` overridden through `addInitScript`; narrow viewport (≤560 px) hides button and hint; Meta+Enter triggers Search all.
- M6 scenarios: selection survives append/prepend/evict (highlight at remapped position); selection survives a pagination jump and re-highlights when the row is in-window; off-window selection restores on scroll-back or go-to-line; filter change keeps matching selection highlighted; shift-range and ctrl-toggle store global ids; Esc clears all; copy excludes off-window rows.
- Existing Search all tests (~2608, ~2900 in `tests/e2e/app.e2e.spec.mjs`) gain assertions only; behavior unchanged.

## Risks and Mitigations

1. Scroll anchoring bugs (highest): prepend compensation off by wrapped-row heights; Chromium native scroll anchoring interference. Mitigation: measure-then-compensate ordering, `overflow-anchor: none` evaluation, dedicated wrap-on prepend e2e.
2. Eviction index drift: seqToIdx/heights/selection off-by-one after trimming. Mitigation: single rebuild helper used by every mutation path; e2e assertion that highlights land on the correct lines after eviction.
3. Mark-band regressions: false start/end marks mid-window. Mitigation: rework keyed strictly on window bounds vs global bounds; mid-window e2e scenario.
4. Race conditions: wheel cooldown vs in-flight append vs filter change mid-fetch. Mitigation: reuse viewToken/pageToken guards inside append/prepend; busy gating unchanged.
5. Memory growth: bounded by the 5-page cap; no other growth path introduced.
6. Stress test churn: re-baseline `state().rows` expectations; budget for e2e iteration.
7. Selection semantics surprises: copy/export operating on window rows only may surprise users with off-window selections. Mitigation: status count reflects in-window selection; Esc clears everything; behavior documented in acceptance.md.

## Conventional Commits (planned series)

- `feat(viewer): seamless continuous scrolling across page boundaries`
- `feat(viewer): keep selection anchored to global line ids across paging`
- `feat(viewer): platform-aware shortcut hint on Search all button`
- `test(e2e): cover continuous scroll window, selection persistence, and shortcut hint`
