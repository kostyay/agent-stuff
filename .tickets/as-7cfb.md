{
  "id": "as-7cfb",
  "title": "Unit tests for formatting.ts",
  "status": "open",
  "type": "task",
  "priority": 1,
  "tests_passed": false,
  "created_at": "2026-03-10T00:46:07.982Z",
  "parent": "as-5a68",
  "deps": [
    "as-0673"
  ]
}

Create `pi-extensions/subagent/test/formatting.test.ts` — pure unit tests for every exported function in `pi-extensions/subagent/formatting.ts`.

## Context
`formatting.ts` contains pure string formatting utilities with no pi runtime dependencies (only `ThemeColor` type import and `os.homedir()`). All tests should always run.

## Functions to test

### `shortenPath(p)`
- Path starting with homedir → replaced with `~` (e.g. `/Users/foo/bar` → `~/bar`)
- Path NOT starting with homedir → returned unchanged
- Homedir itself → `~`

### `formatTokens(count)`
- `0` → `"0"`
- `999` → `"999"` (under 1000 → raw)
- `1000` → `"1.0k"` (1k–10k → one decimal)
- `1234` → `"1.2k"`
- `9999` → `"10.0k"`
- `10000` → `"10k"` (10k–1M → rounded)
- `150000` → `"150k"`
- `999999` → `"1000k"`
- `1000000` → `"1.0M"` (>1M → one decimal)
- `1500000` → `"1.5M"`

### `formatUsageStats(usage, model?)`
- All fields populated → includes all parts: turns, ↑, ↓, R, W, $, ctx, model
- Zero fields omitted (e.g. `cacheRead: 0` → no `R` part)
- Model appended at end when provided
- Empty usage (all zeros, no model) → `""`
- Single turn → `"1 turn"` (no plural s)
- Multiple turns → `"2 turns"`

### `formatToolCall(toolName, args, themeFg)`
- Use identity `themeFg: (color, text) => text` mock
- `"bash"` → `"$ <command preview>"`, truncated at 60 chars
- `"read"` → `"read <path>"` with offset/limit range display
- `"write"` → `"write <path> (N lines)"`
- `"edit"` → `"edit <path>"`
- `"ls"` → `"ls <path>"`
- `"find"` → `"find <pattern> in <path>"`
- `"grep"` → `"grep /<pattern>/ in <path>"`
- Unknown tool → `"<toolName> <JSON args preview>"`, truncated at 50 chars
- Paths shortened via `shortenPath`

### `truncate(s, max)`
- String under max → unchanged
- String at max → unchanged
- String over max → truncated to `max-1` chars + `…`
- Empty string → empty

### `expandTabs(s)`
- Tab chars replaced with two spaces
- No tabs → unchanged
- Multiple tabs → each replaced independently

## Test framework
Use `node:test` + `node:assert/strict`. Import directly from `../formatting.js`.

## Acceptance Criteria

- All 6 functions have tests covering primary and edge cases
- `formatToolCall` covers all 7 named tool branches + default fallback
- `node --test test/formatting.test.ts` passes

## Tests

`node --test pi-extensions/subagent/test/formatting.test.ts` — all tests pass
