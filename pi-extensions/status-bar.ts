/**
 * Status Bar — Rich two-line custom footer inspired by claude-status
 *
 * Line 1: status icon + model + context meter (left), tokens in/out/cache + cost (right)
 * Line 2: cwd (branch ±dirty +add,-del ✨new📝mod🗑del⚡unstaged) on left, tool tally + turn on right
 *
 * Context meter is color-coded: green <50%, yellow 50-80%, red >80%
 *
 * Usage: pi -e pi-extensions/status-bar.ts
 */

import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { basename } from "node:path";

interface GitDiffStats {
	additions: number;
	deletions: number;
	newFiles: number;
	modifiedFiles: number;
	deletedFiles: number;
	unstagedFiles: number;
}

export default function (pi: ExtensionAPI) {
	const counts: Record<string, number> = {};
	let turnCount = 0;
	let agentActive = false;

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

		// Refresh git diff stats after file-mutating tools
		const mutating = ["write", "edit", "bash"];
		if (mutating.includes(event.toolName)) {
			scheduleDiffRefresh(ctx);
		}
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
		// Reconstruct state from session history
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "message" && entry.message.role === "toolResult") {
				const name = entry.message.toolName;
				if (name) counts[name] = (counts[name] || 0) + 1;
			}
			if (entry.type === "message" && entry.message.role === "assistant") {
				turnCount++;
			}
		}

		// Initial diff stats fetch
		refreshDiffStats(ctx);

		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsub = footerData.onBranchChange(() => tui.requestRender());

			return {
				dispose: unsub,
				invalidate() {},
				render(width: number): string[] {
					// --- Accumulate tokens and cost ---
					let tokIn = 0;
					let tokOut = 0;
					let tokCache = 0;
					let cost = 0;
					for (const entry of ctx.sessionManager.getBranch()) {
						if (entry.type === "message" && entry.message.role === "assistant") {
							const m = entry.message as AssistantMessage;
							tokIn += m.usage.input;
							tokOut += m.usage.output;
							tokCache += (m.usage as any).cacheRead ?? 0;
							tokCache += (m.usage as any).cacheCreation ?? 0;
							cost += m.usage.cost.total;
						}
					}

					const fmt = (n: number) =>
						n >= 1_000_000
							? `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`
							: n >= 1_000
								? `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}k`
								: `${n}`;

					// --- Line 1: model + context meter (left), tokens + cost (right) ---
					const usage = ctx.getContextUsage();
					const pct = usage ? usage.percent : 0;
					const filled = Math.round(pct / 10) || 1;
					const model = ctx.model?.id || "no-model";

					const statusIcon = agentActive
						? theme.fg("accent", "● ")
						: theme.fg("success", "✓ ");

					// Color-coded context: green <50%, yellow 50-80%, red >80%
					const ctxColor: "success" | "warning" | "error" =
						pct >= 80 ? "error" : pct >= 50 ? "warning" : "success";

					const l1Left =
						statusIcon +
						theme.fg("dim", `${model} `) +
						theme.fg("warning", "[") +
						theme.fg(ctxColor, "#".repeat(filled)) +
						theme.fg("dim", "-".repeat(10 - filled)) +
						theme.fg("warning", "]") +
						theme.fg("dim", " ") +
						theme.fg(ctxColor, `${Math.round(pct)}%`);

					let l1Right =
						theme.fg("success", `↑${fmt(tokIn)}`) +
						theme.fg("dim", " ") +
						theme.fg("accent", `↓${fmt(tokOut)}`);

					if (tokCache > 0) {
						l1Right += theme.fg("dim", " ") + theme.fg("muted", `⚡${fmt(tokCache)}`);
					}

					l1Right +=
						theme.fg("dim", " ") +
						theme.fg("warning", `$${cost.toFixed(4)}`) +
						theme.fg("dim", " ");

					const pad1 = " ".repeat(
						Math.max(1, width - visibleWidth(l1Left) - visibleWidth(l1Right)),
					);
					const line1 = truncateToWidth(l1Left + pad1 + l1Right, width, "");

					// --- Line 2: cwd + git info (left), tool tally + turn (right) ---
					const dir = basename(ctx.cwd);
					const branch = footerData.getGitBranch();

					let l2Left = theme.fg("dim", ` 📁 ${dir}`);

					if (branch) {
						l2Left += theme.fg("dim", " 🌿 ") + theme.fg("success", branch);

						// Git status (dirty file count)
						if (diffStats) {
							const totalDirty =
								diffStats.newFiles + diffStats.modifiedFiles +
								diffStats.deletedFiles + diffStats.unstagedFiles;

							if (totalDirty > 0) {
								l2Left += theme.fg("warning", ` ±${totalDirty}`);
							}

							// Diff stats: +additions,-deletions
							if (diffStats.additions > 0 || diffStats.deletions > 0) {
								l2Left += theme.fg("dim", " ");
								if (diffStats.additions > 0) {
									l2Left += theme.fg("success", `+${diffStats.additions}`);
								}
								if (diffStats.deletions > 0) {
									if (diffStats.additions > 0) l2Left += theme.fg("dim", ",");
									l2Left += theme.fg("error", `-${diffStats.deletions}`);
								}
							}

							// File type indicators
							let fileIndicators = "";
							if (diffStats.newFiles > 0)
								fileIndicators += `✨${diffStats.newFiles}`;
							if (diffStats.modifiedFiles > 0)
								fileIndicators += `📝${diffStats.modifiedFiles}`;
							if (diffStats.deletedFiles > 0)
								fileIndicators += `🗑${diffStats.deletedFiles}`;
							if (diffStats.unstagedFiles > 0)
								fileIndicators += `⚡${diffStats.unstagedFiles}`;

							if (fileIndicators) {
								l2Left += theme.fg("dim", " ") + theme.fg("muted", fileIndicators);
							}
						}
					}

					// Tool tally + turn count on right
					const entries = Object.entries(counts);
					let l2Right = "";

					if (entries.length > 0) {
						// Show top tools, collapse rest if too many
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

					return [line1, line2];
				},
			};
		});
	});

	// Reset on new session
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
