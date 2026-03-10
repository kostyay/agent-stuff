{
  "id": "as-f0df",
  "title": "E2E tests for tool handler (pi test harness)",
  "status": "open",
  "type": "task",
  "priority": 2,
  "tests_passed": false,
  "created_at": "2026-03-10T00:48:19.121Z",
  "parent": "as-5a68",
  "deps": [
    "as-0673",
    "as-a098"
  ]
}

Create `pi-extensions/subagent/test/tool-handler.test.ts` — end-to-end tests for the `subagent` tool registered in `pi-extensions/subagent/index.ts`, using `@marcfargas/pi-test-harness` `createTestSession`.

## Context
The subagent extension registers a `subagent` tool via `pi.registerTool()` in `index.ts`. The tool handler supports 3 modes (single, parallel, chain) plus session continuation. E2E tests load the real extension, mock the model with playbook-scripted actions, and mock the spawned subagent processes with `createMockPi()`.

## Reference implementation
Follow the pattern from `/Users/kostya/work/pi-subagents/test/e2e-tool.test.ts` — uses `createTestSession`, `when`, `calls`, `says` from the harness.

## Test setup
```typescript
const harness = await tryImport<any>("@marcfargas/pi-test-harness");
const available = !!harness;

let mockPi: MockPi | undefined;
if (available) {
  mockPi = createMockPi();
  mockPi.install();
  process.on("exit", () => mockPi?.uninstall());
}

const EXTENSION = path.resolve("index.ts"); // path to subagent extension entry
```

Each test creates a session with the extension loaded:
```typescript
t = await createTestSession({
  extensions: [EXTENSION],
  mockTools: { bash: "ok", read: "ok", write: "ok", edit: "ok" },
});
```

Use `writeTestAgents(t.cwd, [...])` to set up agents in the session's cwd.

## Test cases

### Validation
- **Rejects ambiguous mode**: Both `agent+task` AND `chain` provided → error containing "exactly one mode" or "Provide exactly one"
- **Rejects empty chain**: `chain: []` → treated as no mode selected → error
- **Rejects empty tasks**: `tasks: []` → treated as no mode → error
- **Rejects too many parallel tasks**: `tasks` array with 9 entries (> MAX_PARALLEL_TASKS=8) → error mentioning max
- **Unknown session**: `sessionId: "nonexistent-id"` → error containing "Unknown session"

### Single mode
- **Executes single agent**: `mockPi.onCall({ output: "Hello" })` + `{ agent: "echo", task: "Say hello", agentScope: "project" }` → result contains "Hello", not an error
- **Returns sessionId**: Result text or details include a session ID for continuation
- **Error on failed agent**: `mockPi.onCall({ exitCode: 1, stderr: "crashed" })` → `isError: true`
- **Unknown agent**: `{ agent: "nonexistent", task: "..." }` → error mentioning "Unknown"

### Chain mode
- **2-step chain**: Two agents, both succeed → result has 2 step outputs
- **{previous} substitution**: Step 1 outputs unique marker → step 2 receives it in task
- **Chain stops on failure**: Step 1 fails → step 2 never runs, error reported
- **Unknown agent in chain**: Second step has unknown agent → error

### Parallel mode
- **Runs multiple agents**: 2 tasks → both complete, summary shows "2/2 succeeded"
- **Independent results**: Each result has correct agent name
- **Mixed success/failure**: One succeeds, one fails → summary reflects counts

### Session continuation
- **Continue existing session**: Run single agent (gets sessionId), then call with `sessionId` + new task → resumes successfully

## Graceful skip
Entire file skips if `@marcfargas/pi-test-harness` unavailable.

## Test framework
Use `node:test` + `node:assert/strict`. Access tool results via `t.events.toolResultsFor("subagent")`.

## Acceptance Criteria

- All validation paths tested (5 cases)
- Single, chain, parallel modes each have 3-4 test cases
- Session continuation tested
- Skips gracefully when harness unavailable
- `node --test test/tool-handler.test.ts` passes

## Tests

`node --test pi-extensions/subagent/test/tool-handler.test.ts` — all tests pass or skip
