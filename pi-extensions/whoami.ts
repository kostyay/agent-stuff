/**
 * Whoami Extension
 *
 * Registers a `/whoami` command that prints the API key used for the
 * current model's requests. Masks the middle portion for safety.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

/** Show first and last 12 chars, mask the rest with asterisks. */
function maskKey(key: string): string {
	const VISIBLE = 12;
	if (key.length <= VISIBLE * 2) return key;
	return `${key.slice(0, VISIBLE)}********${key.slice(-VISIBLE)}`;
}

export default function whoamiExtension(pi: ExtensionAPI): void {
	pi.registerCommand("whoami", {
		description: "Print the API key used for model requests",
		handler: async (_args, ctx) => {
			if (!ctx.model) {
				ctx.ui.notify("No model configured.", "warning");
				return;
			}

			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
			if (!auth.ok) {
				ctx.ui.notify(
					`No API key found for ${ctx.model.provider}/${ctx.model.id}.`,
					"warning",
				);
				return;
			}

			const masked = auth.apiKey ? maskKey(auth.apiKey) : "(no key, headers only)";
			ctx.ui.notify(
				`${ctx.model.provider}/${ctx.model.id}: ${masked}`,
				"info",
			);
		},
	});
}
