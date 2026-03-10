{
  "id": "as-29fb",
  "title": "Filesystem integration tests for agents.ts",
  "status": "open",
  "type": "task",
  "priority": 1,
  "tests_passed": false,
  "created_at": "2026-03-10T00:47:17.233Z",
  "parent": "as-5a68",
  "deps": [
    "as-0673"
  ]
}

Create `pi-extensions/subagent/test/agents.test.ts` — filesystem integration tests for `pi-extensions/subagent/agents.ts`.

## Context
`agents.ts` handles agent discovery from the filesystem (reading `.md` files with YAML frontmatter), team loading from `teams.yaml`, and agent model updates. Tests need real temp directories with actual files. Imports `getAgentDir` and `parseFrontmatter` from `@mariozechner/pi-coding-agent`, so use `tryImport` for graceful skip.

## Functions to test

### `discoverAgents(cwd, scope, bundledDir?)`

Setup: Create temp dirs simulating user agents dir, project `.pi/agents/` dir, and bundled agents dir. Use `writeTestAgents` helper or write `.md` files directly.

**Test cases:**
- **scope="user"**: Only loads from user dir, ignores project dir
- **scope="project"**: Only loads from project `.pi/agents/`, ignores user dir
- **scope="both"**: Merges both; project agents override user agents with same name
- **Bundled priority**: Bundled agents loaded but overridden by user and project agents with same name
- **Frontmatter parsing**: Correctly extracts `name`, `description`, `model`, `tools` (comma-separated) from YAML frontmatter
- **Body as systemPrompt**: Markdown body after `---` becomes `systemPrompt`
- **Skip invalid**: `.md` files missing `name` or `description` in frontmatter are skipped silently
- **Non-existent dir**: Returns empty agents array, no error
- **Non-`.md` files**: `.txt`, `.yaml` files in agents dir are ignored
- **Returns projectAgentsDir**: Correct path when `.pi/agents/` found, `null` when not

Note: `discoverAgents` calls `findNearestProjectAgentsDir` internally — test this behavior by creating `.pi/agents/` at different levels and checking discovery from subdirectories.

### `formatAgentList(agents, maxItems)`
- 0 agents → `{ text: "none", remaining: 0 }`
- 3 agents, maxItems=5 → all listed, remaining=0
- 5 agents, maxItems=3 → first 3 listed, remaining=2
- Text format: `"name (source): description"` separated by `"; "`

### `updateAgentModel(agent, newModel)`
- Agent file with existing `model: old-model` line → replaced with `model: new-model`
- Agent file without `model:` line → inserted before closing `---`
- `agent.model` property updated in-place
- Symlinks: Create a symlink to agent file, call `updateAgentModel` on symlink → target file is modified (uses `fs.realpathSync`)

### `loadTeams(projectAgentsDir, scope)`
- **User teams only** (scope="user"): Reads `teams.yaml` from user agents dir
- **Project teams only** (scope="project"): Reads from project agents dir
- **Both** (scope="both"): Merges; project teams override user teams with same name
- **Missing files**: Returns empty `{}` when no `teams.yaml` exists
- **YAML parsing**: Correctly maps team names to arrays of agent names

**teams.yaml format:**
```yaml
frontend:
  - scout
  - writer
backend:
  - planner
  - executor
```

### `parseTeamsYaml` (internal, tested via `loadTeams`)
- Multiple teams with multiple members
- Empty lines handled gracefully

## Test lifecycle
- `beforeEach`: Create temp dirs, set env vars if needed for `getAgentDir()` override
- `afterEach`: Remove temp dirs

## Test framework
Use `node:test` + `node:assert/strict`. Wrap in `tryImport` skip for `@mariozechner/pi-coding-agent` dependency.

## Acceptance Criteria

- `discoverAgents` tested for all 3 scopes + priority override behavior
- `updateAgentModel` tested for update + insert + symlink cases
- `loadTeams` tested for all scopes + merge behavior
- `node --test test/agents.test.ts` passes (or skips gracefully)

## Tests

`node --test pi-extensions/subagent/test/agents.test.ts` — all tests pass or skip
