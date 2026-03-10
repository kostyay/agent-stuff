{
  "id": "as-ffd2",
  "title": "Export simplify pure functions + unit tests",
  "status": "open",
  "type": "task",
  "priority": 2,
  "tests_passed": false,
  "created_at": "2026-03-10T09:04:00.239Z",
  "parent": "as-2165"
}

Add named exports for 8 pure functions in `pi-extensions/simplify.ts`, then create `tests/simplify.test.ts` with unit tests for them.

**File under test:** `pi-extensions/simplify.ts`
**Test file:** `tests/simplify.test.ts`

**Step 1: Add exports to `pi-extensions/simplify.ts`**

These functions are currently file-private. Add `export` keyword and JSDoc to each:

1. **`detectLanguage(files: string[]): string | null`** — counts file extensions, maps via `FILE_EXTENSIONS` (`{ ".ts": "js", ".go": "go", ".py": "py", ... }`), returns the language key with the highest count. Returns null if no supported files.

2. **`filterByLanguage(files: string[], lang: string): string[]`** — returns files whose extension maps to the given language key.

3. **`isSupportedFile(file: string): boolean`** — checks if the file extension exists in `FILE_EXTENSIONS`.

4. **`buildPrompt(skillContent: string, files: string[], extraInstructions?: string): string`** — assembles a user message with skill instructions header, file list, and optional extra instructions section.

5. **`parseArgs(args: string): ParsedArgs`** — splits tokens: those with supported extensions go to `files[]`, rest joined as `extraInstructions`. Returns `{ files, extraInstructions }`. Also export the `ParsedArgs` interface.

6. **`diffSnapshots(before: Map<string, FileStats>, after: Map<string, FileStats>): Map<string, number>`** — computes files modified between two snapshots. New files (in after, not before) are included. Changed files (different added/removed counts) are included. Unchanged files excluded. Returns map of file → absolute delta. Also export the `FileStats` interface.

7. **`buildConfirmMessage(files: string[], lang: string): string`** — ≤2 files: lists filenames; >2 files: shows count only. Uses uppercase language label.

8. **`wasAborted(event: unknown): boolean`** — finds last assistant message in `event.messages`, checks stopReason. Returns true for "aborted" or "error". Returns false when no messages or no assistant messages found.

Also export `FILE_EXTENSIONS` constant so tests can verify the mapping.

**Step 2: Create `tests/simplify.test.ts`**

Test cases:

**`detectLanguage`:**
- All .ts files → "js"
- All .go files → "go"
- All .py files → "py"
- Mixed .ts + .go, more .ts → "js"
- No supported files → null
- Empty array → null
- .tsx, .jsx, .mjs, .cjs all map to "js"

**`filterByLanguage`:**
- Filters .ts/.tsx for "js"
- Excludes .go when filtering "js"
- Empty files → empty result
- No matches → empty result

**`isSupportedFile`:**
- true for .ts, .tsx, .js, .go, .py
- false for .md, .json, .txt, .yaml

**`buildPrompt`:**
- Includes skill content verbatim
- Includes file list as bullet points
- Appends extra instructions section when provided
- Omits extra section when extraInstructions is undefined

**`parseArgs`:**
- "foo.ts bar.go" → files: ["foo.ts", "bar.go"], extraInstructions: undefined
- "foo.ts check for bugs" → files: ["foo.ts"], extraInstructions: "check for bugs"
- "" → files: [], extraInstructions: undefined
- "no files here" → files: [], extraInstructions: "no files here"

**`diffSnapshots`:**
- New file (in after only) → included with full delta
- Changed file (different counts) → included with absolute delta
- Unchanged file → excluded
- Empty before map → all after entries are new
- Empty after map → empty result

**`buildConfirmMessage`:**
- 1 file → includes filename
- 2 files → includes both filenames
- 3+ files → shows count, no filenames
- Language label is uppercased ("JS", "GO", "PY")

**`wasAborted`:**
- `{ messages: [{ role: "assistant", stopReason: "aborted" }] }` → true
- `{ messages: [{ role: "assistant", stopReason: "error" }] }` → true
- `{ messages: [{ role: "assistant", stopReason: "end_turn" }] }` → false
- `{ messages: [] }` → false
- `{}` → false
- `{ messages: [{ role: "user" }] }` → false (no assistant message)

**Conventions:** `node:test` + `node:assert/strict`. ~30 tests expected.

## Acceptance Criteria

- 8 functions + `ParsedArgs` + `FileStats` + `FILE_EXTENSIONS` exported from `pi-extensions/simplify.ts` with JSDoc
- `tests/simplify.test.ts` exists with ≥ 28 test cases, all passing
- Existing extension behavior unchanged (default export still works)

## Tests

- `node --experimental-strip-types --test tests/simplify.test.ts` passes with 0 failures
- Existing tests still pass (no regressions)
