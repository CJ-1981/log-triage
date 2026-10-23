# SPEC-VIEWER-002 Implementation Plan

Related: `spec.md` (EARS requirements R1-1 through R5-4), `acceptance.md` (scenarios).

## Milestones (priority-based)

- Primary goal: master Filter toggle with non-destructive bypass semantics (M1) — the core safety feature.
- Secondary goal: status-bar FILTERED badge with visibility matrix and refresh hooks (M2) plus the plain-language tooltip (M3).
- Final goal: zen HUD indication (M4) and session-restore / mutation-while-bypassed semantics (M5) with full e2e coverage.
- Optional goal: richer tooltip than `title` (styled hover card) if the plain `title` proves cramped — only if trivial.

Dependency note: M1 is the foundation (badge and HUD both key off the toggle state). M2 and M3 land together (badge carries the tooltip). M4 and M5 are thin layers over M1-M2 and land in the same or a follow-up commit.

## Design Decisions (locked)

- Bypass point: `rebuildView()` builds the worker `spec` without narrowing fields while `state.filtersEnabled` is false. The stateless worker `query` handler is untouched; no worker change.
- State: single new transient flag `state.filtersEnabled`, default true, added to `defaults()` and to the `saveState()` strip destructure. It is deliberately NOT persisted — a persisted bypass would make freshly loaded files appear invisible, the exact failure the existing strip list prevents.
- Badge predicate: visibility = (stored filters active) AND (toggle ON). Because `viewIsFiltered()` reads the live `filter` object, add a stored-settings evaluation so the badge reflects configuration rather than the bypassed spec. Prefer implementing this as a tiny helper in `app.js` (exempt from coverage) rather than in `src/filters.js` (gated); move it to `src/filters.js` only if it needs the engine's internals, in which case add gated unit coverage.
- Bypassed semantics propagate through `viewIsFiltered()`: making it return false while OFF gives correct band labels (`markLabel()`) and derived UI for free. The badge uses the separate stored-settings predicate, not `viewIsFiltered()`.
- Toggle UX: "Filter: ON/OFF" label + `on` class, identical to `#btn-mask`/`#btn-wrap`. ON means filters apply; OFF means bypass. Placed in `#vtools` next to `#btn-mask` (template.html:433).
- Filters stay editable while bypassed (R5-2/R5-3): `applyFilters()` stores values to state and persists them, but the rebuild runs unfiltered; toggling ON re-applies everything in one rebuild. No disabling of inputs.
- No clear-all affordance anywhere in the Viewer (R1-6); the Filters tab remains the only place to clear filters.
- Tooltip: plain `title` attribute on badge and toggle (search-flag precedent). No richer widget in the primary milestone.

## File-by-file Changes

### src/app.js (browser-only glue; exempt from coverage gate)

1. State (lines 14-29, 31-40):
   - Add `filtersEnabled: true` to `defaults()`.
   - Add `filtersEnabled` to the `saveState()` destructure strip list (line 36) so it is never persisted.
2. Toggle handler (new, alongside `setMask` at 2322):
   - `setFiltersEnabled(on)`: set `state.filtersEnabled`, update `#btn-filter` textContent ("Filter: ON"/"Filter: OFF") and `classList.toggle('on', on)`, then `rebuildView()` (which cascades `renderChips()`/`updateStatus()` via the existing line-720 path). Register the click handler next to `$('btn-mask').onclick` (line 2767).
3. Bypass in `rebuildView()` (lines 699-723):
   - When building `spec` (706-712): if `!state.filtersEnabled`, omit `timeFrom`/`timeTo` (709), pass empty `rules`/`levels`/`quick` (708), and `bookmarkOnly: false` (710). Keep `fileId` (707) and `bookmarks` (711) — view mode and bookmark data are not narrowing filters.
4. Filtered predicates (794-808):
   - Make `viewIsFiltered()` return false while bypassed (drives `markLabel()` band wording and derived UI).
   - Add `storedFiltersActive()`: same five checks over state/filter settings, ignoring the bypass flag — used by badge visibility and tooltip.
   - Add `filterSummary()`: plain-language active-category list ("time range", "N include rules", "N exclude rules", "levels E W", "quick filter", "bookmarks only"); empty string when nothing is active.
5. Badge rendering in `updateStatus()` (991-1004):
   - Toggle the hidden class on `#st-filtered` from `storedFiltersActive() && state.filtersEnabled`; set its `title` from `filterSummary()` (badge side of R2-1/R2-4, R3-1/R3-2).
   - This also covers zen: `updateZenHud()` (1003) is called from `updateStatus()`.
6. Zen HUD (2356-2358):
   - Append " · FILTERED" between mask state and shown count when `storedFiltersActive() && state.filtersEnabled` (R4-1); keep the exact existing format otherwise (R4-2).
7. Deferred application while bypassed (`applyFilters()` 1405-1418):
   - Keep storing values to state and `saveState()`; when `!state.filtersEnabled`, skip the narrowing rebuild (the view stays unfiltered; run the unfiltered rebuild once if inputs changed) and re-apply fully on toggle-ON. Chip/rule mutations follow the same rule via their existing rebuild call sites (696, 720, 772, 1062, 2043).

