/**
 * TUI rendering primitives for the subagent extension.
 *
 * Shared by agent-manager, log-viewer, and dashboard components.
 * Provides bordered layout helpers, fuzzy filtering, and color palette.
 */

import type { Theme, ThemeColor } from "@mariozechner/pi-coding-agent";
import { visibleWidth } from "@mariozechner/pi-tui";
import type { AgentConfig } from "./agents.js";

/** Rotating color palette for distinguishing agents in the dashboard. */
export const AGENT_COLORS: ThemeColor[] = [
	"accent",
	"syntaxString",
	"syntaxFunction",
	"warning",
	"syntaxType",
	"syntaxKeyword",
	"success",
	"syntaxNumber",
	"mdLink",
];

/** Get the assigned color for an agent by its 1-based display index. */
export function agentColor(displayIndex: number): ThemeColor {
	return AGENT_COLORS[(displayIndex - 1) % AGENT_COLORS.length];
}

/** Render a centered bordered row (header or footer). */
export function renderBorderRow(
	text: string,
	width: number,
	theme: Theme,
	style: "header" | "footer",
): string {
	const innerW = width - 2;
	const padLen = Math.max(0, innerW - visibleWidth(text));
	const padLeft = Math.floor(padLen / 2);
	const padRight = padLen - padLeft;
	const [left, right] = style === "header" ? ["╭", "╮"] : ["╰", "╯"];
	const textColor = style === "header" ? "accent" : "dim";
	return (
		theme.fg("border", left + "─".repeat(padLeft)) +
		theme.fg(textColor, text) +
		theme.fg("border", "─".repeat(padRight) + right)
	);
}

/** Pad a string to a minimum visible width. */
export function pad(s: string, len: number): string {
	const vis = visibleWidth(s);
	return s + " ".repeat(Math.max(0, len - vis));
}

/** Render a bordered row with content. */
export function borderedRow(content: string, width: number, theme: Theme): string {
	const innerW = width - 2;
	return theme.fg("border", "│") + pad(content, innerW) + theme.fg("border", "│");
}

/** Simple fuzzy scoring: substring match then character-by-character. */
export function fuzzyScore(query: string, text: string): number {
	const lq = query.toLowerCase();
	const lt = text.toLowerCase();
	if (lt.includes(lq)) return 100 + (lq.length / lt.length) * 50;
	let score = 0;
	let qi = 0;
	let consecutive = 0;
	for (let i = 0; i < lt.length && qi < lq.length; i++) {
		if (lt[i] === lq[qi]) {
			score += 10 + consecutive;
			consecutive += 5;
			qi++;
		} else {
			consecutive = 0;
		}
	}
	return qi === lq.length ? score : 0;
}

/** Filter agents by fuzzy query across name/description/model. */
export function fuzzyFilterAgents(agents: AgentConfig[], query: string): AgentConfig[] {
	const q = query.trim();
	if (!q) return agents;
	return agents
		.map((a) => ({
			agent: a,
			score: Math.max(
				fuzzyScore(q, a.name),
				fuzzyScore(q, a.description) * 0.8,
				fuzzyScore(q, a.model ?? "") * 0.6,
			),
		}))
		.filter((x) => x.score > 0)
		.sort((a, b) => b.score - a.score)
		.map((x) => x.agent);
}
