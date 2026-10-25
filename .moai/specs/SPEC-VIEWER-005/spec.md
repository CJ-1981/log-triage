---
id: SPEC-VIEWER-005
title: "Dynamic Mobile Viewer Toolbar Button Visibility by Active Status"
version: "1.0.0"
status: completed
created: 2026-10-25
updated: 2026-10-25
author: "CJ-1981"
priority: P2
phase: "v1.65.0 target"
module: "template.html, src/app.js, tests/e2e/app.e2e.spec.mjs"
lifecycle: spec-anchored
tags: "viewer, mobile, responsive, toolbar, ellipsis, overflow, ux"
tier: S
---

# SPEC-VIEWER-005: Dynamic Mobile Viewer Toolbar Button Visibility by Active Status

## HISTORY

| Date | Version | Author | Change |
|---|---|---|---|
| 2026-10-25 | 1.0.0 | CJ-1981 | Initial specification and implementation plan. Dynamically show only buttons with ON status on mobile top viewer toolbar while collapsing OFF-status buttons into the ellipsis (⋯) overflow menu. Fully interactive toggle state synchronization and test verification. |

## 1. User Story

As a mobile user inspecting logs and files on small-screen devices (viewport width <= 560px), I want the top viewer toolbar to dynamically display only the buttons that currently have an active `ON` status (e.g. `Mask: ON`, `Filter: ON`, `Wrap: ON`, `Follow: ON`, `Drawer: ON`, `Syntax: ON`, `Markdown: ON`) while keeping inactive (`OFF`) buttons and secondary inputs collapsed behind the ellipsis (`⋯`) button, so that I have immediate awareness and one-tap control of all active triage modes without wasting precious mobile vertical or horizontal screen space.

## 2. Environment & Architecture Constraints

- **Single-file deliverable invariant**: All changes are made to `template.html` and `src/app.js`, compiling cleanly into `log-triage.html` via `build.js` without external dependencies.
- **Pure CSS / DOM class contract**: Toggle buttons already maintain standard `.on` classes when active (`Mask`, `Filter`, `Wrap`, `Follow`, `Drawer`, `Syntax`, `Markdown`). The responsive media query `@media (max-width: 560px)` dynamically shows `.vt-sec.on:not(.hidden)` while hiding `.vt-sec:not(.on)`.
- **Ellipsis expansion (`vtools-open`)**: When the user taps the ellipsis button (`#vtools-more`), `body.vtools-open` is toggled. In the expanded state, all secondary controls (`.vt-sec:not(.hidden)`) are displayed, allowing the user to view and activate any currently inactive features.
- **Dynamic reactivity**: When any button transitions between ON and OFF (or when file types change such as `.md` or code files), the button's visibility dynamically updates to match its new active status.
- **Desktop layout invariance**: Viewports wider than 560px remain completely unaffected, displaying all toolbar buttons in their standard layout.

## 3. GEARS Requirements & Inline Acceptance Criteria

### Requirement 1: Collapsed Mobile Toolbar Displays Only Active Buttons
**While** the viewport width is 560px or less and the viewer toolbar is collapsed (`:not(.vtools-open)`), the top toolbar shall display `#quick`, `#vtools-more`, and only those toolbar buttons that have an active status (`.on`) and are not hidden (`:not(.hidden)`).

- **AC-001 (Active Buttons Visible by Default)**:
  - **Given** the app is opened on a mobile viewport (e.g. 390px x 844px),
  - **When** the toolbar is collapsed,
  - **Then** all toggle buttons with status `ON` (such as `Mask: ON`, `Filter: ON`, `Drawer: ON`, and `Wrap: ON` if enabled) are visible (`display: inline-block`).

- **AC-002 (Inactive Buttons and Secondary Controls Hidden by Default)**:
  - **Given** the app is on a mobile viewport,
  - **When** a toggle button has status `OFF` (such as `Follow: OFF` or `Wrap: OFF` when disabled), or a control is non-toggle (such as `#goto-ln` or `#btn-sall`),
  - **Then** it is hidden (`display: none`).

### Requirement 2: Ellipsis Expansion Reveals All Controls
**When** the user activates the ellipsis button (`#vtools-more`), the toolbar shall expand (`body.vtools-open`) to reveal all secondary controls and inactive buttons, enabling the user to toggle any feature.

- **AC-003 (Expanded State Visibility)**:
  - **Given** the app is on a mobile viewport in collapsed state,
  - **When** the user clicks `#vtools-more`,
  - **Then** `body.vtools-open` is set, `aria-expanded` is `"true"`, and previously hidden controls (like `#goto-ln`, `#btn-sall`, and buttons with `OFF` status) become visible.

### Requirement 3: Dynamic State Transition
**When** the user toggles a button from `ON` to `OFF` while on a mobile viewport, the button shall dynamically collapse into the ellipsis menu; **When** the user toggles a button from `OFF` to `ON`, it shall dynamically appear in the top toolbar.

- **AC-004 (Dynamic Hide on Turn OFF)**:
  - **Given** a button is currently `ON` and visible on the mobile toolbar (e.g. `Mask: ON`),
  - **When** the user clicks it turning it `OFF`,
  - **Then** class `on` is removed and the button is immediately hidden from the collapsed toolbar.

- **AC-005 (Dynamic Show on Turn ON)**:
  - **Given** the ellipsis menu is open and a button is `OFF` (e.g. `Follow: OFF`),
  - **When** the user clicks it turning it `ON`,
  - **Then** class `on` is added, and the button remains visible in the top toolbar even when the ellipsis menu is closed.

### Requirement 4: File-Type Specific Switches Track Format Visibility
**While** the displayed file is a code file or markdown file, its corresponding button (`#btn-syntax` or `#btn-markdown`) shall follow active-status visibility; **While** the displayed file is a standard log file, format-specific buttons remain hidden (`.hidden`).

- **AC-006 (Format-Specific Button Adherence)**:
  - **Given** a python script is loaded and `Syntax: ON` is active,
  - **Then** `#btn-syntax` is displayed on the mobile top toolbar.
  - **Given** a standard log file is loaded,
  - **Then** `#btn-syntax` remains hidden (`display: none !important`).

## 4. Test Verification Matrix

| Test ID | Area | Scenario | Method |
|---|---|---|---|
| T-001 | CSS / Layout | Collapsed mobile toolbar shows only `.on` buttons and `#quick` | Playwright E2E (`tests/e2e/app.e2e.spec.mjs`) |
| T-002 | CSS / Layout | Ellipsis button toggles `body.vtools-open` and reveals all controls | Playwright E2E (`tests/e2e/app.e2e.spec.mjs`) |
| T-003 | Interaction | Toggling ON -> OFF hides the button from collapsed toolbar | Playwright E2E (`tests/e2e/app.e2e.spec.mjs`) |
| T-004 | Interaction | Toggling OFF -> ON keeps the button visible in collapsed toolbar | Playwright E2E (`tests/e2e/app.e2e.spec.mjs`) |
| T-005 | Formats | Syntax button visible for code file when ON; hidden for log file | Playwright E2E (`tests/e2e/app.e2e.spec.mjs`) |
| T-006 | Quality Gate | All unit tests, coverage gate, bundle freshness, and E2E pass | `npm run test:gate`, `npm run build`, `npm run e2e` |
