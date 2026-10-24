# SPEC-FORMAT-002 Implementation Plan

## 1. Overview
Implement built-in support for Qualcomm QXDM / QCAT text-exported logs (`qxdm`), enabling automatic detection, parsing, level mapping, and viewer integration.

## 2. Milestones

### Milestone 1: Core Detection and Parsing (`src/detect.js`, `src/parser.js`)
- Define `RE_QXDM` regex pattern in `src/detect.js` and register `['qxdm', RE_QXDM]` in `FORMATS`.
- Implement `parseQxdm(line)` in `src/parser.js` supporting:
  - Timestamp parsing (`HH:MM:SS.mmm` and date-prefixed formats)
  - Category and severity parsing (`[LOG]`, `[MSG]` with HIGH/MED/LOW/ERROR/FATAL, `[EV]`)
  - Packet ID extraction (`0xXXXX`) and subsystem tag
  - Continuation lines fallback for payload trees
- Wire `parseQxdm` into `parseLine(line, 'qxdm')`.

### Milestone 2: Shared Cases & Unit Tests (`tests/core-cases.js`, `tests/qxdm.test.js`)
- Add shared test cases to `tests/core-cases.js`:
  - Detection cases: QXDM standard packets, debug messages, events, and header comments.
  - Parsing cases: timestamp normalization, severity levels, tags, message text, and indented tree lines.
- Create `tests/qxdm.test.js` exercising edge cases and ensuring coverage gate compliance.

### Milestone 3: UI & Viewer Integration (`template.html`, `src/app.js`)
- Add `<option value="qxdm">Qualcomm QXDM / QCAT</option>` to `#sel-format-override` in `template.html`.
- Add `'qxdm': 'QXDM'` in `src/app.js` `FORMAT_NAMES`.

### Milestone 4: Verification and Quality Gate
- Run `npm test` to verify all test suites pass.
- Run `npm run test:gate` to verify line ≥ 90% and branch ≥ 85% on all core modules.
- Run `npm run build` to verify `log-triage.html` generates cleanly.

### Milestone 5: Documentation Synchronization
- Update `docs/requirements.md` (FR-34).
- Update `docs/architecture.md`.
- Update `docs/decisions.md` (ADR-0020).
- Update `README.md` and `docs/changelog.md`.
- Close SPEC in `spec.md` and `progress.md`.

## 3. Risk & Mitigation
- **Risk**: Indented lines or hex dumps could dilute detection score below threshold 0.5.
  - **Mitigation**: Exclude lines starting with whitespace from the non-hit count, or ensure `RE_QXDM` scores against non-indented packet boundary lines.
- **Risk**: Branch coverage in `src/parser.js` dropping below 85%.
  - **Mitigation**: Keep parsing logic branch-lean and fully covered with test assertions for all level combinations (FATAL, ERROR, HIGH, MED, LOW, LOG, EV).
