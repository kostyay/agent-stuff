# Global Development Standards

Global instructions for all projects. Project-specific AGENTS.md files override these defaults.

- Work style: telegraph; noun-phrases ok; drop grammar; min tokens
- Workspace: `~/personal`. Missing `kostyay` repo → clone `https://github.com/kostyay/<repo>.git`
- Web: search early; quote exact errors; prefer 2024–2026 sources

## Task Routing

Use extensions/skills instead of manual workflows:

| task | use |
|------|-----|
| commit, push, PR, merge | `/commit`, `/commit-push`, `/commit-push-pr`, `/merge-pr` |
| code review | `/review` |
| planning | `/plan` or Shift+Tab |
| code cleanup | `/simplify` (auto-detects language → `*-code-simplifier` skill) |
| changelog | `kchangelog` skill |
| PR description | `pr-update` skill |
| GitHub ops | `github` skill |
| brainstorm | `kbrainstorm` skill + `ask_question` tool |

## Philosophy

- **No speculative features** — don't add features/flags/config unless actively needed
- **No premature abstraction** — don't extract until the same code appears three times
- **Justify new dependencies** — each one is attack surface and maintenance burden
- **No phantom features** — don't document or validate unimplemented features
- **Replace, don't deprecate** — remove old implementation entirely; no shims or dual formats
- **Verify at every level** — set up automated guardrails first, not as afterthought
- **Bias toward action** — decide and move for reversible changes; ask before interfaces, data models, architecture, or destructive external ops
- **Finish the job** — handle visible edge cases, clean up what you touched, flag adjacent breakage. Don't invent new scope.
- **Agent-native by default** — tools are atomic primitives; features are outcomes. Prefer file-based state. Every UI capability must be agent-achievable too.

## Critical Thinking

- Fix root cause, not band-aid, always use TDD to reproduce the issue first.
- Unsure → read more code; still stuck → ask w/ short options
- Conflicts → call out; pick safer path
- Unrecognized changes → assume other agent; keep going; focus your changes
- Always ASK user when unsure

## Hard Limits

1. ≤100 lines/function, cyclomatic complexity ≤8
2. ≤5 positional params
3. Absolute imports only — no relative (`..`) paths
4. Google-style docstrings on non-trivial public APIs
5. Zero warnings — fix every linter/type-checker/compiler warning even if unrelated to your changes. Inline ignore + justification if truly unfixable.

Prefer `ast-grep` over grep for code structure. Bash scripts: `set -euo pipefail`.

## Workflow

- Use repo's package manager/runtime; no swaps w/o approval
- Need upstream file → stage in `/tmp/`, cherry-pick; never overwrite tracked
- Avoid manual `git stash`; auto-stash during pull/rebase is fine
- No amend unless asked
- Never push directly to main — feature branches + PRs
- Never commit secrets/keys/credentials — `.env` files (gitignored) + env vars
- When adding dependencies/CI actions/tool versions → look up current stable version, never assume
