---
id: SPEC-VIEWER-002
version: "1.1.0"
status: "completed"
created: "2026-10-19"
updated: "2026-10-19"
author: "CJ-1981"
priority: "MEDIUM"
---

# SPEC-VIEWER-002: Active-Filter Indication with Master Filter Toggle

## HISTORY

| Date | Version | Author | Change |
|---|---|---|---|
| 2026-10-19 | 1.0.0 | CJ-1981 | Initial draft. User-requested active-filter indication: master Filter toggle with non-destructive BYPASS semantics, status-bar FILTERED badge, plain-language active-filter tooltip, and zen HUD indication. All design decisions resolved at plan-approval time. |
| 2026-10-19 | 1.0.1 | CJ-1981 | Follow-up: toggle position preservation. Toggling with nothing narrowing is an exact view no-op; when the view set changes, the first fully visible line is identity-anchored and restored at the viewport top after the rebuild. |
| 2026-10-19 | 1.1.0 | CJ-1981 | Amendment 1 (user decision): the quick filter is renamed "quick scan" across the UI and is DECOUPLED from the master toggle — it narrows and highlights in both toggle states. The OFF bypass now covers only rules, time range, level chips and bookmarks-only. See "Amendment 1" below; it overrides the touched requirements. |

## Amendment 1 — Quick scan decoupling and rename (2026-10-19, overrides below)

User decision after working with the shipped toggle: the bypassed OFF state proved
confusing when a typed pattern visibly did nothing to the view. The quick filter is
renamed **quick scan** in every user-facing string (toolbar placeholder, Search all
tooltip, find hint, flash messages, tooltips, zen HUD, README); internal identifiers
(`state.quick`, `#quick`, the engine `filter.quick` field) are unchanged. Semantics:

- The quick scan ALWAYS narrows and highlights, in both toggle states. The
  `rebuildView()` bypassed spec-build keeps `quick` while omitting `rules`,
  `levels`, `timeFrom`/`timeTo`; `bookmarkOnly` stays bypassable.
- Requirement overrides: R1-2 (OFF suspends everything EXCEPT the quick scan),
  R1-5/R2-2/R4-2 ("treated as unfiltered while OFF" applies only when nothing
  actually narrows — a live quick scan keeps the FILTERED badge, filtered band
  wording, and zen HUD marker), R3-1 (examples read "quick scan"; while OFF the
  badge tooltip lists only the quick scan), R5-2 (quick scan edits apply
  immediately while bypassed; only bypassable-filter edits are stored until ON),
  R5-4 (unchanged for bypassable filters).
- Toggle-place guarantee (v1.0.1) still applies: toggling with an active quick
  scan and nothing else is set-preserving; OFF→ON with quick+rule re-anchors the
  top visible line.

## Environment

