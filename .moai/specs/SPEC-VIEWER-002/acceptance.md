# SPEC-VIEWER-002 Acceptance Criteria

Given-When-Then scenarios per requirement group, edge cases, success criteria, and validation method.

> **Amendment 1 (2026-10-19):** the scenarios below were written for v1.0.0, where
> the OFF bypass suspended the quick filter too. As of v1.1.0 the quick filter is
> renamed "quick scan" and ALWAYS narrows/highlights in both toggle states; the
> scenarios in "Amendment 1 acceptance" at the bottom override any scenario they
> contradict (notably AC-1.1, AC-1.3, AC-2.1, AC-3.1, AC-4.2, AC-5.2, AC-5.4, AC-E.4, AC-E.5).

## Amendment 1 acceptance — quick scan decoupling (overrides above where contradictory)

### AC-A.1 Quick scan narrows while bypassed (overrides AC-1.1, AC-5.2)
- Given the toggle is OFF with no quick scan configured (the full log is shown)
- When the user types a quick scan pattern in the viewer toolbar
- Then the view narrows to the matching lines immediately (past the debounce), the matches carry `<mark>` highlights, and the FILTERED badge appears with the tooltip "quick scan".

### AC-A.2 Badge/band/HUD truthfulness with only the quick scan while OFF (overrides AC-2.1, AC-1.3, AC-4.2, AC-E.4, AC-E.5)
- Given only a quick scan is configured and the toggle is OFF
- When the status bar, band labels, and zen HUD render
- Then the badge is visible with tooltip "quick scan" (suspended categories are NOT listed), the bands keep the "first/last match in …" wording, and the zen HUD keeps the "· FILTERED" marker.
- When instead nothing narrows at all while OFF (e.g. only a rule is configured)
- Then the badge is hidden, the bands read "start/end of …", and the HUD drops the marker.

### AC-A.3 OFF→ON re-anchors with quick scan + rule
- Given a quick scan and an exclude rule both active (ON) on a large file, scrolled so a specific line sits at the viewport top
- When the user toggles OFF (rule lifted, quick scan still narrowing) and back ON (rule re-applied)
- Then in both transitions the previously top visible line is restored at the top of the viewport (identity anchoring), and the shown count changes exactly between the quick-only and quick+rule sets.

### AC-A.4 Toggle stays an exact no-op only when nothing narrows
- Given no narrowing input at all (no quick scan, rules, chips, time range, bookmarks-only)
- When the toggle is flipped OFF and ON
- Then scrollTop and the top visible line are exactly unchanged (no rebuild).

### AC-A.5 Rename
- Given any viewer/search surface with quick-scan wording (placeholder, Search all tooltip, find hint, empty-pattern flash, badge/toggle tooltips)
- When the UI text is inspected
- Then user-facing strings read "quick scan"; internal identifiers (`state.quick`, `#quick`, engine field) are unchanged.


## M1 — Master Filter toggle (R1-1 … R1-7)

### AC-1.1 Toggle flips the view immediately
- Given a loaded file with a quick filter that narrows 500 lines to 44 (badge visible, matching count 44)
- When the user clicks the "Filter: ON" toolbar toggle
- Then the button reads "Filter: OFF", the `on` class is removed, every indexed line is shown (matching equals total), and the view is not cleared or reloaded destructively.

### AC-1.2 Round-trip preserves all settings exactly
- Given a time range set, two exclude rules and one include rule enabled, level chips E and W selected, a quick filter typed, and bookmarks-only ON
- When the user toggles OFF and then back ON
- Then the Filters tab shows the identical time range, all three rules in the same order and enabled state, the same chips selected, the same quick filter text, and bookmarks-only still active; the shown count after re-apply equals the count before the round-trip.

### AC-1.3 Bypassed band labels read as unfiltered
- Given filters are active with the "first/last match in …" band wording showing and the toggle then set to OFF
- When the user scrolls to the window bounds
- Then the bands read the unfiltered "start of …"/"end of …" wording, because the bypassed view is treated as unfiltered.

### AC-1.4 No clear-all affordance appears
- Given the Viewer tab with active filters in any toggle state
- When the user inspects the toolbar, chips row, and badge
- Then no clear-all or reset control exists there; clearing filters remains possible only in the Filters tab.

### AC-1.5 Bypass never persists across sessions
- Given the toggle is OFF
- When the page is reloaded (state persisted, filters cleared as today)
- Then the new session starts with the toggle ON and the label "Filter: ON".

## M2 — FILTERED badge (R2-1 … R2-4)

### AC-2.1 Badge visibility matrix
- Given the four combinations of (filters configured, not configured) × (toggle ON, OFF)
- When the status bar renders
- Then: filters configured + ON → "FILTERED" badge visible; filters configured + OFF → badge hidden; no filters + ON → badge hidden; no filters + OFF → badge hidden.

### AC-2.2 Badge refreshes on filter mutation
- Given no filters are active and the badge is hidden
- When the user adds an exclude rule in the Filters tab (without visiting the Viewer)
- Then the badge is visible on return; when the rule is removed or disabled, the badge disappears immediately.

