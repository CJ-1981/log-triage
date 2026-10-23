---
id: SPEC-VIEWER-001
version: "1.0.1"
status: "completed"
created: "2026-10-18"
updated: "2026-10-18"
author: "CJ-1981"
priority: "HIGH"
---

# SPEC-VIEWER-001: Continuous Viewer Scrolling, Search-all Shortcut Hint, and Selection Persistence

## HISTORY

| Date | Version | Author | Change |
|---|---|---|---|
| 2026-10-18 | 1.0.0 | CJ-1981 | Initial draft. Two user-requested enhancements (continuous scrolling; visible Search-all shortcut hint) plus one user-added requirement group (M6 selection persistence). All design decisions resolved at plan-approval time. |
| 2026-10-18 | 1.0.1 | CJ-1981 | Implemented in 6f22676 (continuous scroll window), 1dfbe31 (seq-keyed selection persistence), 0aa1e71 (platform-aware Search-all hint), a754887 (e2e coverage). Quality gate PASS: 321 unit / 105 e2e, 0 fail; coverage green on touched modules; bundle fresh. Status draft → completed. |

## Environment

- Privacy-first, browser-only log triage tool. Vanilla JS UMD modules, no framework.
- Single self-contained HTML artifact built by `build.js` from `template.html` plus `src/` modules. The single-file build invariant must not be broken.
- Node 22 for the unit test suite (`node --test`); Playwright for e2e (87 app specs plus 8 stress specs).
- Viewer paging: `PagingClient` promise RPC to a stateless worker `page` handler (`src/app-paging-worker.js:80-89`, clamps to the last full page; per-request stateless, no worker changes needed). `PAGE_SIZE = 500` (`src/app.js:85-87`).
- Virtualized rendering: `ROW_H = 22`, wrap-mode heights via prefix sums, windowed rendering with overscan into `#vspacer` (`src/app.js:692-857`). The spacer and binary-search offset lookup already operate over the whole in-memory `view`, so a larger window works without algorithmic change.
- Data cache: 256-row block LRU in `src/paged.js:87-106` (16 blocks / 8 MB bound), independent of view windowing.
- Current paging behavior: `loadPage()` replaces the view wholesale, rebuilds `seqToIdx`/`viewMaxLen`, clears display cache and selection, and resets scroll position (`src/app.js:100-114`).
- Existing wheel-edge hook: at bottom/top edge the current code calls `loadPage` (page replacement) with a `wheelPaging` flag and 150 ms cooldown, skipped while `#viewer-busy` is active (`src/app.js:2595-2601`).
- Search all: `#btn-sall` in `#vtools` (`template.html:432`), click handler (`src/app.js:2748`), document keydown accepting Ctrl or Meta plus Enter (`src/app.js:2863-2871`). An unused `kbd` CSS rule exists at `template.html:329`. `.vt-sec` controls are hidden at viewports of 560 px or narrower (`template.html:361-363`).
- Selection model: generic integer-set `SelectionModel` in `src/selection.js` (click anchor, shift range, ctrl toggle, selectAll). Currently keyed by window index. Rows carry a global sequence id (`seq`); `seqToIdx` maps seq to window index, confirming seq as the stable global row identifier.
- Coverage gate: 90 percent line / 85 percent branch on core modules; `app.js` and other browser-only glue modules are exempt (`structure.md`). E2E is the safety net for this SPEC.

## Assumptions

- `seq` is unique and stable per line within a loaded file set, across filtered and unfiltered views. Confidence: High (evidence: `seqToIdx` map and worker paging contract).
- The worker `page` handler can serve arbitrary start offsets repeatedly without side effects, so append/prepend fetches are safe to interleave with the block cache. Confidence: High.
- Chromium's native CSS scroll anchoring may interact with manual scroll compensation on prepend; the viewer may need `overflow-anchor: none`. Confidence: Medium, verified during implementation.
- Platform detection via `navigator.userAgentData.platform` (Chromium) falling back to `navigator.platform` (Safari, Firefox) covers all three target browsers. Confidence: High.
- Keeping at most 5 pages (2,500 rows) in the view keeps seqToIdx rebuilds, display cache, and wrap-mode prefix-sum recomputation imperceptible. Confidence: High.

## Requirements (EARS)

### M1 — Continuous scroll-down (page append)

