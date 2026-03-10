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

import { StringEnum } from "@mariozechner/pi-ai";
import { type ExtensionAPI, type Theme, getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text, type TUI } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ControlChannelServer } from "../../lib/control-channel.ts";
import { AgentManagerComponent } from "./agent-manager.js";
import {
	type AgentConfig,
	type AgentScope,
	type TeamConfig,
	discoverAgents,
	loadTeams,
} from "./agents.js";
import { renderCard } from "./dashboard.js";
import { formatToolCall, formatUsageStats } from "./formatting.js";
import { LogViewerComponent } from "./log-viewer.js";
import { runSingleAgent } from "./runner.js";
import type {
	AgentManagerResult,
	AgentProgress,
	DisplayItem,
	OnUpdateCallback,
	RunState,
	SessionRecord,
	SingleResult,
	SubagentDetails,
} from "./types.js";
import {
	aggregateUsage,
	appendOutputPaths,
	ensureSessionDir,
	getDisplayItems,
	getErrorMessage,
	getFinalOutput,
	getSessionDir,
	isAgentError,
	mapWithConcurrencyLimit,
	parseAgentSegments,
	resultIcon,
	zeroUsage,
} from "./utils.js";

// ── Constants ────────────────────────────────────

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;
const DASHBOARD_WIDGET_KEY = "subagent-dashboard";
const BUNDLED_AGENTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "agents");

// ── Multi-Agent Completions ──────────────────────

/**
 * Build an autocomplete provider for multi-agent commands (/chain, /parallel).
 *
 * Completes agent names at each segment boundary (after `->` or at start).
 * Once the user has typed a space after an agent name (entering the task),
 * completions stop for that segment.
 */
