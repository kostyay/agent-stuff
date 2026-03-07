/**
 * Changelog — pure logic for parsing, splicing, reconciling, and prompt
 * building against a markdown changelog file.
 *
 * All functions are side-effect-free: they accept strings and return strings.
 * Git/gh execution and file I/O are the caller's responsibility.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single `## …` section parsed from the changelog. */
export interface ChangelogSection {
	/** The raw heading text after `## ` (e.g. `"git-rebase-master"` or `"[1.3.0]…"`). */
	heading: string;
	/** The body text below the heading (may be empty). */
	body: string;
}

/** Context gathered from git/gh for changelog generation. */
export interface ChangelogContext {
	branch: string;
	prNumber: number | null;
	commitLog: string;
	diffStat: string;
	diff: string;
	existingSectionBody: string | null;
}

/** Information about a merged PR used during reconciliation. */
export interface MergedPrInfo {
	number: number;
	mergedAt: string;
}

/** Result of promoting a branch section to a version heading. */
export interface PromotionResult {
	branch: string;
	version: string;
	prNumber: number;
	date: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum diff length included in the changelog prompt (chars). */
const MAX_CHANGELOG_DIFF = 15_000;

/** Regex matching a version heading like `[1.3.0](url) - 2026-01-01` or `1.3.0`. */
const VERSION_HEADING_RE = /^\[?\d+\.\d+\.\d+/;

/** The preamble heading for unreleased changes. */
const UNRELEASED = "Unreleased";

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse a changelog markdown string into its header (text before the first
 * `## `) and an ordered list of sections.
 */
export function parseChangelog(content: string): { header: string; sections: ChangelogSection[] } {
	const marker = "\n## ";
	const firstIdx = content.indexOf(marker);

	if (firstIdx === -1) {
		return { header: content, sections: [] };
	}

	const header = content.slice(0, firstIdx);
	const rest = content.slice(firstIdx + 1); // keep the leading `## `
	const rawParts = rest.split(marker);

	const sections: ChangelogSection[] = rawParts.map((part) => {
		const newlineIdx = part.indexOf("\n");
		if (newlineIdx === -1) {
			return { heading: part.replace(/^## /, "").trimEnd(), body: "" };
		}
		const heading = part.slice(0, newlineIdx).replace(/^## /, "").trimEnd();
		const body = part.slice(newlineIdx + 1).replace(/^\n+/, "").replace(/\n+$/, "");
		return { heading, body };
	});

	return { header, sections };
}

/**
 * Serialize a parsed changelog back to a markdown string.
 */
export function serializeChangelog(header: string, sections: ChangelogSection[]): string {
	const parts = [header];
	for (const section of sections) {
		const sectionText = section.body
			? `## ${section.heading}\n\n${section.body}`
			: `## ${section.heading}`;
		parts.push(sectionText);
	}
	return parts.join("\n\n") + "\n";
}

// ---------------------------------------------------------------------------
// Section classification
// ---------------------------------------------------------------------------

/** Return `true` if the heading looks like a version (e.g. `[1.3.0]…` or `1.3.0`). */
export function isVersionHeading(heading: string): boolean {
	return VERSION_HEADING_RE.test(heading);
}

/** Return `true` if the heading is a branch name (not a version and not `Unreleased`). */
export function isBranchHeading(heading: string): boolean {
	return !isVersionHeading(heading) && heading !== UNRELEASED;
}

/**
 * Extract all branch-named sections from the changelog.
 * Returns the heading strings (branch names).
 */
export function getBranchSections(sections: ChangelogSection[]): string[] {
	return sections.filter((s) => isBranchHeading(s.heading)).map((s) => s.heading);
}

// ---------------------------------------------------------------------------
// Splicing
// ---------------------------------------------------------------------------

/**
 * Insert or update a branch section in the changelog.
 *
 * - If a section with the given branch heading exists, its body is replaced
 *   with the new text.
 * - If no section exists, a new one is inserted at the top (after the header,
 *   before all other sections).
 *
 * Returns the updated changelog string.
 */
export function spliceBranchSection(
	content: string,
	branch: string,
	newBody: string,
): string {
	const { header, sections } = parseChangelog(content);

	const idx = sections.findIndex((s) => s.heading === branch);
	if (idx !== -1) {
		sections[idx] = { heading: branch, body: newBody };
	} else {
		sections.unshift({ heading: branch, body: newBody });
	}

	return serializeChangelog(header, sections);
}

// ---------------------------------------------------------------------------
// Reconciliation (promotion)
// ---------------------------------------------------------------------------

/**
 * Promote a branch section to a versioned heading.
 *
 * Replaces `## <branch>` with `## [<version>](prUrl) - <date>`.
 * Returns the updated changelog string, or the original if the branch
 * section was not found.
 */
export function promoteBranchToVersion(
	content: string,
	branch: string,
	version: string,
	prUrl: string,
	date: string,
): string {
	const { header, sections } = parseChangelog(content);

	const idx = sections.findIndex((s) => s.heading === branch);
	if (idx === -1) return content;

	const newHeading = `[${version}](${prUrl}) - ${date}`;
	sections[idx] = { heading: newHeading, body: sections[idx].body };

	return serializeChangelog(header, sections);
}

// ---------------------------------------------------------------------------
// Prompt building
// ---------------------------------------------------------------------------

/** Truncate a diff string, appending a marker when truncation occurs. */
export function truncateDiff(diff: string, maxLength: number = MAX_CHANGELOG_DIFF): string {
	if (diff.length <= maxLength) return diff;
	return diff.slice(0, maxLength) + "\n\n[diff truncated]";
}

/** Build the Haiku prompt for generating a changelog section body. */
export function buildChangelogPrompt(ctx: ChangelogContext): string {
	const prLine = ctx.prNumber != null ? `PR: #${ctx.prNumber}` : "PR: none";
	const existingLine = ctx.existingSectionBody
		? `Existing section (append to this, don't repeat):\n${ctx.existingSectionBody}`
		: "Existing section: none (new section)";

	return `You are a changelog writer. Given the git context below, write an executive summary for a CHANGELOG.md branch section.

Rules:
- 3-5 sentences, semi-technical (user impact + key technical terms)
- Group by theme, NOT by conventional commit type
- Lead with the most impactful change; highlight breaking changes first
- Filter out insignificant changes (typo fixes, internal refactoring, minor doc updates, dependency bumps unless security-related)
- IGNORE auto-generated files entirely. Lock files (package-lock.json, yarn.lock, pnpm-lock.yaml, go.sum, Cargo.lock), generated code (*.pb.go, *_generated.*, *.gen.*), and build artifacts (dist/, *.min.js, *.min.css) are noise — do not mention them
- Include PR# inline as (#N) if provided
- Output ONLY the section body text — no heading, no markdown fences, no quotes

Branch: ${ctx.branch}
${prLine}

${existingLine}

Commits:
${ctx.commitLog}

Diff stat:
${ctx.diffStat}

Diff:
${truncateDiff(ctx.diff)}`;
}
