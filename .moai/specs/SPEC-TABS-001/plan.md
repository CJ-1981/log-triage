# SPEC-TABS-001 Implementation Plan

Related: `spec.md` (EARS requirements R1-1 through R4-2), `acceptance.md` (scenarios).

## Milestones (priority-based)

- Primary goal: digit keys 1-8 switch tabs with the text-entry focus guard (M1 + M2) — the core navigation gain.
- Secondary goal: Escape releases text-field focus without regressing existing Escape behaviors (M3) — the user-reported gap.
- Final goal: discoverability (tab titles / kbd digit hints) and README documentation (M4) with full e2e coverage.

Dependency note: M1/M2 land together (the guard and the digit mapping are one handler change). M3 is an independent branch of the same handler and can land in the same or a follow-up commit. M4 is trivial and independent.

## Design Decisions (locked)

- One insertion point: the existing central document keydown (`src/app.js:2956-2989`). No second document-level listener — competing listeners are how the current ordering bugs were born.
- Handler ordering preserved and extended, top to bottom: modifier shortcuts (Ctrl/Cmd+Enter, Ctrl/Cmd+F) → zen-exit and search-all-close Escape branches (2982-2983, unchanged, any-focus) → NEW Escape-blur-field branch (field focused + not composing → blur, preventDefault, return) → extended field guard (INPUT/TEXTAREA/SELECT/contenteditable early-return, now via a shared predicate) → single-key shortcuts M/W/B extended with the digit map → remaining Escape branch (selection clear + drawer close, 2988).
- Rationale for the blur branch placement: zen exit and search-all close were deliberately fixed to work from ANY focus (in-code comment 2977-2981); putting blur before them would regress that fix. Blur sits after them so the first Escape dismisses the global surface and the next Escape releases the field. The theme menu close (2537) is an independent listener and keeps working regardless.
- Digit map: constant array `['viewer','search','filters','masks','pii','analysis','export','config']` indexed by `e.key` digit minus 1, mapped through `switchTab()` — order-derived per R1-2, no per-button data attribute required (though the title hints are per-button markup).
- Modifiers rejected: digits only fire when `!ctrlKey && !metaKey && !altKey && !shiftKey` (R1-3).
- Zen suppression: digits require `!state.zenOn` (R1-4) — CSS hides `#tabs` under `body.zen` but the buttons remain in the DOM, so the check must be in the handler.
- Shared text-entry predicate: `isTextEntry(el)` covering INPUT/TEXTAREA/SELECT plus `isContentEditable` (R2-2), used by both the Escape-blur branch and the field guard, replacing the bare tagName check at 2984.
- IME safety: the Escape-blur branch checks `e.isComposing` like the Enter handlers at 2759/2813 (R3-3).
- Discoverability: `title="… — press N"` on all eight tab buttons (only search has a title today); kbd digit labels only if they do not crowd narrow viewports — titles are the committed part, kbd labels optional.
- Nothing persisted: no state, no `saveState()` change.

## File-by-file Changes

### src/app.js (browser-only glue; exempt from coverage gate)

1. Shared predicate (new, near the keydown handler):
   - `isTextEntry(el)`: true for INPUT/TEXTAREA/SELECT tags and `el.isContentEditable`. Replace the tagName check at 2984 with this predicate.
2. Digit map + handler extension (inside the 2956 handler, after the field guard):
   - Tab-name constant array; on plain digit 1-8 with `!e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && !state.zenOn`, call `switchTab(name)`; no preventDefault needed (digits have no default page action to suppress) unless testing shows scroll-by-digit side effects.
3. Escape-blur branch (between the 2983 sall-close branch and the field guard):
   - `if (e.key === 'Escape' && !e.isComposing && isTextEntry(e.target)) { e.target.blur(); e.preventDefault(); return; }`
   - Zen and sall branches above it keep their any-focus precedence (R3-2).
4. No changes to `switchTab()` (2309-2321), tab click registration (2673), theme menu listener (2537), or the M/W/B/Ctrl+C/Ctrl+A branches.

### template.html

- `#tabs` buttons (373-380): add `title="… — press N"` to each of the eight buttons (the search button merges its existing long title with the press hint).
- Optional: a `<kbd>N</kbd>` digit label inside each button reusing the `kbd` rule (line 329), `#sall-kbd` style; include only if it survives the narrow-viewport check without crowding — otherwise titles alone satisfy R4-1.

