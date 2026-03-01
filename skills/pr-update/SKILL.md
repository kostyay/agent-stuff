---
name: pr-update
description: "Update or create a pull request for the current branch using the gh CLI. Analyzes code diffs for accurate PR descriptions."
---

# PR Update

Update (or create) a pull request for the current branch.

## Steps

### 1. Find the PR

```bash
gh pr view --json number,title,body,url,isDraft,baseRefName 2>&1
```

If no PR exists, ask the user whether to create one. If yes:

```bash
gh pr create --draft --title "WIP" --body ""
```

Then continue with the update steps below.

### 2. Analyze changes

Find the merge base and gather both commit messages and the actual diff:

```bash
BASE=$(gh pr view --json baseRefName --jq .baseRefName)
MERGE_BASE=$(git merge-base origin/$BASE HEAD)
git log --oneline $MERGE_BASE..HEAD
```

Then read the actual code diff to understand what changed beyond commit messages:

```bash
git diff $MERGE_BASE..HEAD --stat
git diff $MERGE_BASE..HEAD
```

Use the diff — not just commit messages — to write accurate change descriptions. Commit messages can be vague or misleading; the code tells the truth.

### 3. Update the PR

Choose a title in `<type>: <summary>` format (under 70 characters).

Types: `feat`, `fix`, `refactor`, `docs`, `chore`, `perf`, `test`, `build`, `ci`, `style`

Write a body as a bullet list of meaningful changes. Focus on *what* changed and *why*, not on file-by-file diffs. If something was tested, mention it briefly. Skip boilerplate — no "## Description" headers or template sections.

```bash
gh pr edit <number> --title "<title>" --body "<body>"
```

### 4. Output

Print the PR URL so the user can review it.
