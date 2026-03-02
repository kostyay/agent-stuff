/**
 * Git Rebase Master Extension
 *
 * Registers a `/git-rebase-master` command that fetches the latest main/master
 * from origin and rebases the current branch onto it. When conflicts arise,
 * the LLM resolves them automatically via a user message prompt.
 *
 * Auto-detects whether the remote uses `main` or `master`.
 * Guards against running when already on the default branch.
 * Shows a confirmation with branch info and commit count before proceeding.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

/** Detect the default branch name from the remote (main or master). */
async function detectDefaultBranch(pi: ExtensionAPI): Promise<string | null> {
	// Try symbolic-ref first (most reliable)
	const { stdout: symRef, code: symCode } = await pi.exec("git", [
		"symbolic-ref",
		"refs/remotes/origin/HEAD",
		"--short",
	]);
	const trimmedSymRef = symRef.trim();
	if (symCode === 0 && trimmedSymRef) {
		return trimmedSymRef.replace("origin/", "");
	}

	// Fall back: check which of main/master exists on the remote
	const { code: mainCode } = await pi.exec("git", [
		"rev-parse",
		"--verify",
		"origin/main",
	]);
	if (mainCode === 0) return "main";

	const { code: masterCode } = await pi.exec("git", [
		"rev-parse",
		"--verify",
		"origin/master",
	]);
	if (masterCode === 0) return "master";

	return null;
}

/** Get the current branch name, or null if in detached HEAD. */
async function getCurrentBranch(pi: ExtensionAPI): Promise<string | null> {
	const { stdout, code } = await pi.exec("git", ["branch", "--show-current"]);
	const branch = stdout.trim();
	if (code === 0 && branch) return branch;
	return null;
}

/** Count how many commits the current branch is ahead of a given base ref. */
async function countCommitsAhead(pi: ExtensionAPI, baseRef: string): Promise<number> {
	const { stdout, code } = await pi.exec("git", [
		"rev-list",
		"--count",
		`${baseRef}..HEAD`,
	]);
	if (code === 0) {
		return parseInt(stdout.trim(), 10) || 0;
	}
	return 0;
}

/** List files with rebase conflicts. */
async function getConflictedFiles(pi: ExtensionAPI): Promise<string[]> {
	const { stdout, code } = await pi.exec("git", ["diff", "--name-only", "--diff-filter=U"]);
	const output = stdout.trim();
	if (code !== 0 || !output) return [];
	return output.split("\n").filter((f) => f.trim());
}

/** Build a prompt that asks the LLM to resolve rebase conflicts. */
function buildConflictResolutionPrompt(
	defaultBranch: string,
	conflictedFiles: string[],
): string {
	const fileList = conflictedFiles.map((f) => `  - ${f}`).join("\n");
	return `A git rebase onto origin/${defaultBranch} has hit merge conflicts in the following files:

${fileList}

Please resolve all conflicts in these files:
1. Read each conflicted file
2. Resolve the conflict markers (<<<<<<< / ======= / >>>>>>>) by choosing the correct merged code
3. Write the resolved file using the write or edit tool
4. Stage each resolved file with \`git add <file>\`
5. After ALL files are resolved and staged, run \`git -c core.editor=true rebase --continue\`
6. If additional conflicts arise after continuing, repeat the process

Important:
- Do NOT run \`git rebase --abort\`
- Preserve the intent of both sides when merging
- If a conflict is genuinely ambiguous, prefer the changes from the current branch (ours)`;
}

export default function gitRebaseMasterExtension(pi: ExtensionAPI) {
	pi.registerCommand("git-rebase-master", {
		description: "Fetch and rebase the current branch onto origin's main/master",
		handler: async (_args, ctx) => {
			const { code: gitCheck } = await pi.exec("git", ["rev-parse", "--git-dir"]);
			if (gitCheck !== 0) {
				ctx.ui.notify("Not a git repository.", "error");
				return;
			}

			const defaultBranch = await detectDefaultBranch(pi);
			if (!defaultBranch) {
				ctx.ui.notify(
					"Could not detect default branch. Make sure origin/main or origin/master exists.",
					"error",
				);
				return;
			}

			const currentBranch = await getCurrentBranch(pi);
			if (!currentBranch) {
				ctx.ui.notify("Detached HEAD state — nothing to rebase.", "warning");
				return;
			}

			if (currentBranch === defaultBranch) {
				ctx.ui.notify(`Already on ${defaultBranch}, nothing to rebase.`, "warning");
				return;
			}

			ctx.ui.notify(`Fetching origin/${defaultBranch}...`, "info");
			const { code: fetchCode, stderr: fetchErr } = await pi.exec("git", [
				"fetch",
				"origin",
				defaultBranch,
			]);
			if (fetchCode !== 0) {
				ctx.ui.notify(`Failed to fetch: ${fetchErr}`, "error");
				return;
			}

			const commitCount = await countCommitsAhead(pi, `origin/${defaultBranch}`);
			const confirmed = await ctx.ui.confirm(
				"Git Rebase",
				`Rebase ${currentBranch} (${commitCount} commit${commitCount !== 1 ? "s" : ""}) onto origin/${defaultBranch}?`,
			);
			if (!confirmed) {
				ctx.ui.notify("Rebase cancelled.", "info");
				return;
			}

			ctx.ui.notify(`Rebasing ${currentBranch} onto origin/${defaultBranch}...`, "info");
			const { code: rebaseCode, stderr: rebaseErr } = await pi.exec("git", [
				"rebase",
				`origin/${defaultBranch}`,
			]);

			if (rebaseCode === 0) {
				ctx.ui.notify("Rebase completed successfully — no conflicts.", "info");
				return;
			}

			const conflictedFiles = await getConflictedFiles(pi);
			if (conflictedFiles.length === 0) {
				// Rebase failed for a non-conflict reason
				ctx.ui.notify(`Rebase failed: ${rebaseErr}`, "error");
				await pi.exec("git", ["rebase", "--abort"]);
				return;
			}

			ctx.ui.notify(
				`Rebase conflicts in ${conflictedFiles.length} file${conflictedFiles.length !== 1 ? "s" : ""}. Asking LLM to resolve...`,
				"warning",
			);

			const prompt = buildConflictResolutionPrompt(defaultBranch, conflictedFiles);
			pi.sendUserMessage(prompt);
		},
	});
}
