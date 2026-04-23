/**
 * Status Bar — Powerline-styled two-line custom footer
 *
 * Line 1: profile▸auth▸📁dir▸branch PR#n/✓merged ±changes +add,-del ✨new📝mod  │ tickets/bgrun │ T5
 * Line 2: ●mode▸model▸🧠thinking▸████░░ 62%  │ ⏱speed ⚡cache $cost
 * Line 3: sandbox status (shown only when sandbox extension is active)
 *
 * Powerline segments use muted bg-color palette with  (U+E0B0) separators.
 * Profile badge bg is deterministically hashed from the profile name.
 * Context meter uses Unicode block chars (█░), color-coded green/yellow/red.
 *
 * Usage: pi -e pi-extensions/status-bar.ts
 */

import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { Buffer } from "node:buffer";
import { basename } from "node:path";

// ── ANSI / Powerline constants ───────────────────────────────────────────────

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const PL = "\uE0B0"; // Powerline right-arrow separator

// ── Segment background colors (RGB strings for \x1b[48;2;R;G;Bm) ────────────

const BG_AUTH = "38;38;56";
const BG_DIR = "30;30;48";
const BG_BRANCH = "26;26;42";
const BG_MODE_PLAN = "45;31;94";
const BG_MODE_CODE = "26;58;42";
const BG_MODEL = "34;34;52";
const BG_THINKING = "42;34;53";
const BG_CONTEXT = "26;26;42";

// ── Type aliases for footer callback params ──────────────────────────────────

type FooterFactory = NonNullable<Parameters<ExtensionContext["ui"]["setFooter"]>[0]>;
type ThemeRef = Parameters<FooterFactory>[1];
type FooterDataRef = Parameters<FooterFactory>[2];

// ── Color helpers ────────────────────────────────────────────────────────────

/** Hash a string into a 32-bit unsigned integer (djb2). */
export function hashString(str: string): number {
	let hash = 5381;
	for (let i = 0; i < str.length; i++) {
		hash = ((hash << 5) + hash + str.charCodeAt(i)) >>> 0;
	}
	return hash;
}

/** Convert HSL (h: 0-360, s/l: 0-1) to an "R;G;B" string for ANSI escapes. */
export function hslToRgbAnsi(h: number, s: number, l: number): string {
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
	return `${Math.round((r + m) * 255)};${Math.round((g + m) * 255)};${Math.round((b + m) * 255)}`;
}

// ── Powerline segment builders ───────────────────────────────────────────────

/** Set background color (persists until next bg change or reset). */
function setBg(rgb: string): string { return `\x1b[48;2;${rgb}m`; }

/** Render a powerline arrow: fg=fromBg color, bg=toBg (or terminal default). */
function plArrow(fromBg: string, toBg: string | null): string {
	const bg = toBg ? setBg(toBg) : "";
	return `${bg}\x1b[38;2;${fromBg}m${PL}${RESET}`;
}

/** Segment descriptor: bg color + pre-built content string (may contain fg escapes). */
interface Segment {
	bg: string;
	content: string;
}

/**
 * Render a chain of powerline segments with arrows between them.
 * Content strings may include fg ANSI codes — bg is applied per-segment.
 * Returns the complete styled string.
 */
function renderChain(segments: Segment[]): string {
	if (segments.length === 0) return "";

	let result = "";
	for (let i = 0; i < segments.length; i++) {
		const { bg, content } = segments[i];
		result += `${setBg(bg)}${content}${RESET}`;
		const nextBg = i < segments.length - 1 ? segments[i + 1].bg : null;
		result += plArrow(bg, nextBg);
	}
	return result;
}

// ── Profile / auth helpers ───────────────────────────────────────────────────

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

/** Get the profile's background RGB ANSI string (hashed from name). */
function getProfileBgRgb(name: string): string {
	return hslToRgbAnsi(hashString(name) % 360, 0.65, 0.28);
}

