# SPEC-FILES-001 Acceptance Criteria

Verification layer for SPEC-FILES-001. Every criterion is binary-testable with the named command; requirements (GEARS obligations) live in `spec.md` — this file states observable evidence only.

## §A Verification approach

- Primary: Playwright e2e (Chromium against the built single-file HTML — `npm run build && npm run e2e`), new spec `tests/e2e/files-panel-names.e2e.spec.mjs` following the `app.e2e.spec.mjs` harness (`tools/serve.mjs`, zero-uncaught-page-errors `afterEach`).
- Regression: existing unit suites (`npm test`, Node `node --test`) exit 0; existing e2e specs pass unmodified.
- Static contract: targeted `grep` on `template.html` / `src/app.js` for the CSS triplet and the tooltip insertions.

## §B AC Matrix (Given-When-Then)

| ID | Requirement | Given | When | Then |
|---|---|---|---|---|
| AC-FILES-001 | REQ-001/002 | A live file whose stored name is wider than the panel (runtime-generated temp fixture, ~120-char name — under OS filename limits, far past panel width) | The entry renders in `#file-list` | `.fname` computed style is `white-space: nowrap`, `overflow: hidden`, `text-overflow: ellipsis`; element height ≈ one line-height (no wrap); `scrollWidth > clientWidth` is permitted (clipped) |
| AC-FILES-002 | REQ-003/004 | A live entry with stored name `N` | `.fname` is queried | `getAttribute('title') === N` (the exact stored value, including any intra-archive folder prefix — exact equality proves no metadata duplication and no JS shortening) |
| AC-FILES-003 | REQ-003/005 | A cached entry (`.file-item.cached`) with stored name `C` | The entry is queried and hovered/clicked | `.fname` `title === C`; `getComputedStyle('.fname','::after').content` includes `↻`; container `title === 'cached — click to load'`; click still loads the file |
| AC-FILES-004 | REQ-003/006 | A missing entry (`.file-item.missing`) with stored name `M` | The entry is queried | `.fname` `title === M`; `.fname` computed `text-decoration-line` includes `line-through`; container `title === 'this file could not be restored'` |
| AC-FILES-005 | REQ-003/004 | A file whose name contains `<`, `>`, `&`, `"`, `'` | The entry renders | `title` decodes to the exact raw name (unshortened, unrewritten — REQ-004); no HTML markup is injected into the entry (element count/DOM shape unchanged) |
| AC-FILES-006 | REQ-001/005 | A short cached name that does NOT overflow | The entry renders | No clipping occurs (`scrollWidth <= clientWidth`); the `↻` suffix is still rendered — asserted via `getComputedStyle(el, '::after').content` including `↻` (the AC-003 mechanism; `::after` content is invisible to `textContent`) |
| AC-FILES-007 | REQ-005..008 | The pre-existing files-panel behaviors (`.fx` remove button incl. its title, cached click-to-load, active highlight, filter/sort) | The existing e2e suites run | All pre-existing specs pass unmodified; `npm test` exit 0 |
| AC-FILES-008 | REQ-001/002/007 | The built sources | Static checks + full e2e run | `template.html` `.file-item .fname` rule contains the ellipsis triplet and NO `word-break`; `npm run build && npm run e2e` passes including `files-panel-names.e2e.spec.mjs` with zero uncaught page errors |

## §C Evidence commands

```bash
npm test                                        # AC-007: exit 0
npm run build && npm run e2e                    # AC-001..008: full suites green
grep -n "file-item .fname" template.html        # AC-008: rule carries ellipsis triplet, no word-break
grep -n "fname\" title=" src/app.js             # AC-002..005: three esc()'d tooltip insertions
git diff --exit-code -- log-triage.html         # bundle freshness (CI parity)
```

## §D Edge cases

- Name exactly at the panel-width boundary: either state is acceptable; the contract is the CSS triplet + single line, not a specific glyph count.
- Overflowing cached name: the `↻` glyph may be clipped by the ellipsis box — accepted per spec.md Assumptions; the tooltip still carries the full name.
- Archive members with deep intra-archive prefixes: tooltip shows the prefix verbatim (it is part of the stored name).
- Filter active while truncation asserted: truncation is independent of `#file-filter`; assertions may run filtered or unfiltered.
- Mobile drawer width: the base rule is width-agnostic — no separate assertion required.

## §E Quality gates (harness: minimal)

1. `npm test` → exit 0.
2. `npm run build && npm run e2e` → all suites green, including the new files-panel spec; zero uncaught page errors.
3. Bundle freshness: `git diff --exit-code -- log-triage.html` after build (CI parity).
4. Coverage gate: unchanged — `src/app.js` is exempt; no logic moved into gated modules.

## §F Definition of Done

- AC-FILES-001..008 all PASS with verbatim command output attributed to this tree and HEAD SHA.
- No existing test modified except a provably-obsolete wrap assertion (reported explicitly if so).
- PRESERVE list of plan.md §D intact (verified by diff scope).
- Conventional commits per milestone, direct to `main`, including the rebuilt bundle.

## §G Traceability

AC-FILES-001→REQ-001/002 · 002→REQ-003/004 · 003→REQ-003/005 · 004→REQ-003/006 · 005→REQ-003/004 · 006→REQ-001/005 · 007→REQ-005..008 · 008→REQ-001/002/007. Every REQ is covered by at least one AC; every AC traces to at least one REQ.
