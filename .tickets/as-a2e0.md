{
  "id": "as-a2e0",
  "title": "Unit tests for utils.ts",
  "status": "open",
  "type": "task",
  "priority": 1,
  "tests_passed": false,
  "created_at": "2026-03-10T00:45:44.175Z",
  "parent": "as-5a68",
  "deps": [
    "as-0673"
  ]
}

Create `pi-extensions/subagent/test/utils.test.ts` — pure unit tests for every exported function in `pi-extensions/subagent/utils.ts`.

## Context
`utils.ts` contains pure helper functions used across the subagent extension. These have zero pi package dependencies at runtime (only `getAgentDir` from pi-coding-agent for path resolution), so most tests can run without the full pi environment.

## Functions to test

### `zeroUsage()`
- Returns `UsageStats` with all fields zero: `{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 }`

### `resultIcon(r, themeFg)`
- exitCode 0 → calls `themeFg("success", "✓")`
- exitCode > 0 → calls `themeFg("error", "✗")`
- exitCode -1 → calls `themeFg("warning", "⏳")`
- Use a simple identity `themeFg` mock: `(color, text) => text`

### `isAgentError(r)`
- `exitCode !== 0` → true
- `stopReason === "error"` → true (even with exitCode 0)
- `stopReason === "aborted"` → true
- Clean result (exitCode 0, no stopReason) → false

### `getErrorMessage(r)`
- Prefers `r.errorMessage` when set
- Falls back to `r.stderr` when no errorMessage
- Falls back to `getFinalOutput(r.messages)` when no stderr
- Returns `"(no output)"` when everything empty

### `aggregateUsage(results)`
- Sums `input`, `output`, `cacheRead`, `cacheWrite`, `cost`, `turns` across array
- Empty array → all zeros
- Single item → same values back
- Return type omits `contextTokens` (per the actual signature)

### `getFinalOutput(messages)`
- Returns last assistant message's text content
- Skips non-assistant messages
- Returns `""` when no assistant messages
- Returns `""` for empty array
- Handles assistant messages with no text content parts

### `getDisplayItems(messages)`
- Collects `{ type: "text", text }` items from assistant text content
- Collects `{ type: "toolCall", name, args }` from assistant toolCall content
- Skips non-assistant messages
- Returns empty array for no messages

### `mapWithConcurrencyLimit(items, concurrency, fn)`
- Processes all items and preserves order
- Respects concurrency limit (track max concurrent via counter)
- Handles empty array → returns `[]`
- Propagates errors from fn
- Handles concurrency > items.length gracefully

### `writePromptToTempFile(agentName, prompt)`
- Creates temp file in `os.tmpdir()` subdirectory
- File content matches prompt string
- Returns `{ dir, filePath }` — both exist on disk
- Agent name sanitized (non-word chars replaced with `_`)
- Clean up temp files in `afterEach`

### `ensureSessionDir()` / `getSessionDir()`
- `getSessionDir()` returns path ending in `sessions/subagents`
- `ensureSessionDir()` creates the directory recursively
- Calling twice doesn't error (idempotent)

### `parseAgentSegments(input)`
- `null`/`undefined`/`""` → returns `null`
- `"agent1"` → `[{ agent: "agent1", task: "" }]`
- `'agent1 "quoted task"'` → `[{ agent: "agent1", task: "quoted task" }]`
- `"agent1 'single quoted'"` → `[{ agent: "agent1", task: "single quoted" }]`
- `"agent1 unquoted task text"` → `[{ agent: "agent1", task: "unquoted task text" }]`
- `'agent1 "task1" -> agent2 "task2"'` → 2 segments
- `"agent1 -> agent2"` → 2 segments, both with empty task
- Whitespace around `->` is trimmed

## Test framework
Use `node:test` (`describe`, `it`, `before`, `afterEach`) + `node:assert/strict`. Import functions directly from `../utils.js`.

## Acceptance Criteria

- All functions from utils.ts have at least one test
- All branches covered (error vs success, empty vs populated)
- `node --test test/utils.test.ts` passes

## Tests

`node --test pi-extensions/subagent/test/utils.test.ts` — all tests pass, zero failures
