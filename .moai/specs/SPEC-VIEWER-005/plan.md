# SPEC-VIEWER-005 Implementation Plan: Dynamic Mobile Viewer Toolbar Button Visibility

## Objective
Optimize the mobile browser viewer toolbar (`#vtools` at `<= 560px` viewport width) so that when collapsed, only buttons that have `ON` status are displayed on top, while inactive (`OFF`) buttons and secondary controls are hidden behind the ellipsis (`⋯`) button. All controls remain accessible upon expanding the ellipsis.

## Architecture & Implementation Steps

### Step 1: Markup and Class Uniformity in `template.html`
- Update `#btn-mask` and `#btn-filter` to include `class="vt-sec on"` so that all viewer toggle buttons adhere to the same `.vt-sec` scoping rules.
- Set initial `.on` state classes on default-ON buttons (`#btn-drawer`, `#btn-mask`, `#btn-filter`, `#btn-syntax`).
- Position `#vtools-more` with `order: 50` on mobile so it always appears at the end of the top row, right after the active ON buttons.

### Step 2: Responsive CSS in `template.html`
- In `@media (max-width: 560px)`:
  - `#vtools .vt-sec { display: none; }`
  - `#vtools button.vt-sec.on:not(.hidden) { display: inline-block; }`
  - `body.vtools-open #vtools .vt-sec:not(.hidden) { display: inline-block; }`
  - `#vtools-more { display: inline-block; order: 50; }`

### Step 3: Application Logic and Dynamic State Sync in `src/app.js`
- Verify that every toggle button (`setMask`, `syncFilterToggle`, `setWrap`, `setFollow`, `setDrawer`, `updateSyntaxButton`, `updateMarkdownView`) properly toggles `.on` on its DOM button element when the state changes.
- Ensure that when a user turns a button OFF or ON, the DOM class `.on` is updated synchronously so the CSS rule takes effect immediately.

### Step 4: Verification and Automated E2E Tests
- Update existing test in `tests/e2e/app.e2e.spec.mjs` (`mobile pass: compact chrome, toolbar overflow, wrap default, files scrim`):
  - Reflect that when Wrap is ON (on a fresh narrow boot), `#btn-wrap` is visible on top toolbar.
  - Test that inactive controls (`#btn-follow`) are hidden behind `⋯`.
- Add dedicated E2E test `mobile viewer buttons: dynamic visibility by ON/OFF status`:
  - Verify collapsed state displays only `.on` buttons (`Mask`, `Filter`, `Drawer`, `Wrap`).
  - Verify `Follow: OFF` is hidden behind `⋯`.
  - Toggle `Mask: ON` -> `Mask: OFF`: verify `#btn-mask` hides dynamically.
  - Click `⋯`: verify all controls reveal.
  - Toggle `Follow: OFF` -> `Follow: ON`: verify `#btn-follow` appears and remains visible when `⋯` is collapsed.
  - Verify syntax button visibility for code files vs log files on mobile.

### Step 5: Quality Gate & CI Freshness
- Rebuild bundle: `npm run build`
- Unit tests & coverage: `npm run test:gate`
- Full E2E suite: `npm run e2e`
- Confirm `git diff --exit-code -- log-triage.html` is clean.