- Privacy-first, browser-only log triage tool. Vanilla JS UMD modules, no framework, no network, no new dependencies.
- Single self-contained HTML artifact built by `build.js` from `template.html` plus `src/` modules. The single-file build invariant must not be broken.
- The Viewer narrows lines through five mechanisms: time range (`filter.timeFrom`/`filter.timeTo`), include/exclude rules (`filter.rules`), level chips (`filter.levels`), the quick filter (`filter.quick`), and the bookmarks-only chip (`state.showOnlyBookmarked`). The predicate `viewIsFiltered()` (`src/app.js:794-795`) already covers exactly these five.
- Toolbar toggle precedent: `#btn-mask` "Mask: ON" (`template.html:433`), `setMask()` sets textContent plus `classList.toggle('on', on)` (`src/app.js:2322-2324`), and the `button.on` CSS rule (`template.html:25`) provides the pressed styling. `#btn-wrap` and `#btn-follow` follow the same pattern.
- Status bar: `#statusbar` spans (`template.html:469-477`), populated by `updateStatus()` (`src/app.js:991-1004`), which also calls `updateZenHud()` (line 1003). Existing badge variants live at `template.html:96-99`; `.badge.enc` already colors with `var(--warn)` (line 98) — the palette source is `src/themes.js` and all colors must come from theme CSS variables.
- View construction: `rebuildView()` (`src/app.js:699-723`) builds the worker query `spec` (fileId at 707, `timeFrom`/`timeTo` at 709, rules/quick/levels at 708, `bookmarkOnly` at 710); `renderChips()` and `updateStatus()` run after every rebuild (line 720, and the sibling call site at 696). Input-driven filter changes flow through `applyFilters()` (`src/app.js:1405-1418`).
- Band labels: `markLabel()` (`src/app.js:796-808`) keys its "first/last match in …" wording on `viewIsFiltered()`.
- Persistence: `saveState()` (`src/app.js:31-40`) deliberately strips transient filter state (`quick`, `levels`, `timeFrom`, `timeTo`, `rgPattern`, `showOnlyBookmarked`, `zenOn`) at the line-36 destructure so every new session starts unfiltered; include/exclude rules and Config-tab settings persist.
- Zen mode: `body.zen` hides the header, sidebar, chips, toolbar, pager and status bar via CSS (`template.html:107`), leaving `#zen-hud` (`template.html:460`, CSS 116-117) as the only status surface; `updateZenHud()` (`src/app.js:2356-2358`) renders the precedent string "Mask: ON · N shown".
- Plain-language tooltip precedent: the Search all button and search flag controls carry long plain-language `title` strings (`template.html:432`).
- Tests: `node:test` unit suites (`tests/core-cases.js` shared suite, also run in-browser by the `?selftest` page) and Playwright e2e in `tests/e2e/app.e2e.spec.mjs` (100 app specs today) with helpers `fresh()` (line 62), `click(id)` (line 72), and `status()` (line 76) reading `#st-total`/`#st-shown`/`.badge.fmt`. New badge assertions can use `waitForFunction` on the new badge id or a `status()` extension.
- Coverage gate: 90 percent line / 85 percent branch on core modules; `app.js` is exempt. `src/filters.js` IS gated — if any helper logic moves there it must carry unit coverage.

## Assumptions

- Bypass can be implemented purely at the `rebuildView()` spec-building point by omitting the narrowing fields; the stateless worker `query` handler needs no change. Confidence: High (evidence: the spec object at `src/app.js:706-712` fully determines narrowing).
- The badge must evaluate filter activity against the STORED filter settings, not the bypassed worker spec; `viewIsFiltered()` reads the live `filter` object, so a bypass-aware variant (or evaluating before spec mutation) is needed. Confidence: Medium, verified during implementation.
- `state.filtersEnabled` will be persisted automatically by `saveState()` unless explicitly added to the line-36 strip list, because `saveState()` only removes the named transient fields. Confidence: High (evidence: the destructure at `src/app.js:36`).
- Filters remain editable in the Filters tab while bypassed, with changes stored but not applied until the toggle returns to ON; this deferred-application UX is the accepted resolution of "changing filters while OFF must not partially apply". Confidence: Medium, confirmed by user decision at plan approval.
- The `.badge.enc` visual language (small rounded pill, `var(--warn)` border and text) is the right model for the FILTERED badge; no new color is introduced. Confidence: High.
- Reload semantics: include/exclude rules persist, so after a reload the badge correctly shows FILTERED with the toggle ON even though the time range, quick filter, chips, and bookmarks-only state are gone (they are transient by design). Confidence: High (evidence: `saveState()` strip list).

## Requirements (EARS)

### M1 — Master Filter toggle (non-destructive BYPASS)

