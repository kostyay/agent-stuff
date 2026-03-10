/**
 * Single agent runner — spawns a `pi` process and streams events.
 *
 * Manages the lifecycle of a single subagent invocation: building
 * CLI args, spawning the child process, parsing streaming JSON events,
 * and accumulating usage stats and messages.
 */

import type { Message } from "@mariozechner/pi-ai";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import type { AgentConfig } from "./agents.js";

import type { AgentProgress, OnUpdateCallback, SingleResult, SubagentDetails } from "./types.js";
import { getFinalOutput, writePromptToTempFile, zeroUsage } from "./utils.js";

/** Options for running a single subagent. Uses an object to stay within the 5-param limit. */
export interface RunAgentOptions {
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
	/** Called with every parsed JSON event from the subagent process. */
	onRawEvent?: (event: Record<string, unknown>) => void;
	/** Override the agent's configured model (e.g. use the parent session's current model). */
	modelOverride?: string;
	/** Extra env vars to pass to the child process (e.g. control channel). */
	extraEnv?: Record<string, string>;
}

/** Spawn a subagent process and stream results back. */
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

	const args: string[] = ["--mode", "json", "-p"];
	if (opts.sessionFile) {
		args.push("--session", opts.sessionFile);
		if (opts.isResume) args.push("-c");
	} else {
		args.push("--no-session");
	}
	const effectiveModel = opts.modelOverride ?? agent.model;
	if (effectiveModel) args.push("--model", effectiveModel);
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
		model: opts.modelOverride ?? agent.model,
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
				env: { ...process.env, PI_CODING_AGENT_DIR: getAgentDir(), ...opts.extraEnv },
			});
			let buffer = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: Record<string, unknown>;
				try {
					event = JSON.parse(line) as Record<string, unknown>;
				} catch {
					return;
				}

				// Forward every parsed event to the log viewer
				if (opts.onRawEvent) opts.onRawEvent(event);

				// ── Streaming text deltas → dashboard lastLine ──
				if (event.type === "message_update") {
					const delta = event.assistantMessageEvent as Record<string, unknown> | undefined;
					if (delta?.type === "text_delta" && delta.delta) {
						progressState.textChunks.push(delta.delta as string);
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
						// Reset text accumulator so next turn starts fresh
						progressState.textChunks = [];
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

			proc.on("error", (err) => {
				currentResult.stderr += `\nSpawn error: ${err.message}`;
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
		if (wasAborted) {
			currentResult.exitCode = currentResult.exitCode || 1;
			currentResult.stopReason = "aborted";
			currentResult.stderr += "\nSubagent was aborted";
		}
		return currentResult;
	} finally {
		if (tmpPromptPath) try { fs.unlinkSync(tmpPromptPath); } catch { /* ignore */ }
		if (tmpPromptDir) try { fs.rmdirSync(tmpPromptDir); } catch { /* ignore */ }
	}
}
