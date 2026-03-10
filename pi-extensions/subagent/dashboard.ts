/**
 * Dashboard card rendering for the subagent live progress widget.
 *
 * Renders agent status cards with context window bars, elapsed time,
 * tool counts, and model info.
 */

import type { ThemeColor } from "@mariozechner/pi-coding-agent";
import { expandTabs, formatTokens, truncate } from "./formatting.js";
import { agentColor } from "./tui-helpers.js";
import type { RunState } from "./types.js";

/** Keyword → context window size mapping for known model families. */
const CONTEXT_WINDOW_MAP: [string, number][] = [
	["claude", 200_000],
	["gpt-4o", 128_000],
	["gpt-4-turbo", 128_000],
	["o1", 200_000],
	["o3", 200_000],
	["o4", 200_000],
	["gemini", 1_000_000],
	["deepseek", 128_000],
];

/**
 * Estimate the context window size from a model name.
 * Returns null if the model is unrecognized.
 */
export function estimateContextWindow(model: string | undefined): number | null {
	if (!model) return null;
	const m = model.toLowerCase();
	return CONTEXT_WINDOW_MAP.find(([key]) => m.includes(key))?.[1] ?? null;
}

/** Render a single agent card for the dashboard widget. */
export function renderCard(
	state: RunState,
	colWidth: number,
	theme: { fg: (c: ThemeColor, t: string) => string; bold: (t: string) => string },
	displayIndex: number,
): string[] {
	const w = colWidth - 2;
	const color = agentColor(displayIndex);
	const statusColor = state.status === "running" ? color
		: state.status === "done" ? "success"
		: state.status === "aborted" ? "warning" : "error";
	const statusIcon = state.status === "running" ? "●"
		: state.status === "done" ? "✓"
		: state.status === "aborted" ? "⊘" : "✗";

	const indexTag = `${displayIndex} `;
	const indexStr = theme.fg(color, indexTag);
	const indexVis = indexTag.length;
	const nameMaxW = Math.min(w - 2 - indexVis, 16);
	const name = truncate(state.agent, nameMaxW);
	const nameStr = theme.fg(color, theme.bold(name));
	const modelRaw = state.model ?? "";
	const modelShort = modelRaw.includes("/") ? modelRaw.split("/").pop() ?? modelRaw : modelRaw;
	const modelTrunc = modelShort ? truncate(modelShort, Math.max(0, w - 2 - indexVis - name.length)) : "";
	const modelStr = modelTrunc ? " " + theme.fg("dim", modelTrunc) : "";
	const nameVis = indexVis + name.length + (modelTrunc ? 1 + modelTrunc.length : 0);

	const elapsed = `${Math.round(state.progress.elapsed / 1000)}s`;
	const tools = `T:${state.progress.toolCount}`;
	const stepLabel = state.step ? `#${state.step} ` : "";
	const statusStr = `${statusIcon} ${stepLabel}${state.status} ${elapsed} ${tools}`;
	const statusLine = theme.fg(statusColor, statusStr);
	const statusVis = statusStr.length;

	// Context bar: 5 segments, each = 20%
	const ctxTokens = state.progress.contextTokens;
	const ctxWindow = estimateContextWindow(state.model);
	let ctxStr: string;
	if (ctxWindow && ctxTokens > 0) {
		const pct = Math.min(100, Math.round((ctxTokens / ctxWindow) * 100));
		const filled = Math.ceil(pct / 20);
		const bar = "#".repeat(filled) + "-".repeat(5 - filled);
		ctxStr = `[${bar}] ${pct}%`;
	} else if (ctxTokens > 0) {
		ctxStr = `ctx: ${formatTokens(ctxTokens)}`;
	} else {
		ctxStr = "";
	}
	const ctxLine = ctxStr ? theme.fg("dim", ctxStr) : theme.fg("dim", "—");
	const ctxVis = ctxStr ? ctxStr.length : 1;

	const descText = state.description
		? truncate(state.description, w - 1)
		: truncate(expandTabs(state.progress.lastLine || "—"), w - 1);
	const descLine = state.description
		? theme.fg("accent", descText)
		: theme.fg("muted", descText);
	const descVis = descText.length;

	const borderColor = state.status === "running" ? color : "dim";
	const top = "┌" + "─".repeat(w) + "┐";
	const bot = "└" + "─".repeat(w) + "┘";
	const border = (content: string, visLen: number) =>
		theme.fg(borderColor, "│") + content + " ".repeat(Math.max(0, w - visLen)) + theme.fg(borderColor, "│");

	return [
		theme.fg(borderColor, top),
		border(" " + indexStr + nameStr + modelStr, 1 + nameVis),
		border(" " + descLine, 1 + descVis),
		border(" " + statusLine, 1 + statusVis),
		border(" " + ctxLine, 1 + ctxVis),
		theme.fg(borderColor, bot),
	];
}
