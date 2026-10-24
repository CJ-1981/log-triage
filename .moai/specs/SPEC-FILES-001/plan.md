# SPEC-FILES-001 Implementation Plan

## §A Context

- Repo: `/Users/chimin/Downloads/log-triage` (privacy-first single-file HTML log viewer; vanilla JS UMD, no framework, no deps). Branch `main`, Route A (Hybrid Trunk main-direct — Tier S default; no PR, no branch).
- SPEC artifacts: `.moai/specs/SPEC-FILES-001/{spec,plan,acceptance,progress}.md`. Tier: S (harness `minimal`). Development mode: tdd.
- Feature (user-approved, clarity 10/10 — decisions settled, do not re-open):
  1. Native `title` tooltip = full stored name (exactly as stored, `esc()`-escaped) on every files-panel entry — live, cached, missing. Name only, no metadata.
  2. Single-line truncation: `.file-item .fname` clips with `text-overflow: ellipsis` replacing the `word-break: break-all` multi-line wrap; ellipsis is the only indicator.
  3. Applies to all three entry kinds.
- Existing infrastructure — EXTEND: `renderFiles()` (`src/app.js:460-538`, single render site), `.file-item .fname` rule (`template.html:96`). PRESERVE: sibling `.file-item` rules (`template.html:87-95, 97-101`), `.fx` button titles (`src/app.js:487, 515`), container tooltips (`src/app.js:520, 528`), all non-files-panel ellipsis/tooltip surfaces.
- Estimated delta: ~5 source lines + one `package.json` `scripts.e2e` entry + one new e2e spec file. Well under Tier S bounds.

## §B Known Issues / Risks

- R1 — `.cached .fname::after` interplay: the `↻` glyph (template.html:92) rides in the same clipped inline box as the ellipsized text; on overflowing cached names the browser may render the ellipsis before the glyph or clip it. ACCEPTED per the user decision (ellipsis is THE indicator; tooltip carries the full name; the rule stays untouched). Non-overflowing cached names keep visible `name ↻` (AC-FILES-006). No JS mitigation permitted (would violate REQ-004/007).
- R2 — Ellipsis determinism in headless Chromium: do not assert pixel-level ellipsis glyphs. Assert computed styles (`white-space/overflow/text-overflow`) plus the overflow signal (`scrollWidth > clientWidth`) with a runtime-generated temp fixture file named with ~120 chars — long enough to overflow the ~250-300px panel many times over, yet under the 255-byte OS filename cap (and the Windows 260-char full-path budget) on every dev/CI platform — and single-line-ness via element height ≈ 1 line-height.
- R3 — Attribute-context escaping: `esc()` (= `escapeHtml`, `src/util.js:14`) must yield double-quote-safe attribute content. Precedent exists in the same function (`data-remove="' + esc(f.id) + '"`, src/app.js:487); verify during implementation and note in the run report.
- R4 — Cached-entry e2e fixtures need an IDB-seeded cache; reuse the seeding approach of `tests/e2e/restore-repro.spec.mjs:93-96`. Missing-entry fixtures = cached entries whose `data` is absent.
- R5 — Bundle-freshness CI gate: `git diff --exit-code -- log-triage.html` fails on a stale committed bundle. M3 MUST rebuild (`npm run build`) and include `log-triage.html` in the commit.
- R6 — Do not modify existing files-panel e2e assertions in `tests/e2e/app.e2e.spec.mjs` — the change could alter layout assumptions there (`.file-item` selectors at 173, 261-263, 525, 613). If any existing spec asserts multi-line wrapping (none known), that assertion is updated in its own right — report it, never silently relax it.

## §C Pre-flight

```bash
git branch --show-current          # expect main
git rev-parse --short HEAD
npm test                           # baseline: exit 0 before any change
npm run build && npm run e2e       # baseline: full suites green before any change
grep -n "file-item .fname" template.html   # touchpoint sanity (line 96)
```

Baseline failures are reported, not absorbed: a pre-existing red baseline blocks M3's "new spec passes" claim from being attributed to this SPEC.

## §D Constraints

- PRESERVE (untouched): `src/app.js` outside `renderFiles()`; `template.html:87-95` and `97-101`; `.fx` titles; both container tooltips; `.vcell.fl`, `.sr-row .srf`, `.history-item`, `#sall-note`, tab labels, headers; `tests/e2e/app.e2e.spec.mjs`; `src/filters.js` (coverage-gated — no logic moves there); `build.js`.
- No new dependencies, no new CSS classes, no literal colors, no custom tooltip surface.
- The stored name is never mutated; no JS measurement/truncation code.
- Forbidden: `--no-verify`, `--amend`, force-push, `git add -A`/`git commit -a` (stage by explicit pathspec), any branch/worktree/issue creation in this SPEC's plan phase.
- TDD note: `tdd_settings.test_first_required` is satisfied by writing the M3 e2e assertions and capturing RED (failing) output before the M1/M2 GREEN steps land; the parent-approved milestone ORDER (CSS → tooltips → tests) is authoritative for deliverables, and manager-develop MAY front-load the spec file to capture verbatim RED evidence (E8 of the self-verification matrix).
- Commits: conventional, per-milestone (`feat(SPEC-FILES-001): M1 ...`), direct to `main` (Route A), including the rebuilt `log-triage.html`.

## §E Self-Verification

Per `verification-claim-integrity.md` §3 (Claim / Evidence / Baseline-attribution / Gaps / Residual-risk), each item names command + verbatim output + HEAD SHA:

