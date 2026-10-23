---
id: SPEC-TABS-001
version: "1.0.0"
status: "completed"
created: "2026-10-19"
updated: "2026-10-19"
author: "CJ-1981"
priority: "MEDIUM"
---

# SPEC-TABS-001: Keyboard Tab Switching and Focus Release

## HISTORY

| Date | Version | Author | Change |
|---|---|---|---|
| 2026-10-19 | 1.0.0 | CJ-1981 | Initial draft. User-reported gap and user-requested enhancement: OS-agnostic digit keys 1-8 for tab switching with a text-entry focus guard, plus Escape releasing text-field focus so single-key shortcuts work again without a mouse. All design decisions resolved at plan-approval time. |

## Environment

- Privacy-first, browser-only log triage tool. Vanilla JS UMD modules, no framework, no network, no new dependencies.
- Single self-contained HTML artifact built by `build.js` from `template.html` plus `src/` modules. The single-file build invariant must not be broken.
- Tab bar: eight buttons in `#tabs` (`template.html:372-381`) — 1 Viewer, 2 Multifile search, 3 Filters, 4 Masks, 5 PII, 6 Analysis, 7 Export, 8 Config — in that visual order; only the search button currently carries a `title` (line 375). Click handlers are registered centrally at `src/app.js:2673` calling `switchTab(name)` (`src/app.js:2309-2321`).
- Document-level keydown: one central handler at `src/app.js:2956-2989`. Its structure, in order: Ctrl/Cmd+Enter (Search all), Ctrl/Cmd+F (focus quick filter), Escape exits zen (2982), Escape closes the search-all panel (2983), an INPUT/TEXTAREA/SELECT early-return guard (2984) that deliberately lets typed keys pass through fields untouched, then single-key shortcuts M/W/B, Escape (selection clear + drawer close, 2988), Ctrl+C, Ctrl+A. The 2977-2981 comment documents that zen exit and panel close intentionally work from ANY focus — a past fix that must not regress.
- IME safety precedent: `e.isComposing` guards exist on the quick filter and rg-pattern Enter handlers (`src/app.js:2759`, `2813`); composition input must never be interrupted.
- Text fields in the app: quick filter (`#quick`), rg-pattern, go-to-line (`#goto-ln`), page number, time-from/to, paste area, search tab fields, and various Config/PII inputs and textareas. The 2984 guard covers INPUT/TEXTAREA/SELECT but NOT `contenteditable` elements.
- Theme menu: its own document keydown closes it on Escape from any focus (`src/app.js:2537`), independent of the central handler.
- Zen mode: `body.zen` CSS hides the header including `#tabs` (`template.html:107`); zen is a viewer focus mode exited by Escape or the floating ✕ (`setZen`, `src/app.js:2360+`). Files panel: sidebar with an overlay drawer treatment on narrow screens (`#drawer`, `template.html:446`; closed via the existing Escape branch at 2988).
- kbd hint precedent: `kbd` CSS rule (`template.html:329`) and the `#sall-kbd` element inside `#btn-sall` (`template.html:432`) from SPEC-VIEWER-001.
- Tests: Playwright e2e in `tests/e2e/app.e2e.spec.mjs` (100 app specs) with helpers `fresh()` (62), `click(id)` (72), `status()` (76); `node --test` unit suites with the coverage gate (90/85) on core modules — `app.js` is exempt, `src/filters.js` IS gated. Keyboard interaction is e2e territory.
- No state is introduced by this SPEC: key bindings are static; nothing to persist.

## Assumptions