### tests/e2e/app.e2e.spec.mjs

- New specs (see Test Plan) using `page.keyboard.press('1')` … `'8'`, `page.keyboard.press('Escape')`, field focusing via `page.focus`/click, and active-tab assertions on `#tabs button.active` / `#tab-<name>.active`.

### README.md

- Add digit shortcuts and Escape-releases-focus to the keyboard shortcut mentions (~line 33 and the tab/feature prose at 70-81).

### Gated-module note

- Zero changes to gated modules (`src/filters.js` untouched); the coverage gate (90/85) is a regression check only. All logic lives in `app.js` (exempt) and markup.

## Task Decomposition (with dependencies)

1. Task A (no deps): `isTextEntry()` predicate; replace the 2984 tagName check. [M2, R2-2]
2. Task B (depends on A): digit map constant + digit branch with modifier and zen guards. [M1, R1-1 … R1-5]
3. Task C (depends on A): Escape-blur branch with isComposing guard, ordered after zen/sall branches. [M3, R3-1 … R3-4]
4. Task D (no deps): tab button titles (+ optional kbd labels) in template.html. [M4, R4-1]
5. Task E (depends on B, C): e2e scenarios (see Test Plan).
6. Task F (depends on D): README documentation. [M4, R4-2]

TDD sequence: write the failing e2e specs for Task B (digit mapping + guards) and Task C (Escape blur) first, then implement, then add the discoverability/doc tasks.

## Test Plan

Unit (node --test):
- Expected: no gated module changes; `npm run test:gate` stays green as a regression check only.

E2E (Playwright) — failing specs written before the implementation they cover:
- Digit mapping: fresh page, press 1 through 8 in order; assert the corresponding tab is active each time (`#tabs button.active` dataset and `#tab-<name>.active`), covering all eight mappings.
- Focus guard: focus `#quick`, type "1"; assert the quick filter contains "1", no tab switch occurred, and the shown count reflects the quick filter after debounce. Repeat for `#rg-pattern` and `#time-from` (at least one input, one textarea/paste area if reachable, one select).
- Modifier rejection: press Ctrl+1 and Cmd+1 (Meta+1) on the Viewer tab; assert no tab switch (browser-reserved combos must be ignored by the app).
- Escape blur: focus `#time-from`, press Escape; assert the field no longer has focus (`document.activeElement` is body), then press "m" and assert the mask toggled — single-key shortcuts work again without a mouse.
- Escape precedence: enter zen with focus in `#quick`; press Escape → zen exits (not just blur); with the search-all panel open and focus in `#quick`, press Escape → panel closes; press Escape again → field blurs.
- No regression: Escape with no field focused still clears the selection and closes the files drawer (existing behavior assertions); theme menu opens and closes with Escape while a field is focused.
- IME safety: simulate composition (keyboard.insertText / composition events) in `#quick`, press Escape during composition; assert the composition is not interrupted (field keeps focus and text).
- Zen suppression: enter zen, press digits 1-8; assert no tab switch and zen remains; exit zen with Escape, digits work again.
- Discoverability: assert each of the eight tab buttons has a title containing "press N" for its digit.

## Risks and Mitigations

1. Escape regression (highest): the blur branch accidentally shadowing zen exit or search-all close. Mitigation: branch ordering locked in the design decision; dedicated precedence e2e (zen-from-field, sall-close-from-field).
2. Double-handling from multiple listeners: adding a second document keydown would desynchronize ordering. Mitigation: single central handler only; no new listeners.
3. IME interruption: Escape during composition on CJK input. Mitigation: `isComposing` guard mirroring 2759/2813; composition e2e.
4. contentEditable gap: the old tagName check misses it; missed predicate use would let digits leak into editors. Mitigation: single shared predicate used by both branches.
5. Digit side effects: some browsers scroll or navigate on digits in rare contexts. Mitigation: evaluate preventDefault in the digit branch during e2e; default is no preventDefault unless a test shows leakage.
6. Narrow-viewport crowding from kbd labels: mitigate by making kbd labels optional; titles are the committed deliverable.

## Conventional Commits (planned series)

- `feat(ui): switch tabs with plain digit keys 1-8 outside text fields`
- `feat(ui): Escape releases text-field focus back to the page`
- `feat(ui): digit shortcut hints on tab buttons`
- `test(e2e): cover digit tab switching, focus guard, and Escape blur`