- R1-1 [Event-driven] WHEN the user scrolls the viewer to within the bottom-edge threshold (scrollTop + clientHeight >= scrollHeight − 2) AND the window's last page is not the final page of the filtered view AND no page fetch is in flight, THEN the system shall append the next 500-row page to the existing view without replacing rendered rows and without resetting scroll position.
- R1-2 [State-driven] WHILE a page append fetch is in flight, WHEN the user scrolls past the edge again, THEN the system shall not issue a duplicate page request (reuse the wheelPaging flag, the 150 ms cooldown, and the #viewer-busy gating).
- R1-3 [Unwanted] WHEN the window's last page is the final page of the view, THEN the system shall not fetch another page and the "end of results" mark shall remain the sole bottom boundary indicator.
- R1-4 [Ubiquitous] The system shall preserve existing row selection, display cache entries, and seqToIdx entries for rows already in the window when appending a page.

### M2 — Continuous scroll-up (page prepend with anchoring)

- R2-1 [Event-driven] WHEN the user scrolls the viewer to within the top-edge threshold (scrollTop <= 0) AND the window's first page is not page 0, THEN the system shall prepend the previous 500-row page and keep the viewport anchored on the same log lines via explicit compensation: capture scrollTop and scrollHeight before mutation, then set scrollTop so the same first visible line remains in view after rendering.
- R2-2 [State-driven] IF the viewer is in wrap mode, THEN the system shall recalculate wrap heights for prepended rows (invalidateHeights plus prefix-sum rebuild) before applying the scroll compensation, so the first visible line is unchanged.
- R2-3 [Ubiquitous] The system shall render the "start of results" mark only when the window begins at global line 1, and the "end of results" mark only when the window ends at the last matching line (rework of the current single-page-bounds checks).

### M3 — Bounded window (5-page cap, eviction, collapse)

- R3-1 [State-driven] WHILE the accumulated view holds fewer than 5 pages (2,500 rows) counting both former and next pages around the anchor, WHEN the user crosses a page boundary by wheel, THEN the system shall extend the view in the scroll direction.
- R3-2 [State-driven] WHILE the window already holds 5 pages, WHEN a new page is appended, THEN the system shall evict the farthest page at the top (former end); WHEN a new page is prepended, THEN the system shall evict the farthest page at the bottom (next end). The evicted page is always on the side opposite the scroll direction and therefore off-screen.
- R3-3 [Ubiquitous] The system shall keep seqToIdx, viewMaxLen, display cache, wrap height prefix sums, and selection anchors consistent after every eviction, and shall compensate scrollTop by the evicted rows' total height so the user's visible lines do not shift.
- R3-4 [Event-driven] WHEN a filter changes, view-mode changes, a new file loads, or a pagination / go-to-line / worker-locate jump occurs, THEN the system shall collapse the window to a single anchor page via the existing loadPage full-replacement path.

### M4 — Pagination and jump preservation

- R4-1 [Event-driven] WHEN the user clicks first/prev/next/last, types a page number, uses go-to-line, or a worker locate jumps, THEN the system shall load exactly the requested page with the existing full-replacement behavior; the wheel edge path is the only caller of append/prepend.
- R4-2 [Ubiquitous] The system shall keep the four pagination buttons and the page-number input enabled/disabled exactly per the current updatePager logic, based on the anchor page (the window's first page).
- R4-3 [State-driven] WHILE an extended window is active, WHEN the user reads the pager, THEN it shall display the anchor page number and the anchor page's line range.
- R4-4 [Event-driven] WHEN the user uses keyboard paging (Ctrl+Home, PageUp, PageDown, Ctrl+End), THEN the system shall perform an explicit loadPage jump exactly as today; keyboard paging is not part of seamless scrolling (decided at plan approval).

### M5 — Platform-aware Search-all keyboard hint

- R5-1 [Optional-feature-state] WHERE the Search all button (#btn-sall) is visible, the system shall render a visible kbd hint element adjacent to the button label, reusing the existing kbd CSS rule.
- R5-2 [Event-driven] WHEN the runtime platform is macOS, THEN the hint shall display "⌘Enter" (matching the metaKey acceptance in the existing keydown handler); on Windows and Linux it shall display "Ctrl+Enter".
- R5-3 [Unwanted] WHEN platform detection is unavailable or the platform is unrecognized, THEN the system shall not fail and shall fall back to "Ctrl+Enter".
- R5-4 [Event-driven] WHEN the viewport is 560 px or narrower, THEN the hint shall be hidden together with the button, following the existing .vt-sec responsive treatment (achieved by placing the kbd element inside the button; no new media query).
- R5-5 [Ubiquitous] The system shall keep the existing title tooltip unchanged and shall continue to accept both Ctrl+Enter and Cmd(⌘)+Enter for Search all.

### M6 — Selection persistence

- R6-1 [Ubiquitous] The system shall key selection state by the global row identifier (seq), not by window index, so selections survive window mutation and view replacement.
- R6-2 [Event-driven] WHEN pages are appended, prepended, or evicted during continuous scrolling, THEN the system shall preserve all selected rows and re-render their highlights at the remapped window positions.
- R6-3 [Event-driven] WHEN a pagination jump, go-to-line, worker locate, filter change, or file load replaces the view via loadPage, THEN the system shall retain the selection set instead of clearing it (a deliberate behavior change from the current clear at loadPage).
- R6-4 [State-driven] IF a selected row is within the newly loaded window, THEN the system shall render its highlight on the corresponding row.
- R6-5 [State-driven] IF a selected row is outside the current window (scrolled out by a jump or eviction), THEN the system shall keep the selection stored by global id and restore the highlight automatically when the row re-enters the window via paging, go-to-line, or search-all click-to-jump.
- R6-6 [State-driven] IF a selected line does not match the active filter after a filter change, THEN the system shall keep the selection stored but inert: no highlight (the line is not in any filtered window), excluded from the status-bar count, copy, and selection export, until the line matches again (for example after clearing the filter) or the user clears the selection.
- R6-7 [Event-driven] WHEN the user shift-clicks a row, THEN the system shall select all rows between the anchor and the clicked row within the current window, storing their global ids; WHEN the user ctrl/cmd-clicks, THEN the system shall toggle that row's global id in the selection.
- R6-8 [Ubiquitous] The system shall scope copy, selection export, the status-bar selection count, and Ctrl+A select-all to selected rows present in the current window; rows selected but off-window shall be excluded from those operations and shall remain selected.
- R6-9 [Event-driven] WHEN the user presses Escape, THEN the system shall clear the entire selection, including off-window entries (existing behavior, retained).
- R6-10 [Unwanted] The system shall not require changes to the SelectionModel data structure semantics beyond passing global ids in place of window indices; any change to `src/selection.js` (a coverage-gated core module) shall be minimized and unit-tested.

## Constraints

Technical constraints:
- No new dependencies; vanilla JS UMD modules only.
- Single self-contained HTML build via `build.js` must remain intact.
- No changes to the worker `page` handler or `src/paged.js` (stateless paging and block cache already support the design).
- `app.js` is exempt from the coverage gate; e2e is the safety net for viewer behavior. `src/selection.js` is gated — keep changes minimal or zero.
- Conventional commits mandatory.
- Priority-based milestones only; no time estimates.

Business constraints:
- Existing pagination UX (buttons, page input, range text) must remain recognizable; continuous scrolling is an additive layer, not a replacement.
- Memory must stay bounded regardless of session length on multi-GB files (the 5-page cap).

## Technical Notes (file:line touchpoints)

- `src/app.js:85-87` — paging client, PAGE_SIZE, state (pageStart/viewToken/pageToken).
- `src/app.js:92-99` — updatePager anchor semantics.
- `src/app.js:100-114` — loadPage wholesale replacement (selection clear at line 108 is deliberately removed for M6).
- `src/app.js:692-857` — virtualization: ROW_H, wrap prefix sums, showStartMark/showEndMark (703-704), totalHeight, findIndexAtOffset, renderRows.
- `src/app.js:910` — status-bar selection count; `src/app.js:924-930` — scroll handler (renderRows, follow-mode disengage).
- `src/app.js:944-960` — click/shift/ctrl selection handlers; `src/app.js:1067-1068` — copySelection; `src/app.js:1773, 1837` — selection export.
- `src/app.js:2045` — go-to-line jump (loadPage); `src/app.js:2066-2068` — worker locate jump (loadPage).
- `src/app.js:2589-2593` — pagination control handlers; `src/app.js:2595-2601` — wheel edge handler (conversion point); `src/app.js:2602-2606` — keyboard paging (kept as loadPage jumps).
- `src/app.js:2748` — Search all click handler; `src/app.js:2863-2871` — Ctrl/Meta+Enter keydown; `src/app.js:2892-2895` — keyboard selection shortcuts (B, Esc, Ctrl+C, Ctrl+A).
- `src/selection.js` — SelectionModel (generic integer set; will receive global ids).
- `src/app-paging-worker.js:80-89` — stateless page handler; no worker changes.
- `template.html:329` — unused kbd CSS rule (reuse); `template.html:361-363` — .vt-sec responsive hiding; `template.html:429-432` — #vtools and #btn-sall; `template.html:465` — #find-hint prose mentioning Ctrl+Enter.
- `tests/e2e/stress.e2e.spec.mjs:105-120` — wheel paging stress test (must be updated in the same commit as the behavior change).

## Traceability

- SPEC-VIEWER-001 requirement groups M1-M6.
- Touching: `src/app.js`, `template.html`, `tests/e2e/stress.e2e.spec.mjs`, `tests/e2e/app.e2e.spec.mjs` (Search all block), optionally `src/selection.js` (minimized).
- Not touching: `src/app-paging-worker.js`, `src/paged.js`, `build.js`.
