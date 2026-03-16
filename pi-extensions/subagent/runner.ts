/**
 * Single agent runner — manages subagent lifecycle via tmux.
 *
 * Spawns each subagent as a `pi` process inside a tmux window,
 * giving human-readable output that can be monitored via `tmux attach`.
 * Real-time stats (tool count, usage, text) arrive over the UDP
 * control channel from the stats-reporter extension loaded in the child.
 *
 * Completion is detected via the `agent_done` control message,
 * with tmux pane_dead polling as a fallback.
 */

import { getAgentDir } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ControlMessage } from "../../lib/control-channel.ts";
import {
	type ExecFn,
	type TmuxConfig,
	createWindow,
	killWindow,
	listWindowState,
	sanitizeName,
	shellEscape,
	uniqueName,
} from "../../lib/tmux.ts";
import type { AgentConfig } from "./agents.js";
import type { AgentProgress, OnUpdateCallback, SingleResult, SubagentDetails } from "./types.js";
import { getFinalOutput, writePromptToTempFile, zeroUsage } from "./utils.js";

/** Prefix for all subagent tmux windows. */
export const AGENT_WINDOW_PREFIX = "agent:";

/** Path to the stats-reporter extension loaded into child pi processes. */
const STATS_REPORTER_PATH = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"stats-reporter.ts",
);

/** Options for running a single subagent. */
export interface RunAgentOptions {
	exec: ExecFn;
	tmuxConfig: TmuxConfig;
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
	/** Override the agent's configured model. */
	modelOverride?: string;
	/** Extra env vars to pass to the child process (includes control channel env). */
	extraEnv?: Record<string, string>;
	/** Set of existing window names for uniqueness across concurrent runs. */
	existingWindows?: Set<string>;
	/**
	 * Register a handler for control messages from this agent's run ID.
	 * Called before the tmux window is created so messages are captured immediately.
	 * The handler receives raw ControlMessages and the caller can route them.
	 */
	registerControlHandler?: (handler: (msg: ControlMessage) => void) => void;
	/**
	 * Unregister the control handler when the run is complete.
	 */
	unregisterControlHandler?: () => void;
}

/** Build the pi CLI command string for the subagent. */
function buildPiCommand(opts: {
	task: string;
	sessionFile?: string;
	isResume?: boolean;
	model?: string;
	tools?: string[];
	promptPath?: string;
}): string {
	const args: string[] = ["pi", "-p"];
	if (opts.sessionFile) {
		args.push("--session", shellEscape(opts.sessionFile));
		if (opts.isResume) args.push("-c");
	} else {
		args.push("--no-session");
	}
	if (opts.model) args.push("--model", shellEscape(opts.model));
	if (opts.tools?.length) {
		args.push("--tools", opts.tools.join(","));
	}
	// Load the stats-reporter extension for real-time progress
	args.push("-e", shellEscape(STATS_REPORTER_PATH));
	if (opts.promptPath) {
		args.push("--append-system-prompt", shellEscape(opts.promptPath));
	}
	args.push(shellEscape(`Task: ${opts.task}`));
	return args.join(" ");
}

