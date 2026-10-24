# SPEC-FORMAT-002 Progress Tracking

- **SPEC ID**: SPEC-FORMAT-002
- **Phase**: Sync complete
- **Status**: completed

## Milestones

- [x] **M0: Planning & Specification**
  - [x] SPEC documents created (`spec.md`, `plan.md`, `spec-compact.md`, `progress.md`)
  - [x] Acceptance criteria defined

- [x] **M1: Core Detection and Parsing (`src/detect.js`, `src/parser.js`)**
  - [x] Define `RE_QXDM` regex in `src/detect.js` and register in `FORMATS`
  - [x] Implement `parseQxdm(line)` in `src/parser.js` and wire in `parseLine`

- [x] **M2: Shared Cases & Unit Tests**
  - [x] Add QXDM test cases to `tests/core-cases.js`
  - [x] Create `tests/qxdm.test.js`

- [x] **M3: UI & Viewer Integration**
  - [x] Add `qxdm` to `#sel-format-override` in `template.html`
  - [x] Add `qxdm: 'QXDM'` in `src/app.js` `FORMAT_NAMES`

- [x] **M4: Verification & Quality Gate**
  - [x] Unit tests pass (`npm test`: 490 tests passed)
  - [x] Coverage gate pass (`npm run test:gate`: line ≥ 90%, branch ≥ 85%)
  - [x] Bundle build pass (`npm run build`: `log-triage.html` 618.0 KB)

- [x] **M5: Documentation Synchronization (Sync Phase)**
  - [x] Update `docs/requirements.md` (FR-34)
  - [x] Update `docs/architecture.md`
  - [x] Update `docs/decisions.md` (ADR-0020)
  - [x] Update `README.md` and `docs/changelog.md`
  - [x] Close SPEC status
