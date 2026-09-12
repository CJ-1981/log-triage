# Decisions

Architecture decision records (ADRs). Status values: proposed, accepted, superseded.

## ADR-0001 — Single-file HTML deliverable built from UMD src modules

- **Status:** accepted
- **Context:** The tool must be trivially distributable and usable by non-developers (email an HTML file, open it, done), while still supporting serious TDD with Node-based coverage measurement. Common bundler setups (webpack/esbuild/rollup) would add toolchain weight for a zero-dependency project, and ESM browser modules do not load cleanly from `file://` in all environments.
- **Decision:** Ship one self-contained `log-triage.html` assembled by `build.js` from UMD modules in `src/`. No bundler, no transpilation, no runtime dependencies. UMD keeps every module `require()`-able in Node for `node:test` and the coverage gate, and the same files are concatenated verbatim into the HTML. Template tokens (`__LT_VERSION__`, `/*__LT_CSS__*/`, `/*__LT_MODULES__*/`, `/*__LT_CASES__*/`, `/*__LT_DEMO__*/`) inject version, styles, modules, shared cases, and demo data at build time.
- **Consequences:** Zero-dependency distribution that works offline from `file://`; identical code paths in tests and production; no tree-shaking or minification (acceptable at this codebase size); module order in `build.js` matters and must be maintained; UMD boilerplate is repeated per module.

## ADR-0002 — PII regex set ported verbatim from the android-log-analysis skill

- **Status:** accepted
- **Context:** The android-log-analysis skill already contains a battle-tested `pii_mask.py` with 16 ordered rules tuned for Android logs (VIN, IBAN, credit card, SSN, international phone, US phone, IMEI, email, device serial `SN-`, MAC keeping OUI, private IPv4, public IPv4, IPv6 link-local/ULA, GNSS decimal pairs ≥ 3 decimals, subscriberId, hotspot SSID `AndroidShare_`). Re-deriving these in JavaScript would reintroduce subtle bugs and diverge from a proven reference.
- **Decision:** Port the regex set from `pii_mask.py` verbatim into `src/masks.js`, preserving the original rule order (order affects which rule claims an overlap). Document the deliberate false-positive guards so they are never "fixed" away: timestamp-like digit runs must not match, 13-digit epoch-milliseconds values must not match phone/IMEI rules, version numbers like `2.41.3` must not match GNSS decimal pairs, single decimal numbers (e.g. `1.5`) must not match GNSS pairs, and the IPv6 multicast address `ff02::1` must not match the IPv6 rule.
- **Consequences:** Predictable masking behavior identical to the reference implementation; a documented test matrix of true positives and guarded negatives in the shared case suite (G5); porting verbatim means some rules remain Android-specific, which matches the tool's primary use case; rule order is contractual — reordering changes results.

## ADR-0003 — External PII analysis extension (PiiProvider, Presidio/LLM)

- **Status:** proposed
- **Context:** Regex rules catch known patterns but not names, free-text addresses, or format-drift PII. External analyzers (Microsoft Presidio, LLM-based analysis) could improve recall, but they change the privacy posture: Presidio can run machine-locally as a sidecar service, while an LLM backend necessarily sends log content off the machine. The tool's core promise is "files never leave the machine", so any remote path must be impossible to trigger accidentally.
- **Decision:** Ship the `PiiProvider` interface and registry in v1 with a local regex provider and a mock provider; findings use the format `{ start, end, type, score }` as offsets into each line, and masking and the PII census tag every finding with its provider id. A future Presidio backend would run as a localhost sidecar service — still machine-local, flagged `local: true`. A future LLM backend is remote by definition: it must be explicit opt-in, off by default, and display a warning that data leaves the machine. Neither backend is wired in v1; v1 contains no network code paths at all.
- **Consequences:** The extension seam exists and is testable now (mock provider), so wiring a real backend later is additive; the `local` flag makes the privacy boundary machine-checkable (a provider that can become available without user opt-in is a bug); census results remain auditable per provider; remote backends, if ever added, require UI, consent, and warning work beyond the interface itself.

## ADR-0004 — Year-less UTC-naive timestamp model

