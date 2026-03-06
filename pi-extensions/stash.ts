/**
 * Prompt Stash Extension
 *
 * Ctrl+Shift+S stashes the current editor draft so you can fire off a quick question.
 * The stashed prompt auto-restores after the agent finishes responding.
 *
 * Behavior:
 * - Ctrl+Shift+S with text in editor → stash it, clear editor
 * - Ctrl+Shift+S with empty editor + stash exists → pop stash back into editor
 * - After agent_end → auto-restore stashed text into editor
 * - New/switched session → clears stash
 *
 * Shows a widget above the editor with a truncated preview of the stashed text.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const WIDGET_ID = "stash";
const MAX_PREVIEW_LENGTH = 60;

/**
 * Collapse whitespace and truncate text to a single-line preview.
 */
function truncatePreview(text: string, maxLength: number): string {
	const collapsed = text.replace(/\s+/g, " ").trim();
	if (collapsed.length <= maxLength) {
		return collapsed;
	}
	return `${collapsed.slice(0, maxLength - 1)}…`;
}

export default function stashExtension(pi: ExtensionAPI): void {
	let stashedText: string | null = null;

	/** Show the stash preview widget above the editor. */
	function showWidget(ctx: ExtensionContext): void {
		if (!stashedText) {
			return;
		}
		const preview = truncatePreview(stashedText, MAX_PREVIEW_LENGTH);
		ctx.ui.setWidget(WIDGET_ID, (_tui, theme) => ({
			render: () => [
				`${theme.fg("warning", "📌 Stashed:")} ${theme.fg("muted", theme.italic(`"${preview}"`))}`,
			],
			invalidate: () => {},
		}));
	}

	/** Clear the stash and remove the widget. */
	function clearStash(ctx: ExtensionContext): void {
		stashedText = null;
		ctx.ui.setWidget(WIDGET_ID, undefined);
	}

	/** Restore stashed text into the editor, then clear the stash. */
	function restoreStash(ctx: ExtensionContext): void {
		if (!stashedText) {
			return;
		}
		ctx.ui.setEditorText(stashedText);
		clearStash(ctx);
	}

	pi.registerShortcut("ctrl+shift+s", {
		description: "Stash or unstash editor draft",
		handler: async (ctx) => {
			if (!ctx.hasUI) {
				return;
			}

			const rawText = ctx.ui.getEditorText() ?? "";

			if (rawText.trim().length > 0) {
				stashedText = rawText;
				ctx.ui.setEditorText("");
				showWidget(ctx);
				ctx.ui.notify("Draft stashed", "info");
			} else if (stashedText) {
				restoreStash(ctx);
				ctx.ui.notify("Draft restored", "info");
			}
		},
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (!stashedText || !ctx.hasUI) {
			return;
		}
		restoreStash(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		clearStash(ctx);
	});
}
