# lib/ — Shared Utilities

Reusable modules shared across extensions. Extensions import from here
via relative paths (`../lib/<module>.ts`). No module in this directory
may import from `pi-extensions/` — the dependency arrow is one-way.

## Modules

### control-channel.ts

UDP-based communication channel between parent and child processes.

The problem: when pi spawns subagent processes (`pi --mode json`), the child's
stdout carries structured agent events (messages, tool calls, usage). There is
no built-in way for extensions running inside the child (e.g. session-namer)
to send metadata back to the parent without polluting the JSON event stream.

The solution: the parent opens a UDP socket on `127.0.0.1:<random>` and passes
the port to children via environment variables. Children send fire-and-forget
JSON packets — no connection setup, no blocking, no interference with stdout.

#### Server (parent side)

```ts
import { ControlChannelServer } from "../lib/control-channel.ts";

const channel = new ControlChannelServer((msg) => {
  // msg: { type: string, id: number, ...payload }
  console.log(`Child ${msg.id} sent: ${msg.type}`);
});
await channel.start();

// When spawning a child process, spread the env vars:
spawn("pi", args, {
  env: { ...process.env, ...channel.childEnv(childId) },
});

// Cleanup
channel.close();
```

**API:**

| Method | Description |
|--------|-------------|
| `start(): Promise<void>` | Bind socket, resolve when ready |
| `getPort(): number` | Listening port (0 if not started) |
| `childEnv(id): Record<string, string>` | Env vars dict to spread into child spawn |
| `close(): void` | Release the socket |

#### Client (child side)

```ts
import { sendControlMessage } from "../lib/control-channel.ts";

// Reads PI_CONTROL_PORT and PI_CONTROL_ID from env automatically.
// No-op if env vars are absent (not running as a child).
sendControlMessage({ type: "session_name", name: "refactoring auth" });
```

That's it. One function call, no setup. The `id` field is injected automatically
from the environment.

**Environment variables** (set by the server via `childEnv()`):

| Variable | Description |
|----------|-------------|
| `PI_CONTROL_PORT` | UDP port the parent is listening on |
| `PI_CONTROL_ID` | Numeric ID identifying this child |

**Message protocol:**

Every message is a JSON object with at minimum `{ type: string, id: number }`.
The `id` is injected by `sendControlMessage()`. Additional fields are type-specific.

Current message types:

| Type | Fields | Source | Purpose |
|------|--------|--------|---------|
| `session_name` | `name: string` | session-namer.ts | AI-generated session name displayed on dashboard cards |

The protocol is extensible — add new `type` values as needed.

---

### changelog.ts

Pure-function library for parsing, editing, and generating CHANGELOG.md content.

Handles the branch-based changelog workflow: changes are tracked under
`## <branch-name>` sections during development, then promoted to
`## [<version>](url) - date` headings on release.

All functions are side-effect-free — they accept strings and return strings.
Git/gh execution and file I/O are the caller's responsibility.

**Key types:**

| Type | Description |
|------|-------------|
| `ChangelogSection` | A parsed `## …` section (heading + body) |
| `ChangelogContext` | Git context for prompt building (branch, diff, commits, PR) |
| `MergedPrInfo` | PR number + merge timestamp for reconciliation |
| `PromotionResult` | Result of promoting a branch section to a version |

**Key functions:**

| Function | Description |
|----------|-------------|
| `parseChangelog(content)` | Split markdown into header + ordered sections |
| `serializeChangelog(header, sections)` | Reassemble into markdown string |
| `spliceBranchSection(content, branch, body)` | Insert or update a branch section |
| `promoteBranchToVersion(content, branch, version, url, date)` | Rename branch heading to version |
| `isVersionHeading(heading)` | Check if heading is `[1.2.3]…` format |
| `isBranchHeading(heading)` | Check if heading is a branch name |
| `getBranchSections(sections)` | List all branch-named section headings |
| `buildChangelogPrompt(ctx)` | Build Haiku prompt for generating section body |
| `truncateDiff(diff, maxLength?)` | Truncate diff with `[diff truncated]` marker |

**Used by:** `commit.ts` extension (via the `kchangelog` skill).

---

### timed-confirm.ts

Reusable TUI confirmation dialog with a countdown timer.

Shows a bordered prompt that auto-resolves after a configurable number of
seconds. The user can press Enter to confirm or Escape to cancel at any time.

```ts
import { timedConfirm } from "../lib/timed-confirm.ts";

const ok = await timedConfirm(ctx, {
  title: "Merge PR",
  message: "Merge PR #42 into main?",
  seconds: 5,         // countdown duration (default: 5)
  defaultValue: true,  // value on timeout (default: true)
});
```

Works in both command handlers (`ExtensionCommandContext`) and event handlers
(`ExtensionContext`) — only requires `ctx.ui.custom()`.

**Used by:** `commit.ts`, `simplify.ts` extensions.
