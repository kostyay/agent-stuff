# Changelog

All notable changes to agent-stuff are documented here.

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
