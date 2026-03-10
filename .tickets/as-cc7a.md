{
  "id": "as-cc7a",
  "title": "Export loop prompt builders + unit tests",
  "status": "open",
  "type": "task",
  "priority": 2,
  "tests_passed": false,
  "created_at": "2026-03-10T09:04:43.623Z",
  "parent": "as-2165"
}

Add named exports for 3 pure functions and 1 type in `pi-extensions/loop.ts`, then create `tests/loop.test.ts` with unit tests.

**File under test:** `pi-extensions/loop.ts`
**Test file:** `tests/loop.test.ts`

**Step 1: Add exports to `pi-extensions/loop.ts`**

These are currently file-private. Add `export` keyword and JSDoc:

1. **`type LoopMode = "tests" | "custom" | "self"`** — the three loop mode variants.

2. **`buildPrompt(mode: LoopMode, condition?: string): string`** — returns the prompt text sent as a follow-up message each loop iteration.
   - "tests" → mentions running tests and calling `signal_loop_success`
   - "custom" → includes the user's condition text, mentions `signal_loop_success`
   - "self" → mentions "when finished" and `signal_loop_success`

3. **`summarizeCondition(mode: LoopMode, condition?: string): string`** — returns a short fallback summary for the status widget.
   - "tests" → "tests pass"
   - "self" → "done"
   - "custom" → truncates to 48 chars with "..." suffix

4. **`getConditionText(mode: LoopMode, condition?: string): string`** — returns the raw condition text for compaction instructions.
   - "tests" → "tests pass"
   - "self" → "you are done"
   - "custom" → user's condition text or "custom condition" fallback

**Step 2: Create `tests/loop.test.ts`**

**`buildPrompt`:**
- "tests" mode: includes "Run all tests" and "signal_loop_success"
- "custom" with condition: includes condition text and "signal_loop_success"
- "custom" without condition: uses fallback "the custom condition is satisfied"
- "self" mode: includes "Continue until you are done" and "signal_loop_success"

**`summarizeCondition`:**
- "tests" → exactly "tests pass"
- "self" → exactly "done"
- "custom" with short condition → returns it as-is
- "custom" with >48 char condition → truncated to 45 chars + "..."
- "custom" with no condition → "custom condition"

**`getConditionText`:**
- "tests" → "tests pass"
- "self" → "you are done"
- "custom" with condition → returns it verbatim
- "custom" with empty/undefined condition → "custom condition"

**Conventions:** `node:test` + `node:assert/strict`. ~15 tests expected.

## Acceptance Criteria

- `LoopMode` type and 3 functions exported from `pi-extensions/loop.ts` with JSDoc
- `tests/loop.test.ts` exists with ≥ 13 test cases, all passing
- Existing extension behavior unchanged (default export still works)

## Tests

- `node --experimental-strip-types --test tests/loop.test.ts` passes with 0 failures
- Existing tests still pass (no regressions)
