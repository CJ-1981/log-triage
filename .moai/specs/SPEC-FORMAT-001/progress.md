# SPEC-FORMAT-001 Progress Tracking

- **SPEC ID**: SPEC-FORMAT-001
- **Phase**: Sync complete
- **Status**: completed

## Milestones

- [x] **M0: Planning & Specification**
  - [x] SPEC documents created (`spec.md`, `plan.md`, `spec-compact.md`, `progress.md`)
  - [x] Acceptance criteria defined

- [x] **M1: Custom Format Engine (`src/custom-format.js`)**
  - [x] Implement `src/custom-format.js` with regex group extraction, timestamp normalization, level mapping, validation
  - [x] Implement starter examples (`DEFAULT_CUSTOM_FORMAT_EXAMPLES`)
  - [x] Write unit tests `tests/custom-format.test.js`

- [x] **M2: Detection and Parser Pipeline Integration**
  - [x] Integrate into `src/detect.js` (`detectFormat`)
  - [x] Integrate into `src/parser.js` (`parseLine`)
  - [x] Integrate into `src/paged.js` and `src/app-paging-worker.js`
  - [x] Register module in `build.js` and `src/_src.js`

- [x] **M3: Viewer Toolbar Format Override Selector**
  - [x] Add `#sel-format-override` in `#vtools` in `template.html`
  - [x] Wire format override in `src/app.js` with dynamic re-index

- [x] **M4: Config Tab UI & Preset / Config Lifecycle**
  - [x] Add Custom Log Formats section in `template.html`
  - [x] Implement format list, edit form, live preview, restore examples in `src/app.js`
  - [x] Include in `exportConfig()` and `importConfig()`
  - [x] Update config setup cards

- [x] **M5: Verification and Quality Gate**
  - [x] Unit tests pass (`npm test`: 488 tests passed)
  - [x] Coverage gate pass (`npm run test:gate`: line >= 90%, branch >= 85%)
  - [x] Bundle build pass (`npm run build`: `log-triage.html` 611.6 KB)
  - [x] Sync documentation (`docs/requirements.md` FR-33, `docs/architecture.md`, `docs/decisions.md` ADR-0019, `README.md`, `docs/changelog.md`)