- **Status:** accepted
- **Context:** Log sources use heterogeneous, often year-less timestamps: logcat threadtime (`MM-DD HH:MM:SS.mmm`), bare `MM-DD`, syslog (`MMM DD HH:MM:SS`), plus full ISO-8601 and CLF. Sessions being triaged rarely span a year boundary, and carrying per-file year inference would create false ordering across files with guessed years.
- **Decision:** Normalize every parsed timestamp to a year-less, UTC-naive `MM-DD HH:MM:SS.mmm` string. Because the format is zero-padded and fixed-width, lexicographic string comparison is exactly chronological order — enabling cheap prefix-compare time-range filtering and simple merged-timeline sorting with file order as tiebreak. Cross-year sessions are out of scope for v1. Lines without timestamps (stack traces, continuations) are null-timestamp records that attach to the preceding parsed line's timestamp when merging timelines, preserving their logical grouping.
- **Consequences:** Trivially correct and fast ordering/filtering with no timezone machinery; cross-year sessions sort incorrectly at the boundary (accepted, documented limitation); a future year-aware mode would require widening the model, not changing existing data; null-timestamp attachment is deterministic — a stack trace always follows its trigger line in merged view.

## ADR-0005 — TDD with shared case suite and coverage gates

- **Status:** accepted
- **Context:** The deliverable is browser-only, but browser-only testing is slow and hard to gate in CI. Conversely, Node tests can silently drift from browser behavior if the browser has its own test paths. Coverage targets need mechanical enforcement or they decay.
- **Decision:** Develop test-first against a single shared case suite, `tests/core-cases.js`: a UMD module of named input → expected cases consumed by `node --test` (Node 22) and, via the `/*__LT_CASES__*/` build token, by the in-page `?selftest` runner — one suite, two runners, no drift. Coverage is enforced per core `src/` module at ≥ 90% line and ≥ 85% branch by `node tools/coverage-gate.mjs`, run locally and in CI. UI glue (`src/app-*.js`), `build.js`, and tests are exempt. Progress is structured as gates G0–G8 with explicit entry/exit criteria (see `docs/test-plan.md`); CI runs test + coverage, build, and Playwright e2e, then bumps the version from conventional commits on main.
- **Consequences:** Every behavior change lands as a case first, keeping specs and code synchronized; the `?selftest` page doubles as a user-run diagnostic on any machine; coverage exemptions are explicit so UI glue cannot hide untested logic that belongs in core modules; gate discipline adds process overhead per feature, which is accepted as the cost of a trustworthy privacy-focused tool.

## ADR-0006 — Timer-throttle-resistant streaming

- **Status:** accepted
- **Context:** Streaming ingestion must yield to the UI thread periodically so progress rendering and cancellation stay responsive during long reads. The original implementation used `setTimeout` for these yields, but browsers clamp timers in hidden/background tabs to ≥ 1 s, which stalled ingestion of large files whenever the tab was not visible — turning a ~30 s load into many minutes.
- **Decision:** Periodic UI yields during ingestion use `MessageChannel` instead of `setTimeout`. MessageChannel postMessage dispatches as a macrotask that browsers do not subject to timer clamping, so ingestion keeps making progress regardless of tab visibility.
- **Consequences:** Yields are cheap and unthrottled in all tab states; the cost is one MessageChannel per batch (creation/dispatch overhead). Background tabs can still show somewhat lower throughput for other browser-scheduling reasons, but no longer suffer order-of-magnitude timer clamping; confirmed by the big-file performance evidence in `docs/test-plan.md`.

## ADR-0007 — Transient view filters are session-scoped

- **Status:** accepted
- **Context:** The app originally persisted quick search, level chips, time range, and the search pattern across sessions alongside themes, mask/rule config, presets, and bookmarks. A restored stale filter made freshly loaded files appear empty or nearly empty — the "new files are invisible" bug reported against v1.1.x — even though ingestion had succeeded. The fault was in persistence policy, not in ingestion or rendering.
- **Decision:** Transient view filters — quick search, level chips, time range, and the search pattern — are intentionally not persisted across sessions. Rules, masks, presets, themes, and bookmarks remain persisted because they describe durable user configuration rather than a moment's investigative focus.
- **Consequences:** Reloading the page always starts with an unfiltered view of whatever is loaded, so newly loaded files are immediately visible; users who need a filter across a reload must reapply it — accepted friction, far cheaper than misdiagnosing "lost" logs. The persistence specs and the `fresh()` e2e helper (which clears localStorage before app boot) cover this behavior.
