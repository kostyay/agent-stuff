/**
 * Prompt Stash Extension
 *
 * `/stash` stashes the current editor draft so you can fire off a quick question.
 * The stashed prompt auto-restores after the agent finishes responding.
 *
 * Behavior:
 * - `/stash` with text in editor → stash it, clear editor
 * - `/stash` with empty editor + stash exists → pop stash back into editor
 * - After agent_end → auto-restore stashed text into editor
 *
 * Persistence:
 * - Stash survives session switches and restarts.
 * - Stored per-workspace in $PI_CODING_AGENT_DIR/stash/<encoded-cwd>.txt
 *
 * Shows a widget above the editor with a truncated preview of the stashed text.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const WIDGET_ID = "stash";
const MAX_PREVIEW_LENGTH = 60;
const STASH_DIR = join(process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? "", ".pi", "agent"), "stash");

/**
 * Build the file path for a workspace's stash file.
 * Uses encodeURIComponent on the cwd to produce a safe filename.
 */
function stashFilePath(cwd: string): string {
	return join(STASH_DIR, `${encodeURIComponent(cwd)}.txt`);
}

/** Read stash from disk for the given workspace. Returns null if none exists. */
function loadStash(cwd: string): string | null {
	const path = stashFilePath(cwd);
	if (!existsSync(path)) {
		return null;
	}
	const text = readFileSync(path, "utf-8");
	return text.length > 0 ? text : null;
}

/** Write stash to disk for the given workspace. */
function saveStash(cwd: string, text: string): void {
	mkdirSync(STASH_DIR, { recursive: true });
	writeFileSync(stashFilePath(cwd), text, "utf-8");
}

/** Delete stash file for the given workspace. */
function deleteStash(cwd: string): void {
	const path = stashFilePath(cwd);
	if (existsSync(path)) {
		rmSync(path);
	}
}

/** Collapse whitespace and truncate text to a single-line preview. */
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

	/** Clear the in-memory stash, remove the widget, and delete the file. */
	function clearStash(ctx: ExtensionContext): void {
		stashedText = null;
		ctx.ui.setWidget(WIDGET_ID, undefined);
		deleteStash(ctx.cwd);
	}

	/** Restore stashed text into the editor, then clear the stash. */
	function restoreStash(ctx: ExtensionContext): void {
		if (!stashedText) {
			return;
		}
		ctx.ui.setEditorText(stashedText);
		clearStash(ctx);
	}

	// session_start fires for every replacement reason in pi 0.65+
	// (startup/reload/new/resume/fork).
	pi.on("session_start", async (_event, ctx) => {
		stashedText = loadStash(ctx.cwd);
		if (stashedText && ctx.hasUI) {
			showWidget(ctx);
		}
	});

	pi.registerCommand("stash", {
		description: "Stash or unstash editor draft",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				return;
			}

			const rawText = ctx.ui.getEditorText() ?? "";

			if (rawText.trim().length > 0) {
				stashedText = rawText;
				saveStash(ctx.cwd, rawText);
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
}