// ── Formatting helpers ───────────────────────────────────────────────────────

/** Format bytes/sec as a compact string (e.g. 512B/s, 1.2kB/s). */
export function formatBytesPerSec(bps: number): string {
	if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(1)}MB/s`;
	if (bps >= 1_000) return `${(bps / 1_000).toFixed(1)}kB/s`;
	return `${Math.round(bps)}B/s`;
}

/** Format a token count as a compact string (e.g. 1.2k, 3.5M). */
export function formatTokenCount(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
	return `${n}`;
}

/** Extract mode name ("plan", "ask", or "code") from plan-ask extension status string. */
function detectModeName(modeStatus: string | undefined): string {
	if (!modeStatus) return "code";
	const stripped = modeStatus.replace(/\x1b\[[^m]*m/g, "").trim();
	if (/plan/i.test(stripped)) return "plan";
	if (/ask/i.test(stripped)) return "ask";
	return "code";
}

// ── Constants ────────────────────────────────────────────────────────────────

/** Tools that mutate files and should trigger a git diff refresh. */
export const MUTATING_TOOLS = new Set(["write", "edit", "bash"]);

/** Extension status keys hidden from the status bar. */
const HIDDEN_STATUSES = new Set(["sandbox", "auto-update", "packages", "plan-mode"]);

// ── Types ────────────────────────────────────────────────────────────────────

interface GitDiffStats {
	additions: number;
	deletions: number;
	newFiles: number;
	modifiedFiles: number;
	deletedFiles: number;
	unstagedFiles: number;
}

/** PR status for the current branch fetched via gh CLI. */
interface PrStatus {
	number: number;
	state: "OPEN" | "CLOSED" | "MERGED";
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

// ── Extension entry point ────────────────────────────────────────────────────

/** Status bar extension — registers a powerline-styled two-line custom footer. */
export default function statusBarExtension(pi: ExtensionAPI): void {
	let turnCount = 0;
	let agentActive = false;

	// Streaming speed tracking (bytes/sec, 1s sliding window)
	let windowBytes = 0;
	let currentBytesPerSec = 0;
	let isStreaming = false;
	let renderTimer: ReturnType<typeof setInterval> | null = null;
	let tuiRef: { requestRender: () => void } | null = null;

	function stopRenderTimer(): void {
		if (renderTimer) {
			clearInterval(renderTimer);
			renderTimer = null;
		}
	}

	/** `unref()` a timer if supported so it doesn't keep the event loop alive. */
	function unrefTimer(timer: ReturnType<typeof setInterval> | ReturnType<typeof setTimeout>): void {
		const withUnref = timer as { unref?: () => void };
		withUnref.unref?.();
	}

	// External stats via pi.events
	let ticketStats: TicketStats | null = null;
	pi.events.on("ticket:stats", (data: unknown) => { ticketStats = data as TicketStats; });

	let bgrunStats: { running: number } | null = null;
	pi.events.on("bgrun:stats", (data: unknown) => { bgrunStats = data as { running: number }; });

	// Git diff stats (refreshed on mutating tool executions)
	let diffStats: GitDiffStats | null = null;
	let diffStatsTimer: ReturnType<typeof setTimeout> | null = null;

	// PR status for current branch (refreshed on branch change + every 60s)
	let prStatus: PrStatus | null = null;
	let prStatusTimer: ReturnType<typeof setTimeout> | null = null;
	let prStatusBranch: string | null = null;
	let prPollInterval: ReturnType<typeof setInterval> | null = null;

	async function refreshDiffStats(): Promise<void> {
		try {
			const shortstat = await pi.exec("git", ["diff", "--shortstat"], { timeout: 2000 });
			const shortstatCached = await pi.exec("git", ["diff", "--shortstat", "--cached"], { timeout: 2000 });
			const statusOut = await pi.exec("git", ["status", "--porcelain"], { timeout: 2000 });

			const stats: GitDiffStats = {
				additions: 0, deletions: 0,
				newFiles: 0, modifiedFiles: 0, deletedFiles: 0, unstagedFiles: 0,
			};

			for (const out of [shortstat.stdout, shortstatCached.stdout]) {
				if (!out) continue;
				const addMatch = out.match(/(\d+)\s+insertion/);
				const delMatch = out.match(/(\d+)\s+deletion/);
				if (addMatch) stats.additions += parseInt(addMatch[1], 10);
				if (delMatch) stats.deletions += parseInt(delMatch[1], 10);
			}

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

	function scheduleDiffRefresh(): void {
		if (diffStatsTimer) clearTimeout(diffStatsTimer);
		diffStatsTimer = setTimeout(() => refreshDiffStats(), 500);
		unrefTimer(diffStatsTimer);
	}

	/** Fetch PR status for the current branch via gh CLI. */
	async function refreshPrStatus(branch?: string | null, force = false): Promise<void> {
		const currentBranch = branch ?? prStatusBranch;
		if (!currentBranch || currentBranch === "main" || currentBranch === "master") {
			prStatus = null;
			prStatusBranch = currentBranch ?? null;
			return;
		}
		if (!force && currentBranch === prStatusBranch && prStatus !== null) return;
		prStatusBranch = currentBranch;
		try {
			const result = await pi.exec(
				"gh", ["pr", "view", "--json", "number,state"],
				{ timeout: 5000 },
			);
			if (result.stdout) {
				const data = JSON.parse(result.stdout);
				prStatus = { number: data.number, state: data.state };
			} else {
				prStatus = null;
			}
		} catch {
			prStatus = null;
		}
	}

	function schedulePrRefresh(branch?: string | null): void {
		if (prStatusTimer) clearTimeout(prStatusTimer);
		prStatusTimer = setTimeout(() => refreshPrStatus(branch), 600);
		unrefTimer(prStatusTimer);
	}

	/** Start a 60s polling interval to keep PR status up-to-date (e.g. detect merges). */
	function startPrPoll(): void {
		stopPrPoll();
		prPollInterval = setInterval(async () => {
			if (!prStatusBranch) return;
			await refreshPrStatus(prStatusBranch, true);
			tuiRef?.requestRender();
		}, 60_000);
		unrefTimer(prPollInterval);
	}

	function stopPrPoll(): void {
		if (prPollInterval) {
			clearInterval(prPollInterval);
			prPollInterval = null;
		}
	}

	// ── Event handlers ─────────────────────────────────────────────────────

	pi.on("message_start", async (event) => {
		if (event.message.role !== "assistant") return;
		windowBytes = 0;
		currentBytesPerSec = 0;
		isStreaming = true;
		if (tuiRef && !renderTimer) {
			renderTimer = setInterval(() => {
				currentBytesPerSec = windowBytes;
				windowBytes = 0;
				tuiRef?.requestRender();
			}, 1000);
			unrefTimer(renderTimer);
		}
	});

	pi.on("message_update", async (event) => {
		const e = event.assistantMessageEvent;
		if (e.type === "text_delta" || e.type === "thinking_delta" || e.type === "toolcall_delta") {
			windowBytes += Buffer.byteLength(e.delta, "utf8");
		}
	});

	pi.on("message_end", async (event) => {
		if (event.message.role !== "assistant") return;
		isStreaming = false;
		stopRenderTimer();
	});

	pi.on("tool_execution_end", async (event) => {
		if (MUTATING_TOOLS.has(event.toolName)) {
			scheduleDiffRefresh();
			// Force PR re-check after bash (might have created/merged a PR)
			if (event.toolName === "bash") {
				prStatusBranch = null;
				schedulePrRefresh();
			}
		}
	});

	pi.on("turn_start", async () => { turnCount++; agentActive = true; });
	pi.on("turn_end", async () => { agentActive = false; });
	pi.on("agent_end", async () => { agentActive = false; });

	// ── Footer registration ────────────────────────────────────────────────

	// Live ctx reference, updated on every session_start so that the footer's
	// render closure always sees the current (non-stale) context. On session
	// replacement/reload the old ctx becomes stale; pending render ticks would
	// otherwise hit the stale ctx getters and throw.
	let currentCtx: ExtensionContext | null = null;

	pi.on("session_start", async (event, ctx) => {
		// Reset per-session state on any replacement (new/resume/fork).
		// "reload" preserves the session, so keep counters running.
		if (event.reason === "new" || event.reason === "resume" || event.reason === "fork") {
			turnCount = 0;
			agentActive = false;
			diffStats = null;
			prStatus = null;
			prStatusBranch = null;
			windowBytes = 0;
			currentBytesPerSec = 0;
			isStreaming = false;
			stopRenderTimer();
			stopPrPoll();
		}

		currentCtx = ctx;

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "message" && entry.message.role === "assistant") turnCount++;
		}
		refreshDiffStats();

		ctx.ui.setFooter((tui, theme, footerData) => {
			refreshPrStatus(footerData.getGitBranch());
			startPrPoll();
			tuiRef = tui;
			const unsub = footerData.onBranchChange(() => {
				schedulePrRefresh(footerData.getGitBranch());
				tui.requestRender();
			});

			return {
				dispose() { unsub(); stopRenderTimer(); stopPrPoll(); tuiRef = null; },
				invalidate() {},
				render(width: number): string[] {
					// Use the live ctx reference. If the extension instance is being
					// torn down, currentCtx is cleared in session_shutdown and we
					// render a blank footer to avoid touching a stale ctx.
					const liveCtx = currentCtx;
					if (!liveCtx) return ["", ""];
					try {
						return renderFooter(width, liveCtx, theme, footerData);
					} catch {
						// Ctx went stale between the check and the call (race during
						// session replacement). Fall back to a blank footer; pi will
						// dispose this factory and install a fresh one shortly.
						return ["", ""];
					}
				},
			};
		});
	});

	// Tear down the footer and all session-scoped resources BEFORE pi invalidates
	// the ctx. Without this, a pending TUI render tick could call the footer's
	// render() with a stale ctx and throw. See docs/extensions.md
	// "Session replacement lifecycle and footguns".
	pi.on("session_shutdown", async (_event, ctx) => {
		stopRenderTimer();
		stopPrPoll();
		if (diffStatsTimer) { clearTimeout(diffStatsTimer); diffStatsTimer = null; }
		if (prStatusTimer) { clearTimeout(prStatusTimer); prStatusTimer = null; }
		currentCtx = null;
		tuiRef = null;
		if (ctx.hasUI) ctx.ui.setFooter(undefined);
	});

	// ── Render logic ───────────────────────────────────────────────────────

	function renderFooter(
		width: number, ctx: ExtensionContext, theme: ThemeRef, footerData: FooterDataRef,
	): string[] {
		let tokCache = 0;
		let cost = 0;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			const m = entry.message as AssistantMessage;
			tokCache += (m.usage as any).cacheRead ?? 0;
			tokCache += (m.usage as any).cacheCreation ?? 0;
			cost += m.usage.cost.total;
		}

		const line1 = renderLine1(width, ctx, theme, footerData);
		const line2 = renderLine2(width, ctx, theme, footerData, tokCache, cost);

		const sandboxStatus = footerData.getExtensionStatuses().get("sandbox");
		if (!sandboxStatus) return [line1, line2];

		const l3 = " " + sandboxStatus;
		const pad3 = " ".repeat(Math.max(1, width - visibleWidth(l3)));
		return [line1, line2, truncateToWidth(l3 + pad3, width, "")];
	}

	/** Line 1: profile▸auth▸📁dir▸branch + changes │ tickets/bgrun │ T{n} */
	function renderLine1(
		width: number, ctx: ExtensionContext, theme: ThemeRef, footerData: FooterDataRef,
	): string {
		const profileName = getProfileName();
		const auth = getAuthLabel(ctx);
		const dir = basename(ctx.cwd);
		const branch = footerData.getGitBranch();

		// Build powerline segments (theme.fg is safe — it only resets fg, not bg)
		const segs: Segment[] = [];

		if (profileName) {
			segs.push({
				bg: getProfileBgRgb(profileName),
				content: `${BOLD}\x1b[97m ${profileName} `,
			});
		}

		segs.push({ bg: BG_AUTH, content: ` ${theme.fg("muted", auth)} ` });
		segs.push({ bg: BG_DIR, content: ` ${theme.fg("dim", "📁")} ${theme.fg("muted", dir)} ` });

		if (branch) {
			let branchContent = ` ${theme.fg("success", ` ${branch}`)}`;
			if (prStatus) {
				if (prStatus.state === "MERGED") {
					branchContent += theme.fg("dim", ` ✓merged`);
				} else if (prStatus.state === "OPEN") {
					branchContent += theme.fg("accent", ` PR#${prStatus.number}`);
				}
			}
			segs.push({ bg: BG_BRANCH, content: `${branchContent} ` });
		}

		const leftChain = renderChain(segs);

		// Git change indicators (plain text after powerline chain)
		let gitInfo = "";
		if (branch && diffStats) {
			const totalDirty =
				diffStats.newFiles + diffStats.modifiedFiles +
				diffStats.deletedFiles + diffStats.unstagedFiles;

			if (totalDirty > 0) {
				gitInfo += theme.fg("warning", ` ±${totalDirty}`);
			}

			if (diffStats.additions > 0 || diffStats.deletions > 0) {
				const parts: string[] = [];
				if (diffStats.additions > 0) parts.push(theme.fg("success", `+${diffStats.additions}`));
				if (diffStats.deletions > 0) parts.push(theme.fg("error", `-${diffStats.deletions}`));
				gitInfo += " " + parts.join(theme.fg("dim", ","));
			}

			const indicators: Array<[number, string]> = [
				[diffStats.newFiles, "✨"],
				[diffStats.modifiedFiles, "📝"],
				[diffStats.deletedFiles, "🗑"],
				[diffStats.unstagedFiles, "⚡"],
			];
			const fileIcons = indicators
				.filter(([count]) => count > 0)
				.map(([count, icon]) => `${icon}${count}`);
			if (fileIcons.length > 0) {
				gitInfo += " " + theme.fg("muted", fileIcons.join(""));
			}
		}

		// Right side: extension statuses, tickets, bgrun, turn count
		const rightParts: string[] = [];

		const statuses = footerData.getExtensionStatuses();
		const otherStatuses = [...statuses.entries()]
			.filter(([key, val]) => !HIDDEN_STATUSES.has(key) && !/auto.?update|pkg/i.test(val))
			.map(([, val]) => val);

		if (bgrunStats && bgrunStats.running > 0) {
			otherStatuses.push(`${theme.fg("accent", `⚙${bgrunStats.running}`)}`);
		}

		if (ticketStats && (ticketStats.open > 0 || ticketStats.inProgress > 0)) {
			const tp: string[] = [];
			if (ticketStats.epics > 0) tp.push(theme.fg("accent", `${ticketStats.epics}E`));
			const nonEpic = ticketStats.tasks + ticketStats.bugs + ticketStats.features;
			if (nonEpic > 0) tp.push(theme.fg("muted", `${nonEpic}T`));
			if (ticketStats.inProgress > 0) tp.push(theme.fg("warning", `${ticketStats.inProgress}▶`));
			if (ticketStats.open > 0) tp.push(theme.fg("dim", `${ticketStats.open}○`));
			if (ticketStats.closed > 0) tp.push(theme.fg("success", `${ticketStats.closed}✓`));
			otherStatuses.push(`🎫${tp.join(" ")}`);
		}

		if (otherStatuses.length > 0) {
			rightParts.push(otherStatuses.join(theme.fg("dim", " · ")));
		}

		rightParts.push(theme.fg("dim", `T${turnCount} `));

		const rightText = rightParts.join(" ");
		const leftWidth = visibleWidth(leftChain + gitInfo);
		const rightWidth = visibleWidth(rightText);
		const pad = " ".repeat(Math.max(1, width - leftWidth - rightWidth));

		return truncateToWidth(leftChain + gitInfo + pad + rightText, width, "");
	}

	/** Line 2: ●mode▸model▸🧠thinking▸████░░ 62% │ ⏱speed ⚡cache $cost */
	function renderLine2(
		width: number, ctx: ExtensionContext, theme: ThemeRef, footerData: FooterDataRef,
		tokCache: number, cost: number,
	): string {
		const statuses = footerData.getExtensionStatuses();
		const modeName = detectModeName(statuses.get("plan-mode"));
		const isReadOnly = modeName === "plan" || modeName === "ask";

		const dot = agentActive ? "● " : "✓ ";
		const modeBg = isReadOnly ? BG_MODE_PLAN : BG_MODE_CODE;

		const model = ctx.model?.id || "no-model";
		const thinkingLevel = pi.getThinkingLevel();
		const showThinking = !!(ctx.model?.reasoning && thinkingLevel !== "off");

		// Build powerline segments
		const segs: Segment[] = [];

		// Mode segment (bold, colored)
		segs.push({
			bg: modeBg,
			content: `${BOLD} ${isReadOnly ? theme.fg("accent", `${dot}${modeName}`) : theme.fg("success", `${dot}${modeName}`)} `,
		});

		// Model segment
		segs.push({ bg: BG_MODEL, content: ` ${theme.fg("dim", model)} ` });

		// Thinking segment (conditional)
		if (showThinking) {
			segs.push({ bg: BG_THINKING, content: ` ${theme.fg("accent", `🧠${thinkingLevel}`)} ` });
		}

		// Context meter segment
		const pct = ctx.getContextUsage()?.percent ?? 0;
		const ctxColor: "success" | "warning" | "error" =
			pct >= 80 ? "error" : pct >= 50 ? "warning" : "success";
		const blocks = 8;
		const filled = Math.min(blocks, Math.max(1, Math.round((pct / 100) * blocks)));
		const pctStr = `${Math.round(pct)}%`;

		segs.push({
			bg: BG_CONTEXT,
			content: ` ${theme.fg(ctxColor, "█".repeat(filled))}${theme.fg("dim", "░".repeat(blocks - filled))} ${theme.fg(ctxColor, pctStr)} `,
		});

		const leftChain = renderChain(segs);

		// Right side: speed, cache, cost
		const rightParts: string[] = [];

		let speedLabel = "";
		if (isStreaming && currentBytesPerSec === 0) {
			speedLabel = "…";
		} else if (currentBytesPerSec > 0 || isStreaming) {
			speedLabel = formatBytesPerSec(currentBytesPerSec);
		}
		if (speedLabel) {
			rightParts.push(theme.fg("muted", `⏱${speedLabel}`));
		}

		if (tokCache > 0) {
			rightParts.push(theme.fg("dim", `⚡${formatTokenCount(tokCache)}`));
		}

		rightParts.push(theme.fg("warning", `$${cost.toFixed(4)} `));

		const rightText = rightParts.join(" ");
		const leftWidth = visibleWidth(leftChain);
		const rightWidth = visibleWidth(rightText);
		const pad = " ".repeat(Math.max(1, width - leftWidth - rightWidth));

		return truncateToWidth(leftChain + pad + rightText, width, "");
	}
}
