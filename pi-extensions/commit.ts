/**
 * Commit Extension
 *
 * Registers three commands that compose incrementally:
 *   `/commit`          — Stage, generate commit message, branch if needed, commit.
 *   `/commit-push`     — Update changelog, then commit and push.
 *   `/commit-push-pr`  — Update changelog, commit, push, and create/update a PR
 *                         with an AI-generated title and description.
 *
 * The changelog step is fully scripted: git/gh context is gathered in code,
 * a single Haiku call generates the summary, and the result is spliced into
 * CHANGELOG.md programmatically.
 *
 * Uses `complete()` from `@mariozechner/pi-ai` for direct model invocation.
 */

import { complete, getModel } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
	type ChangelogContext,
	buildChangelogPrompt,
	getBranchSections,
	parseChangelog,
	promoteBranchToVersion,
	spliceBranchSection,
} from "../lib/changelog.ts";

// ---------------------------------------------------------------------------
// Model & constants
// ---------------------------------------------------------------------------

/** Model used for all text generation. */
const HAIKU = getModel("anthropic", "claude-haiku-4-5");

/** Maximum diff length sent to the model (chars). */
const MAX_DIFF_LENGTH = 15_000;

/** Package root (parent of `pi-extensions/`). */
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

/** Prompt for generating a Conventional Commits subject line. */
const COMMIT_MESSAGE_PROMPT = `You are a commit-message generator. Given a git diff, output ONLY a single Conventional Commits subject line. No explanation, no body, no markdown fences.

Format: <type>(<scope>): <summary>

Rules:
- type REQUIRED: feat, fix, docs, refactor, chore, test, or perf.
- scope OPTIONAL: short noun for the affected area (e.g. api, parser, ui). Omit if changes span many areas.
- summary REQUIRED: imperative mood, lowercase start, ≤72 chars total, no trailing period.
- No breaking-change markers or footers.
- No sign-offs.
- Output the subject line and nothing else.

Diff:
`;

/** Prompt for generating a git branch name. */
const BRANCH_NAME_PROMPT = `You are a git branch name generator. Given a git diff, output ONLY a single branch name. No explanation, no markdown fences, no quotes.

Format: <type>/<short-description>

Rules:
- type REQUIRED: feat, fix, docs, refactor, chore, test, or perf.
- short-description REQUIRED: 2-5 lowercase words joined by hyphens describing the change.
- Total length ≤60 chars.
- Only lowercase letters, digits, hyphens, and one forward slash separating type from description.
- No trailing hyphens.
- Output the branch name and nothing else.

Diff:
`;

/** Prompt for generating a PR title and body. */
const PR_CONTENT_PROMPT = `You are a pull request writer. Given a git diff, commit log, and diff stat, generate a PR title and body.

Output format (exactly two sections, separated by a blank line):
TITLE: <type>: <summary>
BODY:
<bullet list>

Title rules:
- Format: <type>: <summary> (under 70 chars total)
- Types: feat, fix, refactor, docs, chore, perf, test, build, ci, style
- Summary: imperative mood, lowercase start, no trailing period

Body rules:
- Bullet list of meaningful changes (use - prefix)
- Focus on *what* changed and *why*, not file-by-file diffs
- If something was tested, mention it briefly
- No boilerplate, no "## Description" headers, no template sections
- Keep it concise — 3-8 bullets typically

Output the TITLE and BODY sections and nothing else. No markdown fences.

`;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Truncate a diff, appending a marker when truncation occurs. */
function truncateDiff(diff: string): string {
	if (diff.length <= MAX_DIFF_LENGTH) return diff;
	return diff.slice(0, MAX_DIFF_LENGTH) + "\n\n[diff truncated]";
}