- E1 — AC binary PASS/FAIL matrix over AC-FILES-001..008 (evidence: the new e2e spec run output).
- E2 — `npm test` → exit 0 (verbatim tail).
- E3 — `npm run build && npm run e2e` → all suites green incl. `tests/e2e/files-panel-names.e2e.spec.mjs`; zero uncaught page errors.
- E4 — Bundle freshness: `git diff --exit-code -- log-triage.html` after build → silent (exit 0).
- E5 — Static contract greps: `grep -n "text-overflow: ellipsis" template.html` shows the `.file-item .fname` rule; `grep -n "word-break" template.html` shows NO `.fname` hit; `grep -n 'fname" title=' src/app.js` is the precise 0→3 discriminator for the tooltip insertions (a bare `esc(c.name)` count cannot distinguish the two pre-existing text-node uses at src/app.js:521/529).
- E6 — RED evidence (TDD): verbatim failing output of the new e2e spec captured before the CSS/tooltip changes (if front-loaded per §D).
- E7 — Push state: commit SHAs + `git push origin main` result.

## §F Milestones (serial, priority-ordered by decision-reversibility: visual decisions first, mechanics last)

### M1 — CSS single-line ellipsis (Priority High)

- `template.html:96`: `.file-item .fname { font-size: 12.5px; word-break: break-all; }` → `.file-item .fname { font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }`.
- The base rule covers all three entry kinds (live, cached, missing — `.fname muted` on missing entries still matches `.file-item .fname`). Verify, do not restructure, the interplay with `template.html:92` (`.cached .fname::after` ↻) and `template.html:94` (missing line-through) — risk R1.
- No JS change. Exit: CSS contract in place; existing suites still green.

### M2 — Native full-name tooltips (Priority High)

- `src/app.js` `renderFiles()`:
  - Live (line 488): `<div class="fname">' + esc(f.name) + '</div>` → `<div class="fname" title="' + esc(f.name) + '">' + esc(f.name) + '</div>`.
  - Cached (line 521): same pattern with `esc(c.name)`.
  - Missing (line 529): same pattern with `esc(c.name)`.
- Container titles (`src/app.js:520, 528`) and `.fx` titles (`487, 515`) remain byte-identical. Attribute-context safety per risk R3.
- Exit: all three templates carry `title="esc(name)"`; `npm test` still green.

### M3 — Tests + bundle (Priority Medium)

- New e2e spec `tests/e2e/files-panel-names.e2e.spec.mjs`, bootstrapped on the `app.e2e.spec.mjs` pattern (`tools/serve.mjs` + Chromium, built `log-triage.html`, `afterEach` zero-page-errors invariant). Separate file per suite is the repo convention (app + stress + restore-repro are separate files).
- Wire the new spec into `package.json` `scripts.e2e` — the script is a hardcoded file list (`node --test tests/e2e/app.e2e.spec.mjs tests/e2e/stress.e2e.spec.mjs`, package.json:11), so append `tests/e2e/files-panel-names.e2e.spec.mjs`; without this the AC evidence command `npm run build && npm run e2e` never executes the new spec (audit D1).
- Assertions: AC-FILES-001..006 (generate a temp fixture file with a ~120-char name at runtime — the repo's real-disk-file `setInputFiles` pattern; the in-memory `{name, mimeType, buffer}` payload form has zero in-repo precedent and is not used — and load it via the same file-input mechanism `fresh()` uses; seed the IDB cache for cached/missing fixtures per R4). Unit tests: none added — no new pure-function helper is warranted (decision recorded in spec.md Constraints); `npm test` must remain exit 0 as the regression gate.
- Run: `npm run build && npm run e2e`; rebuild + stage `log-triage.html`; conventional commit(s) + push (E7).
- Exit: AC-FILES-007/008 PASS with evidence.

## §G Anti-Patterns

- Do NOT introduce a custom tooltip div/CSS class or JS hover logic — native `title` only (REQ-007).
- Do NOT measure or clamp names in JS — clipping is CSS-only (REQ-004).
- Do NOT touch `.vcell.fl`, `.sr-row .srf`, `.history-item`, tab labels, or headers while "in the area" (scope discipline; REQ-008).
- Do NOT replace `word-break` with `overflow-wrap`/`white-space: normal` variants that reintroduce wrapping (REQ-002).
- Do NOT add ellipsis/metadata to `.fmeta` or duplicate size/lines into the tooltip (REQ-004).
- Do NOT relax existing e2e assertions to make the suite pass — update only a genuinely-obsolete multi-line-wrap assertion, and report it explicitly (R6).

## §H Cross-References

- SPEC: `.moai/specs/SPEC-FILES-001/spec.md` (requirements REQ-FILES-001..008), `acceptance.md` (AC-FILES-001..008), `progress.md` (§E lifecycle signals).
- Precedent SPECs: SPEC-VIEWER-002 (tooltip copy style), SPEC-DLT-BINARY-001 (recent Tier artifact-set precedent).
- Code touchpoints: `src/app.js:460-538` (renderFiles; `.fname` at 488/521/529), `src/util.js:14` (escapeHtml), `template.html:87-101` (files-panel CSS; target rule at 96), `template.html:395-412` (panel skeleton).
- Tests: `tests/e2e/app.e2e.spec.mjs` (harness pattern; helpers at 62-90), `tests/e2e/restore-repro.spec.mjs` (cache-seeding pattern).
- Config: `quality.yaml` (development_mode: tdd), `.moai/project/tech.md` (build/CI/bundle-freshness, coverage exemptions).
