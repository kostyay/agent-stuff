Make a release of this repository.

Version or release type: "$ARGUMENTS"

## Step-by-Step Process:

### 1. Determine the target version

Fetch tags first:
```bash
git fetch --tags origin
```

The `$ARGUMENTS` can be either:
- An explicit version number (e.g., `1.2.3`) — use directly
- A release type: `patch`, `minor`, or `major` — auto-bump from latest tag
- Empty — default to `patch`

To auto-bump:
```bash
LATEST=$(git tag -l 'v*' --sort=-v:refname | head -1)
# If no tags exist, start at v1.0.0
# Otherwise bump the appropriate segment
```

### 2. Update the changelog

Run the `/kchangelog` skill to ensure the changelog is up to date with recent changes.

### 3. Update package.json version

```bash
npm version $NEW_VERSION --no-git-tag-version
```

### 4. Commit, tag, and push

```bash
git add -A
git commit -m "Release v$NEW_VERSION"
git tag "v$NEW_VERSION"
```

Show the push commands to the user but do **NOT** auto-push:

```bash
git push origin main && git push origin "v$NEW_VERSION"
```

Let the user review the commit and tag first.
