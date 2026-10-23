# SPEC-TABS-001 Acceptance Criteria

Given-When-Then scenarios per requirement group, edge cases, success criteria, and validation method.

## M1 — Digit tab switching (R1-1 … R1-5)

### AC-1.1 Each digit switches the right tab
- Given the app is open with no field focused and the Viewer tab active
- When the user presses 2, 3, 4, 5, 6, 7, 8, then 1 in sequence
- Then each press activates exactly the corresponding tab — 2 Multifile search, 3 Filters, 4 Masks, 5 PII, 6 Analysis, 7 Export, 8 Config, 1 Viewer — matching the tab bar order.

### AC-1.2 Modifier combos never switch
- Given the Viewer tab is active and no field is focused
- When the user presses Ctrl+1, Cmd(⌘)+1, Alt+1, or Shift+1
- Then no tab switch occurs (the app ignores modified digits; the browser keeps its reserved Ctrl/Cmd+digit behavior).

### AC-1.3 Digits do not switch tabs in zen mode
- Given zen mode is active (tab bar hidden)
- When the user presses any digit 1-8
- Then no tab switch occurs and zen remains; after exiting zen with Escape, digits switch tabs again.

### AC-1.4 Numpad digits work
- Given no field is focused
- When the user presses a numpad digit (event with `e.key` "1"-"8", code "NumpadN")
- Then the corresponding tab switches, identical to the top-row digit.

## M2 — Text-entry focus guard (R2-1 … R2-3)

### AC-2.1 Digit typed in the quick filter does not switch
- Given focus is in the quick filter field
- When the user types "1" (and "42")
- Then the digits appear in the field text, no tab switch occurs, and the quick filter applies after its debounce as usual.

### AC-2.2 Guard covers all field types
- Given focus is in each of: the rg-pattern field, the go-to-line input, the page-number input, a time-from/to input, the paste area (textarea), a select, and any Config-tab text input
- When the user presses a digit in each
- Then the digit is delivered to that field and no tab switch occurs.

### AC-2.3 Digits still work outside fields
- Given focus is on the page body, a header button, or the viewer rows container
- When the user presses a digit
- Then the corresponding tab switches (the guard swallows nothing outside text entry).

### AC-2.4 contenteditable is guarded
- Given a contenteditable element exists and has focus (present or future app surface)
- When the user presses a digit
- Then no tab switch occurs and the digit goes to the editor.

## M3 — Escape releases field focus (R3-1 … R3-4)

### AC-3.1 Escape from time-from restores single-key behavior
- Given focus is in the time-from field
- When the user presses Escape
- Then the field loses focus (activeElement returns to body) and is no longer focused; pressing "m" afterward toggles the mask without a mouse click — single-key shortcuts work again.

### AC-3.2 Zen exit keeps any-focus precedence
- Given zen mode is active and focus is in the quick filter
- When the user presses Escape
- Then zen exits (the existing any-focus behavior); a second Escape (field now focused, no global surface) blurs the field.

### AC-3.3 Search-all close keeps any-focus precedence
- Given the search-all panel is open and focus is in the quick filter (the documented past-fix scenario)
- When the user presses Escape
- Then the panel closes first; a subsequent Escape blurs the field. The any-focus fix at `src/app.js:2977-2983` does not regress.

### AC-3.4 Existing Escape behaviors preserved
- Given no field is focused
- When the user presses Escape with rows selected, with the files drawer open, and with the theme menu open
- Then the selection clears and the drawer closes as today; the theme menu closes even while a field is focused (its independent listener at `src/app.js:2537`).

### AC-3.5 IME composition not interrupted
- Given an IME composition is in progress in the quick filter (simulated via composition events in e2e)
- When the user presses Escape during composition
- Then the composition is not cancelled by the app, the field keeps focus and its text, and no shortcut fires; after composition ends, Escape blurs the field normally.

## M4 — Discoverability (R4-1, R4-2)

### AC-4.1 Tab buttons expose their digits
- Given the tab bar is rendered
- When each of the eight tab buttons is inspected
- Then each carries a title containing its digit ("… — press N"), and where rendered, a kbd-styled digit label using the existing `kbd` styling.

### AC-4.2 README documents the shortcuts
- Given the README
- When the keyboard shortcut mentions are read
- Then the digit tab mapping and the Escape-releases-focus behavior are documented.

## Edge-Case Scenarios (cross-cutting)

### AC-E.1 Rapid digit switching
- Given the Viewer has a filtered view and analysis data rendered
- When the user presses 6 then 1 rapidly
- Then each tab renders correctly (analysis repaints via `switchTab`, viewer refills via its requestAnimationFrame path) with no stale or blank panel.

### AC-E.2 Digit while a modal-ish surface is open
- Given the search-all panel is open (bottom drawer)
- When the user presses a digit while focus is outside text fields
- Then the tab switches per the existing guard ordering for unmodified keys (same treatment as M/W/B today); focus rules follow the handler's existing order.

### AC-E.3 Escape in a field with modified state
- Given text was typed but not yet applied in the quick filter (debounce pending)
- When the user presses Escape
- Then the field blurs; the debounced filter application completes as designed (blur does not cancel in-flight logic).

### AC-E.4 Files overlay drawer on narrow screens
- Given a narrow viewport where the files panel is an overlay drawer, with the drawer open
- When the user presses a digit outside a text field, then Escape
- Then the tab switch works, and Escape closes the drawer as today.

### AC-E.5 No state leakage across sessions
- Given any tab reached via digit keys
- When the page is reloaded
- Then behavior is unchanged — key bindings are static code and nothing about this feature appears in persisted state.

### AC-E.6 No console errors
- Given any sequence of digit presses, field focus/blur, and Escape presses
- When the e2e `errs` check runs
- Then no console errors are recorded.

## Success Criteria

- All EARS requirements R1-1 through R4-2 implemented and covered by at least one scenario above.
- All eight digit-to-tab mappings verified, fully OS-agnostic (no modifier required, modified digits ignored).
- Typing in any text field is never hijacked; Escape alone always restores keyboard-only navigation.
- Zero regressions in existing Escape behaviors (zen exit, search-all close, theme menu, selection clear, drawer close) and zero regressions in the existing 100 app e2e specs and 8 stress specs.
- IME composition input is never interrupted by the new handling.
- Shortcuts discoverable on the tab bar and documented in the README.

## Validation Method

- `npm run test:gate` — unit suite plus coverage gate (90/85); expected green with zero gated-module changes.
- `npm run e2e` — full Playwright run including the new digit-mapping, focus-guard, Escape-blur, IME, and regression scenarios.
- `node build.js` — build succeeds and the generated single-file HTML is fresh (diff-clean regeneration).
