/**
 * Status Bar — Rich two-line custom footer inspired by claude-status
 *
 * Line 1: [profile badge] + status icon + model + context meter (left), tokens in/out/cache + cost (right)
 * Line 2: cwd (branch ±dirty +add,-del ✨new📝mod🗑del⚡unstaged) on left, tool tally + turn on right
 * Line 3: sandbox status (shown only when sandbox extension is active)
 *
 * When PI_CODING_AGENT_DIR is set to a non-default path, a colored profile badge
 * is shown at the start of line 1. The badge background color is deterministically
 * derived from a hash of the profile name for easy visual identification.
 *
 * Context meter is color-coded: green <50%, yellow 50-80%, red >80%
 *
 * Usage: pi -e pi-extensions/status-bar.ts
 */

import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { basename } from "node:path";

/** Hash a string into a 32-bit unsigned integer (djb2). */
export function hashString(str: string): number {
	let hash = 5381;
	for (let i = 0; i < str.length; i++) {
		hash = ((hash << 5) + hash + str.charCodeAt(i)) >>> 0;
	}
	return hash;
}

/** Convert HSL (h: 0-360, s/l: 0-1) to RGB (0-255 each). */
export function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
	const c = (1 - Math.abs(2 * l - 1)) * s;
	const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
	const m = l - c / 2;
	let r = 0, g = 0, b = 0;
	if (h < 60)       { r = c; g = x; }
	else if (h < 120) { r = x; g = c; }
	else if (h < 180) { g = c; b = x; }
	else if (h < 240) { g = x; b = c; }
	else if (h < 300) { r = x; b = c; }
	else              { r = c; b = x; }
	return {
		r: Math.round((r + m) * 255),
		g: Math.round((g + m) * 255),
		b: Math.round((b + m) * 255),
	};
}

/**
 * Resolve the profile name from PI_CODING_AGENT_DIR.
 * Returns undefined when the env var is unset or points to the default "agent" dir.
 */
export function getProfileName(): string | undefined {
	const configDir = process.env.PI_CODING_AGENT_DIR;
	if (!configDir) return undefined;
	const name = basename(configDir);
	return name === "agent" ? undefined : name;
}

/** Return "oauth", "api-key", or "no-auth" for the current model. */
export function getAuthLabel(ctx: ExtensionContext): string {
	if (!ctx.model) return "no-auth";
	return ctx.modelRegistry.isUsingOAuth(ctx.model) ? "oauth" : "api-key";
}

/**
 * Build an ANSI-styled profile badge (e.g. " work [oauth] ") with a
 * hashed background color and bold white foreground.
 * Returns empty text when there is no custom profile.
 */
export function buildProfileBadge(ctx: ExtensionContext): { text: string; width: number } {
	const name = getProfileName();
	if (!name) return { text: "", width: 0 };

	const auth = getAuthLabel(ctx);
	const hue = hashString(name) % 360;
	const { r, g, b } = hslToRgb(hue, 0.65, 0.38);
	const label = ` ${name} [${auth}] `;

	return {
		text: `\x1b[48;2;${r};${g};${b}m\x1b[1;97m${label}\x1b[0m `,
		width: label.length + 1,
	};
}

/** Format a token count as a compact string (e.g. 1.2k, 3.5M). */
export function formatTokenCount(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
	return `${n}`;
}

/** Tools that mutate files and should trigger a git diff refresh. */
export const MUTATING_TOOLS = new Set(["write", "edit", "bash"]);

interface GitDiffStats {
	additions: number;
	deletions: number;
	newFiles: number;
	modifiedFiles: number;
	deletedFiles: number;
	unstagedFiles: number;
}

/** Ticket statistics emitted by the ticket extension via pi.events. */
interface TicketStats {
	total: number;
	epics: number;
	tasks: number;
	bugs: number;
	features: number;
	open: number;
	inProgress: number;
	closed: number;
}

