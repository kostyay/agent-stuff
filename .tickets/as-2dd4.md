{
  "id": "as-2dd4",
  "title": "Export commit parsers + unit tests",
  "status": "open",
  "type": "task",
  "priority": 1,
  "tests_passed": false,
  "created_at": "2026-03-10T09:03:36.369Z",
  "parent": "as-2165"
}

Add named exports for 4 pure parser functions in `pi-extensions/commit.ts`, then create `tests/commit.test.ts` with unit tests for them.

**File under test:** `pi-extensions/commit.ts`
**Test file:** `tests/commit.test.ts`

**Step 1: Add exports to `pi-extensions/commit.ts`**

These 4 functions are currently file-private. Add the `export` keyword to each and add a JSDoc comment:

1. **`truncateDiff(diff: string): string`** (line ~136) — truncates diff to `MAX_DIFF_LENGTH` (15000 chars), appending `\n\n[diff truncated]` marker.

2. **`cleanFirstLine(raw: string): string`** (line ~142) — strips markdown backtick fences, leading/trailing quotes, takes first line, trims.

3. **`parseCommitAndBranch(raw: string): CommitAndBranch`** (line ~230) — parses Haiku response with `COMMIT: <msg>` and `BRANCH: <name>` lines. Falls back to `FALLBACK_COMMIT` / `FALLBACK_BRANCH` constants. Branch name is lowercased and sanitized (only `a-z0-9/-`).

4. **`parsePrContent(raw: string): PrContent`** (line ~266) — parses `TITLE: <title>` and `BODY:\n<body>` format. Falls back to `"chore: update"` / `""`.

Also export the `CommitAndBranch` and `PrContent` interfaces, and the fallback constants `FALLBACK_COMMIT` and `FALLBACK_BRANCH` so tests can assert against them.

**Step 2: Create `tests/commit.test.ts`**

Test cases per function:

**`truncateDiff`:**
- Short diff (< 15000) returned unchanged
- Exact-length diff returned unchanged
- Long diff truncated with `[diff truncated]` marker
- Empty string returned unchanged

**`cleanFirstLine`:**
- Strips backtick code fences
- Strips leading/trailing single and double quotes
- Takes only first line from multiline input
- Trims whitespace
- Empty string returns empty
- Already clean string returned as-is

**`parseCommitAndBranch`:**
- Parses well-formed `COMMIT: feat(auth): add login\nBRANCH: feat/add-login`
- Missing COMMIT line falls back to `FALLBACK_COMMIT`
- Missing BRANCH line falls back to `FALLBACK_BRANCH`
- Branch name sanitized: uppercase → lowercase, special chars → dashes, trailing dashes removed
- Empty string falls back to both defaults
- Extra lines/whitespace around COMMIT/BRANCH lines ignored

**`parsePrContent`:**
- Parses well-formed `TITLE: feat: add auth\nBODY:\n- Added login\n- Added logout`
- Missing TITLE falls back to `"chore: update"`
- Missing BODY returns empty string
- Multiline BODY preserved
- Trims whitespace from title and body

**Conventions:** `node:test` + `node:assert/strict`. ~20 tests expected.

## Acceptance Criteria

- 4 functions exported from `pi-extensions/commit.ts` with JSDoc
- `CommitAndBranch`, `PrContent` interfaces exported
- `FALLBACK_COMMIT`, `FALLBACK_BRANCH` constants exported
- `tests/commit.test.ts` exists with ≥ 18 test cases, all passing
- Existing extension behavior unchanged (default export still works)

## Tests

- `node --experimental-strip-types --test tests/commit.test.ts` passes with 0 failures
- Existing tests still pass (no regressions)
