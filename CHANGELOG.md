# Changelog

All notable changes to agent-stuff are documented here.



































## refactor/rename-kt-to-ticket

Renamed the `kt` extension to `ticket` for improved clarity and consistency (#19). All user-facing commands (`/ticket`, `/ticket-create`, `/ticket-run-all`), the `ticket` tool with its 9 actions, internal modules (`ticket-core.ts`), UI identifiers, and test files have been updated to reflect the new naming. This is a breaking change for users relying on `/kt` commands—they must now use the `/ticket` equivalents. The functionality and file storage structure (`.tickets/` directory) remain unchanged.

## [1.0.7](https://github.com/kostyay/agent-stuff/pull/18) - 2026-03-03

Added configurable network isolation controls to the sandbox extension (#18), enabling users to selectively weaken network restrictions for compatibility with Go-based CLI tools (gh, docker, etc.) that require macOS trust daemon access for TLS certificate verification. The new `enableWeakerNetworkIsolation` option is exposed in the `SandboxConfig` interface with a default value of `true` to support these commonly-used tools out-of-the-box, while still allowing stricter isolation configurations when needed. Configuration merging logic has been updated to properly handle the new isolation setting alongside existing sandbox policies.

## [1.0.6](https://github.com/kostyay/agent-stuff/pull/17) - 2026-03-03

This refactor consolidates filesystem enforcement into a dedicated event-driven architecture (#17). The plan-ask extension now delegates read-only command filtering to the sandbox extension via a shared `readonly` event on `pi.events`, eliminating ~100 lines of duplicated destructive-command pattern matching and reducing the plan-ask module's responsibility to tool restrictions and system prompts only. The sandbox extension listens for readonly state changes and dynamically reconfigures its filesystem allowlist, with an acknowledgment mechanism that warns users if the sandbox extension isn't loaded. Additionally, the status bar now displays sandbox state on a dedicated line 3, surfacing sandbox and readonly modes to users in real-time.

## [1.0.5](https://github.com/kostyay/agent-stuff/pull/16) - 2026-03-03

Introduces a terminal progress indicator extension using OSC 9;4 escape sequences (#16), providing visual feedback in the terminal tab/titlebar with an indeterminate pulse while the agent is working. The indicator automatically clears when the agent finishes or waits for user input, with graceful cleanup on process exit to prevent stuck indicators. Supports multiple terminal emulators including Ghostty, iTerm2, WezTerm, Windows Terminal, and ConEmu, enhancing the user experience during long-running agent operations without requiring explicit status polling.

## [1.0.4](https://github.com/kostyay/agent-stuff/pull/15) - 2026-03-03

Session Namer now correctly restores session state when resuming a previous session (#15), preventing redundant Haiku calls that would overwrite existing names — the extension retrieves `baseName`, mode emoji, and `userTurnCount` from persisted session data on `session_switch`. Additionally, the extension strips XML-style tags (e.g., `<skill>`, `<available_skills>`) from conversation context before sending to Haiku, preventing polluted or malformed session names generated from skill expansions. These fixes ensure naming remains deterministic and clean across session lifecycle transitions.

## [1.0.3](https://github.com/kostyay/agent-stuff/pull/14) - 2026-03-02

Introduces the Session Namer extension (#14), which automatically generates concise, descriptive session names using Claude Haiku after the first agent response. The extension appends a mode emoji (📋 for plan, 🧠 for ask) based on the most recent non-agent interaction mode, and regenerates names on session compaction or via the new `/session-name-refresh` command. All AI calls execute asynchronously in the background to prevent blocking the agent loop, with silent error handling to ensure naming remains best-effort and non-disruptive.

Fixed session state not being restored on resume: when switching to a resumed session via `session_switch`, the extension now restores `baseName`, mode emoji, and `userTurnCount` from the persisted session — preventing a redundant Haiku call that would overwrite the existing name. Also strips XML-style tags (e.g. `<skill>`, `<available_skills>`) from conversation context before sending to Haiku, avoiding polluted session names from skill expansions.

## [1.0.2](https://github.com/kostyay/agent-stuff/pull/13) - 2026-03-02

Improved type safety across the extension system by adding explicit TypeScript type annotations and migrating from string-based to typed enum patterns for UI colors and notification levels (#13). Reorganized the linting pipeline to include TypeScript type checking via `tsc --noEmit`, catching previously undetected type errors in message content handling, component rendering, and event data access. Standardized UI component property names for consistency (e.g., `selectedBg` → `selectedPrefix`, `matchHighlight` → `selectedText`) and updated notification severity levels to use semantic theme colors (`success`/`info` → `info`/`accent`). Removed ~2,100 lines of unused code and added comprehensive test coverage for the plan-ask extension, improving maintainability and reducing technical debt.

## [1.0.1](https://github.com/kostyay/agent-stuff/pull/12) - 2026-03-02

Enhanced the push workflow to gracefully handle rejected pushes by prompting users to force-push with `--force-with-lease` (#12). When a normal push fails due to non-fast-forward errors (common after rebasing), users are now prompted to safely force-push rather than failing silently. The implementation includes rejection detection via stderr pattern matching and proper error handling for both standard and force-push attempts, with user-facing notifications at each step.

## [1.0.0](https://github.com/kostyay/agent-stuff/pull/11) - 2026-03-02

Implemented automatic semantic versioning and tag-based releases in the CI workflow (#11), eliminating the need for manual version bumps in package.json. The release pipeline now automatically detects the latest git tag, counts commits since that tag, and bumps the patch version accordingly—skipping releases when no new commits exist. Additionally refactored the `/plan` command into a unified `plan-ask.ts` extension that introduces a three-way mode rotation (Agent → Ask → Plan) accessible via Shift+Tab, with read-only tool restrictions and safe command filtering for ask and plan modes to enable safe exploration of the codebase.

## [1.0.0](https://github.com/kostyay/agent-stuff/pull/10) - 2026-03-02

Added agent profiles and synchronization tooling (#10) to standardize development workflows across agent instances. The `profiles/AGENTS.agent-personal.md` file establishes global development standards including task routing via extensions, coding philosophy (no speculative features, bias toward action), and hard limits on code complexity and function signatures. A new `sync-agents.sh` script enables automatic symlink-based profile distribution to agent directories, allowing centralized management of agent configurations. Additionally updated Go and Python code-simplifier skills with explicit tooling requirements (newest stable Go versions, Python 3.13 with `uv`/`ruff`/`pytest`) and verification workflows to ensure consistent code quality standards.

## [1.0.0](https://github.com/kostyay/agent-stuff/pull/9) - 2026-03-02

Added a new profile synchronization utility script for Pi configuration management (#9). The `sync-profiles.ts` script enables users to merge configuration from a source profile to a destination profile, supporting deep-merge semantics for `settings.json` and `keybindings.json` (with source values winning on conflicts), while wholesale-copying extension JSON files. The tool operates in dry-run mode by default and provides detailed diff output showing additions, changes, removals, and unchanged entries before writing changes with the `--apply` flag, making it safe for managing multiple Pi profiles without accidental overwrites.

## [1.0.0](https://github.com/kostyay/agent-stuff/pull/8) - 2026-03-02

Added a color-coded profile badge to the status bar that displays the current profile name and authentication method (#8). The badge uses a deterministically hashed background color derived from the profile name for easy visual distinction across multiple profiles, appearing only when `PI_CODING_AGENT_DIR` points to a non-default directory. Supporting utilities including `hashString`, `hslToRgb`, and `buildProfileBadge` were extracted as reusable functions, along with comprehensive unit tests covering color conversion, token formatting, and profile detection logic. The extension now provides richer visual feedback about the active authentication context (OAuth vs. API key) at a glance.

## [1.0.0](https://github.com/kostyay/agent-stuff/pull/7) - 2026-03-02

Introduces a reusable timed confirmation dialog component (#7) that displays a bordered prompt with an auto-resolving countdown timer, allowing users to confirm immediately via Enter or cancel with Escape. The dialog has been integrated into the PR merge workflow, replacing the standard confirmation prompt to streamline the merge process with a 5-second auto-confirm default. Includes comprehensive test coverage (336 lines) validating timer behavior, keyboard input handling, and configuration options, ensuring robust interaction across various scenarios.

## [1.0.0](https://github.com/kostyay/agent-stuff/pull/6) - 2026-03-02

Added ESLint configuration with TypeScript support (#6) to enforce syntax and error detection across the codebase. The setup leverages typescript-eslint with recommended rules while disabling noisy stylistic checks to align with the project's existing conventions. ESLint dependencies (eslint ^10.0.2 and typescript-eslint ^8.56.1) have been added to the dev stack. TypeScript files in pi-extensions were linted and adjusted to comply with the new configuration, focusing on catching genuine bugs rather than enforcing code style preferences.

## [1.0.0](https://github.com/kostyay/agent-stuff/pull/5) - 2026-03-02

Plan mode now supports two entry points: **Shift+Tab** for instant toggling with the planning system prompt injected via `before_agent_start` (#5), and the existing **/plan** command for one-shot planning flows. The restructuring separates the reusable `PLAN_SYSTEM_PROMPT` constant from command-specific logic, enabling seamless mode switching without prompting for input on toggle. Read-only tool restrictions and bash command filtering remain intact, maintaining the safety guarantees of planning mode while improving UX for users who frequently switch between exploratory and implementation phases.

## [1.0.0](https://github.com/kostyay/agent-stuff/pull/4) - 2026-03-02

Updated the README to document two new extensions and clarify project structure. Added [`git-rebase-master.ts`](#4) extension which automates rebasing against main/master branches with LLM-powered conflict resolution, and documented the new [`sandbox/`](#4) directory enabling OS-level sandboxing for bash commands via `sandbox-exec` on macOS and bubblewrap on Linux with configurable filesystem and network restrictions. Also clarified the `.github/` directory location in the project structure overview.

## [1.0.0](https://github.com/kostyay/agent-stuff/pull/2) - 2026-03-02

Added `/git-rebase-master` command that fetches the latest `main` or `master`
from origin and rebases the current branch onto it. The extension auto-detects
the default branch, shows a confirmation with branch info and commit count, and
delegates merge-conflict resolution to the LLM when conflicts arise.

The `/commit-push` and `/commit-push-pr` commands now auto-create a side branch
when invoked on the default branch, skipping the manual branch-name prompt via a
new `autoBranch` option on `performCommit`.

`/commit-push-pr` now creates PRs in ready mode by default instead of draft
mode, streamlining the publish workflow for most use cases.

## [1.0.0](https://github.com/kostyay/agent-stuff/pull/3) - 2026-03-02

The commit extension was overhauled to dramatically reduce token consumption by gathering changelog context deterministically through git/gh commands and calling the model once for summary generation, with the new `/merge-pr` command streamlining the full pre-merge workflow including changelog updates, incremental PR description refresh, and squash-merge with cleanup. The sandbox extension now supports runtime toggling via `/sandbox on` and `/sandbox off` commands with a visual status indicator, eliminating the need to restart. An auto-release workflow now replaces the npm-publish pipeline, automatically creating GitHub tags and releases on main merges when `package.json` version changes, with release notes extracted from `CHANGELOG.md` via a new Python script that falls back to the git commit log. (#3)

## Unreleased

* Added the `/plan` command for read-only planning mode with interactive brainstorming via the `ask_question` tool. Supports Shift+Tab mode toggle and an always-visible mode status indicator.
* Added the `kbrainstorm` skill and extension providing a TUI-based `ask_question` tool with auto-edit mode and numeric shortcuts for rapid option selection during brainstorming sessions.
* Added the `pr-update` skill for generating accurate PR descriptions by analyzing code diffs.
* Added the Go code simplifier skill targeting Go 1.26+ and split the existing code-simplifier skill into separate JS/TS and Python variants for more targeted refinement.
* Fixed the `/commit` side-branch prompt to show the AI-generated branch name in a confirm dialog instead of an empty text input. The `ctx.ui.input()` placeholder parameter is silently ignored by the TUI, so the flow now uses `confirm()` with the suggestion and falls back to `input()` only if declined.
* Added the status bar extension for persistent footer status display and the `/clear` command for resetting conversation context. Desktop notifications now fire on `waiting_for_input` events.
* Rewrote README and AGENTS.md with current extension inventory, installation instructions, and code quality guidelines including strict isolation and naming conventions.
* Added Makefile with `release` and `changelog` targets for streamlined release workflows.
* Replaced the update-changelog extension with the `kchangelog` skill for executive-style changelog generation tracked by branch name. The control extension now registers tools only when `--session-control` is enabled, improving performance and reducing noise.
* Enhanced the review mode with loop fixing capabilities that detect blocking-aware patterns, support for empty sessions, and a revamped end-review flow. The files browser now appends git status to file labels for better context.
* Added the `native-web-search` skill for direct web search integration via CLI scripts.
* Removed unused extensions (uv, go-to-bed, intercepted-commands) and skills (anachb, apple-mail, ghidra, google-workspace, oebb-scotty, openscad, sentry, uv) to streamline the package for kostyay's fork.

## 1.3.0

* Added `/session-breakdown` command with interactive TUI showing sessions, messages, tokens, and cost over the last 7/30/90 days with a GitHub-style contribution calendar.
* Added messages/tokens tracking and large-count abbreviations to `/session-breakdown`.
* Added progress reporting while analyzing sessions in `/session-breakdown`.
* Added `/context` command for viewing context overview.
* Added folder snapshot review mode to `/review`.
* Improved review rubric with lessons from codex.
* Added a `summarize` skill for converting files/URLs to Markdown via `markitdown`.

## 1.2.0

* Updated pi-extensions to use the new `ToolDefinition.execute` parameter order.
* Fixed notify extension notifications to render plain Markdown.

## 1.1.1

* Removed the deprecated `qna` extension.
* Added `uv` extension and skill for uv integration.

## 1.1.0

* Added project review guidelines and preserved review state across navigation.
* Added the `/diff` command to the unified file browser and merged diff/file workflows.
* Added new skills for commits, changelog updates, and frontend design.
* Expanded the whimsical "thinking" messages.
* Added prompts directory configuration support for Pi.
* Fixed reveal shortcut conflicts and improved the PR review editor flow.

## 1.0.5

* Fixed the release CI pipeline for the published package.

## 1.0.4

* Added the session control extension with socket rendering, output retrieval, and copy-todo text actions.
* Added support for session names and custom message types in session control.
* Improved control socket rendering and reconnection handling.
* Added control extension documentation.

## 1.0.3

* Added todo assignments and validation for todo identifiers.
* Added copy-to-clipboard workflows for todos and improved update UX.
* Switched answer tooling to prefer Codex mini and refined prompt refinement.
* Documented todos and refreshed README guidance.

## 1.0.2

* Introduced the todo manager extension (list/list-all, update, delete, and garbage collection).
* Added TODO-prefixed identifiers and refined the todo action menu behavior.
* Improved todo rendering and the refinement workflow ordering.
* Added support for append-only updates without requiring a body.
* Removed the unused codex-tuning extension.

## 1.0.1

* Added core extensions: /answer (Q&A), /review, /files, /reveal, /loop, and cwd history.
* Added skills for Sentry, GitHub, web browsing, tmux, ghidra, pi-share, and Austrian transit APIs.
* Added Pi themes including Night Owl and additional styling.
* Added and refined the commit extension and review workflow.
* Improved packaging and initial repository setup.