- The INPUT/TEXTAREA/SELECT early-return at `src/app.js:2984` is the correct insertion point for the digit handler: digits registered after that guard inherit the field guard for the three tagged element types. Confidence: High (evidence: the guard's existing role for M/W/B).
- `contenteditable` is not used in the app today but the guard must still cover it explicitly per the requirement, since the tagged-element check does not. Confidence: High for the gap; the element check is one extra predicate.
- Digit keys (top row and numpad) produce `e.key` values "1"-"8" across the three target browsers without modifiers, so a plain `e.key` match is OS- and layout-safe enough; modifier combos are rejected by checking `ctrlKey/metaKey/altKey/shiftKey` are all false. Confidence: High.
- Zen mode must suppress digit switching: the tab bar is CSS-hidden (`body.zen`, `template.html:107`) but the buttons remain in the DOM, so a `state.zenOn` check is required in the handler — CSS hiding alone does not stop keyboard events. Confidence: High.
- Escape-in-field must NOT preempt the zen-exit and search-all-close branches (2982-2983): those were deliberately fixed to work from ANY focus (comment 2977-2981), so the blur branch must sit after them. Without this ordering, pressing Escape with focus in the quick filter and the panel open would only blur, regressing the documented fix. Confidence: High (evidence: in-code comment); resolved at plan approval.
- No existing shortcut uses plain digits 1-8 at the document or viewer level (verified: no digit bindings in `src/app.js`), so the mapping is conflict-free. Confidence: High.

## Requirements (EARS)

### M1 — Digit tab switching (OS-agnostic)

- R1-1 [Event-driven] WHEN the user presses a plain digit key 1-8 without any modifier and focus is outside text-entry surfaces, THEN the system shall switch to the corresponding tab via the existing `switchTab()`: 1 Viewer, 2 Multifile search, 3 Filters, 4 Masks, 5 PII, 6 Analysis, 7 Export, 8 Config.
- R1-2 [Ubiquitous] The system shall map digits to tabs in the visual order of the `#tabs` buttons, so the mapping stays correct if tab labels change.
- R1-3 [Unwanted] The system shall not switch tabs on modified digits (Ctrl+, Cmd/⌘+, Alt+, Shift+digit) — browsers reserve Ctrl/Cmd+digit for their own tab switching, and the feature must stay OS-agnostic with no modifier requirement.
- R1-4 [State-driven] WHILE zen mode is active, digit keys shall not switch tabs; zen is a viewer focus mode and Escape exits it first.
- R1-5 [State-driven] WHILE the search-all panel drawer or the files overlay drawer has focus-visible state that the existing handler would swallow keys for, digit behavior shall follow the same guard ordering as the existing single-key shortcuts (digits are ordinary unmodified keys under the 2984-style guard).

### M2 — Text-entry focus guard

- R2-1 [State-driven] WHILE focus is inside an input, textarea, select, or contenteditable element, digit keys shall not switch tabs and shall be delivered to the field for normal text entry.
- R2-2 [Ubiquitous] The system shall extend the existing field guard to cover `contenteditable` in addition to INPUT/TEXTAREA/SELECT, so the digit guard and the existing M/W/B guard share one predicate.
- R2-3 [Unwanted] The guard shall not swallow digits when focus is on the page body, header buttons, viewer rows, or the search-all panel — outside text fields the digits must work.

### M3 — Escape releases field focus

- R3-1 [Event-driven] WHEN Escape is pressed while a text field (input, textarea, or contenteditable) has focus AND no higher-priority global Escape surface is active AND IME composition is not in progress, THEN the system shall blur the field, releasing focus back to the page so single-key shortcuts (M, W, B, digits, Ctrl+A) work again without a mouse click.
- R3-2 [Event-driven] WHEN zen mode is active or the search-all panel is open, THEN Escape shall continue to exit zen / close the panel first even when a field has focus, preserving the existing any-focus behavior (the deliberate fix documented at `src/app.js:2977-2983`); only after those surfaces are closed does a subsequent Escape blur the field.
- R3-3 [State-driven] IF IME composition is in progress (`e.isComposing`, following the guards at `src/app.js:2759`/`2813`), THEN Escape shall neither blur the field nor trigger any shortcut, so composition cancel/confirm stays with the IME.
- R3-4 [Ubiquitous] The system shall preserve all existing Escape behaviors: theme menu close (`src/app.js:2537`, independent listener), zen exit, search-all panel close, selection clear, and files drawer close (2988) — the latter two now run when no field is focused, or on a subsequent Escape after the blur.

### M4 — Discoverability

- R4-1 [Optional-feature-state] WHERE the tab bar is visible, each tab button shall expose its digit: a `title` attribute of the form "… — press N" on every tab button, and a small kbd-styled digit label reusing the existing `kbd` CSS rule (`template.html:329`, `#sall-kbd` precedent) where it does not crowd the label.
- R4-2 [Ubiquitous] The README shall document the digit tab shortcuts and the Escape-releases-focus behavior alongside the existing keyboard shortcut mentions.

## Constraints

Technical constraints:
- No new dependencies; vanilla JS UMD modules only. No network access.
- Single self-contained HTML build via `build.js` must remain intact.
- No state to persist — key bindings are static code; no `saveState()` changes.
- `src/app.js` is exempt from the coverage gate; e2e is the safety net. No changes to gated modules (`src/filters.js` untouched) are expected or permitted by this SPEC.
- The handler must follow the existing document keydown's structure and ordering (modifier combos first, then global Escape surfaces, then the field guard, then single-key shortcuts) — no second competing keydown listener at document level for digits or blur.
- IME safety: all new key handling respects `e.isComposing` like the existing Enter handlers.
- Conventional commits mandatory.
- Priority-based milestones only; no time estimates.

Business constraints:
- Fully OS-agnostic: macOS, Windows, Linux behave identically — deliberately NOT Ctrl/Cmd+digit, which browsers reserve.
- A user must never be trapped: after typing in any field, Escape alone must restore keyboard-only navigation.
- Existing Escape behaviors must not regress, in particular the any-focus zen exit and search-all panel close.

## Technical Notes (file:line touchpoints)

- `template.html:372-381` — `#tabs` buttons; add per-button `title` (and optional kbd digit label) here.
- `template.html:329` — `kbd` CSS rule; `template.html:432` — `#sall-kbd` precedent inside `#btn-sall`.
- `src/app.js:2309-2321` — `switchTab(name)`; digits call this, no changes expected.
- `src/app.js:2673` — central tab click registration; digit mapping defined adjacent to it or as a constant near the keydown handler.
- `src/app.js:2956-2989` — the central document keydown; insertion points: digit mapping after the field guard (2984) with the zen check; Escape-blur branch after the zen/sall Escape branches (2982-2983) and before the selection-clear branch (2988), replacing the bare field guard for the Escape key.
- `src/app.js:2984` — INPUT/TEXTAREA/SELECT early-return; extend to a shared `isTextEntry(target)` predicate including `contenteditable` (R2-2).
- `src/app.js:2759, 2813` — `isComposing` guards to mirror for Escape (R3-3).
- `src/app.js:2537` — theme menu Escape listener (independent; must keep working).
- `src/app.js:2360+` — `setZen()` / `state.zenOn` used for the zen suppression check (R1-4).
- `README.md` (~line 33 and the Viewer/tab feature prose at 70-81) — document the shortcuts.
- `tests/e2e/app.e2e.spec.mjs:62-90` — helpers; new specs use `page.keyboard.press('1'…'8')`, focus fields, and assert `#tabs button.active`.

## Traceability

- SPEC-TABS-001 requirement groups M1-M4.
- Touching: `src/app.js` (central keydown only), `template.html` (tab titles/labels), `tests/e2e/app.e2e.spec.mjs`, `README.md`.
- Not touching: `src/filters.js` or any gated module, `src/app-paging-worker.js`, `build.js`, `switchTab()` internals.
