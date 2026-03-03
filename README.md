# Agent Stuff

Extensions, skills, and themes for [Pi](https://buildwithpi.ai/), the coding agent.

> **Note:** These are tuned for my workflow. They may need modification for yours.

## Installation

Install from git (extensions, skills, and themes are all discovered automatically):

```bash
pi install git:github.com/kostyay/agent-stuff
```

To try a single extension without installing the full package:

```bash
pi -e ./pi-extensions/status-bar.ts
```

## Extensions

All extensions live in [`pi-extensions/`](pi-extensions). Each file is a self-contained Pi extension — one responsibility per file, no cross-extension dependencies.

| Extension | Description |
|-----------|-------------|
| [`answer.ts`](pi-extensions/answer.ts) | Extracts questions from assistant responses and presents an interactive TUI for answering them one by one |
| [`clear.ts`](pi-extensions/clear.ts) | `/clear` command — starts a new session (alias for `/new`) |
| [`commit.ts`](pi-extensions/commit.ts) | `/commit` command — stages all changes, generates a Conventional Commits message via LLM, creates a side branch if on the default branch |
| [`context.ts`](pi-extensions/context.ts) | `/context` command — shows loaded extensions, skills, AGENTS.md/CLAUDE.md, and token usage |
| [`control.ts`](pi-extensions/control.ts) | Session control via Unix domain sockets for inter-session communication |
| [`files.ts`](pi-extensions/files.ts) | `/files` command — file browser merging git status with session-referenced files, plus diff/edit actions |
| [`git-rebase-master.ts`](pi-extensions/git-rebase-master.ts) | `/git-rebase-master` command — fetches latest main/master and rebases current branch with automatic LLM conflict resolution |
| [`kbrainstorm.ts`](pi-extensions/kbrainstorm.ts) | `ask_question` tool — interactive TUI for brainstorming with multiple-choice and freeform answers |
| [`kt/`](pi-extensions/kt) | `kt` tool — git-backed ticket tracker storing tickets as markdown files in `.tickets/` with hierarchy, dependencies, and status workflow |
| [`loop.ts`](pi-extensions/loop.ts) | `/loop` command — runs a follow-up prompt loop with a breakout condition for iterative coding |
| [`notify.ts`](pi-extensions/notify.ts) | Desktop notifications (OSC 777) when the agent finishes and is waiting for input |
| [`plan-ask.ts`](pi-extensions/plan-ask.ts) | `/plan`, `/ask` commands and Shift+Tab mode rotation (🤖 agent → ❓ ask → 📋 plan) with read-only tool restrictions for safe exploration |
| [`prompt-editor.ts`](pi-extensions/prompt-editor.ts) | Prompt mode selector (default/fast/precise) with per-mode model & thinking persistence |
| [`review.ts`](pi-extensions/review.ts) | `/review` command — code review for uncommitted changes, PRs, or specific commits with optional auto-fix loop |
| [`sandbox/`](pi-extensions/sandbox) | OS-level sandboxing for bash commands via `sandbox-exec` (macOS) / bubblewrap (Linux) with configurable filesystem and network restrictions |
| [`session-breakdown.ts`](pi-extensions/session-breakdown.ts) | `/session-breakdown` command — analyzes session usage (cost by model) with a GitHub-style activity graph |
| [`session-namer.ts`](pi-extensions/session-namer.ts) | Auto-generates a short session name via Haiku after the first user request, re-generates on compaction or `/session-name-refresh`, and appends a mode emoji (📋/🧠) |
| [`simplify.ts`](pi-extensions/simplify.ts) | `/simplify` command — detects the dominant language of uncommitted changes and runs the matching code-simplifier skill |
| [`status-bar.ts`](pi-extensions/status-bar.ts) | Rich two-line footer with model, context meter, token counts, cost, git status, tool tally, and color-coded profile badge |
| [`whimsical.ts`](pi-extensions/whimsical.ts) | Replaces "Thinking..." with random phrases like "Reticulating splines..." and "Consulting the void..." |

## Shared Libraries

Reusable utilities in [`lib/`](lib), importable by extensions:

| Library | Description |
|---------|-------------|
| [`changelog.ts`](lib/changelog.ts) | Pure-logic changelog parser — parses, splices, and reconciles markdown changelog sections (no I/O) |
| [`timed-confirm.ts`](lib/timed-confirm.ts) | Timed confirmation dialog with auto-resolve countdown — used by commit/merge workflows |

## Skills

Skills live in [`skills/`](skills). Each skill has a `SKILL.md` that the agent reads when the task matches.

| Skill | Description |
|-------|-------------|
| [`github`](skills/github) | GitHub interactions via the `gh` CLI (issues, PRs, runs, API) |
| [`go-code-simplifier`](skills/go-code-simplifier) | Simplify and refine Go code for clarity and maintainability (Go 1.26+) |
| [`js-code-simplifier`](skills/js-code-simplifier) | Simplify and refine JavaScript/TypeScript code for clarity and maintainability |
| [`kbrainstorm`](skills/kbrainstorm) | Collaborative brainstorming — explores intent, requirements, and design before implementation |
| [`kchangelog`](skills/kchangelog) | Executive-style changelog entries tracked by branch, auto-promoted on release |
| [`mermaid`](skills/mermaid) | Create and validate Mermaid diagrams with the Mermaid CLI |
| [`native-web-search`](skills/native-web-search) | Quick web research with concise summaries and source URLs |
| [`pi-share`](skills/pi-share) | Load and parse session transcripts from buildwithpi.ai URLs |
| [`pr-update`](skills/pr-update) | Update or create a pull request for the current branch with diff-based descriptions |
| [`py-code-simplifier`](skills/py-code-simplifier) | Simplify and refine Python code for clarity and maintainability |
| [`summarize`](skills/summarize) | Convert URLs or files (PDF/DOCX/HTML) to Markdown via `markitdown`, with optional summarization |
| [`tmux`](skills/tmux) | Remote-control tmux sessions by sending keystrokes and scraping pane output |
| [`web-browser`](skills/web-browser) | Browser automation via Chrome DevTools Protocol (clicking, forms, navigation) |

## Themes

Custom themes live in [`pi-themes/`](pi-themes).

| Theme | Description |
|-------|-------------|
| [`nightowl.json`](pi-themes/nightowl.json) | Night Owl color scheme |

## Agent Profiles

The [`profiles/`](profiles) directory contains global AGENTS.md files for different Pi profiles (e.g. `agent-personal`). Run [`sync-agents.sh`](sync-agents.sh) to symlink them into `~/.pi/<profile>/AGENTS.md` for centralized management across agent instances.

## Project Structure

```
├── .github/           # CI workflows (auto-release) and scripts
├── lib/               # Shared TypeScript utilities (timed-confirm, etc.)
├── pi-extensions/     # Pi extensions (auto-discovered)
├── profiles/          # Global AGENTS.md files per Pi profile
├── scripts/           # Tooling (sync-profiles.ts)
├── skills/            # Agent skills (SKILL.md per skill)
├── tests/             # Unit tests (node --test)
├── pi-themes/         # Custom themes
├── plumbing-commands/ # Release automation templates
├── eslint.config.js   # ESLint + typescript-eslint config
├── sync-agents.sh     # Symlink profiles into ~/.pi/
├── Makefile           # Release and changelog targets
├── AGENTS.md          # Agent-facing coding conventions
├── CHANGELOG.md       # Release history
└── package.json       # Pi package manifest
```

## License

Personal use. No warranty.
