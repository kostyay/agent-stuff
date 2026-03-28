/**
 * Commit Extension
 *
 * Registers four commands that compose incrementally:
 *   `/commit`          — Stage, generate commit message (+ branch name if needed), commit.
 *   `/commit-push`     — Commit and push. No changelog.
 *   `/commit-push-pr`  — Commit, push, and create/update a PR with AI-generated description.
 *   `/merge-pr`        — Update changelog, update PR description, rebase if needed, merge.
 *
 * Token-optimized: commit message and branch name are generated in a single
 * Haiku call. Changelog is only generated during `/merge-pr`.
 *
 * Uses `complete()` from `@mariozechner/pi-ai` for direct model invocation.
 */

import { complete, getModel } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { timedConfirm } from "../lib/timed-confirm.ts";
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

/** Model used for all text generation (cheap, fast). */
const HAIKU = getModel("anthropic", "claude-haiku-4-5");

/** Maximum diff length sent to the model (chars). */
const MAX_DIFF_LENGTH = 15_000;

/** Fallback commit message when AI generation fails or diff is empty. */
const FALLBACK_COMMIT = "chore: update files";

/** Fallback branch name when AI generation fails or diff is empty. */
const FALLBACK_BRANCH = "feature/auto-branch";

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

/**
 * Combined prompt that generates both a conventional commit message and a
 * branch name in a single model call. Used when on the default branch.
 */
const COMMIT_BRANCH_PROMPT = `You are a git assistant. Given a diff, output a conventional commit message and a branch name.

Output format (exactly two lines):
COMMIT: <type>(<scope>): <summary>
BRANCH: <type>/<short-description>

Commit message rules:
- type REQUIRED: feat, fix, docs, refactor, chore, test, or perf.
- scope OPTIONAL: short noun for the affected area. Omit if changes span many areas.
- summary REQUIRED: imperative mood, lowercase start, ≤72 chars total, no trailing period.
- No breaking-change markers, footers, or sign-offs.
- IGNORE auto-generated files when writing the summary. Lock files (package-lock.json, yarn.lock, pnpm-lock.yaml, go.sum, Cargo.lock), generated code (*.pb.go, *_generated.*, *.gen.*), and build artifacts (dist/, *.min.js, *.min.css) are noise — focus on hand-written changes only.

Branch name rules:
- type REQUIRED: feat, fix, docs, refactor, chore, test, or perf.
- short-description REQUIRED: 2-5 lowercase words joined by dashes.
- Total length ≤60 chars.
- Only lowercase letters, digits, dashes, and one forward slash.

Output the two lines and nothing else.

Diff:
`;

/** Prompt for generating only a commit message (when already on a feature branch). */
const COMMIT_ONLY_PROMPT = `You are a commit-message generator. Given a git diff, output ONLY a single Conventional Commits subject line. No explanation, no body, no markdown fences.

Format: <type>(<scope>): <summary>

Rules:
- type REQUIRED: feat, fix, docs, refactor, chore, test, or perf.
- scope OPTIONAL: short noun for the affected area. Omit if changes span many areas.
- summary REQUIRED: imperative mood, lowercase start, ≤72 chars total, no trailing period.
- No breaking-change markers or footers.
- No sign-offs.
- IGNORE auto-generated files when writing the summary. Lock files (package-lock.json, yarn.lock, pnpm-lock.yaml, go.sum, Cargo.lock), generated code (*.pb.go, *_generated.*, *.gen.*), and build artifacts (dist/, *.min.js, *.min.css) are noise — focus on hand-written changes only.
- Output the subject line and nothing else.

Diff:
`;

