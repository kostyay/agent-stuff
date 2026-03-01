# Scripted Changelog Pipeline

## Problem

The `/commit-push` and `/commit-push-pr` commands delegate changelog updates to the
agent via `sendUserMessage`, which triggers 5–8 tool-call round-trips (read file,
run git/gh commands, write file). This makes the flow slow and noisy.

## Solution

Replace `performChangelog` with a fully scripted pipeline: gather all git/gh context
in code, send a single direct Haiku call for the summary text, and splice the result
into CHANGELOG.md programmatically.

## Pipeline

```
1. Reconcile (pure code)
   - Read CHANGELOG.md
   - Find branch-named sections (regex)
   - For each: gh pr list --state merged → git tag → promote to version heading
   - Write back promoted sections

2. Gather context (pure code)
   - git log origin/<base>..HEAD --oneline
   - git diff --stat origin/<base>..HEAD
   - git diff origin/<base>..HEAD (truncated to 15k chars)
   - gh pr list for current branch (number if exists)
   - Read existing branch section text if any

3. Generate summary (single Haiku call)
   - Send all context + kchangelog style rules in one prompt
   - Haiku returns ONLY the section body text (no heading, no fences)

4. Splice into file (pure code)
   - Find or create ## <branch> section
   - Append new text to existing section, or create fresh
   - Write CHANGELOG.md
```

## Haiku Prompt

```
You are a changelog writer. Given the git context below, write an executive
summary for the CHANGELOG.md branch section.

Rules:
- 3-5 sentences, semi-technical (user impact + key technical terms)
- Group by theme, NOT by commit type
- Lead with most impactful change; highlight breaking changes first
- Filter out insignificant changes (typo fixes, internal refactoring, minor doc updates)
- Include PR# inline as (#N) if provided
- Output ONLY the section body text — no heading, no markdown fences

Branch: {branch}
PR: {pr_number or "none"}
Existing section (append to this, don't repeat): {existing_text or "none"}

Commits:
{git log output}

Diff stat:
{git diff --stat output}

Diff:
{truncated diff}
```

## File Splicing Logic

1. Read CHANGELOG.md as text
2. Parse into sections by splitting on `\n## `
3. Find section matching current branch name
4. If found: append new text after existing body
5. If not found: insert new section after header, before all other `##` sections
6. Rejoin and write

## Reconciliation Logic

1. Extract all `## <name>` sections where name doesn't match `[version]` or `Unreleased`
2. For each: `gh pr list --state merged --head <branch>`
3. If merged: find first release tag after merge date via `git tag --sort=-creatordate`
4. If tag found: rename `## <branch>` → `## [version](pr-url) - date`
5. If no tag yet: leave as-is

## Edge Cases

- **New branch, no existing section** → create fresh section
- **Re-run, no new commits** → Haiku sees existing text + same diff, returns empty/minimal → skip write
- **Multiple branches pending promotion** → process all before adding new content
- **No PR exists** → omit PR# from prompt, section uses branch name only

## Impact

Reduces changelog generation from ~8 agent tool-call round-trips to 1 direct Haiku
call plus scripted git/file operations. The `/commit-push` flow becomes significantly
faster and produces no agent conversation noise.
