---
id: SPEC-FORMAT-002
title: "Built-in Qualcomm QXDM / QCAT Text Export Log Format"
version: "1.0.0"
status: completed
created: 2026-10-24
updated: 2026-10-24
author: "Antigravity"
priority: P2
phase: "v1.64.0 target"
module: "src/detect.js, src/parser.js, src/app.js, template.html, build.js"
lifecycle: spec-anchored
tags: "format, qxdm, qcat, qualcomm, diag, parser, detect, built-in"
tier: M
---

# SPEC-FORMAT-002: Built-in Qualcomm QXDM / QCAT Text Export Log Format

## HISTORY

| Date | Version | Author | Change |
|---|---|---|---|
| 2026-10-24 | 0.1.0 | Antigravity | Initial draft for built-in Qualcomm QXDM / QCAT text export format autodetection and parsing. |
| 2026-10-24 | 1.0.0 | Antigravity | Full implementation, unit tests, coverage gates, build, and documentation sync complete. |

## 1. User Story

As a modem, cellular (LTE/5G), embedded software, or QA engineer analyzing Qualcomm chipset diagnostic logs exported from QXDM (Qualcomm eXtensible Diagnostic Monitor) or QCAT, I want Log Triage to automatically detect, parse, and structure QXDM text export logs into normalized records (with accurate timestamps, packet/event codes, severity levels, and continuation payload lines), so that I can triage cellular connectivity issues, protocol state transitions, and modem debug prints with full filtering, timeline merging, search, and PII masking—offline and without third-party tools.

## 2. Environment & Architecture Constraints

- **Single-file deliverable invariant**: Zero runtime dependencies, no bundler, no transpilation, no WebAssembly (`docs/decisions.md` ADR-0001).
- **100% offline & client-side**: Log parsing, timestamp normalization, and filtering execute purely in the browser.
- **Coverage Gate**: All core modules (`src/detect.js`, `src/parser.js`, etc.) must maintain line coverage ≥ 90% and branch coverage ≥ 85% via `npm run test:gate`.
- **Text-first roadmap**: Focuses on text-exported QXDM/QCAT logs (`.txt`, `.log`, `.qcat.txt`), mirroring the proven pattern of DLT ASCII exports (`docs/decisions.md` ADR-0014).
- **Single-line anchor with continuation records**: Packet headers form anchor records; indented payload tree lines (e.g. ` Protocol Discriminator: ...`) parse as continuation records (`parseFallback`), preserving raw line content and grouping with their parent packet.

## 3. GEARS Requirements & Acceptance Criteria

### Requirement 1: Format Autodetection (`src/detect.js`)
**When** a log file containing QXDM or QCAT text export data is ingested, the system shall reliably detect it as format `qxdm`.

- **AC-001 (Signature Detection)**:
  - **Given** sample lines matching standard QXDM/QCAT packet headers (timestamp + category `[LOG]`, `[MSG]`, `[EV]`, or `[EVENT]` + optional hex code `0xXXXX`),
  - **When** `detectFormat(lines)` is evaluated,
  - **Then** it classifies the file as `qxdm` when the match ratio is ≥ 0.5.
- **AC-002 (Header Comment Resilience)**:
  - **Given** QXDM files beginning with comment headers (e.g. `%MOBILE PARSED MESSAGE FILE`, `%QCAT VERSION`),
  - **When** `detectFormat` scans the sample lines,
  - **Then** comment lines do not prevent positive classification of subsequent packet records.
- **AC-003 (Disjointness)**:
  - **Given** standard logcat, syslog, ISO-8601, CLF, or plain text logs,
  - **When** `detectFormat` is evaluated,
  - **Then** they never misclassify as `qxdm`.

### Requirement 2: Record Parsing & Normalization (`src/parser.js`)
**When** a line from a `qxdm` format log is parsed by `parseLine(line, 'qxdm')`, the system shall extract normalized timestamp, severity level, tag, and message.

- **AC-004 (Timestamp Normalization)**:
  - Time-only timestamps (`HH:MM:SS.mmm` or `HH:MM:SS.mmmmmm`) normalize to `HH:MM:SS.mmm`.
  - Date-bearing timestamps (`YYYY Mon DD  HH:MM:SS.mmm` or `YYYY-MM-DD HH:MM:SS.mmm`) normalize to standard year-less `MM-DD HH:MM:SS.mmm`.
- **AC-005 (Severity Mapping)**:
  - `[MSG]` lines with severity tokens map: `FATAL`→`F`, `ERROR`→`E`, `HIGH`→`W`, `MED`/`MEDIUM`→`I`, `LOW`→`D`.
  - `[LOG]` and `[EV]` lines map to canonical `I` (or `E` if explicit error).
- **AC-006 (Tag Extraction)**:
  - Captures hex packet ID (e.g. `0x11AB`, `0x133C`, `0x038A`) and optional subsystem name (e.g. `3GPP_NAS`, `LTE RRC`, `EVENT`).
- **AC-007 (Continuation Handling)**:
  - Indented payload sub-lines (e.g. `    Protocol Discriminator: LTE RRC (3)`) parse as continuation records with null timestamp and null level so they attach to the preceding log record.

### Requirement 3: UI & Viewer Integration (`src/app.js`, `template.html`)
- **AC-008 (Format Override Choice)**:
  - Viewer toolbar `#sel-format-override` includes `Qualcomm QXDM / QCAT` (`qxdm`).
  - Switching to `qxdm` re-indexes and parses the file using `parseQxdm`.
- **AC-009 (Format Badge)**:
  - Files panel and viewer headers display badge `qxdm`.
