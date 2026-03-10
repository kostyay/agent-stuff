{
  "id": "as-04bb",
  "title": "Fix tests/plan-ask.test.ts — update mocks for current API",
  "status": "open",
  "type": "task",
  "priority": 2,
  "tests_passed": false,
  "created_at": "2026-03-10T09:05:01.035Z",
  "parent": "as-2165"
}

Fix the broken `tests/plan-ask.test.ts` test file. All 4 tests are currently failing with `TypeError: Cannot read properties of undefined (reading 'on')` — the mock `ExtensionAPI` object is missing methods that `plan-ask.ts` now calls during registration.

**File to fix:** `tests/plan-ask.test.ts`
**Extension under test:** `pi-extensions/plan-ask.ts`

**Root cause:** The extension calls `pi.on(...)`, `pi.registerCommand(...)`, `pi.registerShortcut(...)`, and possibly other `ExtensionAPI` methods that aren't present on the mock object created in the test. The pi extension API has evolved since these tests were written.

**How to fix:**

1. Read the current `pi-extensions/plan-ask.ts` to identify every `pi.*` method called during `planAskExtension(pi)` registration:
   - `pi.registerCommand(...)` — needs a mock
   - `pi.registerShortcut(...)` — needs a mock
   - `pi.on(eventName, handler)` — needs a mock
   - `pi.events.on(...)` / `pi.events.emit(...)` — needs a mock if used
   - Any other method calls

2. Update the mock `ExtensionAPI` in the test to include all required methods. Follow the pattern used in `tests/status-bar.test.ts` and `tests/timed-confirm.test.ts` for mock construction. Capture registered handlers so tests can invoke them.

3. Verify that the existing test assertions still make sense against the current extension behavior. The tests check:
   - MODE_DISPLAY theme colors are valid
   - Shift+Tab cycles modes without throwing
   - Shift+Tab notifies with mode label
   - Full rotation cycle returns to agent mode

4. Update any assertions that reference changed behavior.

**Approach:** Read the current extension code first, identify the full API surface it uses during `init(pi)`, then update the mock to satisfy it. Don't over-mock — only add what the extension actually calls.

**Conventions:** Keep using `node:test` + `node:assert/strict`. Fix existing tests, don't rewrite from scratch unless the mock is completely unusable.

## Acceptance Criteria

- All tests in `tests/plan-ask.test.ts` pass
- No new tests removed — only updated to match current API
- Mock covers all `ExtensionAPI` methods used by `plan-ask.ts` during registration

## Tests

- `node --experimental-strip-types --test tests/plan-ask.test.ts` passes with 0 failures
- Existing tests still pass (no regressions in other test files)
