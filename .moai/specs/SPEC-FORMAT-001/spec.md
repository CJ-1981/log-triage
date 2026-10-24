---
id: SPEC-FORMAT-001
title: "Custom Log Format Definitions and Viewer Format Override"
version: "1.0.0"
status: completed
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

# SPEC-FORMAT-001: Custom Log Format Definitions and Viewer Format Override

## HISTORY

| Date | Version | Author | Change |
|---|---|---|---|
| 2026-10-24 | 0.1.0 | Antigravity | Initial draft based on proposal and user specifications: single-line matching, viewer toolbar format override dropdown, config export/import integration. |
| 2026-10-24 | 1.0.0 | Antigravity | Full implementation, unit tests, coverage gates, build, and documentation sync complete. |

## 1. User Story

As a software engineer, systems administrator, or QA analyst triaging proprietary, team-specific, or non-standard logs (such as Spring Boot application logs, custom microservices, game engine outputs, PLC controllers, or nginx error logs), I want to define custom log formats using regular expressions with named capture groups and configure timestamp formats and level mappings, so that Log Triage automatically detects and parses these logs into structured records with timestamps, levels, tags, and messages. Furthermore, I want a format override dropdown in the viewer toolbar so that I can explicitly force a specific format for any loaded file if autodetection was ambiguous.

## 2. Environment & Architecture Constraints

- **Single-file deliverable invariant**: All modules are built into `log-triage.html` via `build.js` from `template.html` and `src/*.js`. No bundler, no transpiler, zero external CDN dependencies, and no WebAssembly (`docs/decisions.md` ADR-0001).
- **100% offline & zero network**: All regex compilation, format detection, parsing, and timestamp normalizations execute client-side.
- **Worker boundary**: Custom format definitions are JSON-serializable plain objects (`{ name, label, pattern, tsFormat, levelMap, priority, enabled }`) so they pass across `postMessage` to the paging worker without serialization issues.
- **Single-line matching only**: Matching applies strictly on single lines. Non-matching lines in a custom format file fall back to continuation records (`parseFallback`), preserving raw content and bypassing level filters (per user decision Q1).
- **Format override in viewer toolbar**: A dropdown selector in `#vtools` allows forcing the active file's format to any built-in format or custom format, re-indexing/re-parsing on change (per user decision Q2).
- **Configuration lifecycle**: Custom formats persist in `localStorage` under `state.customFormats`, round-trip through the existing Config tab Export/Import JSON (`exportConfig`/`importConfig`), and are saved in presets (per user decision Q3).

## 3. GEARS Requirements & Acceptance Criteria

### Requirement 1: Custom Format Definition Engine (`src/custom-format.js`)
**When** a custom format definition is compiled, the system shall validate its regex syntax, extract and check for recognized named capture groups (`(?<ts>...)`, `(?<level>...)`, `(?<tag>...)`, `(?<pid>...)`, `(?<tid>...)`, `(?<msg>...)`), and prepare timestamp and severity parsers.

- **AC-001 (Compilation and Validation)**:
  - **Given** a valid custom format definition with named capture groups,
  - **When** `compileCustomFormat(def)` is called,
  - **Then** it returns `{ ok: true, name, label, regex, tsFormat, levelMap, ... }`.
  - **Given** an invalid regex string (e.g. `[unclosed`),
  - **When** `compileCustomFormat(def)` is called,
  - **Then** it returns `{ ok: false, error: <readable error message> }` without throwing.

- **AC-002 (Timestamp Normalization)**:
  - **Given** captured timestamp strings in formats like `YYYY-MM-DD HH:mm:ss.SSS`, `YYYY-MM-DDTHH:mm:ss.SSSZ`, `MM/DD HH:mm:ss`, Unix epoch seconds (`X`), or epoch milliseconds (`x`),
  - **When** `normalizeCustomTs(rawTs, tsFormat)` is invoked,
  - **Then** it produces the standardized year-less string `MM-DD HH:MM:SS.mmm`.