/** Prompt for generating a PR title and body. Supports refining an existing description. */
const PR_CONTENT_PROMPT = `You are a pull request writer. Given git context and optionally an existing PR description, generate a PR title and body.

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
- IGNORE auto-generated files entirely. Lock files (package-lock.json, yarn.lock, pnpm-lock.yaml, go.sum, Cargo.lock), generated code (*.pb.go, *_generated.*, *.gen.*), and build artifacts (dist/, *.min.js, *.min.css) are noise — do not mention them

If an existing description is provided, refine and update it rather than writing from scratch. Add new changes, remove outdated items, improve clarity.

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
 * Call Haiku with a single user-message prompt.
 *
 * Returns `undefined` if the model or API key is unavailable.
 */
async function callHaiku(prompt: string, ctx: ExtensionCommandContext): Promise<string | undefined> {
	if (!HAIKU) return undefined;

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(HAIKU);
	if (!auth.ok) return undefined;

	const response = await complete(HAIKU, {
		messages: [{
			role: "user" as const,
			content: [{ type: "text" as const, text: prompt }],
			timestamp: Date.now(),
		}],
	}, { apiKey: auth.apiKey, headers: auth.headers });

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
// AI generation — commit message + branch name
// ---------------------------------------------------------------------------

/** Parsed result from the combined commit+branch Haiku call. */
interface CommitAndBranch {
	commitMessage: string;
	branchName: string;
}

/** Parse the combined `COMMIT: … / BRANCH: …` response from Haiku. */
function parseCommitAndBranch(raw: string): CommitAndBranch {
	const commitMatch = raw.match(/^COMMIT:\s*(.+)$/m);
	const branchMatch = raw.match(/^BRANCH:\s*(.+)$/m);

	const commitMessage = commitMatch
		? cleanFirstLine(commitMatch[1])
		: FALLBACK_COMMIT;

	const branchName = branchMatch
		? cleanFirstLine(branchMatch[1])
			.toLowerCase()
			.replace(/[^a-z0-9/-]/g, "-")
			.replace(/-+/g, "-")
			.replace(/-$/, "")
		: FALLBACK_BRANCH;

	return {
		commitMessage: commitMessage || FALLBACK_COMMIT,
		branchName: branchName || FALLBACK_BRANCH,
	};
}

/**
 * Generate commit message and branch name in a single Haiku call.
 * Used when on the default branch and a side branch must be created.
 */
async function generateCommitAndBranch(
	diff: string,
	ctx: ExtensionCommandContext,
): Promise<CommitAndBranch> {
	const fallback: CommitAndBranch = { commitMessage: FALLBACK_COMMIT, branchName: FALLBACK_BRANCH };
	if (!diff) return fallback;

	const raw = await callHaiku(COMMIT_BRANCH_PROMPT + truncateDiff(diff), ctx);
	return raw ? parseCommitAndBranch(raw) : fallback;
}

/**
 * Generate only a commit message (when already on a feature branch).
 * Falls back to "chore: update files".
 */
async function generateCommitMessage(
	diff: string,
	ctx: ExtensionCommandContext,
): Promise<string> {
	if (!diff) return FALLBACK_COMMIT;
	const raw = await callHaiku(COMMIT_ONLY_PROMPT + truncateDiff(diff), ctx);
	return (raw && cleanFirstLine(raw)) || FALLBACK_COMMIT;
}

// ---------------------------------------------------------------------------
// AI generation — PR content
// ---------------------------------------------------------------------------

/** Parsed PR title and body. */
interface PrContent {
	title: string;
	body: string;
}

/** Parse the `TITLE: … / BODY: …` format returned by Haiku. */
function parsePrContent(raw: string): PrContent {
	const title = raw.match(/^TITLE:\s*(.+)$/m)?.[1]?.trim() || "chore: update";
	const body = raw.match(/^BODY:\s*\n?([\s\S]*)$/m)?.[1]?.trim() || "";
	return { title, body };
}

/**
 * Generate PR title and body from commit log, diff stat, and diff.
 * When `existing` is provided, the model refines the description instead of
 * generating from scratch.
 */
async function generatePrContent(
	commitLog: string,
	diffStat: string,
	diff: string,
	ctx: ExtensionCommandContext,
	existing?: { title: string; body: string },
): Promise<PrContent> {
	const existingSection = existing
		? `Existing PR title: ${existing.title}\nExisting PR body:\n${existing.body || "(empty)"}`
		: "Existing PR: none (new PR)";

	const prompt =
		PR_CONTENT_PROMPT +
		`${existingSection}\n\nCommit log:\n${commitLog}\n\nDiff stat:\n${diffStat}\n\nDiff:\n${truncateDiff(diff)}`;

	const raw = await callHaiku(prompt, ctx);
	return raw ? parsePrContent(raw) : { title: "chore: update", body: "" };
}

// ---------------------------------------------------------------------------
// PR helpers
// ---------------------------------------------------------------------------

/** Full PR info returned by `gh pr view`. */
interface PrInfo {
	number: number;
	url: string;
	title: string;
	body: string;
	isDraft: boolean;
}

/** Return the existing PR for the current branch, or null. */
async function getExistingPr(pi: ExtensionAPI): Promise<PrInfo | null> {
	const { stdout, code } = await pi.exec("gh", [
		"pr", "view", "--json", "number,url,title,body,isDraft",
	]);
	if (code !== 0) return null;
	try {
		return JSON.parse(stdout.trim()) as PrInfo;
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
// Pre-flight checks
// ---------------------------------------------------------------------------

/**
 * Validate git repo and Haiku model availability.
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
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(HAIKU);
	if (!auth.ok) {
		ctx.ui.notify("No API key for anthropic/claude-haiku-4-5", "error");
		return false;
	}
	return true;
}

/** Validate GitHub CLI authentication. */
async function checkGhAuth(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<boolean> {
	const { code } = await pi.exec("gh", ["auth", "status"]);
	if (code !== 0) {
		ctx.ui.notify("Not authenticated with gh CLI. Run `gh auth login`.", "error");
		return false;
	}
	return true;
}

// ---------------------------------------------------------------------------
// Commit flow
// ---------------------------------------------------------------------------

/** Options for the commit flow. */
interface CommitOptions {
	/** When true, auto-create a side branch without prompting the user. */
	autoBranch?: boolean;
}

/**
 * The full stage → generate → branch → commit flow shared by `/commit`,
 * `/commit-push`, and `/commit-push-pr`.
 *
 * Makes exactly **one** Haiku call: either for commit message only (feature
 * branch) or for commit message + branch name combined (default branch).
 *
 * Returns the commit message and default branch on success, or `null` if
 * the flow was cancelled or failed (notifications are already shown).
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

	// Single Haiku call: commit message (+ branch name when on default branch)
	let commitMessage: string;
	let branchName: string | undefined;

	if (onDefaultBranch) {
		const result = await generateCommitAndBranch(diffContent, ctx);
		commitMessage = result.commitMessage;
		branchName = result.branchName;
	} else {
		commitMessage = await generateCommitMessage(diffContent, ctx);
	}

	// Create side branch if on default branch
	if (onDefaultBranch) {
		const suggestion = branchName ?? "feature/auto-branch";

		if (options.autoBranch || !ctx.hasUI) {
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
// Push flow
// ---------------------------------------------------------------------------

/**
 * Push the current branch to origin.
 *
 * When a normal push is rejected (e.g. after a rebase), prompts the user
 * to force-push with `--force-with-lease`. Returns `true` on success,
 * `false` on failure or cancellation (notifications already shown).
 */
async function performPush(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
): Promise<boolean> {
	ctx.ui.notify("Pushing…", "info");
	const branch = await getCurrentBranch(pi);
	const ref = branch ?? "HEAD";

	const { code, stderr } = await pi.exec("git", [
		"push", "--set-upstream", "origin", ref,
	]);

	if (code === 0) {
		ctx.ui.notify("Pushed", "info");
		return true;
	}

	// Check if the failure is a non-fast-forward rejection
	const isRejected = /rejected|non-fast-forward|failed to push/i.test(stderr);
	if (!isRejected || !ctx.hasUI) {
		ctx.ui.notify(`Push failed: ${stderr}`, "error");
		return false;
	}

	const forcePush = await ctx.ui.confirm(
		"Push rejected (history has diverged)",
		"Force push with --force-with-lease?",
	);
	if (!forcePush) {
		ctx.ui.notify("Push cancelled", "info");
		return false;
	}

	const { code: forceCode, stderr: forceErr } = await pi.exec("git", [
		"push", "--force-with-lease", "--set-upstream", "origin", ref,
	]);
	if (forceCode !== 0) {
		ctx.ui.notify(`Force push failed: ${forceErr}`, "error");
		return false;
	}
	ctx.ui.notify("Force pushed", "info");
	return true;
}

// ---------------------------------------------------------------------------
// PR flow (create/update)
// ---------------------------------------------------------------------------

/**
 * Ensure a PR exists for the current branch, then update it with
 * an AI-generated title and body (aware of existing description).
 *
 * Returns the PR info on success, or `null` on failure.
 */
async function performPr(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	defaultBranch: string,
): Promise<PrInfo | null> {
	const branch = await getCurrentBranch(pi);
	let pr = await getExistingPr(pi);
	if (!pr) {
		ctx.ui.notify("Creating PR…", "info");
		const createArgs = ["pr", "create", "--title", "WIP", "--body", ""];
		if (branch) {
			createArgs.push("--head", branch);
		}
		const { code, stderr } = await pi.exec("gh", createArgs);
		if (code !== 0) {
			ctx.ui.notify(`Failed to create PR: ${stderr}`, "error");
			return null;
		}
		pr = await getExistingPr(pi);
	}
	if (!pr) {
		ctx.ui.notify("Failed to find PR after creation", "error");
		return null;
	}

	ctx.ui.notify("Generating PR description…", "info");
	const { commitLog, diffStat, diff } = await gatherPrDiff(pi, defaultBranch);
	const prContent = await generatePrContent(
		commitLog, diffStat, diff, ctx,
		{ title: pr.title, body: pr.body },
	);

	const { code, stderr } = await pi.exec("gh", [
		"pr", "edit", String(pr.number),
		"--title", prContent.title,
		"--body", prContent.body,
	]);
	if (code !== 0) {
		ctx.ui.notify(`Failed to update PR: ${stderr}`, "error");
		return null;
	}
	ctx.ui.notify(`PR updated: ${pr.url}`, "info");
	return pr;
}

// ---------------------------------------------------------------------------
// Changelog flow (used only by /merge-pr)
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
 * via a single Haiku call (using kchangelog-style rules), and splice the
 * result into CHANGELOG.md programmatically.
 *
 * Returns `true` if the changelog was modified, `false` otherwise.
 */
async function performChangelog(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
): Promise<boolean> {
	const branch = await getCurrentBranch(pi);
	if (!branch) {
		ctx.ui.notify("Detached HEAD — skipping changelog update", "warning");
		return false;
	}

	const defaultBranch = await getDefaultBranch(pi);
	if (branch === defaultBranch) {
		ctx.ui.notify("On default branch — skipping changelog update", "info");
		return false;
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
		return false;
	}

	// Step 4: Generate summary via single Haiku call (kchangelog rules baked into prompt)
	const prompt = buildChangelogPrompt(changelogCtx);
	const summary = await callHaiku(prompt, ctx);
	if (!summary?.trim()) {
		ctx.ui.notify("Could not generate changelog summary", "warning");
		return false;
	}

	// Step 5: Splice into file
	content = spliceBranchSection(content, branch, summary.trim());
	writeFileSync(changelogPath(), content, "utf-8");
	ctx.ui.notify("Changelog updated", "info");
	return true;
}

// ---------------------------------------------------------------------------
// Merge flow helpers (used only by /merge-pr)
// ---------------------------------------------------------------------------

/** Detect the repo's preferred merge method via GitHub API. */
async function detectMergeMethod(pi: ExtensionAPI): Promise<string> {
	const { stdout, code } = await pi.exec("gh", [
		"api", "repos/{owner}/{repo}",
		"--jq", "[.allow_squash_merge, .allow_merge_commit, .allow_rebase_merge]",
	]);
	if (code === 0) {
		try {
			const [squash, merge, rebase] = JSON.parse(stdout.trim()) as [boolean, boolean, boolean];
			if (squash) return "--squash";
			if (merge) return "--merge";
			if (rebase) return "--rebase";
		} catch {
			// Fall through to default
		}
	}
	return "--merge";
}

/**
 * Attempt to merge a PR, handling branch protection failures.
 *
 * On a "policy prohibits the merge" error, offers the user two recovery
 * paths in sequence:
 * 1. `--admin` — use administrator privileges to merge immediately
 * 2. `--auto` — queue the PR to merge when all requirements are met
 *
 * Both options are always offered; `gh` enforces actual permissions.
 *
 * Returns `true` if the merge succeeded (or auto-merge was enabled).
 */
async function performMerge(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	prNumber: number,
	mergeMethod: string,
): Promise<boolean> {
	ctx.ui.notify("Merging…", "info");
	const { code, stderr } = await pi.exec("gh", [
		"pr", "merge", String(prNumber), mergeMethod,
	]);

	if (code === 0) return true;

	const isPolicyBlock = /policy prohibits the merge|not mergeable/i.test(stderr);
	if (!isPolicyBlock || !ctx.hasUI) {
		ctx.ui.notify(`Merge failed: ${stderr}`, "error");
		return false;
	}

	// Branch protection is blocking — offer admin override first
	const useAdmin = await ctx.ui.confirm(
		"Branch protection blocks merge",
		"Use admin override to merge immediately?",
	);
	if (useAdmin) {
		ctx.ui.notify("Merging with admin override…", "info");
		const { code: adminCode, stderr: adminErr } = await pi.exec("gh", [
			"pr", "merge", String(prNumber), mergeMethod, "--admin",
		]);
		if (adminCode === 0) return true;
		ctx.ui.notify(`Admin merge failed: ${adminErr}`, "error");
		return false;
	}

	// Offer --auto as fallback
	const useAuto = await ctx.ui.confirm(
		"Auto-merge instead?",
		"Enable auto-merge? (PR merges automatically when requirements are met)",
	);
	if (useAuto) {
		ctx.ui.notify("Enabling auto-merge…", "info");
		const { code: autoCode, stderr: autoErr } = await pi.exec("gh", [
			"pr", "merge", String(prNumber), mergeMethod, "--auto",
		]);
		if (autoCode === 0) {
			ctx.ui.notify(`Auto-merge enabled for PR #${prNumber}`, "info");
			return true;
		}
		ctx.ui.notify(`Failed to enable auto-merge: ${autoErr}`, "error");
		return false;
	}

	ctx.ui.notify("Merge cancelled", "info");
	return false;
}

