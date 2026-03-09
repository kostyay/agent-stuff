/**
 * Subagent Tool — Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Additional features:
 *   - Session persistence: continue a previous agent conversation via sessionId
 *   - Live dashboard widget: card grid showing running agent progress
 *   - Teams: filter available agents by named groups (teams.yaml)
 *   - Context tracking: per-agent context window usage percentage
 *
 * Uses JSON mode to capture structured output from subagents.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Message } from "@mariozechner/pi-ai";
import { StringEnum } from "@mariozechner/pi-ai";
import { type ExtensionAPI, type ThemeColor, getAgentDir, getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import {
	type AgentConfig,
	type AgentScope,
	type TeamConfig,
	discoverAgents,
	loadTeams,
} from "./agents.js";

// ── Constants ────────────────────────────────────

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;
const DASHBOARD_WIDGET_KEY = "subagent-dashboard";

/** Resolve session directory using the same env var as pi core (PI_CODING_AGENT_DIR). */
function getSessionDir(): string {
	return path.join(getAgentDir(), "sessions", "subagents");
}

// ── Formatting Helpers ───────────────────────────

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: ThemeColor, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

// ── Context Window Estimation ────────────────────

/**
 * Estimate the context window size from a model name.
 * Returns null if the model is unrecognized.
 */
function estimateContextWindow(model: string | undefined): number | null {
	if (!model) return null;
	const m = model.toLowerCase();
	if (m.includes("claude")) return 200_000;
	if (m.includes("gpt-4o") || m.includes("gpt-4-turbo")) return 128_000;
	if (m.includes("o1") || m.includes("o3") || m.includes("o4")) return 200_000;
	if (m.includes("gemini")) return 1_000_000;
	if (m.includes("deepseek")) return 128_000;
	return null;
}

// ── Types ────────────────────────────────────────

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
	sessionId?: string;
}

interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
}

/** Live progress emitted by a running subagent for the dashboard widget. */
interface AgentProgress {
	toolCount: number;
	lastLine: string;
	contextTokens: number;
	elapsed: number;
}

/** Tracks a single running/completed agent for the dashboard widget. */
interface RunState {
	id: number;
	agent: string;
	task: string;
	status: "running" | "done" | "error";
	progress: AgentProgress;
	model?: string;
	mode: "single" | "parallel" | "chain";
	step?: number;
}

/** Persistent session record for conversation continuation. */
interface SessionRecord {
	id: string;
	sessionFile: string;
	agentName: string;
	agentSource: "user" | "project";
	turnCount: number;
}

// ── Shared Helpers ───────────────────────────────

/** Zero-initialized usage stats, used as default for new/placeholder results. */
function zeroUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

/** Check whether a completed result represents an error. */
function isAgentError(r: SingleResult): boolean {
	return r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted";
}

/** Extract the best available error message from a result. */
function getErrorMessage(r: SingleResult): string {
	return r.errorMessage || r.stderr || getFinalOutput(r.messages) || "(no output)";
}

/** Aggregate usage stats across multiple results. */
function aggregateUsage(results: SingleResult[]): Omit<UsageStats, "contextTokens"> {
	const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
	for (const r of results) {
		total.input += r.usage.input;
		total.output += r.usage.output;
		total.cacheRead += r.usage.cacheRead;
		total.cacheWrite += r.usage.cacheWrite;
		total.cost += r.usage.cost;
		total.turns += r.usage.turns;
	}
	return total;
}

// ── Utility Functions ────────────────────────────

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

