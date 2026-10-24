# SPEC-FORMAT-001 (Compact)

**Goal**: Support custom log format definitions via named regex capture groups (`(?<ts>...)`, `(?<level>...)`, `(?<tag>...)`, `(?<pid>...)`, `(?<tid>...)`, `(?<msg>...)`), timestamp format normalization to `MM-DD HH:MM:SS.mmm`, custom level mappings, Config tab editor with live preview, and a viewer toolbar format override selector.

## Key Invariants
- Single-line matching only (non-matching lines become continuation records).
- Evaluated before built-in formats in descending priority order.
- Fully offline, pure JavaScript, zero external dependencies.
- Persisted in localStorage and exportable/importable via Config JSON.
- Viewer toolbar includes `#sel-format-override` to force any format for the active file.