/**
 * Attempt to rebase the current branch onto the default branch.
 *
 * If the rebase is clean, force-pushes the result. If there are merge
 * conflicts, aborts the rebase and directs the user to `/git-rebase-master`.
 *
 * Returns `true` if the rebase (and push) succeeded, `false` otherwise.
 */
async function performRebase(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	defaultBranch: string,
): Promise<boolean> {
	ctx.ui.notify(`Fetching origin/${defaultBranch}…`, "info");
	const { code: fetchCode, stderr: fetchErr } = await pi.exec("git", [
		"fetch", "origin", defaultBranch,
	]);
	if (fetchCode !== 0) {
		ctx.ui.notify(`Failed to fetch: ${fetchErr}`, "error");
		return false;
	}

	ctx.ui.notify(`Rebasing onto origin/${defaultBranch}…`, "info");
	const { code: rebaseCode, stderr: rebaseErr } = await pi.exec("git", [
		"rebase", `origin/${defaultBranch}`,
	]);

	if (rebaseCode === 0) {
		// Clean rebase — force push
		const { code: pushCode, stderr: pushErr } = await pi.exec("git", [
			"push", "--force-with-lease",
		]);
		if (pushCode !== 0) {
			ctx.ui.notify(`Force push failed after rebase: ${pushErr}`, "error");
			return false;
		}
		ctx.ui.notify("Rebased and pushed", "info");
		return true;
	}

	// Check if failure is due to merge conflicts
	const { stdout: conflictFiles } = await pi.exec("git", [
		"diff", "--name-only", "--diff-filter=U",
	]);
	await pi.exec("git", ["rebase", "--abort"]);

	if (conflictFiles.trim()) {
		ctx.ui.notify(
			"Merge conflicts detected. Run /git-rebase-master to resolve, then re-run /merge-pr.",
			"error",
		);
	} else {
		ctx.ui.notify(`Rebase failed: ${rebaseErr}`, "error");
	}
	return false;
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

/** Registers `/commit`, `/commit-push`, `/commit-push-pr`, and `/merge-pr` commands. */
export default function commitExtension(pi: ExtensionAPI) {
	pi.registerCommand("commit", {
		description:
			"Stage all changes and commit with an AI-generated message. Creates a side branch if on the default branch.",
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
			"Stage, commit, and push. Auto-creates a side branch when on the default branch.",
		handler: async (_args, ctx) => {
			if (!(await checkPrerequisites(pi, ctx))) return;

			const changes = await hasChanges(pi);
			if (changes) {
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
			"Stage, commit, push, and create/update a PR — all in one step. Generates an AI-powered PR description.",
		handler: async (_args, ctx) => {
			if (!(await checkPrerequisites(pi, ctx))) return;
			if (!(await checkGhAuth(pi, ctx))) return;

			const changes = await hasChanges(pi);
			if (changes) {
				const result = await performCommit(pi, ctx, { autoBranch: true });
				if (!result) return;
			}

			const defaultBranch = await getDefaultBranch(pi);

			// Always push before PR creation to ensure the remote branch exists.
			// Handles stale upstream refs (e.g. remote branch deleted after a
			// previous PR merge) where hasUnpushedCommits() incorrectly returns
			// false. The push is idempotent — a no-op when already up-to-date.
			if (!(await performPush(pi, ctx))) return;

			await performPr(pi, ctx, defaultBranch);
		},
	});

	pi.registerCommand("merge-pr", {
		description:
			"Update changelog, update PR description, rebase if needed, confirm, and merge the PR.",
		handler: async (_args, ctx) => {
			if (!(await checkPrerequisites(pi, ctx))) return;
			if (!(await checkGhAuth(pi, ctx))) return;

			const currentBranch = await getCurrentBranch(pi);
			const defaultBranch = await getDefaultBranch(pi);

			if (!currentBranch || currentBranch === defaultBranch) {
				ctx.ui.notify("Must be on a feature branch to merge a PR", "error");
				return;
			}

			if (await hasChanges(pi)) {
				ctx.ui.notify("Uncommitted changes detected. Run /commit-push first.", "error");
				return;
			}

			// Ensure PR exists
			let pr = await getExistingPr(pi);
			if (!pr) {
				ctx.ui.notify("No PR found for this branch. Run /commit-push-pr first.", "error");
				return;
			}

			// Step 1: Update changelog via Haiku (kchangelog rules)
			const changelogUpdated = await performChangelog(pi, ctx);

			// Step 2: Commit + push changelog if it changed
			if (changelogUpdated) {
				const { code: addCode } = await pi.exec("git", ["add", "CHANGELOG.md"]);
				if (addCode === 0) {
					const { code: commitCode } = await pi.exec("git", [
						"commit", "-m", "docs: update changelog",
					]);
					if (commitCode === 0) {
						if (!(await performPush(pi, ctx))) return;
					}
				}
			}

			// Step 3: Update PR description (aware of existing)
			pr = await getExistingPr(pi);
			if (!pr) {
				ctx.ui.notify("Lost PR reference", "error");
				return;
			}

			ctx.ui.notify("Updating PR description…", "info");
			const { commitLog, diffStat, diff } = await gatherPrDiff(pi, defaultBranch);
			const prContent = await generatePrContent(
				commitLog, diffStat, diff, ctx,
				{ title: pr.title, body: pr.body },
			);

			const { code: editCode, stderr: editErr } = await pi.exec("gh", [
				"pr", "edit", String(pr.number),
				"--title", prContent.title,
				"--body", prContent.body,
			]);
			if (editCode !== 0) {
				ctx.ui.notify(`Failed to update PR: ${editErr}`, "error");
				return;
			}
			ctx.ui.notify("PR description updated", "info");

			// Step 4: Undraft if needed
			if (pr.isDraft) {
				ctx.ui.notify("Marking PR as ready for review…", "info");
				const { code, stderr } = await pi.exec("gh", [
					"pr", "ready", String(pr.number),
				]);
				if (code !== 0) {
					ctx.ui.notify(`Failed to mark PR as ready: ${stderr}`, "error");
					return;
				}
			}

			// Step 5: Check mergeability and rebase if needed
			const { stdout: mergeStateRaw } = await pi.exec("gh", [
				"pr", "view", String(pr.number), "--json", "mergeStateStatus",
				"--jq", ".mergeStateStatus",
			]);
			const mergeState = mergeStateRaw.trim();

			if (mergeState === "BEHIND" || mergeState === "DIRTY") {
				if (!(await performRebase(pi, ctx, defaultBranch))) return;
			}

			// Step 6: Confirm with user (auto-confirms after 5s)
			const confirmed = await timedConfirm(ctx, {
				title: "Merge PR",
				message: `Merge PR #${pr.number} into ${defaultBranch}?`,
			});
			if (!confirmed) {
				ctx.ui.notify("Merge cancelled", "info");
				return;
			}

			// Step 7: Merge (using repo's preferred merge strategy)
			const mergeMethod = await detectMergeMethod(pi);
			const merged = await performMerge(pi, ctx, pr.number, mergeMethod);
			if (!merged) return;
			ctx.ui.notify(`PR #${pr.number} merged`, "info");

			// Step 8: Checkout default branch and pull
			await pi.exec("git", ["checkout", defaultBranch]);
			await pi.exec("git", ["pull"]);
			ctx.ui.notify(`Checked out ${defaultBranch}`, "info");
		},
	});
}