/** Spawn a subagent in a tmux window and wait for completion. */
export async function runSingleAgent(opts: RunAgentOptions): Promise<SingleResult> {
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
		model: opts.modelOverride ?? agent.model,
		step: opts.step,
	};

	const progressState = { toolCount: 0, lastLine: "", contextTokens: 0 };
	const startTime = Date.now();

	const emitProgress = (): void => {
		if (opts.onProgress) {
			opts.onProgress({
				toolCount: progressState.toolCount,
				lastLine: progressState.lastLine,
				contextTokens: progressState.contextTokens,
				elapsed: Date.now() - startTime,
			});
		}
	};

	const emitUpdate = (): void => {
		if (opts.onUpdate) {
			opts.onUpdate({
				content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
				details: opts.makeDetails([currentResult]),
			});
		}
	};

	let agentDone = false;

	/** Process a control message from the stats-reporter extension. */
	const handleControlMessage = (msg: ControlMessage): void => {
		switch (msg.type) {
			case "text_delta": {
				progressState.lastLine = (msg as { lastLine: string }).lastLine;
				emitProgress();
				break;
			}
			case "tool_start": {
				progressState.toolCount++;
				emitProgress();
				break;
			}
			case "usage": {
				const u = msg as Record<string, unknown>;
				currentResult.usage.turns++;
				currentResult.usage.input += (u.input as number) || 0;
				currentResult.usage.output += (u.output as number) || 0;
				currentResult.usage.cacheRead += (u.cacheRead as number) || 0;
				currentResult.usage.cacheWrite += (u.cacheWrite as number) || 0;
				currentResult.usage.cost += (u.cost as number) || 0;
				currentResult.usage.contextTokens = (u.contextTokens as number) || 0;
				progressState.contextTokens = (u.contextTokens as number) || 0;
				if (u.model && !currentResult.model) {
					currentResult.model = u.model as string;
				}
				if (u.stopReason) currentResult.stopReason = u.stopReason as string;
				if (u.errorMessage) currentResult.errorMessage = u.errorMessage as string;
				emitProgress();
				emitUpdate();
				break;
			}
			case "agent_done": {
				agentDone = true;
				break;
			}
		}
	};

	try {
		// Prepare system prompt temp file
		if (agent.systemPrompt.trim()) {
			const tmp = writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
		}

		// Build the pi command
		const effectiveModel = opts.modelOverride ?? agent.model;
		const command = buildPiCommand({
			task: opts.task,
			sessionFile: opts.sessionFile,
			isResume: opts.isResume,
			model: effectiveModel,
			tools: agent.tools,
			promptPath: tmpPromptPath ?? undefined,
		});

		// Derive unique tmux window name
		const rawName = `${AGENT_WINDOW_PREFIX}${sanitizeName(opts.agentName)}`;
		const existingNames = opts.existingWindows ?? new Set<string>();
		const windowName = uniqueName(rawName, existingNames);
		existingNames.add(windowName);

		// Build env vars for the child process
		const childEnv: Record<string, string> = {
			PI_CODING_AGENT_DIR: getAgentDir(),
			...(opts.extraEnv ?? {}),
		};

		// Register control handler BEFORE creating window so we catch all messages
		if (opts.registerControlHandler) {
			opts.registerControlHandler(handleControlMessage);
		}

		// Create tmux window
		await createWindow(opts.exec, opts.tmuxConfig, windowName, command, childEnv);

		// Wait for completion: agent_done control message + pane_dead fallback
		let wasAborted = false;
		const POLL_INTERVAL_MS = 500;
		const progressTimer = setInterval(emitProgress, 1000);

		await new Promise<void>((resolve) => {
			if (opts.signal?.aborted) {
				wasAborted = true;
				resolve();
				return;
			}

			const abortHandler = (): void => {
				wasAborted = true;
				killWindow(opts.exec, opts.tmuxConfig, windowName).then(resolve, resolve);
			};

			if (opts.signal) {
				opts.signal.addEventListener("abort", abortHandler, { once: true });
			}

			const poll = async (): Promise<void> => {
				if (wasAborted) return;

				if (agentDone) {
					resolve();
					return;
				}

				// Fallback: check if the tmux pane has exited
				const windowState = await listWindowState(opts.exec, opts.tmuxConfig);
				const isDead = windowState.get(windowName);

				if (isDead === true || !windowState.has(windowName)) {
					resolve();
					return;
				}

				setTimeout(poll, POLL_INTERVAL_MS);
			};

			setTimeout(poll, POLL_INTERVAL_MS);
		});

		clearInterval(progressTimer);

		// Clean up the tmux window
		await killWindow(opts.exec, opts.tmuxConfig, windowName);
		existingNames.delete(windowName);

		if (wasAborted) {
			currentResult.exitCode = 1;
			currentResult.stopReason = "aborted";
		}

		return currentResult;
	} finally {
		if (opts.unregisterControlHandler) opts.unregisterControlHandler();
		if (tmpPromptPath) try { fs.unlinkSync(tmpPromptPath); } catch { /* ignore */ }
		if (tmpPromptDir) try { fs.rmdirSync(tmpPromptDir); } catch { /* ignore */ }
	}
}