### template.html

- `#vtools` next to `#btn-mask` (line 433): add `<button id="btn-filter" title="…">Filter: ON</button>` with a title covering both states and the Filters-tab pointer (R3-4).
- `#statusbar` (469-477): add `<span id="st-filtered" class="badge enc hidden" title="">FILTERED</span>` after the bookmarks span — reuses `.badge.enc` (`var(--warn)`, line 98) so no new CSS is required.
- No new media queries; the badge sits inside `#statusbar`, which zen hides wholesale (line 107).

### tests/e2e/app.e2e.spec.mjs

- Extend the `status()` helper (line 76) with `filtered: !(document.getElementById('st-filtered') || {}).classList.contains('hidden')` and the toggle state, or use `page.waitForFunction` on `#st-filtered` directly.

### README.md

- Viewer feature prose (~line 70): one sentence on the Filter toggle (bypass semantics, nothing deleted, session-transient) and the FILTERED badge.

### Gated-module note

- Preferred: zero changes to `src/filters.js` (the summary/predicate helpers are presentational and stay in `app.js`). If any logic lands there, extend the gated unit suite so the 90/85 gate stays green.

## Task Decomposition (with dependencies)

1. Task A (no deps): state flag + persistence strip + toggle button/handler/label. [M1, R1-1, R1-7]
2. Task B (depends on A): bypass in `rebuildView()` spec construction; re-apply on toggle-ON. [M1, R1-2, R1-3, R1-4]
3. Task C (depends on B): `viewIsFiltered()` bypass-awareness for band labels. [M1, R1-5]
4. Task D (depends on A): `storedFiltersActive()` + `filterSummary()` helpers. [M2, M3]
5. Task E (depends on D): badge span in template + `updateStatus()` visibility/tooltip hooks. [M2, M3]
6. Task F (depends on D): zen HUD marker in `updateZenHud()`. [M4]
7. Task G (depends on B): deferred-application path in `applyFilters()` and chip/rule call sites; new-file-load behavior. [M5]
8. Task H (depends on E, F, G): e2e scenarios (see Test Plan) and README sentence.

## Test Plan

Unit (node --test):
- Expected: no gated module changes; `npm run test:gate` must stay green as a regression check only.
- If a helper lands in `src/filters.js`: add cases to the gated suite for the moved logic first (TDD).

E2E (Playwright) — write failing specs before the implementation tasks they cover (TDD):
- Toggle round-trip: set quick filter + time range + a rule; verify shown count drops; toggle OFF → shown equals total, band labels revert to unfiltered wording, Filters tab still shows everything; toggle ON → identical shown count and chips as before the round-trip.
- Badge visibility matrix (2×2): filtered+ON → visible; filtered+OFF → hidden; unfiltered+ON → hidden; unfiltered+OFF → hidden.
- Badge refresh: add a rule via the Filters tab while ON → badge appears without touching the Viewer; remove it → badge disappears.
- Tooltip: read the `title` of `#st-filtered` and `#btn-filter`; assert the plain-language summary lists active categories (time range / rule counts / levels / quick filter) and the unfiltered message when nothing is active; assert no raw rule ids appear.
- Zen HUD: enter zen with active filters → `#zen-hud` text contains "FILTERED"; bypass or clear filters → marker gone, format otherwise unchanged.
- Session restore: set a persisted rule, reload via `fresh()` (which clears localStorage — use a rule-set flow that survives, or assert with localStorage preserved) → toggle reads ON and badge reflects only surviving filters (rules yes, time range no).
- Mutate-while-bypassed: toggle OFF, edit the quick filter and add an exclude rule, assert the view stays unfiltered; toggle ON → the edited filters apply in full.
- New file load while bypassed: view stays unfiltered, badge hidden; toggle ON re-filters.

## Risks and Mitigations

1. Persisted bypass (highest): forgetting the `saveState()` strip addition would persist OFF across sessions and make new files look empty. Mitigation: strip-list change lands in the same commit as the state flag; e2e asserts a fresh session starts ON.
2. Badge lying about state: `viewIsFiltered()` conflates live/bypassed view with stored settings. Mitigation: two clearly named predicates; the matrix e2e covers all four quadrants.
3. Deferred-application drift: edits made while OFF could apply partially if some call sites rebuild narrowed. Mitigation: single guard helper used at every rebuild call site (696, 720, 772, 1062, 2043); dedicated mutate-while-bypassed e2e.
4. `applyFilters()` re-entrancy: the input path rebuilds on every change; while bypassed this must not thrash the worker. Mitigation: skip the narrowing rebuild while OFF (view is already unfiltered); one rebuild on toggle-ON.
5. Theme regressions: badge reuses `.badge.enc`, so no new color surface exists; verify all six themes visually once.
6. e2e helper churn: extending `status()` touches many specs' helper — additive field only, no behavior change to existing assertions.

## Conventional Commits (planned series)

- `feat(viewer): master Filter toggle that suspends narrowing without deleting settings`
- `feat(viewer): FILTERED status badge and zen HUD marker for active filters`
- `test(e2e): cover filter bypass round-trip, badge matrix, and zen indication`