### AC-2.3 Badge styling uses theme variables only
- Given any of the six themes is active
- When the badge is visible
- Then it uses the existing badge pill styling with `var(--warn)` coloring and reads correctly in all themes (spot-check at least Midnight and Paper).

## M3 — Plain-language tooltip (R3-1 … R3-4)

### AC-3.1 Tooltip lists active categories
- Given a time range, two exclude rules, chips E and W, and a quick filter are active with the toggle ON
- When the user hovers the FILTERED badge or the Filter toggle
- Then the tooltip enumerates exactly the active categories in plain language, for example "time range, 2 exclude rules, levels E W, quick filter" — no raw rule ids, regex sources, or internal keys.

### AC-3.2 Tooltip when nothing is active
- Given no narrowing filter is configured
- When the user hovers the Filter toggle
- Then the tooltip states that no filters are active and the full log is shown (no empty enumeration).

### AC-3.3 Toggle tooltip explains both states
- Given any toggle state
- When the user reads the toggle's tooltip
- Then it explains that OFF suspends filters without deleting them and that settings remain in the Filters tab.

## M4 — Zen HUD (R4-1, R4-2)

### AC-4.1 Zen HUD shows the filtered marker
- Given filters are narrowing the view, the toggle is ON, and zen mode is entered
- When the zen HUD renders
- Then it reads like "Mask: ON · FILTERED · 12 shown" — the marker present in addition to mask state and shown count.

### AC-4.2 Zen HUD unchanged when not narrowing
- Given the view is bypassed or no filters are configured, in zen mode
- When the HUD renders
- Then it keeps the exact existing "Mask: X · N shown" format with no FILTERED marker.

## M5 — Session restore and mutation-while-bypassed (R5-1 … R5-4)

### AC-5.1 Rules persist across reload, time range does not
- Given a persisted exclude rule and a time range are both set, with the badge visible
- When the session is reloaded
- Then the toggle comes up ON, the rule survives and the badge is visible, while the time range is empty (transient) and the tooltip no longer mentions a time range.

### AC-5.2 Edits while bypassed apply in full on re-enable
- Given the toggle is OFF and the view shows all lines
- When the user changes the quick filter text and adds another exclude rule
- Then the view remains unfiltered (no partial application, shown count unchanged); when the toggle returns to ON, the edited quick filter and the new rule apply together in one pass.

### AC-5.3 Filter inputs stay interactive while bypassed
- Given the toggle is OFF
- When the user opens the Filters tab
- Then rule editors, chips, time inputs, and the quick filter are enabled and editable (not grayed out).

### AC-5.4 New file load while bypassed
- Given the toggle is OFF with filters configured
- When the user loads a new file
- Then all of the new file's lines are shown, the badge stays hidden, and toggling ON re-applies the configured filters to the newly loaded data.

## Edge-Case Scenarios (cross-cutting)

### AC-E.1 Bookmarks-only counts as narrowing
- Given only the bookmarks-only chip is active (no rules, chips, time range, or quick filter)
- When the toggle is ON
- Then the badge is visible and the tooltip mentions bookmarks only; toggling OFF shows every line.

### AC-E.2 Disabled rules do not trigger the badge
- Given rules exist but all are disabled and nothing else narrows the view
- When the status bar renders
- Then the badge is hidden (disabled rules are not active filters).

### AC-E.3 Toggle during a busy operation
- Given a large file is mid-filter (busy overlay visible)
- When the user flips the toggle
- Then the flip is not lost: the pending rebuild resolves and the toggle's semantics are honored by the next rebuild (existing viewToken guard behavior).

### AC-E.4 Empty result set round-trip
- Given filters active that match zero lines
- When the toggle is flipped OFF and ON
- Then OFF shows every line (never an empty view from the bypass) and ON restores the zero-match state with the badge visible.

### AC-E.5 Zen toggle interaction
- Given zen mode is active with filters ON
- When the user toggles the Filter OFF (via the toolbar, exiting zen or beforehand)
- Then the HUD marker disappears live and the shown count jumps to the total without leaving zen.

### AC-E.6 Demo log smoke
- Given the Demo log is loaded and default masks/filters apply
- When the user exercises the toggle and badge through one full round-trip
- Then no console errors are recorded (the e2e `errs` check stays empty).

## Success Criteria

- All EARS requirements R1-1 through R5-4 implemented and covered by at least one scenario above.
- Bypass is truly non-destructive: a toggle round-trip is observably lossless for all five filter categories (AC-1.2).
- The badge never lies: all four visibility quadrants verified (AC-2.1), and the zen HUD mirrors it where the status bar cannot (AC-4.1/4.2).
- A new session always starts with filters active (AC-1.5) — no persisted bypass.
- No clear-all affordance is added to the Viewer (AC-1.4).
- No regressions in the existing 100 app e2e specs and 8 stress specs.

## Validation Method

- `npm run test:gate` — unit suite plus coverage gate (90/85); expected green with zero gated-module changes.
- `npm run e2e` — full Playwright run including the new scenarios (badge matrix, round-trip, zen HUD, restore, mutate-while-bypassed).
- `node build.js` — build succeeds and the generated single-file HTML is fresh (diff-clean regeneration).
- Manual: six-theme spot-check of badge and toggle styling.
