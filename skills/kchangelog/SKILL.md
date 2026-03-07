---
name: kchangelog
description: "Read this skill before updating changelogs. Generates executive-style changelog entries tracked by branch name, auto-promoted to version on release."
---

# Executive Summary Changelog

Generate executive-style changelog entries tracked by branch name, auto-promoted to version on release.

## 1. Reconcile Existing Entries

Before adding new content, check if any branch sections need promotion:

```bash
# Get all branch-named sections from CHANGELOG.md (lines starting with ## that aren't versions)
grep -E '^## [^0-9\[]' CHANGELOG.md | sed 's/## //'
```

For each branch found:
```bash
BRANCH="feature/my-branch"

# Check if branch was merged via PR
PR_DATA=$(gh pr list --state merged --head "$BRANCH" --limit 1 --json number,mergedAt,headRefName 2>/dev/null)

if [ -n "$PR_DATA" ] && [ "$PR_DATA" != "[]" ]; then
  PR_NUM=$(echo "$PR_DATA" | jq -r '.[0].number')
  MERGE_DATE=$(echo "$PR_DATA" | jq -r '.[0].mergedAt' | cut -d'T' -f1)

  # Find release tag created after merge
  RELEASE_TAG=$(git tag --sort=-creatordate | while read tag; do
    TAG_DATE=$(git log -1 --format=%ai "$tag" 2>/dev/null | cut -d' ' -f1)
    if [[ "$TAG_DATE" > "$MERGE_DATE" ]] || [[ "$TAG_DATE" == "$MERGE_DATE" ]]; then
      echo "$tag"
      break
    fi
  done)

  if [ -n "$RELEASE_TAG" ]; then
    echo "Promote: $BRANCH -> $RELEASE_TAG (PR #$PR_NUM)"
  fi
fi
```

**Promotion format:**
```markdown
## [0.17.0](https://github.com/OWNER/REPO/pull/XX) - 2026-02-05

<existing content unchanged>
```

## 2. Gather Data for Current Branch

```bash
BRANCH=$(git branch --show-current)
BASE_BRANCH="master"  # or main

# Get commits on this branch
git log "$BASE_BRANCH..$BRANCH" --oneline

# Get PR if exists (draft or open)
gh pr list --head "$BRANCH" --state all --limit 1 --json number,title,body
```

## 3. Write Executive Summary

**Style rules:**
- 3-5 sentences per entry
- Semi-technical: user impact + key technical terms
- Group by theme, NOT by conventional commit type
- Include PR# inline as `(#78)` if PR exists
- Lead with the most impactful change; highlight breaking changes first
- Filter out insignificant changes (typo fixes, internal refactoring, minor doc updates, dependency bumps unless security-related)
- IGNORE auto-generated files entirely — lock files (`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `go.sum`, `Cargo.lock`), generated code (`*.pb.go`, `*_generated.*`, `*.gen.*`), and build artifacts (`dist/`, `*.min.js`, `*.min.css`) are noise and must not appear in the changelog

**Good vs. Bad examples:**
- ✅ `Fixed an issue with the TypeScript SDK which caused an incorrect config for CJS.`
- ✅ `Workflows can now pause mid-execution with wait_duration() and wait_until() operators.`
- ❌ `Fixed bug` (too vague)
- ❌ `Updated dependencies` (insignificant unless security fix)
- ❌ `Refactored internal code structure` (not user-facing)

**Section format (new branch):**
```markdown
## feature/wait-operators

Workflows can now pause mid-execution with `wait_duration()` and `wait_until()`
operators. The wait system supports TimeUnit enum (seconds/minutes/hours/days)
and the linter adds W007 to catch invalid datetime values.
```

## 4. Update CHANGELOG.md

1. Run reconciliation first (promote any merged+released branches)
2. Find or create section for current branch
3. If section already exists, **append** new content — do not replace existing entries
4. Update content under that section
5. Keep sections in reverse chronological order (newest at top)

## 5. Verification

After updating:
1. Confirm branch name matches current branch
2. Check promoted sections have correct version + PR link
3. Verify language is semi-technical
