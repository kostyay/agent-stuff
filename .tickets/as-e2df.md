{
  "id": "as-e2df",
  "title": "Test runner configuration (npm test, deps)",
  "status": "open",
  "type": "task",
  "priority": 1,
  "tests_passed": false,
  "created_at": "2026-03-10T00:48:38.267Z",
  "parent": "as-5a68",
  "deps": [
    "as-0673"
  ]
}

Configure test runner for `pi-extensions/subagent/` so `npm test` runs all test files.

## Context
The subagent extension is part of the `agent-stuff` repo at `/Users/kostya/personal/agent-stuff/`. It uses TypeScript and imports from `@mariozechner/pi-coding-agent`, `@mariozechner/pi-tui`, `@mariozechner/pi-ai`, and `@sinclair/typebox`. Tests need to run with TypeScript support (either via `tsx`, `ts-node`, or Node's built-in `--experimental-strip-types`).

## What to do

### 1. Add test script to `package.json`
Add a `test` script (or `test:subagent` if `package.json` is at repo root) that runs:
```json
"test:subagent": "node --experimental-strip-types --test pi-extensions/subagent/test/*.test.ts"
```
Or if using `tsx`:
```json
"test:subagent": "tsx --test pi-extensions/subagent/test/*.test.ts"
```

Check what the repo already uses for TypeScript execution and be consistent.

### 2. Add dev dependencies if missing
- `@marcfargas/pi-test-harness` — needed for mock pi CLI in runner.test.ts and tool-handler.test.ts. Look up the current stable version before adding.

### 3. Verify TypeScript can resolve test imports
Test files import from `../utils.js`, `../formatting.js`, etc. (with `.js` extension for ESM compatibility). Ensure the TypeScript config supports this resolution. If a `tsconfig.json` exists, verify `moduleResolution` is set appropriately (e.g., `"bundler"` or `"node16"`).

### 4. Verify the test command works
After creating at least the helpers file (T1), run the test command and confirm it discovers test files and reports results (even if they're empty/placeholder tests).

## Constraints
- Don't create a separate `tsconfig.test.json` unless the existing config can't handle test files
- Don't change the repo's package manager or runtime
- Check what exists before adding anything

## Acceptance Criteria

- `npm test` (or `npm run test:subagent`) from repo root runs all `*.test.ts` files in `pi-extensions/subagent/test/`
- TypeScript imports resolve correctly
- `@marcfargas/pi-test-harness` available as dev dependency
- Command exits 0 when all tests pass

## Tests

Run `npm run test:subagent` — command executes without configuration errors, discovers test files
