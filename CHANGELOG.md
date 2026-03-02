# Changelog

All notable changes to agent-stuff are documented here.















## feat/profile-sync-script

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
