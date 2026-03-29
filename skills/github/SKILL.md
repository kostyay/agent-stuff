---
name: github
description: "Interact with GitHub using the `gh` CLI. Use `gh pr`, `gh run`, `gh workflow`, `gh search`, and `gh api` for PRs, CI, search, and advanced queries."
---

# GitHub Skill

Use the `gh` CLI to interact with GitHub. Always specify `--repo owner/repo` when not in a git directory.

## Global Flags

| Flag | Description |
|------|-------------|
| `--repo [HOST/]OWNER/REPO` | Target a different repository |
| `--json FIELDS` | Output JSON with specified fields |
| `--jq EXPRESSION` | Filter JSON output |
| `--web` | Open in browser |
| `--paginate` | Fetch all pages of results |
| `--template STRING` | Format JSON using Go template |

## Pull Requests

### Create

```bash
gh pr create --title "Feature X" --body "Description" --base main
gh pr create --draft --assignee user1 --reviewer user2 --labels enhancement
```

### List & View

```bash
gh pr list --state open --author @me --limit 20
gh pr list --json number,title,state,author,headRefName
gh pr view 55 --json title,body,state,commits,files
```

### Checkout & Diff

```bash
gh pr checkout 55
gh pr diff 55
gh pr diff 55 --name-only
```

### Checks

```bash
gh pr checks 55
gh pr checks 55 --watch --interval 5
```

### Merge

```bash
gh pr merge 55 --squash --delete-branch
gh pr merge 55 --rebase
gh pr merge 55 --merge --admin  # skip checks
```

### Review

```bash
gh pr review 55 --approve --body "LGTM!"
gh pr review 55 --request-changes --body "Please fix X"
gh pr review 55 --comment --body "Some thoughts..."
```

### Edit

```bash
gh pr edit 55 --title "New title" --add-label bug --add-reviewer user1
gh pr edit 55 --remove-label stale --remove-assignee user1
gh pr ready 55  # mark draft as ready
```

### Other Operations

```bash
gh pr close 55 --comment "Closing — superseded by #60"
gh pr reopen 55
gh pr revert 55 --branch revert-pr-55
gh pr update-branch 55  # rebase/merge base into PR branch
gh pr comment 55 --body "Updated the approach"
```

## GitHub Actions

### Workflow Runs

```bash
gh run list --limit 10
gh run list --workflow "ci.yml" --branch main
gh run view <run-id>
gh run view <run-id> --log-failed
gh run watch <run-id>  # real-time status
gh run rerun <run-id>
gh run rerun <run-id> --job <job-id>
gh run cancel <run-id>
gh run download <run-id> --name build --dir ./artifacts
```

### Trigger Workflows

```bash
gh workflow list
gh workflow run ci.yml
gh workflow run deploy.yml --ref main -f version="1.0.0" -f environment="production"
gh workflow enable ci.yml
gh workflow disable ci.yml
```

### Secrets & Variables

```bash
gh secret list
echo "$VALUE" | gh secret set MY_SECRET
gh secret set MY_SECRET --env production
gh secret delete MY_SECRET

gh variable list
gh variable set MY_VAR "value"
gh variable get MY_VAR
gh variable delete MY_VAR
```

### Caches

```bash
gh cache list
gh cache delete <cache-id>
gh cache delete --all
```

## Search

```bash
gh search code "TODO" --repo owner/repo
gh search issues "label:bug state:open"
gh search prs "is:open review:required"
gh search repos "stars:>1000 language:go" --sort stars --order desc --limit 20
gh search commits "fix auth" --repo owner/repo
```

## API

### REST

```bash
gh api repos/owner/repo/pulls/55 --jq '.title, .state, .user.login'
gh api --method POST /repos/owner/repo/issues -f title="Bug" -f body="Details"
gh api /repos/owner/repo/actions/runs --paginate --jq '.workflow_runs[] | select(.conclusion == "failure")'
```

### GraphQL

```bash
gh api graphql -f query='
{
  viewer {
    login
    repositories(first: 5, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes { name, stargazerCount }
    }
  }
}'
```

## JSON Output & Filtering

```bash
gh pr list --json number,title --jq '.[] | "\(.number): \(.title)"'
gh issue list --json number,title,labels --jq '.[] | select(.labels | map(.name) | index("bug"))'
gh pr view 55 --json files --jq '[.files[].path]'
```

## Bulk Operations

```bash
# Close stale issues
gh issue list --search "label:stale" --json number --jq '.[].number' | \
  xargs -I {} gh issue close {} --comment "Closing as stale"

# Add label to PRs needing review
gh pr list --search "review:required" --json number --jq '.[].number' | \
  xargs -I {} gh pr edit {} --add-label needs-review
```

## Best Practices

- **Set default repo** to avoid `--repo` everywhere: `gh repo set-default owner/repo`
- **Use `--paginate`** for large result sets: `gh issue list --state all --paginate`
- **Use `GH_TOKEN` env var** for automation: `export GH_TOKEN=$(gh auth token)`
- **Prefer `--json` + `--jq`** over parsing text output
- **Use `--log-failed`** on `gh run view` to see only failing step logs
