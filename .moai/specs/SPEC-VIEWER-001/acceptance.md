# SPEC-VIEWER-001 Acceptance Criteria

Given-When-Then scenarios per requirement group, edge cases, success criteria, and validation method.

## M1 — Continuous scroll-down (R1-1 … R1-4)

### AC-1.1 Seamless append at the bottom edge
- Given a file with at least 1,001 matching lines and page 1 loaded in the viewer
- When the user wheels down until scrollTop + clientHeight reaches scrollHeight − 2
- Then the next 500 rows appear below without the view being replaced, the scroll position is not reset, rendered line numbers continue past the old page boundary, and the pager still shows the anchor page.

### AC-1.2 No duplicate fetch while in flight
- Given an append fetch is in flight (append triggered, not yet resolved)
- When the user wheels past the bottom edge again before resolution
- Then exactly one page request is issued (the wheelPaging flag and cooldown suppress duplicates) and the viewer does not enter a broken or double-appended state.

### AC-1.3 No fetch past the final page
- Given the window's last page is the final page of the filtered view
- When the user wheels down at the bottom edge
- Then no page request is issued and the "end of results" mark is shown.

## M2 — Continuous scroll-up (R2-1 … R2-3)

### AC-2.1 Prepend keeps the viewport anchored
- Given the window starts at page N greater than 0
- When the user wheels up to scrollTop 0
- Then the previous page is prepended, the same first visible log line remains under the viewport (scrollTop compensation applied after render), and no pagination jump occurs.

### AC-2.2 Wrap-mode prepend anchoring
- Given wrap mode is ON and the window starts at page N greater than 0
- When the user wheels up across the top edge
- Then wrap heights for the prepended rows are recalculated before compensation, and the first visible line is unchanged (the highlight or first visible text is identical before and after).

### AC-2.3 Boundary marks reflect global bounds
- Given the user has scrolled so the window covers pages 3-5 of 10
- When renderRows runs
- Then neither the "start of results" nor the "end of results" mark is rendered; Given the window includes global line 1 or the last matching line
- Then the corresponding mark is rendered exactly once.

## M3 — Bounded window (R3-1 … R3-4)

### AC-3.1 Cap enforced under sustained scroll
- Given the user wheels down continuously through many pages
- When the view would exceed 5 pages (2,500 rows)
- Then the view holds at most 2,500 rows at any time, the farthest top page is evicted, the user's visible lines do not shift, and scrolling continues seamlessly.

### AC-3.2 Eviction on prepend
- Given the window holds 5 pages and the user wheels up across the top edge
- When the previous page is prepended
- Then the farthest bottom page is evicted, seqToIdx and height prefix sums are rebuilt, and visible lines are unchanged.

### AC-3.3 Collapse on filter change
- Given an extended multi-page window is active
- When the user changes the quick filter
- Then the window collapses to a single anchor page via loadPage and all window-specific state (marks, heights, cache) is consistent for the single page.

### AC-3.4 Collapse on pagination jump
- Given an extended multi-page window is active
- When the user clicks next (or types a page number, or uses go-to-line)
- Then exactly the requested page loads with existing replacement behavior and the scroll position resets as today.

## M4 — Pagination and jump preservation (R4-1 … R4-4)

### AC-4.1 Buttons reflect anchor page
- Given an extended window whose anchor is page 2 with window pages 2-5
- When the user inspects the pager
- Then the page number shows 2, the range text shows page 2's line range, prev is enabled, and first is enabled; when the anchor is page 1, first and prev are disabled as today.

### AC-4.2 Keyboard paging stays a jump
- Given any window state
- When the user presses Ctrl+Home, PageUp, PageDown, or Ctrl+End
- Then an explicit loadPage jump occurs to the first/previous/next/last page exactly as today, resetting to a single page.

### AC-4.3 Go-to-line and locate jumps unchanged
- Given a loaded file
- When the user types a line number in go-to-line, or a search-all result triggers a jump
- Then the viewer lands on the exact requested line with existing behavior.

## M5 — Platform-aware Search-all hint (R5-1 … R5-5)

### AC-5.1 Hint visible with default platform text
- Given the viewer tab is open on a desktop viewport wider than 560 px
- When the user looks at the Search all button
- Then a kbd hint is visible adjacent to the label showing "Ctrl+Enter" (on Windows/Linux or fallback) with the existing kbd styling, and the title tooltip is unchanged.

### AC-5.2 Mac platform detection
- Given a browser context where the platform resolves to macOS (emulated in e2e via addInitScript overriding navigator.platform / userAgentData)
- When the viewer renders
- Then the hint reads "⌘Enter".

### AC-5.3 Narrow viewport hides the hint
- Given a viewport of 560 px or narrower
- When the vtools are collapsed (default on narrow screens)
- Then the Search all button and its hint are both hidden, consistent with .vt-sec behavior; expanding vtools shows both.

### AC-5.4 Shortcut still works with both modifiers
- Given files are loaded and the viewer tab is active
- When the user presses Ctrl+Enter or Cmd(⌘)+Enter
- Then Search all runs exactly as before.

