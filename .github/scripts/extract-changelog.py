#!/usr/bin/env python3
"""Extract release notes from CHANGELOG.md.

Tries in order:
  1. Body under "## Unreleased"
  2. Body under a heading matching the given version (e.g. ## 1.2.0, ## [1.2.0](...))
  3. Git commit log since the last tag

Usage:
    python extract-changelog.py <version> <output-file>
"""

import re
import subprocess
import sys
from pathlib import Path


def extract_section(changelog: str, heading_match: str) -> str:
    """Return the body text between a ## heading matching `heading_match` and the next ## heading."""
    lines = changelog.splitlines()
    capturing = False
    body: list[str] = []

    for line in lines:
        if line.startswith("## "):
            if capturing:
                break
            # Strip markdown link syntax: ## [1.2.0](url) - date  ->  1.2.0
            title = re.sub(r"^## \[?", "", line)
            title = re.sub(r"[\]( -].*", "", title).strip()
            if title == heading_match:
                capturing = True
                continue
        elif capturing:
            body.append(line)

    return "\n".join(body).strip()


def git_log_fallback() -> str:
    """Return commit messages since the last tag, or all commits if no tags exist."""
    try:
        base = subprocess.check_output(
            ["git", "describe", "--tags", "--abbrev=0"],
            stderr=subprocess.DEVNULL,
            text=True,
        ).strip()
    except subprocess.CalledProcessError:
        base = subprocess.check_output(
            ["git", "rev-list", "--max-parents=0", "HEAD"],
            text=True,
        ).strip()

    log = subprocess.check_output(
        ["git", "log", f"{base}..HEAD", "--pretty=format:* %s"],
        text=True,
    ).strip()
    return log


def main() -> None:
    if len(sys.argv) != 3:
        print(f"Usage: {sys.argv[0]} <version> <output-file>", file=sys.stderr)
        sys.exit(1)

    version = sys.argv[1]
    output_path = Path(sys.argv[2])

    changelog_path = Path("CHANGELOG.md")
    if not changelog_path.exists():
        print("CHANGELOG.md not found, falling back to git log", file=sys.stderr)
        output_path.write_text(git_log_fallback())
        return

    changelog = changelog_path.read_text()

    # 1. Try "Unreleased"
    notes = extract_section(changelog, "Unreleased")
    if notes:
        print(f"Extracted release notes from '## Unreleased' ({len(notes)} chars)")
        output_path.write_text(notes)
        return

    # 2. Try version match
    notes = extract_section(changelog, version)
    if notes:
        print(f"Extracted release notes from '## {version}' ({len(notes)} chars)")
        output_path.write_text(notes)
        return

    # 3. Fallback to git log
    print("No changelog section found, falling back to git log", file=sys.stderr)
    output_path.write_text(git_log_fallback())


if __name__ == "__main__":
    main()
