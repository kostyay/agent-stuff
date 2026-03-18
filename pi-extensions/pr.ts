/**
 * PR Extension
 *
 * Registers a `/pr` command that checks if the current branch has an
 * open pull request and opens it in the default browser.
 */

import { execSync } from "node:child_process";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

/** Run a shell command and return trimmed stdout, or null on failure. */
function run(cmd: string): string | null {
	try {
		return execSync(cmd, { encoding: "utf-8", timeout: 10_000 }).trim();
	} catch {
		return null;
	}
}

export default function prExtension(pi: ExtensionAPI): void {
	pi.registerCommand("pr", {
		description: "Open the PR for the current branch in the browser",
		handler: async (_args, ctx) => {
			const branch = run("git rev-parse --abbrev-ref HEAD");
			if (!branch) {
				ctx.ui.notify("Not inside a git repository.", "error");
				return;
			}

			if (branch === "main" || branch === "master") {
				ctx.ui.notify(`On ${branch} — no PR to open.`, "warning");
				return;
			}

			const prUrl = run(
				`gh pr view "${branch}" --json url --jq .url 2>/dev/null`,
			);

			if (!prUrl) {
				ctx.ui.notify(
					`No open PR found for branch "${branch}".`,
					"warning",
				);
				return;
			}

			run(`open "${prUrl}"`);
			ctx.ui.notify(`Opened PR: ${prUrl}`, "info");
		},
	});
}
