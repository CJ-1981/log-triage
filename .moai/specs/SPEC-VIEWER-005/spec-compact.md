# SPEC-VIEWER-005: Compact Specification

- **ID**: SPEC-VIEWER-005
- **Title**: Dynamic Mobile Viewer Toolbar Button Visibility by Active Status
- **Tier**: S
- **Status**: completed
- **Module**: `template.html`, `src/app.js`, `tests/e2e/app.e2e.spec.mjs`, `log-triage.html`, `README.md`

## Requirements

### Requirement 1: Collapsed Mobile Toolbar Displays Only Active Buttons
**While** the viewport width is 560px or less and the viewer toolbar is collapsed (`:not(.vtools-open)`), the top toolbar shall display `#quick`, `#vtools-more`, and only those toolbar buttons that have an active status (`.on`) and are not hidden (`:not(.hidden)`).

### Requirement 2: Inactive Buttons and Secondary Controls Collapsed
**While** the viewport width is 560px or less, toggle buttons with status `OFF` and secondary controls (`#goto-ln`, `#btn-sall`, `#sel-format-override`, `#view-mode`, `#btn-copy`, `#copy-prefix`, `#btn-zen`) shall be hidden (`display: none`).

### Requirement 3: Ellipsis Expansion Reveals All Controls
**When** the user activates the ellipsis button (`#vtools-more`), the toolbar shall expand (`body.vtools-open`) to reveal all secondary controls and inactive buttons, enabling the user to toggle any feature.

### Requirement 4: Dynamic State Transition
**When** the user toggles a button from `ON` to `OFF` while on a mobile viewport, the button shall dynamically collapse into the ellipsis menu; **When** the user toggles a button from `OFF` to `ON`, it shall dynamically appear in the top toolbar.

### Requirement 5: Format-Specific Switch Adherence
**While** the displayed file is a code file or markdown file, its corresponding button (`#btn-syntax` or `#btn-markdown`) shall follow active-status visibility; **While** the displayed file is a standard log file, format-specific buttons remain hidden (`.hidden`).

## Acceptance Criteria

- **AC-001**: On mobile (`<= 560px`), buttons with status `ON` (`Mask`, `Filter`, `Drawer`, `Wrap`) are visible in the collapsed top toolbar.
- **AC-002**: Inactive `OFF` buttons (`Follow: OFF`, `Wrap: OFF` when disabled) and secondary controls (`#goto-ln`, `#btn-sall`) are hidden behind `⋯`.
- **AC-003**: Activating `⋯` sets `body.vtools-open` and reveals all secondary controls and `OFF` buttons.
- **AC-004**: Clicking an `ON` button turns it `OFF` and dynamically hides it into the `⋯` menu.
- **AC-005**: Activating an `OFF` button from the expanded `⋯` menu turns it `ON` and keeps it visible on the top toolbar when collapsed.
- **AC-006**: Code and markdown switch buttons respect both format detection and active-status visibility.
