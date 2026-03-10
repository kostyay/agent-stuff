{
  "id": "as-cec4",
  "title": "Unit tests for subagent/utils.ts",
  "status": "open",
  "type": "task",
  "priority": 1,
  "tests_passed": false,
  "created_at": "2026-03-10T09:02:55.450Z",
  "parent": "as-2165",
  "deps": [
    "as-3b57"
  ]
}

Create `tests/subagent-utils.test.ts` with unit tests for all exported pure functions in `pi-extensions/subagent/utils.ts`.

**File under test:** `pi-extensions/subagent/utils.ts`
**Test file:** `tests/subagent-utils.test.ts`

All functions are already exported. Import them directly:
```typescript
import { zeroUsage, isAgentError, getErrorMessage, aggregateUsage, getFinalOutput, getDisplayItems, mapWithConcurrencyLimit, parseAgentSegments, writePromptToTempFile } from "../pi-extensions/subagent/utils.ts";
```

Types needed from `pi-extensions/subagent/types.ts`: `SingleResult`, `UsageStats`, `DisplayItem`, `ParsedSegment`.

**Functions to test and expected coverage:**

1. **`zeroUsage()`** — returns object with all numeric fields = 0 (input, output, cacheRead, cacheWrite, cost, contextTokens, turns)

2. **`isAgentError(r)`** — true when exitCode !== 0; true when stopReason === "error"; true when stopReason === "aborted"; false for clean result (exitCode 0, no error stopReason)

3. **`getErrorMessage(r)`** — prefers `r.errorMessage`; falls back to `r.stderr`; falls back to last assistant text via `getFinalOutput`; returns "(no output)" when all empty

4. **`aggregateUsage(results)`** — sums input/output/cacheRead/cacheWrite/cost/turns across results; handles empty array (all zeros); single result returns same values

5. **`getFinalOutput(messages)`** — extracts text from last assistant message; returns "" when no assistant messages; skips toolResult messages; handles multiple assistant messages (returns last)

6. **`getDisplayItems(messages)`** — collects text + toolCall items from assistant messages; skips non-assistant roles; preserves order

7. **`mapWithConcurrencyLimit(items, concurrency, fn)`** — respects concurrency limit (verify max concurrent via timing/counters); handles empty array; maintains result order; concurrency=1 runs serially; concurrency > items.length works fine

8. **`parseAgentSegments(input)`** — parses `agent "double-quoted task"`; parses `agent 'single-quoted task'`; parses `agent unquoted task text`; handles `->` chain separator; agent name only (no task) → `{ agent, task: "" }`; returns null for empty/undefined; multiple segments with mixed quoting; whitespace around `->` is trimmed

9. **`writePromptToTempFile(agentName, prompt)`** — creates file with correct content; sanitizes special chars in agent name for filename; file permissions are 0o600; returns `{ dir, filePath }` with valid paths. Clean up temp files in afterEach.

**Use `createTempDir`/`removeTempDir` from `tests/helpers.ts`** for any tests needing filesystem.

**Mock `Message` objects:** Build minimal objects matching the `Message` type from `@mariozechner/pi-ai`:
```typescript
const assistantMsg = { role: "assistant", content: [{ type: "text", text: "hello" }] };
const toolResultMsg = { role: "toolResult", content: [{ type: "text", text: "output" }] };
```

**Conventions:** `node:test` + `node:assert/strict`. Group by function name in `describe()` blocks. ~35 tests expected.

## Acceptance Criteria

- `tests/subagent-utils.test.ts` exists and covers all 9 exported functions
- All tests pass via `node --experimental-strip-types --test tests/subagent-utils.test.ts`
- ≥ 30 individual test cases

## Tests

- `node --experimental-strip-types --test tests/subagent-utils.test.ts` passes with 0 failures
- Existing tests still pass (no regressions)