- R1-1 [Event-driven] WHEN the user clicks the "Filter: ON/OFF" toggle in the viewer toolbar, THEN the system shall flip the master filter state (`state.filtersEnabled`, default true), update the button label to "Filter: ON" or "Filter: OFF", toggle the `on` class to match (the `#btn-mask` pattern), and trigger a full view rebuild so the change takes effect immediately.
- R1-2 [State-driven] WHILE the master toggle is OFF, the system shall suspend all narrowing filters non-destructively: the view shall be built as if no time range, include/exclude rules, level chips, quick filter, or bookmarks-only setting were configured, so every indexed line is shown.
- R1-3 [Ubiquitous] The system shall preserve every filter setting verbatim while bypassed — include/exclude rules, selected level chips, quick filter text, time range values, and the bookmarks-only state — so nothing is cleared, reset, or lost during the OFF period.
- R1-4 [Event-driven] WHEN the master toggle returns to ON, THEN the system shall re-apply the stored filters exactly as configured (same rules in the same order, same chips, same quick pattern, same time range, same bookmarks-only state) and restore the previously filtered result set.
- R1-5 [State-driven] WHILE the view is bypassed, the system shall treat it as unfiltered for all derived UI: `viewIsFiltered()`-driven band labels (`markLabel()`) shall use the unfiltered "start/end of …" wording rather than "first/last match in …", and no surface shall imply the log is narrowed.
- R1-6 [Unwanted] The system shall not add any clear-all affordance to the Viewer toolbar, chips row, or badge; clearing filters remains exclusively in the Filters tab.
- R1-7 [Ubiquitous] The system shall not persist the master toggle across sessions: `saveState()` shall strip `filtersEnabled` alongside the other transient filter fields so every new session starts with filters active (ON).

### M2 — Status-bar FILTERED badge

- R2-1 [State-driven] WHILE at least one narrowing filter is configured AND the master toggle is ON, the system shall display a "FILTERED" badge in the status bar, styled with the existing `.badge` pill styling and `var(--warn)` coloring (no new colors).
- R2-2 [State-driven] WHILE the master toggle is OFF, the system shall hide the badge regardless of how many filters are configured (the view is not narrowed, so no indication is due).
- R2-3 [State-driven] WHILE no narrowing filter is configured, the system shall hide the badge even with the toggle ON.
- R2-4 [Event-driven] WHEN any filter-relevant change occurs (chip click, rule edit, quick filter input, time range change, bookmarks-only toggle, master toggle flip, file load, or view rebuild), THEN the system shall refresh badge visibility and its tooltip in the same update cycle as the existing status refresh (the `updateStatus()`/`renderChips()` path).

### M3 — Plain-language active-filter tooltip

- R3-1 [Optional-feature-state] WHERE filters are actively narrowing the view (toggle ON), the badge and the master toggle shall expose a plain-language tooltip summarizing which filters are active, enumerating only the active categories — for example "time range, 2 exclude rules, levels E W, quick filter" — covering time range, include/exclude rule counts (separate include and exclude counts), level chips, quick filter, and bookmarks-only.
- R3-2 [State-driven] IF no filter category is active, THEN the tooltip shall say so plainly (for example "no filters active — the full log is shown") instead of rendering an empty list.
- R3-3 [Unwanted] The system shall not expose raw internal identifiers (rule ids, raw regex sources, internal state keys) in the tooltip; summaries use plain language only, following the search flag control tooltip precedent.
- R3-4 [Ubiquitous] The master toggle button shall always carry a tooltip explaining both states, including that OFF suspends filters without deleting them and that all settings remain in the Filters tab.

### M4 — Zen HUD indication

- R4-1 [State-driven] WHILE zen mode is active AND filters are narrowing the view AND the master toggle is ON, the zen HUD (`#zen-hud`) shall include a filtered indication alongside the existing mask state and shown count, for example "Mask: ON · FILTERED · 12 shown", so the invisible-filter risk is covered where the status bar cannot be (the status bar is hidden by `body.zen` CSS).
- R4-2 [State-driven] WHILE the view is bypassed or unfiltered, the zen HUD shall keep the existing "Mask: X · N shown" format with no FILTERED marker.

### M5 — Session restore and mutation-while-bypassed semantics

- R5-1 [Event-driven] WHEN a session reloads while persisted include/exclude rules exist, THEN the master toggle shall come up ON and the badge shall correctly report FILTERED (rules persist across reloads, while the time range, quick filter, level chips, and bookmarks-only state do not — the badge reflects exactly what survived).
- R5-2 [Event-driven] WHEN the user edits any filter while the toggle is OFF, THEN the system shall store the edits without applying them to the current view; WHEN the toggle returns to ON, THEN the stored edits shall apply in full — no partial application and no lost edit.
- R5-3 [State-driven] WHILE bypassed, filter inputs in the Filters tab and the viewer toolbar shall remain fully interactive (not disabled), so editing during bypass is possible and R5-2 is exercisable.
- R5-4 [State-driven] IF the user loads a new file while bypassed, THEN the bypass shall remain in effect for the new file's indexing view and the badge shall stay hidden; toggling ON re-applies the stored filters to the newly loaded data.

