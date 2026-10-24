---
id: SPEC-FORMAT-001
title: "Custom Log Format Definitions and Viewer Format Override — Plan"
version: "0.1.0"
status: draft
created: 2026-10-24
updated: 2026-10-24
author: "Antigravity"
priority: P2
phase: "v1.63.0 target"
module: "src/custom-format.js, src/detect.js, src/parser.js, src/paged.js, src/app-paging-worker.js, src/app.js, template.html, build.js"
lifecycle: spec-anchored
tags: "format, parser, detect, config, viewer, toolbar, override"
tier: M
---

# SPEC-FORMAT-001: Implementation Plan

## A. Context & Architecture

Log Triage detects and parses log formats via `src/detect.js` (ratio-based scoring of sample lines) and `src/parser.js` (per-format regex parsing into `{ ts, level, tag, pid, tid, msg }`).
This specification introduces user-defined custom formats using regular expressions with named capture groups, configurable timestamp normalization, and severity mappings, integrated into the detection and parsing pipelines, alongside a viewer toolbar format override selector.

### Touching Modules
1. `src/custom-format.js` (NEW):
   - `compileCustomFormat(def)`
   - `parseCustomLine(line, compiled)`
   - `normalizeCustomTs(rawTs, tsFormat)`
   - `validateFormatDef(def)`
   - `DEFAULT_CUSTOM_FORMAT_EXAMPLES`: starter definitions (e.g. Spring Boot, Nginx Error)
2. `src/detect.js`:
   - `detectFormat(lines, customFormats)` evaluates enabled custom formats in descending priority order before built-ins.
3. `src/parser.js`:
   - `parseLine(line, format, customFormats)` supports custom format dispatch.
4. `src/paged.js`:
   - `PagedLog` stores and propagates `customFormats` and `forcedFormat`.
5. `src/app-paging-worker.js`:
   - `index` message accepts `customFormats` and `forcedFormat`.
   - Adds `reformat` or override handler if format is forced dynamically.
6. `template.html`:
   - Viewer toolbar `#vtools`: add format override select `#sel-format-override`.
   - Config tab `#tab-config`: add "Custom log formats" section with list, editor form, live preview, and restore examples button.
7. `src/app.js`:
   - State: `state.customFormats = []`, `state.formatOverrides = {}`.
   - UI wiring: Config tab format editor, list rendering, live preview debounced evaluation.
   - Viewer toolbar: `#sel-format-override` populates with available formats and applies override.
   - Config export/import: serializes and restores `customFormats`.
   - Presets: saves and loads `customFormats`.
8. `build.js`:
   - Register `'custom-format.js'` in `MODULE_ORDER` (after `parser.js`, before `paged.js`).
9. `tests/custom-format.test.js` (NEW) and `tests/core-cases.js`:
   - Unit tests covering compilation, regex group extraction, timestamp normalization, level mapping, fallback handling, error resistance.

## B. Task Breakdown

### Unit 1: Custom Format Engine (`src/custom-format.js`)
- [ ] Task 1.1: Implement UMD module wrapper.
- [ ] Task 1.2: Implement `compileCustomFormat(def)` with named group validation (`ts`, `level`, `tag`, `pid`, `tid`, `msg`).
- [ ] Task 1.3: Implement `normalizeCustomTs(rawTs, tsFormat)` supporting `YYYY-MM-DD HH:mm:ss.SSS`, `ISO-8601`, `MM/DD HH:mm:ss`, Unix epoch seconds (`X`), and milliseconds (`x`).
- [ ] Task 1.4: Implement `parseCustomLine(line, compiled)` returning normalized record `{ ts, level, tag, pid, tid, msg }`.
- [ ] Task 1.5: Define `DEFAULT_CUSTOM_FORMAT_EXAMPLES` with Spring Boot and Nginx Error log patterns.

### Unit 2: Detection & Parser Integration (`src/detect.js`, `src/parser.js`)
- [ ] Task 2.1: Update `detectFormat(lines, customFormats)` in `src/detect.js` to score enabled custom formats in priority order before built-in formats.
- [ ] Task 2.2: Update `parseLine(line, format, customFormats)` in `src/parser.js` to delegate to custom format parser when format matches custom definition.

### Unit 3: Worker & PagedLog Indexing (`src/paged.js`, `src/app-paging-worker.js`)
- [ ] Task 3.1: Pass `customFormats` and optional `forcedFormat` into `PagedLog` constructor in `src/paged.js`.
- [ ] Task 3.2: Allow `PagedLog.index()` to bypass detection if `forcedFormat` is specified.
- [ ] Task 3.3: Wire `app-paging-worker.js` to receive `customFormats` and handle format re-indexing.

### Unit 4: Config Tab UI & Preset / Config Lifecycle (`template.html`, `src/app.js`)
- [ ] Task 4.1: Add HTML markup in `template.html` for "Custom log formats" section in `#tab-config`.
- [ ] Task 4.2: Implement format list rendering and enable/disable/delete handlers in `src/app.js`.
- [ ] Task 4.3: Implement format editor form with live preview debounced update in `src/app.js`.
- [ ] Task 4.4: Include `customFormats` in `exportConfig()` and restore in `importConfig()`.
- [ ] Task 4.5: Update config setup cards to reflect custom format stats.

### Unit 5: Viewer Toolbar Format Override Dropdown (`template.html`, `src/app.js`)
- [ ] Task 5.1: Add `#sel-format-override` into `#vtools` in `template.html`.
- [ ] Task 5.2: Populate `#sel-format-override` with detected and available formats when a file is active.
- [ ] Task 5.3: Handle format override changes by requesting worker re-index/re-parse of the file and updating UI.

### Unit 6: Build & Test Verification
- [ ] Task 6.1: Update `build.js` module list.
- [ ] Task 6.2: Write comprehensive tests in `tests/custom-format.test.js` and extend `tests/core-cases.js`.
- [ ] Task 6.3: Ensure `npm test` and `npm run test:gate` pass with 100% compliance.
- [ ] Task 6.4: Run `npm run build` and verify `log-triage.html`.

## C. Risk Analysis & Mitigation

| Risk | Severity | Mitigation |
|---|---|---|
| Invalid user regex causing catastrophic backtracking or crashes | High | Wrap regex compilation in try/catch; compile once at save time; test against sample line before saving. |
| Performance overhead during 500-row page virtualization | Medium | Pre-compile custom format regex and lookup map so `parseLine` per row is as fast as built-in parsers. |
| Serialization failure across worker `postMessage` | Medium | Store only plain JSON objects in state and worker payloads; compile regexes inside the worker and UI independently. |
| Stale format override state after file switch | Low | Keep format overrides keyed by `fileId` in session state; reset to auto when a new file loads. |