function makeMultiAgentCompletions(
	getCwd: () => string,
): (prefix: string) => { value: string; label: string }[] | null {
	return (prefix: string) => {
		const agents = discoverAgents(getCwd(), "both", BUNDLED_AGENTS_DIR).agents;

		// Find the last segment (after the final `->`)
		const lastArrow = prefix.lastIndexOf(" -> ");
		const segment = lastArrow !== -1 ? prefix.slice(lastArrow + 4) : prefix;

		// If segment already contains a space, user is typing the task — no completions
		if (segment.includes(" ")) return null;

		// Complete agent names for the current segment
		const beforeSegment = lastArrow !== -1 ? prefix.slice(0, lastArrow + 4) : "";
		return agents
			.filter((a) => a.name.startsWith(segment))
			.map((a) => ({
				value: `${beforeSegment}${a.name}`,
				label: `${a.name} — ${a.description}`,
			}));
	};
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
	let baseCwd = process.cwd();
	let dashboardAutoClearTimer: ReturnType<typeof setTimeout> | null = null;
	const DASHBOARD_AUTO_CLEAR_MS = 10_000;

	// ── Control Channel ──────────────────────────

	const controlChannel = new ControlChannelServer((msg) => {
		const state = runStates.get(msg.id);
		if (!state) return;
		if (msg.type === "session_name" && typeof msg.name === "string") {
			state.description = msg.name;
			updateDashboard();
		}
	});
	controlChannel.start().catch(() => {});

	// ── Session Helpers ──────────────────────────

	function createSessionId(agentName: string): string {
		const safeName = agentName.replace(/[^\w.-]+/g, "_");
		return `${safeName}-${Date.now()}`;
	}

	function createSession(agentName: string, agentSource: "user" | "project" | "bundled"): SessionRecord {
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
					const cards = row.map((e, j) => renderCard(e, colWidth, theme, i + j + 1));

					// Pad incomplete rows
					while (cards.length < cols) {
						cards.push(Array(6).fill(" ".repeat(colWidth)));
					}

					const cardHeight = cards[0].length;
					for (let line = 0; line < cardHeight; line++) {
						lines.push(cards.map((card) => card[line] || " ".repeat(colWidth)).join(" ".repeat(gap)));
					}
				}

				const hasRunning = entries.some((e) => e.status === "running");
				if (hasRunning) {
					lines.push(theme.fg("dim", "  Ctrl+Shift+1–9: view agent logs"));
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
		model?: string,
	): { runId: number; onProgress: (p: AgentProgress) => void; onRawEvent: (event: Record<string, unknown>) => void } {
		cancelDashboardAutoClear();
		const runId = nextRunId++;
		const state: RunState = {
			id: runId,
			agent,
			task,
			status: "running",
			progress: { toolCount: 0, lastLine: "", contextTokens: 0, elapsed: 0 },
			model,
			mode,
			step,
			logEntries: [],
			logPartial: "",
		};
		runStates.set(runId, state);
		updateDashboard();

		const onProgress = (p: AgentProgress) => {
			state.progress = p;
			updateDashboard();
		};

		/** Flush any buffered partial text into a log entry. */
		const flushPartial = () => {
			if (state.logPartial) {
				state.logEntries.push({ kind: "text", line: state.logPartial });
				state.logPartial = "";
			}
		};

		/** Process a raw JSON event from the subagent into structured log entries. */
		const onRawEvent = (event: Record<string, unknown>) => {
			// Streaming text deltas
			if (event.type === "message_update") {
				const delta = event.assistantMessageEvent as Record<string, unknown> | undefined;
				if (delta?.type === "text_delta" && typeof delta.delta === "string") {
					const text = state.logPartial + delta.delta;
					const lines = text.split("\n");
					state.logPartial = lines.pop() ?? "";
					for (const line of lines) {
						state.logEntries.push({ kind: "text", line });
					}
				}
				return;
			}

			// Tool execution start — extract tool call info from the event
			if (event.type === "tool_execution_start") {
				flushPartial();
				const name = (event.toolName ?? "unknown") as string;
				const args = (event.args ?? {}) as Record<string, unknown>;
				state.logEntries.push({ kind: "toolCall", name, args });
				return;
			}

			// Tool result — show truncated output
			if (event.type === "tool_result_end" || event.type === "tool_execution_end") {
				const extractContent = (content: Array<Record<string, unknown>> | undefined) => {
					if (!content) return;
					for (const part of content) {
						if (part.type === "text" && typeof part.text === "string") {
							const lines = part.text.split("\n");
							const preview = lines.slice(0, 8);
							if (lines.length > 8) preview.push(`... (${lines.length - 8} more lines)`);
							state.logEntries.push({ kind: "toolOutput", text: preview.join("\n") });
						}
					}
				};

				// tool_execution_end has { result, isError }
				if (event.result && typeof event.result === "object") {
					const result = event.result as Record<string, unknown>;
					extractContent(result.content as Array<Record<string, unknown>> | undefined);
				}
				// tool_result_end has { message } with content
				const msg = event.message as Record<string, unknown> | undefined;
				if (msg?.content) {
					extractContent(msg.content as Array<Record<string, unknown>>);
				}
				return;
			}

			// Message complete — flush text, add separator between turns
			if (event.type === "message_end") {
				flushPartial();
				state.logEntries.push({ kind: "separator" });
			}
		};

		return { runId, onProgress, onRawEvent };
	}

	/** Cancel any pending dashboard auto-clear timer. */
	function cancelDashboardAutoClear(): void {
		if (dashboardAutoClearTimer) {
			clearTimeout(dashboardAutoClearTimer);
			dashboardAutoClearTimer = null;
		}
	}

	/** Schedule dashboard auto-clear if all tracked agents are finished. */
	function scheduleDashboardAutoClear(): void {
		cancelDashboardAutoClear();
		const allDone = Array.from(runStates.values()).every((s) => s.status !== "running");
		if (!allDone) return;
		dashboardAutoClearTimer = setTimeout(() => {
			dashboardAutoClearTimer = null;
			clearDashboard();
		}, DASHBOARD_AUTO_CLEAR_MS);
	}

	/** Mark a tracked agent as completed and update the dashboard. */
	function completeTrackedAgent(runId: number, result: SingleResult): void {
		const state = runStates.get(runId);
		if (!state) return;
		state.status = result.stopReason === "aborted" ? "aborted"
			: result.exitCode === 0 ? "done" : "error";
		state.model = result.model;
		updateDashboard();
		scheduleDashboardAutoClear();
	}

	/** Remove all tracked agents from the dashboard. */
	function clearDashboard(): void {
		cancelDashboardAutoClear();
		runStates.clear();
		if (widgetCtx) {
			widgetCtx.ui.setWidget(DASHBOARD_WIDGET_KEY, undefined);
		}
	}

	// ── Log Viewer ──────────────────────────────

	/** Get the RunState at 1-based display index, or undefined if out of range. */
	function getRunStateByIndex(index: number): RunState | undefined {
		const entries = Array.from(runStates.values());
		return entries[index - 1];
	}

	/** Open a log viewer overlay for the agent at the given 1-based display index. */
	async function openLogViewer(displayIndex: number, ctx: { ui: any; hasUI: boolean }): Promise<void> {
		if (!ctx.hasUI) return;

		const state = getRunStateByIndex(displayIndex);
		if (!state) {
			ctx.ui.notify(`No agent at index ${displayIndex}`, "warning");
			return;
		}

		await ctx.ui.custom(
			(tui: TUI, theme: Theme, _kb: unknown, done: () => void) =>
				new LogViewerComponent(tui, theme, state, displayIndex, done),
			{
				overlay: true,
				overlayOptions: { anchor: "center", width: "80%", maxHeight: "80%" },
			},
		);
	}

	// ── Team Filtering ───────────────────────────

	function filterAgentsByTeam(agents: AgentConfig[]): AgentConfig[] {
		if (!activeTeam || !teams[activeTeam]) return agents;
		const members = new Set(teams[activeTeam].map((n) => n.toLowerCase()));
		return agents.filter((a) => members.has(a.name.toLowerCase()));
	}

	// ── Execute Mode Handlers ────────────────────

	/** Bundled context passed to each execute mode handler to stay within the 5-param limit. */
	interface ModeArgs {
		cwd: string;
		agents: AgentConfig[];
		allAgents: AgentConfig[];
		currentModelId: string | undefined;
		agentScope: AgentScope;
		projectAgentsDir: string | null;
		signal?: AbortSignal;
		onUpdate?: OnUpdateCallback;
	}

	/** Build a SubagentDetails factory for a given execution mode. */
	function buildDetails(
		mode: "single" | "parallel" | "chain",
		args: ModeArgs,
	): (results: SingleResult[]) => SubagentDetails {
		return (results) => ({
			mode,
			agentScope: args.agentScope,
			projectAgentsDir: args.projectAgentsDir,
			results,
		});
	}

	/** Handle session continuation — resume a previous agent conversation. */
	async function executeSessionContinue(
		sessionId: string,
		task: string | undefined,
		cwd: string | undefined,
		args: ModeArgs,
	) {
		const details = buildDetails("single", args);
		const session = sessions.get(sessionId);
		if (!session) {
			return {
				content: [{ type: "text" as const, text: `Unknown session: "${sessionId}". It may have been cleared.` }],
				details: details([]),
			};
		}

		const resolvedTask = task || "Continue from where you left off.";
		const sessionAgent = args.allAgents.find((a) => a.name === session.agentName);
		const { runId, onProgress, onRawEvent } = trackAgent(
			session.agentName, resolvedTask, "single", undefined, args.currentModelId ?? sessionAgent?.model,
		);

		const result = await runSingleAgent({
			defaultCwd: args.cwd, agents: args.allAgents, agentName: session.agentName,
			task: resolvedTask, cwd, signal: args.signal, onUpdate: args.onUpdate,
			makeDetails: details, sessionFile: session.sessionFile, isResume: true,
			onProgress, onRawEvent, modelOverride: args.currentModelId,
			extraEnv: controlChannel.childEnv(runId),
		});

		result.sessionId = sessionId;
		session.turnCount++;
		completeTrackedAgent(runId, result);

		const logFooter = (text: string) => appendOutputPaths(text, [result], sessions);

		if (isAgentError(result)) {
			return {
				content: [{ type: "text" as const, text: logFooter(`Session continue failed: ${getErrorMessage(result)}`) }],
				details: details([result]),
				isError: true,
			};
		}
		return {
			content: [{ type: "text" as const, text: logFooter(getFinalOutput(result.messages) || "(no output)") }],
			details: details([result]),
		};
	}

	/** Handle chain mode — sequential agent execution with {previous} substitution. */
	async function executeChainMode(
		chain: Array<{ agent: string; task: string; cwd?: string }>,
		args: ModeArgs,
	) {
		const details = buildDetails("chain", args);
		const results: SingleResult[] = [];
		let previousOutput = "";

		for (let i = 0; i < chain.length; i++) {
			const step = chain[i];
			const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);
			const chainAgent = args.agents.find((a) => a.name === step.agent);
			const session = createSession(step.agent, chainAgent?.source ?? "user");
			const { runId, onProgress, onRawEvent } = trackAgent(
				step.agent, taskWithContext, "chain", i + 1, args.currentModelId ?? chainAgent?.model,
			);

			const chainUpdate: OnUpdateCallback | undefined = args.onUpdate
				? (partial) => {
						const currentResult = partial.details?.results[0];
						if (currentResult) {
							args.onUpdate!({
								content: partial.content,
								details: details([...results, currentResult]),
							});
						}
					}
				: undefined;

			const result = await runSingleAgent({
				defaultCwd: args.cwd, agents: args.agents, agentName: step.agent,
				task: taskWithContext, cwd: step.cwd, step: i + 1, signal: args.signal,
				onUpdate: chainUpdate, makeDetails: details, onProgress, onRawEvent,
				modelOverride: args.currentModelId, extraEnv: controlChannel.childEnv(runId),
				sessionFile: session.sessionFile,
			});
			result.sessionId = session.id;
			results.push(result);
			completeTrackedAgent(runId, result);

			if (isAgentError(result)) {
				const msg = `Chain stopped at step ${i + 1} (${step.agent}): ${getErrorMessage(result)}`;
				return {
					content: [{ type: "text" as const, text: appendOutputPaths(msg, results, sessions) }],
					details: details(results),
					isError: true,
				};
			}
			previousOutput = getFinalOutput(result.messages);
		}

		const lastOutput = getFinalOutput(results[results.length - 1].messages) || "(no output)";
		return {
			content: [{ type: "text" as const, text: appendOutputPaths(lastOutput, results, sessions) }],
			details: details(results),
		};
	}

	/** Handle parallel mode — concurrent agent execution with bounded concurrency. */
	async function executeParallelMode(
		tasks: Array<{ agent: string; task: string; cwd?: string }>,
		args: ModeArgs,
	) {
		const details = buildDetails("parallel", args);

		if (tasks.length > MAX_PARALLEL_TASKS) {
			return {
				content: [{ type: "text" as const, text: `Too many parallel tasks (${tasks.length}). Max is ${MAX_PARALLEL_TASKS}.` }],
				details: details([]),
			};
		}

		const allResults: SingleResult[] = tasks.map((t) => ({
			agent: t.agent, agentSource: "unknown" as const, task: t.task,
			exitCode: -1, messages: [], stderr: "", usage: zeroUsage(),
		}));

		const emitUpdate = () => {
			if (!args.onUpdate) return;
			const running = allResults.filter((r) => r.exitCode === -1).length;
			const done = allResults.filter((r) => r.exitCode !== -1).length;
			args.onUpdate({
				content: [{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` }],
				details: details([...allResults]),
			});
		};

		// Pre-create sessions for each task so JSONL logs are captured
		const taskSessions = tasks.map((t) => {
			const agent = args.agents.find((a) => a.name === t.agent);
			return createSession(t.agent, agent?.source ?? "user");
		});

		const results = await mapWithConcurrencyLimit(tasks, MAX_CONCURRENCY, async (t, index) => {
			const parallelAgent = args.agents.find((a) => a.name === t.agent);
			const { runId, onProgress, onRawEvent } = trackAgent(
				t.agent, t.task, "parallel", undefined, args.currentModelId ?? parallelAgent?.model,
			);

			const result = await runSingleAgent({
				defaultCwd: args.cwd, agents: args.agents, agentName: t.agent,
				task: t.task, cwd: t.cwd, signal: args.signal,
				onUpdate: (partial) => {
					if (partial.details?.results[0]) {
						allResults[index] = partial.details.results[0];
						emitUpdate();
					}
				},
				makeDetails: details, onProgress, onRawEvent,
				modelOverride: args.currentModelId, extraEnv: controlChannel.childEnv(runId),
				sessionFile: taskSessions[index].sessionFile,
			});
			result.sessionId = taskSessions[index].id;
			allResults[index] = result;
			completeTrackedAgent(runId, result);
			emitUpdate();
			return result;
		});

		const successCount = results.filter((r) => r.exitCode === 0).length;
		const summaries = results.map((r) => {
			const output = getFinalOutput(r.messages);
			const preview = output.slice(0, 100) + (output.length > 100 ? "..." : "");
			return `[${r.agent}] ${r.exitCode === 0 ? "completed" : "failed"}: ${preview || "(no output)"}`;
		});
		const summary = `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n")}`;
		return {
			content: [{ type: "text" as const, text: appendOutputPaths(summary, results, sessions) }],
			details: details(results),
		};
	}

	/** Handle single mode — run one agent with session tracking. */
	async function executeSingleMode(
		agentName: string,
		task: string,
		cwd: string | undefined,
		args: ModeArgs,
	) {
		const details = buildDetails("single", args);
		const agent = args.agents.find((a) => a.name === agentName);
		const session = createSession(agentName, agent?.source ?? "user");
		const { runId, onProgress, onRawEvent } = trackAgent(
			agentName, task, "single", undefined, args.currentModelId ?? agent?.model,
		);

		const result = await runSingleAgent({
			defaultCwd: args.cwd, agents: args.agents, agentName, task, cwd,
			signal: args.signal, onUpdate: args.onUpdate, makeDetails: details,
			sessionFile: session.sessionFile, onProgress, onRawEvent,
			modelOverride: args.currentModelId, extraEnv: controlChannel.childEnv(runId),
		});

		result.sessionId = session.id;
		completeTrackedAgent(runId, result);

		const logFooter = (text: string) => appendOutputPaths(text, [result], sessions);

		if (isAgentError(result)) {
			return {
				content: [{ type: "text" as const, text: logFooter(`Agent ${result.stopReason || "failed"}: ${getErrorMessage(result)}`) }],
				details: details([result]),
				isError: true,
			};
		}
		return {
			content: [{ type: "text" as const, text: logFooter(getFinalOutput(result.messages) || "(no output)") }],
			details: details([result]),
		};
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

			const currentModelId = ctx.model?.id;
			const agentScope: AgentScope = params.agentScope ?? "user";
			const discovery = discoverAgents(ctx.cwd, agentScope, BUNDLED_AGENTS_DIR);
			const allAgents = discovery.agents;
			const agents = filterAgentsByTeam(allAgents);
			const confirmProjectAgents = params.confirmProjectAgents ?? true;

			const modeArgs: ModeArgs = {
				cwd: ctx.cwd, agents, allAgents, currentModelId,
				agentScope, projectAgentsDir: discovery.projectAgentsDir,
				signal, onUpdate,
			};

			// ── Session continuation ──
			if (params.sessionId) {
				return executeSessionContinue(params.sessionId, params.task, params.cwd, modeArgs);
			}

			// ── Mode validation ──
			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			if (modeCount !== 1) {
				const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				return {
					content: [{ type: "text", text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}` }],
					details: buildDetails("single", modeArgs)([]),
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
					if (!ok) {
						const mode = hasChain ? "chain" : hasTasks ? "parallel" : "single";
						return {
							content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
							details: buildDetails(mode, modeArgs)([]),
						};
					}
				}
			}

			// ── Mode dispatch ──
			if (params.chain && params.chain.length > 0) return executeChainMode(params.chain, modeArgs);
			if (params.tasks && params.tasks.length > 0) return executeParallelMode(params.tasks, modeArgs);
			if (params.agent && params.task) return executeSingleMode(params.agent, params.task, params.cwd, modeArgs);

			const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
			return {
				content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
				details: buildDetails("single", modeArgs)([]),
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

			const fgBound = theme.fg.bind(theme);
			const renderCtx: RenderCtx = {
				theme,
				mdTheme: getMarkdownTheme(),
				rIcon: (r: SingleResult) => resultIcon(r, fgBound),
				renderItems(items: DisplayItem[], limit?: number) {
					const toShow = limit ? items.slice(-limit) : items;
					const skipped = limit && items.length > limit ? items.length - limit : 0;
					let text = "";
					if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
					for (const item of toShow) {
						if (item.type === "text") {
							const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
							text += `${theme.fg("toolOutput", preview)}\n`;
						} else {
							text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, fgBound)}\n`;
						}
					}
					return text.trimEnd();
				},
				addToolCalls(container: Container, items: DisplayItem[]) {
					for (const item of items) {
						if (item.type === "toolCall") {
							container.addChild(
								new Text(theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, fgBound), 0, 0),
							);
						}
					}
				},
			};

			// ── Single result ──
			if (details.mode === "single" && details.results.length === 1) {
				return renderSingleResult(details.results[0], expanded, renderCtx);
			}

			// ── Chain result ──
			if (details.mode === "chain") {
				return renderChainResult(details.results, expanded, renderCtx);
			}

			// ── Parallel result ──
			if (details.mode === "parallel") {
				return renderParallelResult(details.results, expanded, renderCtx);
			}

			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
	});

	// ── Result Renderers ─────────────────────────

	/** Shared context for result rendering, avoids passing 8+ params to each renderer. */
	interface RenderCtx {
		theme: Theme;
		mdTheme: ReturnType<typeof getMarkdownTheme>;
		rIcon: (r: SingleResult) => string;
		renderItems: (items: DisplayItem[], limit?: number) => string;
		addToolCalls: (container: Container, items: DisplayItem[]) => void;
	}

	function renderSingleResult(r: SingleResult, expanded: boolean, ctx: RenderCtx): Text | Container {
		const { theme, mdTheme, rIcon } = ctx;
		const isError = isAgentError(r);
		const icon = rIcon(r);
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
				ctx.addToolCalls(container, displayItems);
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
			text += `\n${ctx.renderItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
			if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
		}
		const usageStr = formatUsageStats(r.usage, r.model);
		if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
		return new Text(text, 0, 0);
	}

	function renderChainResult(results: SingleResult[], expanded: boolean, ctx: RenderCtx): Text | Container {
		const { theme, mdTheme, rIcon } = ctx;
		const successCount = results.filter((r) => r.exitCode === 0).length;
		const icon = successCount === results.length ? theme.fg("success", "✓") : theme.fg("error", "✗");

		if (expanded) {
			const container = new Container();
			container.addChild(
				new Text(
					icon + " " + theme.fg("toolTitle", theme.bold("chain ")) +
					theme.fg("accent", `${successCount}/${results.length} steps`),
					0, 0,
				),
			);

			for (const r of results) {
				const displayItems = getDisplayItems(r.messages);
				const finalOutput = getFinalOutput(r.messages);

				container.addChild(new Spacer(1));
				container.addChild(
					new Text(
						`${theme.fg("muted", `─── Step ${r.step}: `) + theme.fg("accent", r.agent)} ${rIcon(r)}`,
						0, 0,
					),
				);
				container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));
				ctx.addToolCalls(container, displayItems);

				if (finalOutput) {
					container.addChild(new Spacer(1));
					container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
				}

				const stepUsage = formatUsageStats(r.usage, r.model);
				if (stepUsage) container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
			}

			const usageStr = formatUsageStats(aggregateUsage(results));
			if (usageStr) {
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
			}
			return container;
		}

		// Collapsed chain view
		let text = icon + " " + theme.fg("toolTitle", theme.bold("chain ")) +
			theme.fg("accent", `${successCount}/${results.length} steps`);
		for (const r of results) {
			const displayItems = getDisplayItems(r.messages);
			text += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${rIcon(r)}`;
			if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
			else text += `\n${ctx.renderItems(displayItems, 5)}`;
		}
		const usageStr = formatUsageStats(aggregateUsage(results));
		if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
		text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
		return new Text(text, 0, 0);
	}

	function renderParallelResult(results: SingleResult[], expanded: boolean, ctx: RenderCtx): Text | Container {
		const { theme, mdTheme, rIcon } = ctx;
		const running = results.filter((r) => r.exitCode === -1).length;
		const successCount = results.filter((r) => r.exitCode === 0).length;
		const failCount = results.filter((r) => r.exitCode > 0).length;
		const isRunning = running > 0;
		const icon = isRunning
			? theme.fg("warning", "⏳")
			: failCount > 0
				? theme.fg("warning", "◐")
				: theme.fg("success", "✓");
		const status = isRunning
			? `${successCount + failCount}/${results.length} done, ${running} running`
			: `${successCount}/${results.length} tasks`;

		if (expanded && !isRunning) {
			const container = new Container();
			container.addChild(
				new Text(
					`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
					0, 0,
				),
			);

			for (const r of results) {
				const displayItems = getDisplayItems(r.messages);
				const finalOutput = getFinalOutput(r.messages);

				container.addChild(new Spacer(1));
				container.addChild(
					new Text(`${theme.fg("muted", "─── ") + theme.fg("accent", r.agent)} ${rIcon(r)}`, 0, 0),
				);
				container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));
				ctx.addToolCalls(container, displayItems);

				if (finalOutput) {
					container.addChild(new Spacer(1));
					container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
				}

				const taskUsage = formatUsageStats(r.usage, r.model);
				if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
			}

			const usageStr = formatUsageStats(aggregateUsage(results));
			if (usageStr) {
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
			}
			return container;
		}

		// Collapsed parallel view (or still running)
		let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
		for (const r of results) {
			const displayItems = getDisplayItems(r.messages);
			text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon(r)}`;
			if (displayItems.length === 0)
				text += `\n${theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}`;
			else text += `\n${ctx.renderItems(displayItems, 5)}`;
		}
		if (!isRunning) {
			const usageStr = formatUsageStats(aggregateUsage(results));
			if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
		}
		if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
		return new Text(text, 0, 0);
	}

	// ── Commands ─────────────────────────────────

	pi.registerCommand("team", {
		description: "Select an agent team, or /team clear to remove filter",
		handler: async (args, ctx) => {
			widgetCtx = ctx;

			// Reload teams on each invocation
			const discovery = discoverAgents(ctx.cwd, "both", BUNDLED_AGENTS_DIR);
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

	/** Send a structured instruction for the LLM to invoke the subagent tool. */
	function sendSubagentInstruction(mode: string, paramsJson: string): void {
		pi.sendUserMessage(
			`Use the subagent tool in ${mode} mode with exactly these parameters:\n` +
			`${paramsJson}\n\n` +
			`Do NOT modify the agents or tasks. Pass them exactly as specified.`,
		);
	}

	/**
	 * Spawn an agent directly from a command handler, bypassing the LLM.
	 *
	 * Used when the main agent is busy (e.g. already executing a subagent tool call)
	 * so that additional agents can run in parallel.
	 */
	function spawnAgentInBackground(
		agentName: string,
		task: string,
		cwd: string,
		ctx: { ui: { notify: (msg: string, level?: "info" | "warning" | "error") => void } },
	): void {
		const discovery = discoverAgents(cwd, "both", BUNDLED_AGENTS_DIR);
		const agents = filterAgentsByTeam(discovery.agents);
		const agent = agents.find((a) => a.name === agentName);

		if (!agent) {
			ctx.ui.notify(`Unknown agent: "${agentName}"`, "error");
			return;
		}

		const session = createSession(agentName, agent.source);
		const { runId, onProgress, onRawEvent } = trackAgent(
			agentName, task, "single", undefined, agent.model,
		);

		ctx.ui.notify(`Background: started ${agentName}`, "info");

		runSingleAgent({
			defaultCwd: cwd,
			agents,
			agentName,
			task,
			makeDetails: (results) => ({
				mode: "single",
				agentScope: "both",
				projectAgentsDir: discovery.projectAgentsDir,
				results,
			}),
			sessionFile: session.sessionFile,
			onProgress,
			onRawEvent,
			extraEnv: controlChannel.childEnv(runId),
		}).then((result) => {
			result.sessionId = session.id;
			completeTrackedAgent(runId, result);
			const status = isAgentError(result) ? "failed" : "completed";
			const level = isAgentError(result) ? "error" : "info";
			ctx.ui.notify(`Background: ${agentName} ${status}`, level);
		}).catch((err) => {
			completeTrackedAgent(runId, {
				agent: agentName,
				agentSource: agent.source,
				task,
				exitCode: 1,
				messages: [],
				stderr: String(err),
				usage: zeroUsage(),
			});
			ctx.ui.notify(`Background: ${agentName} error: ${err}`, "error");
		});
	}

	/** Validate that all named agents exist. Returns the first unknown name, or null. */
	function findUnknownAgent(names: string[], cwd: string): string | null {
		const agents = discoverAgents(cwd, "both", BUNDLED_AGENTS_DIR).agents;
		for (const name of names) {
			if (!agents.find((a) => a.name === name)) return name;
		}
		return null;
	}

	pi.registerCommand("clean-agent", {
		description: "Remove the subagent dashboard widget from the footer",
		handler: async (_args, ctx) => {
			widgetCtx = ctx;
			clearDashboard();
			ctx.ui.notify("Agent dashboard cleared", "info");
		},
	});

	pi.registerCommand("agents", {
		description: "Browse and launch agents interactively",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("Agent manager requires interactive mode", "error");
				return;
			}
			const agents = discoverAgents(ctx.cwd, "both", BUNDLED_AGENTS_DIR).agents;
			const result = await ctx.ui.custom<AgentManagerResult>(
				(tui, theme, _kb, done) => new AgentManagerComponent(tui, theme, agents, ctx.modelRegistry, done),
				{ overlay: true, overlayOptions: { anchor: "center", width: 84, maxHeight: "80%" } },
			);
			if (!result) return;

			if (result.action === "run") {
				if (ctx.isIdle()) {
					sendSubagentInstruction("single", `agent: ${JSON.stringify(result.agent)}, task: ${JSON.stringify(result.task)}`);
				} else {
					spawnAgentInBackground(result.agent, result.task, ctx.cwd, ctx);
				}
			} else if (result.action === "chain") {
				const chain = result.agents.map((name, i) => ({
					agent: name,
					task: i === 0 ? result.task : undefined,
				}));
				sendSubagentInstruction("chain", `chain: ${JSON.stringify(chain)}`);
			} else if (result.action === "parallel") {
				sendSubagentInstruction("parallel", `tasks: ${JSON.stringify(result.tasks)}`);
			}
		},
	});

	/** Autocomplete provider for single-agent commands (/run). Completes only the first token. */
	const singleAgentCompletions = (prefix: string): { value: string; label: string }[] | null => {
		if (prefix.includes(" ")) return null;
		const agents = discoverAgents(baseCwd, "both", BUNDLED_AGENTS_DIR).agents;
		return agents
			.filter((a) => a.name.startsWith(prefix))
			.map((a) => ({ value: a.name, label: `${a.name} — ${a.description}` }));
	};

	/** Autocomplete provider for multi-agent commands (/chain, /parallel). */
	const multiAgentCompletions = makeMultiAgentCompletions(() => baseCwd);

	pi.registerCommand("run", {
		description: 'Run a single agent: /run scout "scan the codebase for auth code"',
		getArgumentCompletions: singleAgentCompletions,
		handler: async (args, ctx) => {
			const input = args?.trim();
			const firstSpace = input?.indexOf(" ") ?? -1;
			if (!input || firstSpace === -1) {
				ctx.ui.notify("Usage: /run <agent> <task>", "warning");
				return;
			}
			const agentName = input.slice(0, firstSpace);
			let task = input.slice(firstSpace + 1).trim();

			// Strip surrounding quotes if present
			if ((task.startsWith('"') && task.endsWith('"')) || (task.startsWith("'") && task.endsWith("'"))) {
				task = task.slice(1, -1);
			}
			if (!task) {
				ctx.ui.notify("Usage: /run <agent> <task>", "warning");
				return;
			}

			const unknown = findUnknownAgent([agentName], ctx.cwd);
			if (unknown) { ctx.ui.notify(`Unknown agent: ${unknown}`, "error"); return; }

			if (ctx.isIdle()) {
				sendSubagentInstruction("single", `agent: ${JSON.stringify(agentName)}, task: ${JSON.stringify(task)}`);
			} else {
				spawnAgentInBackground(agentName, task, ctx.cwd, ctx);
			}
		},
	});

	pi.registerCommand("chain", {
		description: 'Run agents in a chain: /chain scout "scan codebase" -> planner "create plan"',
		getArgumentCompletions: multiAgentCompletions,
		handler: async (args, ctx) => {
			const segments = parseAgentSegments(args);
			if (!segments || segments.length === 0) {
				ctx.ui.notify('Usage: /chain agent1 "task1" -> agent2 "task2" -> ...', "warning");
				return;
			}
			if (!segments[0].task) {
				ctx.ui.notify("First step must have a task", "warning");
				return;
			}

			const unknown = findUnknownAgent(segments.map((s) => s.agent), ctx.cwd);
			if (unknown) { ctx.ui.notify(`Unknown agent: ${unknown}`, "error"); return; }

			const chain = segments.map((s, i) => ({
				agent: s.agent,
				task: i === 0 ? s.task : (s.task ? `{previous}\n\n${s.task}` : undefined),
			}));
			sendSubagentInstruction("chain", `chain: ${JSON.stringify(chain)}`);
		},
	});

	pi.registerCommand("parallel", {
		description: 'Run agents in parallel: /parallel scanner "find issues" -> reviewer "check style"',
		getArgumentCompletions: multiAgentCompletions,
		handler: async (args, ctx) => {
			const segments = parseAgentSegments(args);
			if (!segments || segments.length === 0) {
				ctx.ui.notify('Usage: /parallel agent1 "task1" -> agent2 "task2" -> ...', "warning");
				return;
			}
			if (!segments.some((s) => s.task)) {
				ctx.ui.notify("At least one agent must have a task", "warning");
				return;
			}

			const unknown = findUnknownAgent(segments.map((s) => s.agent), ctx.cwd);
			if (unknown) { ctx.ui.notify(`Unknown agent: ${unknown}`, "error"); return; }

			const tasks = segments.map((s) => ({ agent: s.agent, task: s.task }));
			sendSubagentInstruction("parallel", `tasks: ${JSON.stringify(tasks)}`);
		},
	});

	// ── Per-Agent Shortcut Commands ──────────────────

	/** Track registered agent command names so we can skip re-registration. */
	const registeredAgentCommands = new Set<string>();

	/** Register `/agent:<name>` shortcut commands for all discovered agents. */
	function registerAgentCommands(cwd: string): void {
		const agents = discoverAgents(cwd, "both", BUNDLED_AGENTS_DIR).agents;
		for (const agent of agents) {
			const cmdName = `agent:${agent.name}`;
			if (registeredAgentCommands.has(cmdName)) continue;
			registeredAgentCommands.add(cmdName);

			pi.registerCommand(cmdName, {
				description: `Run ${agent.name}: ${agent.description}  (supports -> chaining)`,
				getArgumentCompletions: multiAgentCompletions,
				handler: async (args, ctx) => {
					const raw = args?.trim();
					if (!raw) {
						ctx.ui.notify(`Usage: /${cmdName} <task> [-> agent2 "task2" -> ...]`, "warning");
						return;
					}

					// Check for chain syntax: contains " -> " after the initial task
					const arrowIdx = raw.indexOf(" -> ");
					if (arrowIdx !== -1) {
						// Prepend this agent's segment, then parse the full chain
						const fullInput = `${agent.name} ${raw}`;
						const segments = parseAgentSegments(fullInput);
						if (!segments || segments.length < 2 || !segments[0].task) {
							ctx.ui.notify(`Usage: /${cmdName} <task> -> agent2 "task2" -> ...`, "warning");
							return;
						}
						const unknown = findUnknownAgent(segments.map((s) => s.agent), ctx.cwd);
						if (unknown) { ctx.ui.notify(`Unknown agent: ${unknown}`, "error"); return; }

						const chain = segments.map((s, i) => ({
							agent: s.agent,
							task: i === 0 ? s.task : (s.task ? `{previous}\n\n${s.task}` : undefined),
						}));
						sendSubagentInstruction("chain", `chain: ${JSON.stringify(chain)}`);
						return;
					}

					// Single agent mode
					let task = raw;
					if ((task.startsWith('"') && task.endsWith('"')) || (task.startsWith("'") && task.endsWith("'"))) {
						task = task.slice(1, -1);
					}
					if (ctx.isIdle()) {
						sendSubagentInstruction(
							"single",
							`agent: ${JSON.stringify(agent.name)}, task: ${JSON.stringify(task)}`,
						);
					} else {
						spawnAgentInBackground(agent.name, task, ctx.cwd, ctx);
					}
				},
			});
		}
	}

	// Register with initial cwd so commands are available immediately
	registerAgentCommands(baseCwd);

	// ── Agent Log Viewer Keybindings ─────────────
	// Digits are valid keys at runtime (documented in keybindings.md) but
	// missing from the KeyId type definition — cast to satisfy the compiler.
	for (let i = 1; i <= 9; i++) {
		pi.registerShortcut(`ctrl+shift+${i}` as unknown as "ctrl+shift+a", {
			description: `View live logs for agent #${i}`,
			handler: async (ctx) => {
				widgetCtx = ctx;
				await openLogViewer(i, ctx);
			},
		});
	}

	// ── Event Handlers ───────────────────────────

	pi.events.on("session:clear", () => {
		cleanupAllSessions();
		clearDashboard();
		nextRunId = 1;
		activeTeam = null;
	});

	// ── Subagent usage policy ─────────────────────────────────────
	// Prevent the LLM from delegating trivial tasks to subagents.

	const SUBAGENT_POLICY = [
		"Subagent usage policy:",
		"NEVER use the subagent tool for operations you can perform directly with built-in tools.",
		"Subagents spawn a separate process with startup overhead and a separate context window — they are expensive.",
		"",
		"Don't delegate:",
		"- File reads (use read tool directly, even for multiple files)",
		"- Search/grep (use bash with grep/rg/find)",
		"- Listing files or directories",
		"- Any deterministic, one-shot operation with a predictable outcome",
		"",
		"Do delegate:",
		"- Tasks requiring independent multi-step reasoning (code review, architecture analysis)",
		"- Work that benefits from isolated context (parallel feature implementation)",
		"- Specialist agent capabilities the parent agent lacks",
	].join("\n");

	pi.on("before_agent_start", async (event) => {
		return {
			systemPrompt: event.systemPrompt + "\n\n" + SUBAGENT_POLICY,
		};
	});

	pi.on("session_start", async (_event, ctx) => {
		widgetCtx = ctx;
		baseCwd = ctx.cwd;
		cleanupAllSessions();
		clearDashboard();
		nextRunId = 1;
		activeTeam = null;

		// Pre-load teams and refresh per-agent commands for the new cwd
		const discovery = discoverAgents(ctx.cwd, "both", BUNDLED_AGENTS_DIR);
		teams = loadTeams(discovery.projectAgentsDir, "both");
		registerAgentCommands(ctx.cwd);
	});
}
