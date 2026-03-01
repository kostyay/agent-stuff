/**
 * Clear Extension
 *
 * Registers a `/clear` command that starts a new session, matching
 * the muscle-memory alias from Claude Code.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function clearExtension(pi: ExtensionAPI) {
	pi.registerCommand("clear", {
		description: "Start a new session (alias for /new)",
		handler: async (_args, ctx) => {
			await ctx.newSession();
		},
	});
}
