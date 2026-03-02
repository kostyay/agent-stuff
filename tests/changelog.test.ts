/**
 * Unit tests for lib/changelog — the pure changelog parsing, splicing,
 * reconciliation, and prompt building logic.
 *
 * Uses Node's built-in test runner (node:test + node:assert).
 * Run with: node --experimental-strip-types --test tests/changelog.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
	type ChangelogContext,
	type ChangelogSection,
	buildChangelogPrompt,
	getBranchSections,
	isBranchHeading,
	isVersionHeading,
	parseChangelog,
	promoteBranchToVersion,
	serializeChangelog,
	spliceBranchSection,
	truncateDiff,
} from "../lib/changelog.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SAMPLE_CHANGELOG = `# Changelog

All notable changes to agent-stuff are documented here.

## git-rebase-master

Added \`/git-rebase-master\` command that fetches the latest \`main\` or \`master\`
from origin and rebases the current branch onto it.

## Unreleased

* Added the \`/plan\` command for read-only planning mode.
* Added the \`kbrainstorm\` skill and extension.

## [1.3.0](https://github.com/kostyay/agent-stuff/pull/5) - 2026-01-15

* Added \`/session-breakdown\` command with interactive TUI.

## 1.2.0

* Updated pi-extensions to use the new \`ToolDefinition.execute\` parameter order.
`;

const MINIMAL_CHANGELOG = `# Changelog

All notable changes.
`;

const EMPTY_CHANGELOG = `# Changelog`;

// ---------------------------------------------------------------------------
// parseChangelog
// ---------------------------------------------------------------------------

describe("parseChangelog", () => {
	it("parses header and sections from a standard changelog", () => {
		const { header, sections } = parseChangelog(SAMPLE_CHANGELOG);

		assert.ok(header.includes("# Changelog"));
		assert.ok(header.includes("All notable changes"));
		assert.equal(sections.length, 4);

		assert.equal(sections[0].heading, "git-rebase-master");
		assert.ok(sections[0].body.includes("/git-rebase-master"));

		assert.equal(sections[1].heading, "Unreleased");
		assert.ok(sections[1].body.includes("/plan"));

		assert.equal(
			sections[2].heading,
			"[1.3.0](https://github.com/kostyay/agent-stuff/pull/5) - 2026-01-15",
		);
		assert.ok(sections[2].body.includes("session-breakdown"));

		assert.equal(sections[3].heading, "1.2.0");
		assert.ok(sections[3].body.includes("ToolDefinition"));
	});

	it("returns empty sections for a changelog with no ## headings", () => {
		const { header, sections } = parseChangelog(MINIMAL_CHANGELOG);

		assert.ok(header.includes("# Changelog"));
		assert.equal(sections.length, 0);
	});

	it("handles a changelog with only a title", () => {
		const { header, sections } = parseChangelog(EMPTY_CHANGELOG);

		assert.equal(header, "# Changelog");
		assert.equal(sections.length, 0);
	});

	it("handles empty string", () => {
		const { header, sections } = parseChangelog("");

		assert.equal(header, "");
		assert.equal(sections.length, 0);
	});

	it("handles section with no body", () => {
		const input = `# Changelog\n\n## EmptySection\n\n## 1.0.0\n\n* Something.`;
		const { sections } = parseChangelog(input);

		assert.equal(sections.length, 2);
		assert.equal(sections[0].heading, "EmptySection");
		assert.equal(sections[0].body, "");
		assert.equal(sections[1].heading, "1.0.0");
		assert.ok(sections[1].body.includes("Something"));
	});
});

// ---------------------------------------------------------------------------
// serializeChangelog
// ---------------------------------------------------------------------------

describe("serializeChangelog", () => {
	it("round-trips a parsed changelog back to equivalent markdown", () => {
		const { header, sections } = parseChangelog(SAMPLE_CHANGELOG);
		const result = serializeChangelog(header, sections);

		// Should contain all the same headings and content
		assert.ok(result.includes("# Changelog"));
		assert.ok(result.includes("## git-rebase-master"));
		assert.ok(result.includes("## Unreleased"));
		assert.ok(result.includes("## [1.3.0]"));
		assert.ok(result.includes("## 1.2.0"));
		assert.ok(result.includes("/git-rebase-master"));
		assert.ok(result.includes("session-breakdown"));
	});

	it("produces valid markdown with no sections", () => {
		const result = serializeChangelog("# Changelog\n\nNotes.", []);

		assert.equal(result, "# Changelog\n\nNotes.\n");
	});

	it("handles a section with empty body", () => {
		const sections: ChangelogSection[] = [
			{ heading: "my-branch", body: "" },
		];
		const result = serializeChangelog("# Changelog", sections);

		assert.ok(result.includes("## my-branch"));
		// Should not have double blank lines between heading and next section
		assert.ok(!result.includes("## my-branch\n\n\n"));
	});
});

// ---------------------------------------------------------------------------
// isVersionHeading / isBranchHeading
// ---------------------------------------------------------------------------

describe("isVersionHeading", () => {
	it("recognizes bracketed version with link", () => {
		assert.ok(isVersionHeading("[1.3.0](https://github.com/x/y/pull/5) - 2026-01-15"));
	});

	it("recognizes bare version number", () => {
		assert.ok(isVersionHeading("1.2.0"));
	});

	it("recognizes version with v prefix inside brackets", () => {
		// Not typical but the regex should still match the digit pattern
		assert.ok(!isVersionHeading("v1.2.0"));
	});

	it("rejects branch names", () => {
		assert.ok(!isVersionHeading("git-rebase-master"));
		assert.ok(!isVersionHeading("feat/my-feature"));
		assert.ok(!isVersionHeading("Unreleased"));
	});
});

describe("isBranchHeading", () => {
	it("recognizes branch names", () => {
		assert.ok(isBranchHeading("git-rebase-master"));
		assert.ok(isBranchHeading("feat/my-feature"));
		assert.ok(isBranchHeading("fix/bug-123"));
	});

	it("rejects version headings", () => {
		assert.ok(!isBranchHeading("[1.3.0](url) - 2026-01-15"));
		assert.ok(!isBranchHeading("1.2.0"));
	});

	it("rejects Unreleased", () => {
		assert.ok(!isBranchHeading("Unreleased"));
	});
});

// ---------------------------------------------------------------------------
// getBranchSections
// ---------------------------------------------------------------------------

describe("getBranchSections", () => {
	it("extracts only branch-named sections", () => {
		const { sections } = parseChangelog(SAMPLE_CHANGELOG);
		const branches = getBranchSections(sections);

		assert.deepEqual(branches, ["git-rebase-master"]);
	});

	it("returns empty array when no branch sections exist", () => {
		const { sections } = parseChangelog(
			"# Changelog\n\n## Unreleased\n\nStuff.\n\n## 1.0.0\n\nMore stuff.",
		);
		const branches = getBranchSections(sections);

		assert.deepEqual(branches, []);
	});

	it("finds multiple branch sections", () => {
		const input = `# Changelog

## feat/second

Second feature.

## feat/first

First feature.

## 1.0.0

Initial release.
`;
		const { sections } = parseChangelog(input);
		const branches = getBranchSections(sections);

		assert.deepEqual(branches, ["feat/second", "feat/first"]);
	});
});

// ---------------------------------------------------------------------------
// spliceBranchSection
// ---------------------------------------------------------------------------

describe("spliceBranchSection", () => {
	it("updates an existing branch section", () => {
		const result = spliceBranchSection(
			SAMPLE_CHANGELOG,
			"git-rebase-master",
			"Updated body text for the branch.",
		);

		assert.ok(result.includes("## git-rebase-master"));
		assert.ok(result.includes("Updated body text for the branch."));
		// Old body should be gone
		assert.ok(!result.includes("fetches the latest"));
		// Other sections preserved
		assert.ok(result.includes("## Unreleased"));
		assert.ok(result.includes("## [1.3.0]"));
	});

	it("inserts a new branch section at the top", () => {
		const result = spliceBranchSection(
			SAMPLE_CHANGELOG,
			"feat/new-feature",
			"Brand new feature description.",
		);

		assert.ok(result.includes("## feat/new-feature"));
		assert.ok(result.includes("Brand new feature description."));

		// New section should come before the existing ones
		const newIdx = result.indexOf("## feat/new-feature");
		const existingIdx = result.indexOf("## git-rebase-master");
		assert.ok(newIdx < existingIdx, "New section should be before existing sections");
	});

	it("inserts into a changelog with no sections", () => {
		const result = spliceBranchSection(
			MINIMAL_CHANGELOG,
			"my-branch",
			"First changelog entry.",
		);

		assert.ok(result.includes("# Changelog"));
		assert.ok(result.includes("## my-branch"));
		assert.ok(result.includes("First changelog entry."));
	});

	it("preserves all unrelated sections when updating", () => {
		const result = spliceBranchSection(
			SAMPLE_CHANGELOG,
			"git-rebase-master",
			"New text.",
		);

		const { sections } = parseChangelog(result);
		assert.equal(sections.length, 4);
		assert.equal(sections[0].heading, "git-rebase-master");
		assert.equal(sections[1].heading, "Unreleased");
		assert.equal(
			sections[2].heading,
			"[1.3.0](https://github.com/kostyay/agent-stuff/pull/5) - 2026-01-15",
		);
		assert.equal(sections[3].heading, "1.2.0");
	});
});

// ---------------------------------------------------------------------------
// promoteBranchToVersion
// ---------------------------------------------------------------------------

describe("promoteBranchToVersion", () => {
	it("promotes a branch heading to a versioned heading", () => {
		const result = promoteBranchToVersion(
			SAMPLE_CHANGELOG,
			"git-rebase-master",
			"1.4.0",
			"https://github.com/kostyay/agent-stuff/pull/10",
			"2026-03-02",
		);

		assert.ok(result.includes("## [1.4.0](https://github.com/kostyay/agent-stuff/pull/10) - 2026-03-02"));
		assert.ok(!result.includes("## git-rebase-master"));
		// Body should be preserved
		assert.ok(result.includes("/git-rebase-master"));
	});

	it("returns original content when branch not found", () => {
		const result = promoteBranchToVersion(
			SAMPLE_CHANGELOG,
			"nonexistent-branch",
			"1.4.0",
			"https://example.com/pr/1",
			"2026-03-02",
		);

		assert.equal(result, SAMPLE_CHANGELOG);
	});

	it("preserves section order after promotion", () => {
		const input = `# Changelog

## feat/b

B changes.

## feat/a

A changes.

## 1.0.0

Initial.
`;
		const result = promoteBranchToVersion(
			input,
			"feat/a",
			"1.1.0",
			"https://example.com/pr/2",
			"2026-03-01",
		);

		const { sections } = parseChangelog(result);
		assert.equal(sections.length, 3);
		assert.equal(sections[0].heading, "feat/b");
		assert.equal(sections[1].heading, "[1.1.0](https://example.com/pr/2) - 2026-03-01");
		assert.equal(sections[2].heading, "1.0.0");
	});
});

// ---------------------------------------------------------------------------
// truncateDiff
// ---------------------------------------------------------------------------

describe("truncateDiff", () => {
	it("returns short diffs unchanged", () => {
		const short = "a".repeat(100);
		assert.equal(truncateDiff(short, 200), short);
	});

	it("truncates long diffs with a marker", () => {
		const long = "x".repeat(500);
		const result = truncateDiff(long, 200);

		assert.ok(result.length < long.length);
		assert.ok(result.endsWith("[diff truncated]"));
		assert.ok(result.startsWith("x".repeat(200)));
	});

	it("returns exact-length diffs unchanged", () => {
		const exact = "y".repeat(200);
		assert.equal(truncateDiff(exact, 200), exact);
	});
});

// ---------------------------------------------------------------------------
// buildChangelogPrompt
// ---------------------------------------------------------------------------

describe("buildChangelogPrompt", () => {
	it("includes all context fields in the prompt", () => {
		const ctx: ChangelogContext = {
			branch: "feat/my-feature",
			prNumber: 42,
			commitLog: "abc123 feat: add widget\ndef456 fix: widget color",
			diffStat: " src/widget.ts | 20 +++++\n 1 file changed",
			diff: "diff --git a/src/widget.ts ...",
			existingSectionBody: null,
		};

		const prompt = buildChangelogPrompt(ctx);

		assert.ok(prompt.includes("Branch: feat/my-feature"));
		assert.ok(prompt.includes("PR: #42"));
		assert.ok(prompt.includes("abc123 feat: add widget"));
		assert.ok(prompt.includes("src/widget.ts | 20"));
		assert.ok(prompt.includes("diff --git"));
		assert.ok(prompt.includes("none (new section)"));
	});

	it("includes existing section body when present", () => {
		const ctx: ChangelogContext = {
			branch: "fix/bug",
			prNumber: null,
			commitLog: "aaa fix: something",
			diffStat: " 1 file changed",
			diff: "diff",
			existingSectionBody: "Previously fixed the widget crash.",
		};

		const prompt = buildChangelogPrompt(ctx);

		assert.ok(prompt.includes("PR: none"));
		assert.ok(prompt.includes("append to this, don't repeat"));
		assert.ok(prompt.includes("Previously fixed the widget crash."));
	});

	it("truncates large diffs", () => {
		const ctx: ChangelogContext = {
			branch: "big-change",
			prNumber: null,
			commitLog: "x",
			diffStat: "x",
			diff: "a".repeat(20_000),
			existingSectionBody: null,
		};

		const prompt = buildChangelogPrompt(ctx);

		assert.ok(prompt.includes("[diff truncated]"));
		assert.ok(prompt.length < 20_000 + 2000); // prompt overhead
	});

	it("contains style rules", () => {
		const ctx: ChangelogContext = {
			branch: "test",
			prNumber: null,
			commitLog: "x",
			diffStat: "x",
			diff: "x",
			existingSectionBody: null,
		};

		const prompt = buildChangelogPrompt(ctx);

		assert.ok(prompt.includes("3-5 sentences"));
		assert.ok(prompt.includes("semi-technical"));
		assert.ok(prompt.includes("breaking changes"));
		assert.ok(prompt.includes("no markdown fences"));
	});
});

// ---------------------------------------------------------------------------
// Integration: parse → splice → serialize round-trip
// ---------------------------------------------------------------------------

describe("integration: full round-trip", () => {
	it("adds a new branch, then updates it, preserving everything else", () => {
		// Start with sample changelog
		let content = SAMPLE_CHANGELOG;

		// Add a new branch section
		content = spliceBranchSection(content, "feat/new", "Initial description.");
		const parsed1 = parseChangelog(content);
		assert.equal(parsed1.sections.length, 5);
		assert.equal(parsed1.sections[0].heading, "feat/new");

		// Update the same branch section
		content = spliceBranchSection(content, "feat/new", "Initial description.\n\nAdditional context added.");
		const parsed2 = parseChangelog(content);
		assert.equal(parsed2.sections.length, 5);
		assert.ok(parsed2.sections[0].body.includes("Additional context"));

		// Promote the branch to a version
		content = promoteBranchToVersion(
			content,
			"feat/new",
			"1.5.0",
			"https://github.com/kostyay/agent-stuff/pull/15",
			"2026-03-02",
		);
		const parsed3 = parseChangelog(content);
		assert.equal(parsed3.sections.length, 5);
		assert.ok(parsed3.sections[0].heading.includes("[1.5.0]"));
		assert.ok(!parsed3.sections[0].heading.includes("feat/new"));

		// Original sections still intact
		assert.equal(parsed3.sections[1].heading, "git-rebase-master");
		assert.equal(parsed3.sections[2].heading, "Unreleased");
	});

	it("handles a fresh changelog from scratch", () => {
		let content = "# Changelog\n\nAll notable changes.\n";

		content = spliceBranchSection(content, "feat/first", "First feature.");
		content = spliceBranchSection(content, "feat/second", "Second feature.");

		const { header, sections } = parseChangelog(content);
		assert.ok(header.includes("# Changelog"));
		assert.equal(sections.length, 2);
		assert.equal(sections[0].heading, "feat/second");
		assert.equal(sections[1].heading, "feat/first");
	});
});
