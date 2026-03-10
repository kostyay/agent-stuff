{
  "id": "as-46bb",
  "title": "Unit tests for subagent/formatting.ts",
  "status": "open",
  "type": "task",
  "priority": 2,
  "tests_passed": false,
  "created_at": "2026-03-10T09:03:13.124Z",
  "parent": "as-2165"
}

Create `tests/subagent-formatting.test.ts` with unit tests for all exported pure functions in `pi-extensions/subagent/formatting.ts`.

**File under test:** `pi-extensions/subagent/formatting.ts`
**Test file:** `tests/subagent-formatting.test.ts`

All functions are already exported. Import them directly:
```typescript
import { shortenPath, formatTokens, formatUsageStats, formatToolCall, truncate, expandTabs } from "../pi-extensions/subagent/formatting.ts";
```

**Functions to test:**

1. **`shortenPath(p)`** — replaces homedir prefix with `~`; leaves non-home paths unchanged; handles path equal to homedir exactly

2. **`formatTokens(count)`** — <1000 returns as-is ("500"); 1000-9999 returns one decimal ("1.2k"); 10000-999999 returns rounded ("150k"); ≥1000000 returns one decimal ("1.1M"); edge cases: 0, 999, 1000, 9999, 10000, 999999, 1000000

3. **`formatUsageStats(usage, model?)`** — includes turns when > 0; includes input/output as ↑/↓; includes cacheRead/cacheWrite as R/W; includes cost as $X.XXXX; includes contextTokens as ctx:; includes model name; omits zero fields; handles all-zero usage

4. **`formatToolCall(toolName, args, themeFg)`** — For `themeFg`, use an identity function: `(color, text) => text` or a tagging function `(color, text) => \`[${color}]${text}\`` to verify color choices.
   - "bash": shows command preview, truncated at 60 chars
   - "read": shows path (shortened), with line range when offset/limit present; supports both `file_path` and `path` arg names
   - "write": shows path with line count
   - "edit": shows path
   - "ls": shows path
   - "find": shows pattern + path
   - "grep": shows pattern + path
   - unknown tool: shows tool name + JSON args preview truncated at 50

5. **`truncate(s, max)`** — returns short strings unchanged; truncates long strings and appends "…"; boundary: string length exactly `max` is unchanged

6. **`expandTabs(s)`** — replaces tab chars with two spaces; handles no tabs; handles multiple tabs

**Note on `shortenPath`:** It uses `os.homedir()` at runtime. Tests should use the actual homedir value from `os.homedir()` to construct test paths, making the test portable.

**Conventions:** `node:test` + `node:assert/strict`. Group by function name in `describe()` blocks. ~25 tests expected.

## Acceptance Criteria

- `tests/subagent-formatting.test.ts` exists and covers all 6 exported functions
- All tests pass via `node --experimental-strip-types --test tests/subagent-formatting.test.ts`
- ≥ 20 individual test cases

## Tests

- `node --experimental-strip-types --test tests/subagent-formatting.test.ts` passes with 0 failures
- Existing tests still pass (no regressions)