/** Status bar extension — registers a rich two-line custom footer. */
export default function statusBarExtension(pi: ExtensionAPI) {
	const counts: Record<string, number> = {};
	let turnCount = 0;
	let agentActive = false;

	// Ticket stats (populated via pi.events from ticket extension)
	let ticketStats: TicketStats | null = null;
	pi.events.on("ticket:stats", (data: TicketStats) => { ticketStats = data; });

	// Cached git diff stats (refreshed on tool_execution_end for write/edit/bash)
	let diffStats: GitDiffStats | null = null;
	let diffStatsTimer: ReturnType<typeof setTimeout> | null = null;

	async function refreshDiffStats(ctx: ExtensionContext) {
		try {
			const shortstat = await pi.exec("git", ["diff", "--shortstat"], { timeout: 2000 });
			const shortstatCached = await pi.exec("git", ["diff", "--shortstat", "--cached"], { timeout: 2000 });
			const statusOut = await pi.exec("git", ["status", "--porcelain"], { timeout: 2000 });

			const stats: GitDiffStats = {
				additions: 0, deletions: 0,
				newFiles: 0, modifiedFiles: 0, deletedFiles: 0, unstagedFiles: 0,
			};

			// Parse shortstat for additions/deletions
			for (const out of [shortstat.stdout, shortstatCached.stdout]) {
				if (!out) continue;
				const addMatch = out.match(/(\d+)\s+insertion/);
				const delMatch = out.match(/(\d+)\s+deletion/);
				if (addMatch) stats.additions += parseInt(addMatch[1], 10);
				if (delMatch) stats.deletions += parseInt(delMatch[1], 10);
			}

			// Parse porcelain status for file type counts
			if (statusOut.stdout) {
				for (const line of statusOut.stdout.split("\n")) {
					if (line.length < 2) continue;
					const x = line[0];
					const y = line[1];

					if (x === "?" && y === "?") {
						stats.newFiles++;
						stats.unstagedFiles++;
					} else if (x === "A") {
						stats.newFiles++;
						if (y === "M" || y === "D") stats.unstagedFiles++;
					} else if (x === "D") {
						stats.deletedFiles++;
					} else if (x === "M" || x === "R" || x === "C") {
						stats.modifiedFiles++;
						if (y === "M" || y === "D") stats.unstagedFiles++;
					} else if (x === " ") {
						if (y === "M") { stats.modifiedFiles++; stats.unstagedFiles++; }
						if (y === "D") { stats.deletedFiles++; stats.unstagedFiles++; }
					}
				}
			}

			diffStats = stats;
		} catch {
			diffStats = null;
		}
	}

	function scheduleDiffRefresh(ctx: ExtensionContext) {
		if (diffStatsTimer) clearTimeout(diffStatsTimer);
		diffStatsTimer = setTimeout(() => refreshDiffStats(ctx), 500);
	}

	pi.on("tool_execution_end", async (event, ctx) => {
		counts[event.toolName] = (counts[event.toolName] || 0) + 1;
		if (MUTATING_TOOLS.has(event.toolName)) scheduleDiffRefresh(ctx);
	});

	pi.on("turn_start", async () => {
		turnCount++;
		agentActive = true;
	});

	pi.on("turn_end", async () => {
		agentActive = false;
	});

	pi.on("agent_end", async () => {
		agentActive = false;
	});

	pi.on("session_start", async (_event, ctx) => {
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			if (entry.message.role === "toolResult" && entry.message.toolName) {
				counts[entry.message.toolName] = (counts[entry.message.toolName] || 0) + 1;
			}
			if (entry.message.role === "assistant") turnCount++;
		}
		refreshDiffStats(ctx);

		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsub = footerData.onBranchChange(() => tui.requestRender());

			return {
				dispose: unsub,
				invalidate() {},
				render(width: number): string[] {
					let tokIn = 0;
					let tokOut = 0;
					let tokCache = 0;
					let cost = 0;
					for (const entry of ctx.sessionManager.getBranch()) {
						if (entry.type !== "message" || entry.message.role !== "assistant") continue;
						const m = entry.message as AssistantMessage;
						tokIn += m.usage.input;
						tokOut += m.usage.output;
						tokCache += (m.usage as any).cacheRead ?? 0;
						tokCache += (m.usage as any).cacheCreation ?? 0;
						cost += m.usage.cost.total;
					}

					// --- Line 1: badge + model + context meter (left), tokens + cost (right) ---
					const pct = ctx.getContextUsage()?.percent ?? 0;
					const filled = Math.round(pct / 10) || 1;
					const model = ctx.model?.id || "no-model";

					const badge = buildProfileBadge(ctx);

					const statusIcon = agentActive
						? theme.fg("accent", "● ")
						: theme.fg("success", "✓ ");
					const ctxColor: "success" | "warning" | "error" =
						pct >= 80 ? "error" : pct >= 50 ? "warning" : "success";

					const l1Left =
						badge.text +
						statusIcon +
						theme.fg("dim", `${model} `) +
						theme.fg("warning", "[") +
						theme.fg(ctxColor, "#".repeat(filled)) +
						theme.fg("dim", "-".repeat(10 - filled)) +
						theme.fg("warning", "]") +
						theme.fg("dim", " ") +
						theme.fg(ctxColor, `${Math.round(pct)}%`);

					let l1Right =
						theme.fg("success", `↑${formatTokenCount(tokIn)}`) +
						theme.fg("dim", " ") +
						theme.fg("accent", `↓${formatTokenCount(tokOut)}`);
					if (tokCache > 0) {
						l1Right += theme.fg("dim", " ") + theme.fg("muted", `⚡${formatTokenCount(tokCache)}`);
					}
					l1Right +=
						theme.fg("dim", " ") +
						theme.fg("warning", `$${cost.toFixed(4)}`) +
						theme.fg("dim", " ");

					const statuses = footerData.getExtensionStatuses();
					const sandboxStatus = statuses.get("sandbox");
					const otherStatuses = [...statuses.entries()]
						.filter(([key]) => key !== "sandbox")
						.map(([, val]) => val);

					// Build ticket status segment from event data (hide when all closed)
					if (ticketStats && (ticketStats.open > 0 || ticketStats.inProgress > 0)) {
						const parts: string[] = [];
						if (ticketStats.epics > 0) parts.push(theme.fg("accent", `${ticketStats.epics}E`));
						const nonEpic = ticketStats.tasks + ticketStats.bugs + ticketStats.features;
						if (nonEpic > 0) parts.push(theme.fg("muted", `${nonEpic}T`));
						if (ticketStats.inProgress > 0) parts.push(theme.fg("warning", `${ticketStats.inProgress}🔵`));
						if (ticketStats.open > 0) parts.push(theme.fg("dim", `${ticketStats.open}⚪`));
						if (ticketStats.closed > 0) parts.push(theme.fg("success", `${ticketStats.closed}✅`));
						otherStatuses.push(`🎫 ${parts.join(" ")}`);
					}

					let l1Mid = "";
					if (otherStatuses.length > 0) {
						l1Mid = " " + otherStatuses.join(theme.fg("dim", " · "));
					}

					const pad1 = " ".repeat(
						Math.max(1, width - visibleWidth(l1Left) - visibleWidth(l1Mid) - visibleWidth(l1Right)),
					);
					const line1 = truncateToWidth(l1Left + l1Mid + pad1 + l1Right, width, "");

					// --- Line 2: cwd + git info (left), tool tally + turn (right) ---
					const dir = basename(ctx.cwd);
					const branch = footerData.getGitBranch();

					let l2Left = theme.fg("dim", ` 📁 ${dir}`);

					if (branch) {
						l2Left += theme.fg("dim", " 🌿 ") + theme.fg("success", branch);

						if (diffStats) {
							const totalDirty =
								diffStats.newFiles + diffStats.modifiedFiles +
								diffStats.deletedFiles + diffStats.unstagedFiles;
							if (totalDirty > 0) {
								l2Left += theme.fg("warning", ` ±${totalDirty}`);
							}

							if (diffStats.additions > 0 || diffStats.deletions > 0) {
								const parts: string[] = [];
								if (diffStats.additions > 0) parts.push(theme.fg("success", `+${diffStats.additions}`));
								if (diffStats.deletions > 0) parts.push(theme.fg("error", `-${diffStats.deletions}`));
								l2Left += theme.fg("dim", " ") + parts.join(theme.fg("dim", ","));
							}

							const indicators: [number, string][] = [
								[diffStats.newFiles, "✨"],
								[diffStats.modifiedFiles, "📝"],
								[diffStats.deletedFiles, "🗑"],
								[diffStats.unstagedFiles, "⚡"],
							];
							const fileIndicators = indicators
								.filter(([count]) => count > 0)
								.map(([count, icon]) => `${icon}${count}`)
								.join("");
							if (fileIndicators) {
								l2Left += theme.fg("dim", " ") + theme.fg("muted", fileIndicators);
							}
						}
					}

					const entries = Object.entries(counts);
					let l2Right = "";
					if (entries.length > 0) {
						const sorted = entries.sort((a, b) => b[1] - a[1]);
						const shown = sorted.slice(0, 5);
						const rest = sorted.slice(5);

						l2Right = shown
							.map(
								([name, count]) =>
									theme.fg("accent", name) +
									theme.fg("dim", ":") +
									theme.fg("success", `${count}`),
							)
							.join(theme.fg("dim", " "));

						if (rest.length > 0) {
							const restTotal = rest.reduce((sum, [, c]) => sum + c, 0);
							l2Right +=
								theme.fg("dim", " +") +
								theme.fg("muted", `${restTotal}`);
						}
					} else {
						l2Right = theme.fg("dim", "no tools yet");
					}

					l2Right +=
						theme.fg("dim", " · ") +
						theme.fg("muted", `T${turnCount} `);

					const pad2 = " ".repeat(
						Math.max(1, width - visibleWidth(l2Left) - visibleWidth(l2Right)),
					);
					const line2 = truncateToWidth(l2Left + pad2 + l2Right, width, "");

					if (!sandboxStatus) return [line1, line2];

					// --- Line 3: sandbox status (left-aligned) ---
					const l3Left = " " + sandboxStatus;
					const pad3 = " ".repeat(Math.max(1, width - visibleWidth(l3Left)));
					const line3 = truncateToWidth(l3Left + pad3, width, "");

					return [line1, line2, line3];
				},
			};
		});
	});

	pi.on("session_switch", async (event, ctx) => {
		if (event.reason === "new") {
			for (const key of Object.keys(counts)) delete counts[key];
			turnCount = 0;
			agentActive = false;
			diffStats = null;
			refreshDiffStats(ctx);
		}
	});
}