## Constraints

Technical constraints:
- No new dependencies; vanilla JS UMD modules only. No network access.
- Single self-contained HTML build via `build.js` must remain intact; the toggle and badge are markup in `template.html` plus glue in `src/app.js`.
- All colors from theme CSS variables (`src/themes.js` palette; six themes) — reuse `var(--warn)`/`var(--accent)`; no literal colors.
- `src/app.js` is exempt from the coverage gate; e2e is the safety net. `src/filters.js` IS gated — any helper logic moved there requires unit coverage in the gated suite.
- `filtersEnabled` must NOT be persisted (add to the `saveState()` strip list); a persisted bypass would make freshly loaded files appear invisible — the exact failure the existing strip list prevents.
- Conventional commits mandatory.
- Priority-based milestones only; no time estimates.

Business constraints:
- The indication must be unmissable enough that a user never forgets they are looking at a narrowed log (the screen-sharing / zen-mode risk), yet silent when nothing is filtered.
- Bypass is non-destructive by definition: the feature must never destroy user-configured filters.

## Technical Notes (file:line touchpoints)

- `src/app.js:14-29` — `defaults()`; add `filtersEnabled: true` here (transient).
- `src/app.js:31-40` — `saveState()`; add `filtersEnabled` to the line-36 destructure strip list (R1-7).
- `src/app.js:699-723` — `rebuildView()`; bypass implementation point: when `filtersEnabled` is false, build the worker `spec` (706-712) without `timeFrom`/`timeTo` (709), `rules`/`quick`/`levels` (708), and `bookmarkOnly` (710).
- `src/app.js:794-795` — `viewIsFiltered()`; add a bypass-aware evaluation (treat as unfiltered while OFF) for R1-5, plus a stored-settings variant for badge visibility (R2-1).
- `src/app.js:796-808` — `markLabel()` band wording; inherits R1-5 automatically once `viewIsFiltered()` is bypass-aware.
- `src/app.js:991-1004` — `updateStatus()`; hook badge visibility/tooltip refresh here (R2-4); `updateZenHud()` call at 1003.
- `src/app.js:1405-1418` — `applyFilters()`; store-edits-without-apply semantics while bypassed (R5-2): persist input values to state, skip the narrowing rebuild (or rebuild unfiltered), and re-apply on toggle-ON.
- `src/app.js:2322-2327` — `setMask()` label + `classList.toggle('on')` precedent for the new toggle.
- `src/app.js:2356-2358` — `updateZenHud()`; append the FILTERED marker per M4.
- `template.html:25` — `button.on` CSS rule (reused as-is).
- `template.html:96-99` — `.badge` variants; `.badge.enc` (line 98) is the `var(--warn)` model for the FILTERED badge.
- `template.html:433` — `#btn-mask`; the new Filter toggle sits adjacent in `#vtools` with the same markup shape.
- `template.html:469-477` — `#statusbar`; add a hidden `#st-filtered` badge span here.
- `template.html:460` — `#zen-hud` element (CSS 116-117, `body.zen` hides the status bar at 107).
- `tests/e2e/app.e2e.spec.mjs:62-90` — `fresh()`, `click()`, `status()` helpers; extend `status()` or use `waitForFunction` on `#st-filtered` for badge assertions.

## Traceability

- SPEC-VIEWER-002 requirement groups M1-M5.
- Touching: `src/app.js`, `template.html`, `tests/e2e/app.e2e.spec.mjs`, `README.md` (Viewer feature prose).
- Not touching: `src/app-paging-worker.js`, `src/paged.js`, `src/filters.js` (unless the stored-settings predicate lands there — then gated unit tests are required), `build.js`.