## M6 — Selection persistence (R6-1 … R6-10)

### AC-6.1 Selection survives append
- Given a row on page 1 is selected (highlighted) and the window is page 1
- When the user wheels down and page 2 is appended
- Then the selected row remains highlighted at its remapped position and the selection set is unchanged.

### AC-6.2 Selection survives prepend and eviction
- Given a row is selected in the window
- When pages are prepended above and the farthest page (containing another selected row at the opposite end) is evicted
- Then remaining selections stay highlighted at correct remapped positions, and the view never shows a highlight on the wrong line.

### AC-6.3 Selection survives a pagination jump
- Given a row on page 2 is selected
- When the user jumps to page 5 via the page-number input (loadPage replacement)
- Then the selection is not cleared; because the row is off-window no highlight shows, the status count excludes it, and
- When the user navigates back (paging, go-to-line, or search-all click-to-jump) so the row re-enters the window
- Then the highlight is restored automatically.

### AC-6.4 Off-window selection degrades gracefully
- Given a selection containing rows outside the current window
- When the user copies the selection (Ctrl+C or Copy selection) or exports the selection
- Then only in-window selected rows are copied/exported, no error occurs, and off-window rows remain selected.

### AC-6.5 Filter change keeps matching selections only
- Given selected rows exist and the user applies a quick filter that excludes some selected lines
- When the filtered view loads
- Then matching selected lines still highlight when in-window; excluded lines are inert (no highlight, excluded from count/copy/export) but remain stored; clearing the filter restores their highlights; Escape clears everything.

### AC-6.6 Multi-row selection semantics
- Given the user shift-clicks a row with an anchor set
- When the range is applied
- Then all window rows between anchor and click are selected by global id; ctrl/cmd-click toggles a single row; Ctrl+A selects all rows in the current window; Escape clears the whole selection including off-window entries.

## Edge-Case Scenarios (cross-cutting)

### AC-E.1 Selection + wrap mode
- Given wrap mode is ON and a wrapped (multi-visual-row) line is selected
- When pages are appended, prepended, or evicted
- Then the selection highlight follows the correct logical line and wrap heights stay consistent.

### AC-E.2 Selection on an evicted page then scroll back
- Given a selected row whose page was evicted after sustained scrolling
- When the user wheels back toward it and the page is re-fetched into the window
- Then the highlight is restored from the stored global id without user action.

### AC-E.3 Empty file and single-page file
- Given a file with zero matching lines, or fewer than 500 matching lines
- When the user wheels at either edge
- Then no append/prepend is attempted, marks render correctly, and no errors occur.

### AC-E.4 Zen mode
- Given zen mode is active (only the viewer visible)
- When the user wheels across page boundaries
- Then continuous scrolling behaves identically and the pager state remains consistent upon exit.

### AC-E.5 Wheel-up at global top / wheel-down at global bottom
- Given the window already includes global line 1 (or the last matching line)
- When the user wheels further in that direction
- Then nothing changes: no fetch, no scroll movement beyond the natural clamp, and the boundary mark stays visible.

### AC-E.6 Platform detection fallback
- Given a context where neither userAgentData nor a recognizable navigator.platform is available
- When the hint renders
- Then it shows "Ctrl+Enter" and the application logs no error.

## Success Criteria

- All EARS requirements R1-1 through R6-10 implemented and verified by at least one scenario above.
- Continuous scrolling: no visible page jump in either direction; visible lines never shift on append, prepend, or eviction.
- Memory bound: the in-memory view never exceeds 2,500 rows regardless of scroll distance.
- Existing behavior preserved: pagination controls, go-to-line, locate jumps, keyboard paging, Search all (both modifiers), Esc clearing, and responsive hiding.
- Selection: never cleared by paging or scrolling; highlights always land on the correct lines; copy/export never fail with off-window selections.
- No regressions in the existing 87 app e2e specs and 8 stress specs (the stress wheel spec is updated in the same commit as the behavior change, not broken).

## Validation Method

- `npm run test:gate` — unit suite plus coverage gate (90 percent line / 85 percent branch on core modules; only `src/selection.js` is at risk of being touched, and only minimally).
- `npm run e2e` — full Playwright run including updated stress spec and new scenarios (app specs, stress specs).
- `node build.js` — build succeeds and the generated single-file HTML is fresh (diff-clean regeneration; single-file build invariant).

## Validation Record (2026-10-18)

Quality gate PASS. Unit: 321 tests / 0 failed via `npm run test:gate`. E2e: 105 passed / 0 failed, with 2 pre-existing environment-conditional skips (7-Zip-CLI-dependent) out of 107 defined specs (99 app + 8 stress). Coverage gate green on all touched modules; the rebuilt single-file bundle is diff-clean (fresh). Pre-existing and out of scope for this SPEC: `src/format-7z.js` branch coverage measures 82.1 percent, below the 85 percent branch gate — unrelated to any file touched by SPEC-VIEWER-001.