- **AC-003 (Level Mapping)**:
  - **Given** captured level values (e.g. `WARNING`, `CRITICAL`, `TRACE`, `ERR`),
  - **When** parsed through `levelMap` or fallback token scanner,
  - **Then** it maps deterministically to one of the standard severity ladder letters: `V`, `D`, `I`, `W`, `E`, `F` (or `null` if unmapped).

### Requirement 2: Format Detection Integration (`src/detect.js`)
**When** `detectFormat(lines, customFormats)` is executed, enabled custom formats shall be evaluated in descending priority order before built-in formats.

- **AC-004 (Custom Format Autodetection)**:
  - **Given** a log file whose sample lines match a custom format regex at a ratio ≥ 0.5,
  - **When** `detectFormat` is called,
  - **Then** it returns `{ format: def.name, confidence: ratio, ... }`.
  - **Given** a custom format with `enabled: false`,
  - **When** `detectFormat` runs,
  - **Then** the disabled custom format is skipped.

### Requirement 3: Record Parsing (`src/parser.js`)
**When** `parseLine(line, format, customFormats)` is called with a custom format name, the compiled custom format shall extract the fields and return a normalized record `{ ts, level, tag, pid, tid, msg }`.

- **AC-005 (Custom Line Parsing)**:
  - **Given** a line matching the custom format pattern,
  - **When** `parseLine(line, formatName, customFormats)` is called,
  - **Then** it returns a record with normalized `ts`, mapped `level`, extracted `tag`, `pid`, `tid`, and `msg`.
  - **Given** a line that fails to match the custom format pattern,
  - **When** `parseLine` is called,
  - **Then** it returns a continuation record with `ts: null`, `level: null`, `tag: null`, and `msg: line`.

### Requirement 4: Paged Log & Worker Support (`src/paged.js`, `src/app-paging-worker.js`)
**When** files are indexed or queried in the paging worker, custom format definitions and format overrides shall be respected.

- **AC-006 (Worker Indexing with Custom Formats & Override)**:
  - **Given** a file indexed with `customFormats` passed in the worker message,
  - **When** indexing runs,
  - **Then** the file detects and parses using the custom format, and columnar offsets, times, and levels are populated accurately.
  - **Given** a format override requested for a file,
  - **When** the file format is overridden,
  - **Then** records are parsed with the overridden format.

### Requirement 5: Config Tab UI for Custom Formats (`template.html`, `src/app.js`)
**When** navigating to the Config tab (Tab 8), a "Custom log formats" panel shall provide a complete management interface.

- **AC-007 (Format List & Management)**:
  - Displays list of custom formats with name badge, label, enable/disable toggle, edit button, and delete button.
  - Includes "+ Add format" and "Restore examples" buttons.
- **AC-008 (Format Editor & Live Preview)**:
  - Editor provides inputs for name, label, regex pattern, timestamp format preset dropdown, and level mapping dictionary.
  - Real-time regex validation displays valid/invalid status and identified named groups (`ts`, `level`, `tag`, `pid`, `tid`, `msg`).
  - Live preview input field parses sample text in real time, rendering matched fields (`ts`, `level`, `tag`, `pid`, `msg`) or an unmatched alert.

### Requirement 6: Viewer Toolbar Format Override Dropdown (`template.html`, `src/app.js`)
**While** viewing a file in the viewer, a format selector `#sel-format-override` shall be visible in the toolbar `#vtools`.

- **AC-009 (Format Override Selector in Viewer)**:
  - Displays currently active format for the active file (e.g. `Auto (logcat)` or the overridden format name).
  - Allows selecting any built-in format (`logcat`, `syslog`, `clf`, `iso8601`, `mmdd`, `dlt`, `plain`) or custom format.
  - Selecting a format re-parses/re-indexes the file with the forced format and updates viewer display, badges, chips, and counters.

### Requirement 7: Config Export / Import & Presets
**When** exporting or importing configuration via the Config tab or presets, custom formats shall be preserved.

- **AC-010 (Config Export/Import & Presets)**:
  - `exportConfig()` includes `customFormats` array in the downloaded JSON.
  - `importConfig()` parses and restores `customFormats`, updating UI cards, state, and worker indexes.
  - Config setup card displays custom format count and active status.
