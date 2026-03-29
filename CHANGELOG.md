# Changelog

All notable changes to agent-stuff are documented here.




































































































## docs/expand-github-skill-docs

Expanded the GitHub skill documentation (#64) with comprehensive `gh` CLI examples and best practices, including detailed sections on pull requests, GitHub Actions workflows, search, and API usage. The guide now covers practical command patterns for PR management (create, review, merge), workflow automation (triggering, monitoring, managing secrets/variables), and advanced querying with JSON filtering and GraphQL. Added a reference table for global flags and bulk operation patterns to improve discoverability and help users leverage the full capabilities of the GitHub CLI.

## chore/update-pi-packages-0-63-1

Updated mariozechner PI packages to version 0.63.1 (#62), introducing API changes across multiple extensions. The update requires strict version pinning (`^0.63.1`) for peer dependencies (@mariozechner/pi-ai, @mariozechner/pi-coding-agent, @mariozechner/pi-tui), and refactors model authentication to use a new `getApiKeyAndHeaders()` method that returns an authentication object instead of a simple API key string. Key technical changes include updates to type imports (ModelRegistry), property accessors for command source information (from `c.path` to `c.sourceInfo?.path`), and dependency upgrades for OpenAI (6.10.0 → 6.26.0) and Mistral (1.10.0 → 1.14.1). The minimum Node.js requirement for pi-coding-agent was bumped from 20.0.0 to 20.6.0, and koffi is now an optional dependency in pi-tui.

## [1.0.40](https://github.com/kostyay/agent-stuff/pull/56) - 2026-03-20

Auto-run continuation for ticket processing (#56): tickets can now be processed sequentially across epic boundaries with automatic context compaction, where the agent receives the next ready task after closing the current one without manual intervention. Status-bar PR polling now refreshes every 60 seconds to detect merge status changes in real-time. Parent epics auto-close when all child tasks are completed, with transition context automatically included when moving between epics to maintain narrative continuity. A new `/ticket-run-stop` command allows halting the auto-run loop gracefully after the current ticket finishes.

## [1.0.40](https://github.com/kostyay/agent-stuff/pull/55) - 2026-03-20

Adds a new `/pr` command extension (#55) that allows users to quickly open pull requests in their browser by detecting the current git branch and using the GitHub CLI (`gh`) to fetch and launch the PR URL. The extension includes safety checks to prevent accidental attempts on main/master branches and gracefully handles cases where no open PR exists for the current branch. Documentation has been updated to reflect the new command and related library additions for tmux session management and a reusable question UI component.

## [1.0.38](https://github.com/kostyay/agent-stuff/pull/54) - 2026-03-18

Removed 18 completed ticket files from `.tickets/` directory and refactored extension code for improved maintainability (#54). The status-bar extension received significant updates to its event handling and rendering logic, reducing complexity while the plan-ask extension saw streamlined initialization. Test suite was modernized with cleaner mocks and improved coverage structure, cutting test file sizes by ~50% through removal of obsolete test cases tied to resolved tickets.

## [1.0.38](https://github.com/kostyay/agent-stuff/pull/52) - 2026-03-18

This refactor centralizes agent and session data storage configuration through the `PI_CODING_AGENT_DIR` environment variable, replacing hard-coded `~/.pi` paths across multiple extensions (#52). The change improves portability and allows users to customize storage locations via environment variable, with automatic fallback to `$HOME/.pi/agent` when unset. Documentation and control socket paths in `control.ts`, `sandbox/index.ts`, `session-breakdown.ts`, and `stash.ts` have been updated to reference the new variable. Additionally, closed ticket references and subagent infrastructure (unused agent definitions and test suites) have been removed to reduce codebase complexity.

## [1.0.36](https://github.com/kostyay/agent-stuff/pull/51) - 2026-03-16

Improved type safety and race condition handling across subagent and ticket extensions (#51). The ticket system now retries ID generation on lock conflicts and uses per-ticket locks during garbage collection to prevent concurrent mutation races, while subagent tool calls include explicit type assertions for content blocks. Enhanced tmux session uniqueness by incorporating a directory hash into session names to avoid collisions in multi-workspace scenarios. Renamed the `/plan` command to `/agentic-plan` to clarify its role in the skill-injection planning workflow. Removed approximately 1,300 lines of test scaffolding that was no longer actively maintained.

## [1.0.35](https://github.com/kostyay/agent-stuff/pull/49) - 2026-03-16

Removed the subagent extension's legacy architecture and consolidated its functionality into a streamlined implementation (#49). The extension previously delegated tasks to isolated child `pi` processes via spawned subagents with UDP control channels and a complex multi-file structure (agent-manager, runner, dashboard, log-viewer); this refactor eliminates ~2,100 lines of overhead code while preserving core agent execution capabilities through a simplified index.ts and new session/test modules. Users retain access to agent execution, team filtering, and session management through a leaner codebase with better maintainability and reduced operational complexity.

## [1.0.34](https://github.com/kostyay/agent-stuff/pull/48) - 2026-03-16

Extracted tmux primitives to a reusable shared library (`lib/tmux.ts`) to eliminate duplication between `bgrun` and the subagent runner (#48). The new library provides a clean abstraction for session management, window creation, and pane capture through an injectable `exec` function, enabling both extensions to leverage consistent tmux handling without tight coupling to the pi extension API. This refactor improves maintainability, enables safer window naming with collision detection, and sets the foundation for future tmux-based features. The bgrun extension now re-exports key utilities for backward compatibility with existing tests and plugins.

## [1.0.34](https://github.com/kostyay/agent-stuff/pull/47) - 2026-03-16

Extracts the interactive ask-question UI logic from kbrainstorm into a reusable library module (#47), enabling other extensions to leverage the same TUI patterns for Q&A workflows. The refactor moves ~328 lines of TUI rendering, editor state management, and option-handling logic into `lib/ask-question-ui.ts` while reducing kbrainstorm to a thin wrapper, and includes comprehensive test coverage (488 lines) to ensure reliability of the extracted component. This improves code maintainability and sets up a foundation for consistent user-facing question/answer interactions across the extension ecosystem.

## [1.0.32](https://github.com/kostyay/agent-stuff/pull/46) - 2026-03-15

Improved background task management with a new kill-all command and enhanced pane exit handling (#46). The `bgrun` extension now runs commands as direct pane processes with `remain-on-exit` enabled, allowing output capture after task completion and automatic cleanup of exited panes. Added `K` hotkey to terminate all running tasks at once from the task manager TUI. Additionally, expanded extension documentation and added `cmux.ts` to the extension registry for sidebar state synchronization, while refactoring test utilities to reduce boilerplate in plan-ask tests.

## [1.0.31](https://github.com/kostyay/agent-stuff/pull/45) - 2026-03-15

Introduces a new cmux sidebar integration extension (#45) that pushes pi agent state—including model, thinking mode, token usage, and session cost—into the cmux multiplexer's sidebar in real-time via lifecycle event hooks. The extension is fire-and-forget, silently ignoring cmux errors to prevent agent disruption, and operates only when running inside cmux (detected via `CMUX_SOCKET_PATH` environment variable). Replaces the terminal progress indicator with this richer sidebar-based status system, providing better visibility into agent activity, resource consumption, and tool execution within the cmux environment.

## [1.0.31](https://github.com/kostyay/agent-stuff/pull/44) - 2026-03-15

Added Ruby file extension support to the code simplification pipeline, enabling the tool to properly identify and process `.rb`, `.rake`, `.gemspec`, `.ru`, and `.erb` files (#44). A comprehensive Ruby code simplification skill has been introduced, targeting Ruby 3.4+ and Rails 8, covering modern idioms (pattern matching, endless methods, hash shorthand), Rails-specific patterns (model macros, Strong Parameters, Solid Queue), and best practices for clarity and maintainability. The skill emphasizes preserving functionality while reducing complexity through guard clauses, guard clauses, eliminating dead code, and leveraging standard library methods—backed by automated tooling (RuboCop, Brakeman, Rails test suite) for verification.

## [1.0.29](https://github.com/kostyay/agent-stuff/pull/43) - 2026-03-14

Updated the brainstorming tool documentation to reflect migration from `ask_question` to the new `interview` tool (#43). The `interview` tool provides a richer user experience with native form windows supporting multiple question types (single/multi-select, text, info panels), inline editing, and rich media rendering including code blocks, tables, and mermaid diagrams. Documentation now clarifies when to batch independent questions into a single call versus sequential questions, introduces recommendation and conviction signals for guiding user choices, and provides comprehensive examples for common patterns like trade-off analysis, design validation, and architecture decisions. Key principle updates emphasize always using the `interview` tool, batching strategies to reduce round-trips, and leveraging rich context presentation to enhance decision-making.

## [1.0.29](https://github.com/kostyay/agent-stuff/pull/40) - 2026-03-14

Introduces a comprehensive background task runner extension (#40) that enables users to launch, monitor, and manage long-running processes via tmux with `/bgrun` and `/bgtasks` commands, plus a `bgrun` tool for LLM-initiated task control. Tasks are automatically assigned memorable window names derived from commands (e.g., `npm run dev` → `npm-dev`), tracked per session, and killed on `/new` or shutdown with a timed confirmation prompt. The extension emits `bgrun:stats` events for real-time status-bar integration and includes an interactive task manager TUI for viewing output, killing tasks, and monitoring durations. Also adds `control-channel.ts` library for inter-process UDP communication and updates status-bar to display background task counts alongside existing metrics.

## [1.0.27](https://github.com/kostyay/agent-stuff/pull/39) - 2026-03-13

Introduces an operation timer widget (#39) that displays real-time elapsed duration during agent execution above the editor, tracking both total operation time (from turn start to agent end) and individual tool execution duration. The widget uses compact time formatting (e.g. "5s", "2m 03s") and automatically manages lifecycle through agent event hooks (turn_start, tool_call, agent_end), ensuring cleanup on session switches or user input waits. This provides visibility into agent performance and tool execution times without requiring manual profiling.

## [1.0.27](https://github.com/kostyay/agent-stuff/pull/38) - 2026-03-13

**Sandbox Security Hardening** (#38)

Sandbox extensions are now disabled by default, requiring explicit opt-in through configuration or runtime commands to enhance security posture (#38). Users running `pi -e ./sandbox` will have sandboxing disabled unless explicitly enabled via config settings or the `/sandbox on` command, while the `--no-sandbox` flag now serves as an explicit override. This change mitigates potential security risks from unintended sandbox execution and aligns with secure-by-default principles for CLI tool isolation.

## [1.0.26](https://github.com/kostyay/agent-stuff/pull/37) - 2026-03-12

The stash extension now persists drafts across session switches and application restarts, storing them per-workspace in `~/.pi/stash/` (#37). Previously, stashed text was cleared whenever switching sessions; it now survives these transitions and survives process restarts by leveraging filesystem-backed storage with encoded workspace paths. The implementation adds load/save operations on `session_start` and `session_switch` events, ensuring users' drafts are automatically restored when they return to a workspace.

## [1.0.25](https://github.com/kostyay/agent-stuff/pull/35) - 2026-03-10

Introduces a new Claude import extension with a complete multi-agent subagent system (#35). The subagent framework enables orchestration of specialized agents (planner, worker, code reviewer, scout) with inter-agent communication via a control channel, live dashboard rendering, and comprehensive test infrastructure. Includes agent discovery from `.md` files with YAML frontmatter, team definitions via `teams.yaml`, and extensible agent management with context window estimation. Adds 7,800+ lines of production code and tests with ~145 new test cases covering unit, integration, and filesystem behaviors, laying groundwork for test coverage expansion across all extensions.

## [1.0.22](https://github.com/kostyay/agent-stuff/pull/33) - 2026-03-08

Adds a thinking level indicator to the status bar display when reasoning models are active, showing Claude's reasoning depth at a glance (#33). Introduces a new `autoSimplify` setting (disabled by default) to control whether code simplification proposals are automatically generated after agent turns, giving users finer control over the extension's behavior. Refactors hash comparison logic in the simplify extension for improved clarity and performance.

## [1.0.21](https://github.com/kostyay/agent-stuff/pull/32) - 2026-03-08

The simplify extension now persists content hashes of simplified files to prevent repeated simplification proposals (#32). After each simplification run, file hashes are stored in `$PI_CODING_AGENT_DIR/simplify-hashes.json` and checked before proposing future simplifications, ensuring proposals only appear when file content actually changes. This eliminates redundant suggestions that occurred when the simplification tool itself modified files, improving the user experience by reducing unnecessary prompts while maintaining the ability to re-simplify genuinely modified code.

## [1.0.20](https://github.com/kostyay/agent-stuff/pull/31) - 2026-03-07

Updated changelog writing rules and commit guidance to exclude auto-generated files from summaries and descriptions (#31). The changelog writer, commit message guidelines, and PR update skill now consistently ignore lock files (package-lock.json, yarn.lock, pnpm-lock.yaml, go.sum, Cargo.lock), generated code (*.pb.go, *_generated.*, *.gen.*), and build artifacts (dist/, *.min.js, *.min.css) to reduce noise and keep focus on meaningful hand-written changes. This ensures that changelog entries and commit descriptions accurately reflect actual development work rather than dependency or build system artifacts.

## [1.0.19](https://github.com/kostyay/agent-stuff/pull/30) - 2026-03-07

Added a real-time streaming speed indicator to the status bar that displays throughput in bytes/second during Claude's message generation (#30). The indicator uses a 1-second sliding window to track bytes from text, thinking, and tool-call deltas, with automatic unit scaling (B/s, kB/s, MB/s) for readability. Speed updates are rendered via a dedicated interval timer that triggers UI refreshes only during active streaming, replacing the previous token count display when streams are active. The feature properly manages lifecycle hooks—clearing timers on message completion and footer disposal to prevent memory leaks.

## [1.0.18](https://github.com/kostyay/agent-stuff/pull/29) - 2026-03-07

Implements session isolation for auto-triggered simplifications (#29), ensuring that files queued from the `agent_end` confirmation create a new isolated session before execution rather than running in the current context. This prevents simplification work from interfering with ongoing analysis and improves context management. The implementation queues files internally and defers their processing to the next `/simplify` invocation, which detects pending auto-simplify work and establishes a fresh session with appropriate naming before proceeding.

## [1.0.17](https://github.com/kostyay/agent-stuff/pull/28) - 2026-03-07

Enhanced task breakdown guidance in the ticket extension to provide agents with clearer constraints on task granularity (#28). The updated prompts now explicitly define "atomic tasks" as single, narrowly-scoped changes affecting 2-3 files or ~50 lines of code maximum, with concrete examples like individual functions, endpoints, or test files. This change addresses context window limitations by encouraging developers and AI agents to split larger tasks into smaller units, improving task completion rates and reducing incomplete work.

## [1.0.16](https://github.com/kostyay/agent-stuff/pull/27) - 2026-03-06

This release fixes a critical issue where PR creation could fail when the remote branch doesn't exist, by ensuring all commits are pushed before attempting to create a pull request (#27). The push operation now always executes unconditionally before PR creation rather than checking for unpushed commits, making it idempotent and handling edge cases like stale upstream refs after previous PR merges. Additionally, the PR creation command now explicitly specifies the branch head to avoid ambiguity in multi-branch workflows. A minor documentation correction updates the stash extension keyboard shortcut from Ctrl+S to Ctrl+Shift+S to match the actual implementation.

## [1.0.16](https://github.com/kostyay/agent-stuff/pull/26) - 2026-03-06

Introduces a configurable auto-simplify threshold and improved change detection for the `/simplify` command (#26). The `/simplify` command now uses per-file diff statistics to track added/removed lines and only triggers auto-proposal when total changes exceed a configurable `minChangedLines` threshold (default: 10), providing finer control over when simplification is suggested. Additionally, two new extensions were added: `/stash` command (Ctrl+S) for temporarily saving editor drafts during quick questions, and `/whoami` command for managing git user identity within sessions—improving workflow ergonomics for context-switching scenarios.

## [1.0.14](https://github.com/kostyay/agent-stuff/pull/25) - 2026-03-05

Introduces a new "Clear context and implement" flow that enables users to save a plan to temporary storage, reset the conversation context, and spawn a new session to execute the plan from scratch (#25). This complements the existing plan persistence and execution features by allowing for cleaner context boundaries when implementing multi-step plans. The implementation adds temporary file management via `savePlanToTemp()` and an internal `_plan-implement` command that orchestrates session creation and plan handoff. Also refactors plan-saving logic to handle both direct file saves and context-clearing scenarios, improving code clarity and reducing duplication.

## [1.0.13](https://github.com/kostyay/agent-stuff/pull/24) - 2026-03-05

Enhanced file path handling and automatic code simplification workflow (#24). The `/simplify` command now accepts explicit file paths as arguments, with remaining text parsed as additional instructions, while non-matching tokens are filtered intelligently. A new `agent_end` hook automatically proposes running `/simplify` when source files are modified during an agent turn, presenting a timed confirmation that auto-accepts after 5 seconds. Internal improvements include refactored git helpers (`splitLines`, `getUntrackedFiles`, `getChangedFilesSince`), support for both command and event contexts via relaxed `ExtensionContext` typing, and text wrapping applied to option descriptions in kbrainstorm for improved terminal UI layout. The extension now tracks agent turn state through HEAD snapshots to enable intelligent change detection without requiring explicit user invocation.

## [1.0.13](https://github.com/kostyay/agent-stuff/pull/23) - 2026-03-05

Sandbox state is now persisted per directory across sessions, with per-profile isolation so different coding profiles maintain independent settings (#23). The sandbox extension now supports `/sandbox on`, `/sandbox off`, and `/sandbox reset` commands that remember your preference for each working directory, eliminating the need to re-enable or re-disable sandbox on every restart. Additionally, the commit extension introduces robust branch-protection handling via a new `performMerge()` function that offers sequential recovery paths—admin override followed by auto-merge—when policy blocks prevent standard merging, and extracts fallback constants for improved maintainability.

## [1.0.11](https://github.com/kostyay/agent-stuff/pull/22) - 2026-03-03

The status bar now hides ticket status information when all tickets are closed, improving UI clarity by eliminating clutter in the status display (#22). Previously, the status would remain visible even with zero open or in-progress tickets; the fix refines the visibility logic to check for active work items instead of just total ticket count. This change reduces unnecessary status indicators while maintaining visibility for ongoing and blocked work.

## [1.0.10](https://github.com/kostyay/agent-stuff/pull/21) - 2026-03-03

This PR introduces an **event-driven architecture for ticket status rendering**, decoupling the ticket extension from direct footer manipulation (#21). The ticket extension now emits structured `ticket:stats` events via `pi.events` instead of calling `ctx.ui.setStatus()`, while the status-bar extension listens and renders rich ticket metrics (epics, tasks, bugs, features, status breakdowns) with theme-aware formatting. Supporting changes improve ticket description guidance to ensure self-contained documentation and simplify session creation logic by separating session initialization from message dispatch. The refactor reinforces architectural isolation—extensions communicate only through the shared event bus, never through cross-extension imports.

## [1.0.9](https://github.com/kostyay/agent-stuff/pull/20) - 2026-03-03

The status bar now aggregates multiple ticket statuses into a single count display (e.g., "3 tickets") rather than listing each ticket individually (#20). This improvement reduces visual clutter in the extension's footer display while maintaining visibility of ticket status information. The change filters ticket statuses separately from other extension statuses and applies proper pluralization, making the status bar more readable when dealing with multiple concurrent tickets.

## [1.0.8](https://github.com/kostyay/agent-stuff/pull/19) - 2026-03-03

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
