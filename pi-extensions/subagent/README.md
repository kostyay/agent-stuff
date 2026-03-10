# Subagent Extension

Delegate tasks to specialized subagents with isolated context windows.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Parent pi process                                      │
│                                                         │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │  index.ts   │  │  runner.ts   │  │  dashboard.ts  │  │
│  │  (tool +    │──│  (spawn +    │  │  (card render) │  │
│  │   commands) │  │   stream)    │  │                │  │
│  └──────┬──────┘  └──────────────┘  └───────────────┘  │
│         │                                               │
│  ┌──────┴──────────────────────┐                        │
│  │  ControlChannelServer       │ UDP 127.0.0.1:<random> │
│  │  (lib/control-channel.ts)   │◄────────────────┐      │
│  └─────────────────────────────┘                 │      │
└──────────────────────────────────────────────────│──────┘
                                                   │
         ┌─────────────────────────────────────────┤
         │                                         │
   ┌─────┴───────────┐                 ┌───────────┴─────┐
   │  Child pi #1    │                 │  Child pi #2    │
   │  (subagent)     │                 │  (subagent)     │
   │                 │                 │                 │
   │  session-namer  │                 │  session-namer  │
   │  calls          │                 │  calls          │
   │  sendControl    │                 │  sendControl    │
   │  Message()      │                 │  Message()      │
   └─────────────────┘                 └─────────────────┘
```

### Event Streams

Each child subagent has two communication paths back to the parent:

1. **stdout (JSON events)** — structured agent events (messages, tool calls, usage).
   Parsed by `runner.ts` and fed to the dashboard via `onProgress`/`onRawEvent` callbacks.

2. **UDP control channel** — out-of-band metadata (session names, status).
   The parent binds a UDP socket on localhost; port and child ID are passed via
   `PI_CONTROL_PORT` and `PI_CONTROL_ID` env vars. Children call
   `sendControlMessage()` from `lib/control-channel.ts` — fire-and-forget, no
   connection overhead, no interference with the JSON stream.

Currently the control channel carries `session_name` messages from
`session-namer.ts`, displayed as task descriptions on dashboard cards.
The protocol is extensible to any `{ type, id, ...payload }` JSON message.

## File Structure

```
subagent/
├── README.md              # This file
├── index.ts               # Extension entry point — tool, commands, dashboard widget
├── runner.ts              # Spawns child `pi` processes, streams JSON events
├── dashboard.ts           # Renders agent status cards for the live widget
├── log-viewer.ts          # TUI overlay for viewing agent logs (Ctrl+Shift+1-9)
├── agent-manager.ts       # TUI overlay for browsing/launching agents (/agents)
├── agents.ts              # Agent discovery, frontmatter parsing, team loading
├── types.ts               # Shared interfaces (RunState, SingleResult, etc.)
├── formatting.ts          # Token/usage formatting, tool call display
├── tui-helpers.ts         # Bordered rows, fuzzy search, color assignment
├── utils.ts               # Pure helpers (concurrency, parsing, session dirs)
└── agents/                # Bundled agent definitions
    ├── scout.md           # Fast recon, returns compressed context
    ├── planner.md         # Creates implementation plans
    ├── reviewer.md        # Code review
    ├── worker.md          # General-purpose (full capabilities)
    └── code.md            # Code-focused agent
```

### Shared Library

```
lib/
└── control-channel.ts     # UDP control channel (server + client)
```

`lib/control-channel.ts` is a shared utility used by both the subagent extension
(server side) and `session-namer.ts` (client side). Any extension can use the
client to send metadata to a parent process when running as a subagent.

## Features

- **Isolated context**: Each subagent runs in a separate `pi` process
- **Three execution modes**: Single, parallel (up to 8, 4 concurrent), chain (sequential with `{previous}`)
- **Session persistence**: Continue a previous agent's conversation via `sessionId`
- **Live dashboard**: Card grid with agent name, description, status, context %, elapsed time
- **Agent log viewer**: Ctrl+Shift+1–9 opens a scrollable log overlay per agent
- **Agent manager**: `/agents` TUI for browsing, searching, and launching agents
- **Teams**: Filter available agents by named groups (`teams.yaml`)
- **Abort handling**: Ctrl+C kills subprocesses, dashboard shows ⊘ aborted status
- **Background spawn**: Launch agents while the main agent is busy

## Security Model

**Project-local agents** (`.pi/agents/*.md`) are repo-controlled prompts.
Only loaded with `agentScope: "both"` or `"project"`. Interactive confirmation
required by default (`confirmProjectAgents: true`).

## Usage

### Single agent
```
Use scout to find all authentication code
```

### Parallel execution
```
Run 2 scouts in parallel: one to find models, one to find providers
```

### Chained workflow
```
Use a chain: first have scout find the read tool, then have planner suggest improvements
```

### Session continuation
```
Continue the scout session (session ID: scout-1710020542123) and also check the middleware
```

## Commands

| Command | Description |
|---------|-------------|
| `/agents` | Interactive TUI to browse, search, and launch agents |
| `/run <agent> <task>` | Run a single agent |
| `/chain agent1 "task" -> agent2 "task"` | Sequential execution |
| `/parallel agent1 "task" -> agent2 "task"` | Concurrent execution |
| `/agent:<name> <task>` | Shortcut per agent (auto-registered) |
| `/team [name\|clear]` | Select/clear agent team filter |
| `/sessions` | List active sessions for continuation |
| `/clean-agent` | Remove dashboard widget |

## Live Dashboard

When subagents are running, a card grid widget appears:

```
┌──────────────────────┐  ┌──────────────────────┐
│ 1 scout  haiku-4-5   │  │ 2 worker  sonnet-4   │
│ scanning auth module │  │ refactoring routes    │
│ ● running 12s T:3    │  │ ● running 3s T:1     │
│ [###--] 62%          │  │ —                     │
└──────────────────────┘  └──────────────────────┘
```

Each card shows:
- **Agent name + model**
- **Description** — AI-generated session name from the child (via control channel), falls back to last streaming line
- **Status** — icon + state + elapsed + tool count (● running, ✓ done, ✗ error, ⊘ aborted)
- **Context usage** — percentage bar or raw token count

## Agent Definitions

Markdown files with YAML frontmatter:

```markdown
---
name: my-agent
description: What this agent does
tools: read, grep, find, ls
model: claude-haiku-4-5
---

System prompt goes here.
```

**Locations:**
- `~/.pi/agent/agents/*.md` — user-level (always loaded)
- `.pi/agents/*.md` — project-level (requires `agentScope: "both"`)

## Error Handling

- **Exit code ≠ 0**: Tool returns error with stderr/output
- **stopReason "error"**: LLM error propagated with error message
- **stopReason "aborted"**: Ctrl+C kills subprocess, dashboard shows ⊘ aborted
- **Chain mode**: Stops at first failing step, reports which step failed

## Limitations

- Output truncated to last 10 items in collapsed view (Ctrl+O to expand)
- Parallel mode limited to 8 tasks, 4 concurrent
- Context % uses heuristic model-name matching (Claude=200k, GPT-4o=128k, Gemini=1M)
- Session continuation only in single mode