function writePromptToTempFile(agentName: string, prompt: string): { dir: string; filePath: string } {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	fs.writeFileSync(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	return { dir: tmpDir, filePath };
}

function ensureSessionDir(): void {
	fs.mkdirSync(getSessionDir(), { recursive: true });
}

function truncate(s: string, max: number): string {
	return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

// ── runSingleAgent ───────────────────────────────

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

/** Options for running a single subagent. Uses an object to stay within the 5-param limit. */
interface RunAgentOptions {
	defaultCwd: string;
	agents: AgentConfig[];
	agentName: string;
	task: string;
	cwd?: string;
	step?: number;
	signal?: AbortSignal;
	onUpdate?: OnUpdateCallback;
	makeDetails: (results: SingleResult[]) => SubagentDetails;
	sessionFile?: string;
	isResume?: boolean;
	onProgress?: (progress: AgentProgress) => void;
}

async function runSingleAgent(opts: RunAgentOptions): Promise<SingleResult> {
	const agent = opts.agents.find((a) => a.name === opts.agentName);

	if (!agent) {
		const available = opts.agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: opts.agentName,
			agentSource: "unknown",
			task: opts.task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${opts.agentName}". Available agents: ${available}.`,
			usage: zeroUsage(),
			step: opts.step,
		};
	}

	// ── Build CLI args ──
	const args: string[] = ["--mode", "json", "-p"];
	if (opts.sessionFile) {
		args.push("--session", opts.sessionFile);
		if (opts.isResume) args.push("-c");
	} else {
		args.push("--no-session");
	}
	if (agent.model) args.push("--model", agent.model);
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const currentResult: SingleResult = {
		agent: opts.agentName,
		agentSource: agent.source,
		task: opts.task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: zeroUsage(),
		model: agent.model,
		step: opts.step,
	};

	const emitUpdate = () => {
		if (opts.onUpdate) {
			opts.onUpdate({
				content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
				details: opts.makeDetails([currentResult]),
			});
		}
	};

	// ── Progress tracking state ──
	const progressState = { toolCount: 0, lastLine: "", contextTokens: 0, textChunks: [] as string[] };
	const startTime = Date.now();

	const emitProgress = () => {
		if (opts.onProgress) {
			opts.onProgress({
				toolCount: progressState.toolCount,
				lastLine: progressState.lastLine,
				contextTokens: progressState.contextTokens,
				elapsed: Date.now() - startTime,
			});
		}
	};

	try {
		if (agent.systemPrompt.trim()) {
			const tmp = writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		args.push(`Task: ${opts.task}`);
		let wasAborted = false;

		// Timer for periodic elapsed-time updates on the dashboard
		const progressTimer = setInterval(emitProgress, 1000);

		const exitCode = await new Promise<number>((resolve) => {
			const proc = spawn("pi", args, {
				cwd: opts.cwd ?? opts.defaultCwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let buffer = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				// ── Streaming text deltas → dashboard lastLine ──
				if (event.type === "message_update") {
					const delta = event.assistantMessageEvent;
					if (delta?.type === "text_delta" && delta.delta) {
						progressState.textChunks.push(delta.delta);
						const full = progressState.textChunks.join("");
						progressState.lastLine = full.split("\n").filter((l: string) => l.trim()).pop() || "";
						emitProgress();
					}
				}

				// ── Tool execution start → dashboard toolCount ──
				if (event.type === "tool_execution_start") {
					progressState.toolCount++;
					emitProgress();
				}

				// ── Completed message → accumulate usage + context tokens ──
				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					currentResult.messages.push(msg);

					if (msg.role === "assistant") {
						currentResult.usage.turns++;
						const usage = msg.usage;
						if (usage) {
							currentResult.usage.input += usage.input || 0;
							currentResult.usage.output += usage.output || 0;
							currentResult.usage.cacheRead += usage.cacheRead || 0;
							currentResult.usage.cacheWrite += usage.cacheWrite || 0;
							currentResult.usage.cost += usage.cost?.total || 0;
							currentResult.usage.contextTokens = usage.totalTokens || 0;
							progressState.contextTokens = usage.totalTokens || 0;
						}
						if (!currentResult.model && msg.model) currentResult.model = msg.model;
						if (msg.stopReason) currentResult.stopReason = msg.stopReason;
						if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
						emitProgress();
					}
					emitUpdate();
				}

				if (event.type === "tool_result_end" && event.message) {
					currentResult.messages.push(event.message as Message);
					emitUpdate();
				}
			};

			proc.stdout.on("data", (data: Buffer) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data: Buffer) => {
				currentResult.stderr += data.toString();
			});

			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				resolve(code ?? 0);
			});

			proc.on("error", () => {
				resolve(1);
			});

			if (opts.signal) {
				const killProc = () => {
					wasAborted = true;
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};
				if (opts.signal.aborted) killProc();
				else opts.signal.addEventListener("abort", killProc, { once: true });
			}
		});

		clearInterval(progressTimer);
		currentResult.exitCode = exitCode;
		if (wasAborted) throw new Error("Subagent was aborted");
		return currentResult;
	} finally {
		if (tmpPromptPath) try { fs.unlinkSync(tmpPromptPath); } catch { /* ignore */ }
		if (tmpPromptDir) try { fs.rmdirSync(tmpPromptDir); } catch { /* ignore */ }
	}
}