/** Extract the first line from a model response, stripping fences and quotes. */
function cleanFirstLine(raw: string): string {
	return raw
		.trim()
		.replace(/^```[\s\S]*?```$/gm, "")
		.replace(/^[`'"]+|[`'"]+$/g, "")
		.split("\n")[0]
		.trim();
}

/**
 * Call haiku with a single user-message prompt.
 *
 * Returns `undefined` if the model or API key is unavailable.
 */
async function callHaiku(prompt: string, ctx: ExtensionCommandContext): Promise<string | undefined> {
	if (!HAIKU) return undefined;

	const apiKey = await ctx.modelRegistry.getApiKey(HAIKU);
	if (!apiKey) return undefined;

	const response = await complete(HAIKU, {
		messages: [{
			role: "user" as const,
			content: [{ type: "text" as const, text: prompt }],
			timestamp: Date.now(),
		}],
	}, { apiKey });

	const text = response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("");

	return text || undefined;
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

/** Detect the repository's default branch (main/master). */
async function getDefaultBranch(pi: ExtensionAPI): Promise<string> {
	const { stdout, code } = await pi.exec("git", [
		"symbolic-ref", "refs/remotes/origin/HEAD", "--short",
	]);
	if (code === 0 && stdout.trim()) {
		return stdout.trim().replace("origin/", "");
	}

	const { stdout: branches } = await pi.exec("git", [
		"branch", "--format=%(refname:short)",
	]);
	const list = branches.trim().split("\n").filter(Boolean);
	if (list.includes("main")) return "main";
	if (list.includes("master")) return "master";
	return "main";
}

/** Return the current branch name, or null if in detached HEAD. */
async function getCurrentBranch(pi: ExtensionAPI): Promise<string | null> {
	const { stdout, code } = await pi.exec("git", ["branch", "--show-current"]);
	return code === 0 && stdout.trim() ? stdout.trim() : null;
}

/** Check whether there are any uncommitted changes. */
async function hasChanges(pi: ExtensionAPI): Promise<boolean> {
	const { stdout, code } = await pi.exec("git", ["status", "--porcelain"]);
	return code === 0 && stdout.trim().length > 0;
}

/** Check whether there are commits ahead of the remote tracking branch. */
async function hasUnpushedCommits(pi: ExtensionAPI): Promise<boolean> {
	const { stdout, code } = await pi.exec("git", [
		"rev-list", "--count", "@{upstream}..HEAD",
	]);
	if (code === 0) {
		return parseInt(stdout.trim(), 10) > 0;
	}
	// No upstream set — if we have any commits, they're unpushed
	const { stdout: logOut, code: logCode } = await pi.exec("git", [
		"rev-list", "--count", "HEAD",
	]);
	return logCode === 0 && parseInt(logOut.trim(), 10) > 0;
}

/** Gather staged + unstaged diff and untracked file names. */
async function gatherDiffContent(pi: ExtensionAPI): Promise<string> {
	const { stdout: diff } = await pi.exec("git", ["diff", "HEAD"]);
	const { stdout: untracked } = await pi.exec("git", [
		"ls-files", "--others", "--exclude-standard",
	]);

	let content = diff.trim();
	if (untracked.trim()) {
		content += `\n\n[New untracked files]\n${untracked.trim()}`;
	}
	if (!content) {
		const { stdout: staged } = await pi.exec("git", ["diff", "--staged"]);
		content = staged.trim();
	}
	return content;
}

// ---------------------------------------------------------------------------
// AI generation
// ---------------------------------------------------------------------------

/** Generate a Conventional Commits message. Falls back to "chore: update files". */
async function generateCommitMessage(diff: string, ctx: ExtensionCommandContext): Promise<string> {
	if (!diff) return "chore: update files";
	const raw = await callHaiku(COMMIT_MESSAGE_PROMPT + truncateDiff(diff), ctx);
	return (raw && cleanFirstLine(raw)) || "chore: update files";
}

/** Generate a branch name. Falls back to "feature/auto-branch". */
async function generateBranchName(diff: string, ctx: ExtensionCommandContext): Promise<string> {
	if (!diff) return "feature/auto-branch";
	const raw = await callHaiku(BRANCH_NAME_PROMPT + truncateDiff(diff), ctx);
	if (!raw) return "feature/auto-branch";

	const cleaned = cleanFirstLine(raw)
		.toLowerCase()
		.replace(/[^a-z0-9/-]/g, "-")
		.replace(/-+/g, "-")
		.replace(/-$/, "");
	return cleaned || "feature/auto-branch";
}

/** Parsed PR title and body. */
interface PrContent {
	title: string;
	body: string;
}

/** Parse the `TITLE: … / BODY: …` format returned by haiku. */
function parsePrContent(raw: string): PrContent {
	const title = raw.match(/^TITLE:\s*(.+)$/m)?.[1]?.trim() || "chore: update";
	const body = raw.match(/^BODY:\s*\n?([\s\S]*)$/m)?.[1]?.trim() || "";
	return { title, body };
}

/** Generate a PR title and body from commit log, diff stat, and diff. */
async function generatePrContent(
	commitLog: string,
	diffStat: string,
	diff: string,
	ctx: ExtensionCommandContext,
): Promise<PrContent> {
	const prompt =
		PR_CONTENT_PROMPT +
		`Commit log:\n${commitLog}\n\nDiff stat:\n${diffStat}\n\nDiff:\n${truncateDiff(diff)}`;
	const raw = await callHaiku(prompt, ctx);
	return raw ? parsePrContent(raw) : { title: "chore: update", body: "" };
}

// ---------------------------------------------------------------------------
// PR helpers
// ---------------------------------------------------------------------------

/** Return the existing PR for the current branch, or null. */
async function getExistingPr(pi: ExtensionAPI): Promise<{ number: number; url: string } | null> {
	const { stdout, code } = await pi.exec("gh", ["pr", "view", "--json", "number,url"]);
	if (code !== 0) return null;
	try {
		return JSON.parse(stdout.trim()) as { number: number; url: string };
	} catch {
		return null;
	}
}

/** Gather the full branch diff against the base branch via merge-base. */
async function gatherPrDiff(
	pi: ExtensionAPI,
	baseBranch: string,
): Promise<{ commitLog: string; diffStat: string; diff: string }> {
	const { stdout: mergeBase } = await pi.exec("git", [
		"merge-base", `origin/${baseBranch}`, "HEAD",
	]);
	const base = mergeBase.trim();

	const [logResult, statResult, diffResult] = await Promise.all([
		pi.exec("git", ["log", "--oneline", `${base}..HEAD`]),
		pi.exec("git", ["diff", `${base}..HEAD`, "--stat"]),
		pi.exec("git", ["diff", `${base}..HEAD`]),
	]);

	return {
		commitLog: logResult.stdout.trim(),
		diffStat: statResult.stdout.trim(),
		diff: diffResult.stdout.trim(),
	};
}

// ---------------------------------------------------------------------------
// Shared commit flow
// ---------------------------------------------------------------------------

/** Options for the commit flow. */
interface CommitOptions {
	/** When true, auto-create a side branch without prompting the user. */
	autoBranch?: boolean;
}

/**
 * The full stage → generate → branch → commit flow shared by all commands.
 *
 * When `options.autoBranch` is true and we're on the default branch, the
 * AI-generated branch name is used without prompting. Otherwise the user
 * is asked to confirm or provide a branch name.
 *
 * Returns the commit message on success, or `null` if the flow was
 * cancelled or failed (notifications are already shown).
 */
async function performCommit(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	options: CommitOptions = {},
): Promise<{ commitMessage: string; defaultBranch: string } | null> {
	const currentBranch = await getCurrentBranch(pi);
	const defaultBranch = await getDefaultBranch(pi);
	const onDefaultBranch = currentBranch === defaultBranch || currentBranch === null;

	// Stage
	const { code: addCode, stderr: addErr } = await pi.exec("git", ["add", "-A"]);
	if (addCode !== 0) {
		ctx.ui.notify(`Failed to stage changes: ${addErr}`, "error");
		return null;
	}

	// Gather diff
	const diffContent = await gatherDiffContent(pi);
	ctx.ui.notify("Generating commit message…", "info");

	// Generate commit message (+ branch name in parallel when needed)
	let commitMessage: string;
	let proposedBranch: string | undefined;

	if (onDefaultBranch) {
		const [msg, branch] = await Promise.all([
			generateCommitMessage(diffContent, ctx),
			generateBranchName(diffContent, ctx),
		]);
		commitMessage = msg;
		proposedBranch = branch;
	} else {
		commitMessage = await generateCommitMessage(diffContent, ctx);
	}

	// Create side branch if on default branch
	if (onDefaultBranch) {
		const suggestion = proposedBranch ?? "feature/auto-branch";

		if (options.autoBranch || !ctx.hasUI) {
			// Auto-create the branch without prompting
			const { code, stderr } = await pi.exec("git", ["checkout", "-b", suggestion]);
			if (code !== 0) {
				ctx.ui.notify(`Failed to create branch: ${stderr}`, "error");
				return null;
			}
			ctx.ui.notify(`Created branch '${suggestion}'`, "info");
		} else {
			const useSuggestion = await ctx.ui.confirm(
				`On '${currentBranch ?? "detached HEAD"}'`,
				`Create branch '${suggestion}'?`,
			);

			let finalBranch: string;
			if (useSuggestion) {
				finalBranch = suggestion;
			} else {
				const name = await ctx.ui.input("Enter branch name:");
				if (!name?.trim()) {
					ctx.ui.notify("Cancelled (no branch name)", "info");
					return null;
				}
				finalBranch = name.trim();
			}

			const { code, stderr } = await pi.exec("git", ["checkout", "-b", finalBranch]);
			if (code !== 0) {
				ctx.ui.notify(`Failed to create branch '${finalBranch}': ${stderr}`, "error");
				return null;
			}
			ctx.ui.notify(`Created branch '${finalBranch}'`, "info");
		}
	}

	// Commit
	const { code: commitCode, stderr: commitErr } = await pi.exec(
		"git", ["commit", "-m", commitMessage],
	);
	if (commitCode !== 0) {
		ctx.ui.notify(`Commit failed: ${commitErr}`, "error");
		return null;
	}
	ctx.ui.notify(`Committed: ${commitMessage}`, "info");

	return { commitMessage, defaultBranch };
}

// ---------------------------------------------------------------------------
// Pre-flight checks
// ---------------------------------------------------------------------------

/**
 * Validate git repo and haiku model availability.
 *
 * Does NOT check for uncommitted changes — callers that need that
 * should check `hasChanges()` separately.
 *
 * Returns `false` (with notifications) if any check fails.
 */
async function checkPrerequisites(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<boolean> {
	const { code: gitCheck } = await pi.exec("git", ["rev-parse", "--git-dir"]);
	if (gitCheck !== 0) {
		ctx.ui.notify("Not a git repository", "error");
		return false;
	}
	if (!HAIKU) {
		ctx.ui.notify("Model anthropic/claude-haiku-4-5 not found", "error");
		return false;
	}
	const apiKey = await ctx.modelRegistry.getApiKey(HAIKU);
	if (!apiKey) {
		ctx.ui.notify("No API key for anthropic/claude-haiku-4-5", "error");
		return false;
	}
	return true;
}

// ---------------------------------------------------------------------------
// Shared changelog flow
// ---------------------------------------------------------------------------

/** Path to the CHANGELOG.md file in the working directory. */
function changelogPath(): string {
	return resolve(process.cwd(), "CHANGELOG.md");
}

/** Read CHANGELOG.md from the working directory. Returns null if missing. */
function readChangelog(): string | null {
	try {
		return readFileSync(changelogPath(), "utf-8");
	} catch {
		return null;
	}
}

/**
 * Reconcile branch sections that have been merged and released.
 *
 * For each branch-named section, checks if it was merged via PR and if a
 * release tag was created after the merge. If so, promotes the section
 * heading to a versioned heading.
 */
async function reconcileChangelog(
	pi: ExtensionAPI,
	content: string,
): Promise<string> {
	const { sections } = parseChangelog(content);
	const branches = getBranchSections(sections);

	let result = content;
	for (const branch of branches) {
		const { stdout: prJson, code: prCode } = await pi.exec("gh", [
			"pr", "list", "--state", "merged", "--head", branch,
			"--limit", "1", "--json", "number,mergedAt",
		]);
		if (prCode !== 0 || !prJson.trim() || prJson.trim() === "[]") continue;

		let prData: Array<{ number: number; mergedAt: string }>;
		try {
			prData = JSON.parse(prJson.trim());
		} catch {
			continue;
		}
		if (prData.length === 0) continue;

		const prNumber = prData[0].number;
		const mergeDate = prData[0].mergedAt.split("T")[0];

		// Find a release tag created on or after the merge date
		const { stdout: tagsRaw } = await pi.exec("git", ["tag", "--sort=-creatordate"]);
		const tags = tagsRaw.trim().split("\n").filter(Boolean);

		let releaseTag: string | null = null;
		for (const tag of tags) {
			const { stdout: tagDateRaw } = await pi.exec("git", [
				"log", "-1", "--format=%ai", tag,
			]);
			const tagDate = tagDateRaw.trim().split(" ")[0];
			if (tagDate >= mergeDate) {
				releaseTag = tag;
				break;
			}
		}
		if (!releaseTag) continue;

		// Extract version from tag (strip leading 'v' if present)
		const version = releaseTag.replace(/^v/, "");
		const { stdout: repoUrl } = await pi.exec("git", [
			"remote", "get-url", "origin",
		]);
		const repoPath = repoUrl.trim()
			.replace(/\.git$/, "")
			.replace(/^git@github\.com:/, "https://github.com/");
		const prUrl = `${repoPath}/pull/${prNumber}`;

		result = promoteBranchToVersion(result, branch, version, prUrl, mergeDate);
	}

	return result;
}

/**
 * Gather the git context needed for changelog generation.
 *
 * Reads commit log, diff stat, and diff relative to the base branch.
 */
async function gatherChangelogContext(
	pi: ExtensionAPI,
	branch: string,
	baseBranch: string,
	existingBody: string | null,
): Promise<ChangelogContext> {
	const base = `origin/${baseBranch}`;

	const [logResult, statResult, diffResult, prResult] = await Promise.all([
		pi.exec("git", ["log", `${base}..HEAD`, "--oneline"]),
		pi.exec("git", ["diff", `${base}..HEAD`, "--stat"]),
		pi.exec("git", ["diff", `${base}..HEAD`]),
		pi.exec("gh", [
			"pr", "list", "--head", branch, "--state", "all",
			"--limit", "1", "--json", "number",
		]),
	]);

	let prNumber: number | null = null;
	try {
		const prs = JSON.parse(prResult.stdout.trim());
		if (Array.isArray(prs) && prs.length > 0) {
			prNumber = prs[0].number;
		}
	} catch {
		// No PR — that's fine
	}

	return {
		branch,
		prNumber,
		commitLog: logResult.stdout.trim(),
		diffStat: statResult.stdout.trim(),
		diff: diffResult.stdout.trim(),
		existingSectionBody: existingBody,
	};
}

/**
 * Scripted changelog update: gather context, reconcile, generate summary
 * via a single Haiku call, and splice the result into CHANGELOG.md.
 *
 * Falls back gracefully if CHANGELOG.md is missing, the model is
 * unavailable, or there are no commits on the branch.
 */
async function performChangelog(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const branch = await getCurrentBranch(pi);
	if (!branch) {
		ctx.ui.notify("Detached HEAD — skipping changelog update", "warning");
		return;
	}

	const defaultBranch = await getDefaultBranch(pi);
	if (branch === defaultBranch) {
		ctx.ui.notify("On default branch — skipping changelog update", "info");
		return;
	}

	let content = readChangelog();
	if (!content) {
		content = "# Changelog\n\nAll notable changes are documented here.\n";
	}

	ctx.ui.notify("Updating changelog…", "info");

	// Step 1: Reconcile any merged+released branch sections
	content = await reconcileChangelog(pi, content);

	// Step 2: Find existing section body for this branch (for append context)
	const { sections } = parseChangelog(content);
	const existing = sections.find((s) => s.heading === branch);
	const existingBody = existing?.body || null;

	// Step 3: Gather git context
	const changelogCtx = await gatherChangelogContext(pi, branch, defaultBranch, existingBody);
	if (!changelogCtx.commitLog) {
		ctx.ui.notify("No commits on branch — skipping changelog", "info");
		return;
	}

	// Step 4: Generate summary via single Haiku call
	const prompt = buildChangelogPrompt(changelogCtx);
	const summary = await callHaiku(prompt, ctx);
	if (!summary?.trim()) {
		ctx.ui.notify("Could not generate changelog summary", "warning");
		return;
	}

	// Step 5: Splice into file
	content = spliceBranchSection(content, branch, summary.trim());
	writeFileSync(changelogPath(), content, "utf-8");
	ctx.ui.notify("Changelog updated", "info");
}

// ---------------------------------------------------------------------------
// Shared push flow
// ---------------------------------------------------------------------------

/**
 * Push the current branch to origin.
 *
 * Returns `true` on success, `false` on failure (notifications already shown).
 */
async function performPush(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
): Promise<boolean> {
	ctx.ui.notify("Pushing…", "info");
	const branch = await getCurrentBranch(pi);
	const { code, stderr } = await pi.exec("git", [
		"push", "--set-upstream", "origin", branch ?? "HEAD",
	]);
	if (code !== 0) {
		ctx.ui.notify(`Push failed: ${stderr}`, "error");
		return false;
	}
	ctx.ui.notify("Pushed", "info");
	return true;
}

// ---------------------------------------------------------------------------
// Shared PR flow
// ---------------------------------------------------------------------------

/**
 * Ensure a PR exists for the current branch, then update it with
 * AI-generated title and body.
 *
 * Notifications are shown for each step; returns silently on failure.
 */
async function performPr(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	defaultBranch: string,
): Promise<void> {
	let pr = await getExistingPr(pi);
	if (!pr) {
		ctx.ui.notify("Creating PR…", "info");
		const { code, stderr } = await pi.exec("gh", [
			"pr", "create", "--title", "WIP", "--body", "",
		]);
		if (code !== 0) {
			ctx.ui.notify(`Failed to create PR: ${stderr}`, "error");
			return;
		}
		pr = await getExistingPr(pi);
	}
	if (!pr) {
		ctx.ui.notify("Failed to find PR after creation", "error");
		return;
	}

	ctx.ui.notify("Generating PR description…", "info");
	const { commitLog, diffStat, diff } = await gatherPrDiff(pi, defaultBranch);
	const prContent = await generatePrContent(commitLog, diffStat, diff, ctx);

	const { code, stderr } = await pi.exec("gh", [
		"pr", "edit", String(pr.number),
		"--title", prContent.title,
		"--body", prContent.body,
	]);
	if (code !== 0) {
		ctx.ui.notify(`Failed to update PR: ${stderr}`, "error");
		return;
	}
	ctx.ui.notify(`PR updated: ${pr.url}`, "info");
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

/** Registers `/commit`, `/commit-push`, and `/commit-push-pr` commands. */
export default function commitExtension(pi: ExtensionAPI) {
	pi.registerCommand("commit", {
		description:
			"Stage all changes and commit with an AI-generated Conventional Commits message. Creates a side branch if on the default branch.",
		handler: async (_args, ctx) => {
			if (!(await checkPrerequisites(pi, ctx))) return;
			if (!(await hasChanges(pi))) {
				ctx.ui.notify("No changes to commit", "info");
				return;
			}
			await performCommit(pi, ctx);
		},
	});

	pi.registerCommand("commit-push", {
		description:
			"Update changelog, stage, commit, and push. Commits if there are changes, pushes if there are unpushed commits. Auto-creates a side branch when on the default branch.",
		handler: async (_args, ctx) => {
			if (!(await checkPrerequisites(pi, ctx))) return;

			const changes = await hasChanges(pi);
			if (changes) {
				await performChangelog(pi, ctx);
				const result = await performCommit(pi, ctx, { autoBranch: true });
				if (!result) return;
			}

			if (changes || (await hasUnpushedCommits(pi))) {
				await performPush(pi, ctx);
			} else {
				ctx.ui.notify("Nothing to commit or push", "info");
			}
		},
	});

	pi.registerCommand("commit-push-pr", {
		description:
			"Update changelog, stage, commit, push, and create/update a PR — all in one step. Commits if there are changes, always pushes and updates the PR. Auto-creates a side branch when on the default branch.",
		handler: async (_args, ctx) => {
			if (!(await checkPrerequisites(pi, ctx))) return;

			const { code: ghCheck } = await pi.exec("gh", ["auth", "status"]);
			if (ghCheck !== 0) {
				ctx.ui.notify("Not authenticated with gh CLI. Run `gh auth login`.", "error");
				return;
			}

			const changes = await hasChanges(pi);
			if (changes) {
				await performChangelog(pi, ctx);
				const result = await performCommit(pi, ctx, { autoBranch: true });
				if (!result) return;
			}

			const defaultBranch = await getDefaultBranch(pi);

			if (changes || (await hasUnpushedCommits(pi))) {
				if (!(await performPush(pi, ctx))) return;
			}

			await performPr(pi, ctx, defaultBranch);
		},
	});
}