// ── Tool Parameter Schemas ───────────────────────

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
	sessionId: Type.Optional(
		Type.String({
			description:
				"Session ID from a previous run to continue the conversation. " +
				"The agent resumes with full prior context preserved, avoiding re-reading files.",
		}),
	),
});

// ── Extension ────────────────────────────────────

export default function subagentExtension(pi: ExtensionAPI) {
	// ── Extension State ──────────────────────────

	const sessions = new Map<string, SessionRecord>();
	const runStates = new Map<number, RunState>();
	let nextRunId = 1;
	let widgetCtx: any = null;
	let activeTeam: string | null = null;
	let teams: TeamConfig = {};

	// ── Session Helpers ──────────────────────────

	function createSessionId(agentName: string): string {
		const safeName = agentName.replace(/[^\w.-]+/g, "_");
		return `${safeName}-${Date.now()}`;
	}

	function createSession(agentName: string, agentSource: "user" | "project"): SessionRecord {
		ensureSessionDir();
		const id = createSessionId(agentName);
		const sessionFile = path.join(getSessionDir(), `${id}.jsonl`);
		const record: SessionRecord = { id, sessionFile, agentName, agentSource, turnCount: 1 };
		sessions.set(id, record);
		return record;
	}

	function cleanupAllSessions(): void {
		sessions.clear();
		const dir = getSessionDir();
		if (!fs.existsSync(dir)) return;
		try {
			for (const f of fs.readdirSync(dir)) {
				if (f.endsWith(".jsonl")) {
					try { fs.unlinkSync(path.join(dir, f)); } catch { /* ignore */ }
				}
			}
		} catch { /* ignore */ }
	}

	// ── Dashboard Widget ─────────────────────────

	function renderCard(
		state: RunState,
		colWidth: number,
		theme: { fg: (c: ThemeColor, t: string) => string; bold: (t: string) => string },
	): string[] {
		const w = colWidth - 2;
		const statusColor = state.status === "running" ? "accent"
			: state.status === "done" ? "success" : "error";
		const statusIcon = state.status === "running" ? "●"
			: state.status === "done" ? "✓" : "✗";

		const name = truncate(state.agent, w - 2);
		const nameStr = theme.fg("accent", theme.bold(name));
		const nameVis = name.length;

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

		const workText = truncate(state.progress.lastLine || "—", w - 1);
		const workLine = theme.fg("muted", workText);
		const workVis = workText.length;

		const top = "┌" + "─".repeat(w) + "┐";
		const bot = "└" + "─".repeat(w) + "┘";
		const border = (content: string, visLen: number) =>
			theme.fg("dim", "│") + content + " ".repeat(Math.max(0, w - visLen)) + theme.fg("dim", "│");

		return [
			theme.fg("dim", top),
			border(" " + nameStr, 1 + nameVis),
			border(" " + statusLine, 1 + statusVis),
			border(" " + ctxLine, 1 + ctxVis),
			border(" " + workLine, 1 + workVis),
			theme.fg("dim", bot),
		];
	}

	function updateDashboard(): void {
		if (!widgetCtx) return;

		if (runStates.size === 0) {
			widgetCtx.ui.setWidget(DASHBOARD_WIDGET_KEY, undefined);
			return;
		}

		widgetCtx.ui.setWidget(DASHBOARD_WIDGET_KEY, (_tui: any, theme: any) => ({
			render(width: number): string[] {
				const entries = Array.from(runStates.values());
				if (entries.length === 0) return [];

				const cols = Math.min(3, entries.length);
				const gap = 1;
				const colWidth = Math.max(16, Math.floor((width - gap * (cols - 1)) / cols));
				const lines: string[] = [""];

				for (let i = 0; i < entries.length; i += cols) {
					const row = entries.slice(i, i + cols);
					const cards = row.map((e) => renderCard(e, colWidth, theme));

					// Pad incomplete rows
					while (cards.length < cols) {
						cards.push(Array(6).fill(" ".repeat(colWidth)));
					}

					const cardHeight = cards[0].length;
					for (let line = 0; line < cardHeight; line++) {
						lines.push(cards.map((card) => card[line] || " ".repeat(colWidth)).join(" ".repeat(gap)));
					}
				}

				return lines;
			},
			invalidate() {},
		}));
	}

	/** Create a RunState entry and return a progress callback that updates it + the dashboard. */
	function trackAgent(
		agent: string,
		task: string,
		mode: "single" | "parallel" | "chain",
		step?: number,
	): { runId: number; onProgress: (p: AgentProgress) => void } {
		const runId = nextRunId++;
		const state: RunState = {
			id: runId,
			agent,
			task,
			status: "running",
			progress: { toolCount: 0, lastLine: "", contextTokens: 0, elapsed: 0 },
			mode,
			step,
		};
		runStates.set(runId, state);
		updateDashboard();

		const onProgress = (p: AgentProgress) => {
			state.progress = p;
			updateDashboard();
		};

		return { runId, onProgress };
	}

	/** Mark a tracked agent as completed and update the dashboard. */
	function completeTrackedAgent(runId: number, result: SingleResult): void {
		const state = runStates.get(runId);
		if (!state) return;
		state.status = result.exitCode === 0 ? "done" : "error";
		state.model = result.model;
		updateDashboard();
	}

	/** Remove all tracked agents from the dashboard. */
	function clearDashboard(): void {
		runStates.clear();
		if (widgetCtx) {
			widgetCtx.ui.setWidget(DASHBOARD_WIDGET_KEY, undefined);
		}
	}

	// ── Team Filtering ───────────────────────────

	function filterAgentsByTeam(agents: AgentConfig[]): AgentConfig[] {
		if (!activeTeam || !teams[activeTeam]) return agents;
		const members = new Set(teams[activeTeam].map((n) => n.toLowerCase()));
		return agents.filter((a) => members.has(a.name.toLowerCase()));
	}

	// ── Tool Registration ────────────────────────

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context.",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
			'Default agent scope is "user" (from ~/.pi/agent/agents).',
			'To enable project-local agents in .pi/agents, set agentScope: "both" (or "project").',
			"Session continuations: each single-mode run returns a sessionId.",
			"Pass sessionId with a new task to continue the conversation, preserving all prior context.",
		].join(" "),
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			widgetCtx = ctx;

			const agentScope: AgentScope = params.agentScope ?? "user";
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const allAgents = discovery.agents;
			const agents = filterAgentsByTeam(allAgents);
			const confirmProjectAgents = params.confirmProjectAgents ?? true;

			const makeDetails =
				(mode: "single" | "parallel" | "chain") =>
				(results: SingleResult[]): SubagentDetails => ({
					mode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					results,
				});

			// ── Session continuation ──
			if (params.sessionId) {
				const session = sessions.get(params.sessionId);
				if (!session) {
					return {
						content: [{ type: "text", text: `Unknown session: "${params.sessionId}". It may have been cleared.` }],
						details: makeDetails("single")([]),
					};
				}
				const task = params.task || "Continue from where you left off.";
				const { runId, onProgress } = trackAgent(session.agentName, task, "single");

				const result = await runSingleAgent({
					defaultCwd: ctx.cwd,
					agents: allAgents, // use unfiltered — the session's agent must exist
					agentName: session.agentName,
					task,
					cwd: params.cwd,
					signal,
					onUpdate,
					makeDetails: makeDetails("single"),
					sessionFile: session.sessionFile,
					isResume: true,
					onProgress,
				});

				result.sessionId = params.sessionId;
				session.turnCount++;
				completeTrackedAgent(runId, result);

				if (isAgentError(result)) {
					return {
						content: [{ type: "text", text: `Session continue failed: ${getErrorMessage(result)}` }],
						details: makeDetails("single")([result]),
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
					details: makeDetails("single")([result]),
				};
			}

			// ── Mode validation ──
			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			if (modeCount !== 1) {
				const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				return {
					content: [{
						type: "text",
						text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
					}],
					details: makeDetails("single")([]),
				};
			}

			// ── Project agent confirmation ──
			if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents && ctx.hasUI) {
				const requestedAgentNames = new Set<string>();
				if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
				if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
				if (params.agent) requestedAgentNames.add(params.agent);

				const projectAgentsRequested = Array.from(requestedAgentNames)
					.map((name) => agents.find((a) => a.name === name))
					.filter((a): a is AgentConfig => a?.source === "project");

				if (projectAgentsRequested.length > 0) {
					const names = projectAgentsRequested.map((a) => a.name).join(", ");
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok)
						return {
							content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
							details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
						};
				}
			}

			// ── Chain mode ──
			if (params.chain && params.chain.length > 0) {
				const results: SingleResult[] = [];
				let previousOutput = "";

				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);
					const { runId, onProgress } = trackAgent(step.agent, taskWithContext, "chain", i + 1);

					const chainUpdate: OnUpdateCallback | undefined = onUpdate
						? (partial) => {
								const currentResult = partial.details?.results[0];
								if (currentResult) {
									onUpdate({
										content: partial.content,
										details: makeDetails("chain")([...results, currentResult]),
									});
								}
							}
						: undefined;

					const result = await runSingleAgent({
						defaultCwd: ctx.cwd,
						agents,
						agentName: step.agent,
						task: taskWithContext,
						cwd: step.cwd,
						step: i + 1,
						signal,
						onUpdate: chainUpdate,
						makeDetails: makeDetails("chain"),
						onProgress,
					});
					results.push(result);
					completeTrackedAgent(runId, result);

					if (isAgentError(result)) {
						return {
							content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${getErrorMessage(result)}` }],
							details: makeDetails("chain")(results),
							isError: true,
						};
					}
					previousOutput = getFinalOutput(result.messages);
				}
				return {
					content: [{ type: "text", text: getFinalOutput(results[results.length - 1].messages) || "(no output)" }],
					details: makeDetails("chain")(results),
				};
			}

			// ── Parallel mode ──
			if (params.tasks && params.tasks.length > 0) {
				if (params.tasks.length > MAX_PARALLEL_TASKS)
					return {
						content: [{
							type: "text",
							text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
						}],
						details: makeDetails("parallel")([]),
					};

				const allResults: SingleResult[] = new Array(params.tasks.length);

				for (let i = 0; i < params.tasks.length; i++) {
					allResults[i] = {
						agent: params.tasks[i].agent,
						agentSource: "unknown",
						task: params.tasks[i].task,
						exitCode: -1,
						messages: [],
						stderr: "",
						usage: zeroUsage(),
					};
				}

				const emitParallelUpdate = () => {
					if (onUpdate) {
						const running = allResults.filter((r) => r.exitCode === -1).length;
						const done = allResults.filter((r) => r.exitCode !== -1).length;
						onUpdate({
							content: [
								{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` },
							],
							details: makeDetails("parallel")([...allResults]),
						});
					}
				};

				const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t, index) => {
					const { runId, onProgress } = trackAgent(t.agent, t.task, "parallel");

					const result = await runSingleAgent({
						defaultCwd: ctx.cwd,
						agents,
						agentName: t.agent,
						task: t.task,
						cwd: t.cwd,
						signal,
						onUpdate: (partial) => {
							if (partial.details?.results[0]) {
								allResults[index] = partial.details.results[0];
								emitParallelUpdate();
							}
						},
						makeDetails: makeDetails("parallel"),
						onProgress,
					});
					allResults[index] = result;
					completeTrackedAgent(runId, result);
					emitParallelUpdate();
					return result;
				});

				const successCount = results.filter((r) => r.exitCode === 0).length;
				const summaries = results.map((r) => {
					const output = getFinalOutput(r.messages);
					const preview = output.slice(0, 100) + (output.length > 100 ? "..." : "");
					return `[${r.agent}] ${r.exitCode === 0 ? "completed" : "failed"}: ${preview || "(no output)"}`;
				});
				return {
					content: [{
						type: "text",
						text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n")}`,
					}],
					details: makeDetails("parallel")(results),
				};
			}

			// ── Single mode ──
			if (params.agent && params.task) {
				// Create a persistent session for this run
				const agent = agents.find((a) => a.name === params.agent);
				const session = createSession(params.agent, agent?.source ?? "user");
				const { runId, onProgress } = trackAgent(params.agent, params.task, "single");

				const result = await runSingleAgent({
					defaultCwd: ctx.cwd,
					agents,
					agentName: params.agent,
					task: params.task,
					cwd: params.cwd,
					signal,
					onUpdate,
					makeDetails: makeDetails("single"),
					sessionFile: session.sessionFile,
					onProgress,
				});

				result.sessionId = session.id;
				completeTrackedAgent(runId, result);

				if (isAgentError(result)) {
					return {
						content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${getErrorMessage(result)}` }],
						details: makeDetails("single")([result]),
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
					details: makeDetails("single")([result]),
				};
			}

			const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
			return {
				content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
				details: makeDetails("single")([]),
			};
		},

		renderCall(args, theme) {
			const scope: AgentScope = args.agentScope ?? "user";

			// Session continuation
			if (args.sessionId) {
				const preview = args.task ? (args.task.length > 50 ? `${args.task.slice(0, 50)}...` : args.task) : "continue";
				return new Text(
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("warning", "continue ") +
					theme.fg("accent", args.sessionId) +
					`\n  ${theme.fg("dim", preview)}`,
					0, 0,
				);
			}

			if (args.chain && args.chain.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `chain (${args.chain.length} steps)`) +
					theme.fg("muted", ` [${scope}]`);
				for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
					const step = args.chain[i];
					const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
					const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
					text +=
						"\n  " +
						theme.fg("muted", `${i + 1}.`) +
						" " +
						theme.fg("accent", step.agent) +
						theme.fg("dim", ` ${preview}`);
				}
				if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			if (args.tasks && args.tasks.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
					theme.fg("muted", ` [${scope}]`);
				for (const t of args.tasks.slice(0, 3)) {
					const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
					text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			const agentName = args.agent || "...";
			const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
			let text =
				theme.fg("toolTitle", theme.bold("subagent ")) +
				theme.fg("accent", agentName) +
				theme.fg("muted", ` [${scope}]`);
			text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();

			const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
				const toShow = limit ? items.slice(-limit) : items;
				const skipped = limit && items.length > limit ? items.length - limit : 0;
				let text = "";
				if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
				for (const item of toShow) {
					if (item.type === "text") {
						const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
						text += `${theme.fg("toolOutput", preview)}\n`;
					} else {
						text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
					}
				}
				return text.trimEnd();
			};

			/** Append tool-call display items to a container (used in expanded views). */
			const addToolCallsToContainer = (container: Container, items: DisplayItem[]) => {
				const fgBound = theme.fg.bind(theme);
				for (const item of items) {
					if (item.type === "toolCall") {
						container.addChild(
							new Text(theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, fgBound), 0, 0),
						);
					}
				}
			};

			// ── Single result ──
			if (details.mode === "single" && details.results.length === 1) {
				const r = details.results[0];
				const isError = isAgentError(r);
				const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const displayItems = getDisplayItems(r.messages);
				const finalOutput = getFinalOutput(r.messages);
				const sessionTag = r.sessionId ? theme.fg("dim", ` session:${r.sessionId}`) : "";

				if (expanded) {
					const container = new Container();
					let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}${sessionTag}`;
					if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
					container.addChild(new Text(header, 0, 0));
					if (isError && r.errorMessage)
						container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
					container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
					if (displayItems.length === 0 && !finalOutput) {
						container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
					} else {
						addToolCallsToContainer(container, displayItems);
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}
					}
					const usageStr = formatUsageStats(r.usage, r.model);
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
					}
					return container;
				}

				let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}${sessionTag}`;
				if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
				if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
				else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
				else {
					text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
					if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				}
				const usageStr = formatUsageStats(r.usage, r.model);
				if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
				return new Text(text, 0, 0);
			}

			// ── Chain result ──
			if (details.mode === "chain") {
				const successCount = details.results.filter((r) => r.exitCode === 0).length;
				const icon = successCount === details.results.length ? theme.fg("success", "✓") : theme.fg("error", "✗");

				if (expanded) {
					const container = new Container();
					container.addChild(
						new Text(
							icon +
								" " +
								theme.fg("toolTitle", theme.bold("chain ")) +
								theme.fg("accent", `${successCount}/${details.results.length} steps`),
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(
								`${theme.fg("muted", `─── Step ${r.step}: `) + theme.fg("accent", r.agent)} ${rIcon}`,
								0,
								0,
							),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));
						addToolCallsToContainer(container, displayItems);

						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const stepUsage = formatUsageStats(r.usage, r.model);
						if (stepUsage) container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed chain view
				let text =
					icon +
					" " +
					theme.fg("toolTitle", theme.bold("chain ")) +
					theme.fg("accent", `${successCount}/${details.results.length} steps`);
				for (const r of details.results) {
					const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				const usageStr = formatUsageStats(aggregateUsage(details.results));
				if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			// ── Parallel result ──
			if (details.mode === "parallel") {
				const running = details.results.filter((r) => r.exitCode === -1).length;
				const successCount = details.results.filter((r) => r.exitCode === 0).length;
				const failCount = details.results.filter((r) => r.exitCode > 0).length;
				const isRunning = running > 0;
				const icon = isRunning
					? theme.fg("warning", "⏳")
					: failCount > 0
						? theme.fg("warning", "◐")
						: theme.fg("success", "✓");
				const status = isRunning
					? `${successCount + failCount}/${details.results.length} done, ${running} running`
					: `${successCount}/${details.results.length} tasks`;

				if (expanded && !isRunning) {
					const container = new Container();
					container.addChild(
						new Text(
							`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(`${theme.fg("muted", "─── ") + theme.fg("accent", r.agent)} ${rIcon}`, 0, 0),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));
						addToolCallsToContainer(container, displayItems);

						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const taskUsage = formatUsageStats(r.usage, r.model);
						if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed parallel view (or still running)
				let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
				for (const r of details.results) {
					const rIcon =
						r.exitCode === -1
							? theme.fg("warning", "⏳")
							: r.exitCode === 0
								? theme.fg("success", "✓")
								: theme.fg("error", "✗");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0)
						text += `\n${theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				if (!isRunning) {
					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				}
				if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
	});

	// ── Commands ─────────────────────────────────

	pi.registerCommand("team", {
		description: "Select an agent team, or /team clear to remove filter",
		handler: async (args, ctx) => {
			widgetCtx = ctx;

			// Reload teams on each invocation
			const discovery = discoverAgents(ctx.cwd, "both");
			teams = loadTeams(discovery.projectAgentsDir, "both");

			const arg = args?.trim();

			if (arg === "clear") {
				activeTeam = null;
				ctx.ui.notify("Team filter cleared — all agents available", "info");
				return;
			}

			if (arg && teams[arg]) {
				activeTeam = arg;
				ctx.ui.notify(`Team: ${arg} — ${teams[arg].join(", ")}`, "info");
				return;
			}

			const teamNames = Object.keys(teams);
			if (teamNames.length === 0) {
				ctx.ui.notify(
					"No teams defined. Add teams.yaml to ~/.pi/agent/agents/ or .pi/agents/",
					"warning",
				);
				return;
			}

			const options = [
				"(none) — show all agents",
				...teamNames.map((name) => `${name} — ${teams[name].join(", ")}`),
			];

			const choice = await ctx.ui.select("Select Team", options);
			if (choice === undefined) return;

			const idx = options.indexOf(choice);
			if (idx === 0) {
				activeTeam = null;
				ctx.ui.notify("Team filter cleared — all agents available", "info");
			} else {
				activeTeam = teamNames[idx - 1];
				ctx.ui.notify(`Team: ${activeTeam} — ${teams[activeTeam].join(", ")}`, "info");
			}
		},
	});

	pi.registerCommand("sessions", {
		description: "List active subagent sessions available for continuation",
		handler: async (_args, ctx) => {
			if (sessions.size === 0) {
				ctx.ui.notify("No active sessions.", "info");
				return;
			}
			const lines = Array.from(sessions.values()).map((s) =>
				`${s.id} — ${s.agentName} (${s.agentSource}, ${s.turnCount} turn${s.turnCount > 1 ? "s" : ""})`,
			);
			ctx.ui.notify(`Sessions:\n${lines.join("\n")}`, "info");
		},
	});

	// ── Event Handlers ───────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		widgetCtx = ctx;
		cleanupAllSessions();
		clearDashboard();
		nextRunId = 1;
		activeTeam = null;

		// Pre-load teams so /team works without manual reload
		const discovery = discoverAgents(ctx.cwd, "both");
		teams = loadTeams(discovery.projectAgentsDir, "both");
	});
}
