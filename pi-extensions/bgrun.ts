/**
 * Background Task Runner Extension
 *
 * Run and manage background tasks using tmux. Each project gets a single tmux
 * session with one window per task. Window names are auto-derived from commands.
 *
 * Commands:
 *   /bgrun <command>  — start a background task
 *   /bgtasks          — open task manager dialog (list, view output, kill)
 *
 * Tool:
 *   bgrun — LLM can start/list/capture/kill background tasks
 *
 * Emits `bgrun:stats` event for status-bar consumption.
 * Tasks are session-scoped: killed on /new. On shutdown, a timed confirm
 * (5s, default=No) asks whether to kill remaining tasks.
 */

import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey, Text, truncateToWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { basename, dirname } from "node:path";

/** Tracked background task metadata. */
export interface BgTask {
	name: string;
	command: string;
	startedAt: number;
}

/** Subcommands that take a target argument (e.g. `npm run dev` → `npm-dev`). */
export const COMPOUND_SUBCOMMANDS = new Set([
	"run", "start", "exec", "test", "build", "serve", "watch", "dev",
]);

/** Derive a short, meaningful tmux window name from a command string. */
export function deriveTaskName(command: string): string {
	const trimmed = command.trim();
	const parts = trimmed.split(/\s+/);
	const base = basename(parts[0] ?? "task");

	if (parts.length <= 1) return sanitizeName(base);

	const subcommand = parts[1] ?? "";
	if (COMPOUND_SUBCOMMANDS.has(subcommand)) {
		const target = parts[2] ?? subcommand;
		return sanitizeName(`${base}-${target}`);
	}

	return sanitizeName(`${base}-${subcommand}`);
}

/** Sanitize a string for use as a tmux window name. */
export function sanitizeName(raw: string): string {
	return raw
		.replace(/[^a-zA-Z0-9._-]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 30) || "task";
}

/** Ensure the window name is unique among tracked tasks. */
export function uniqueName(desired: string, tasks: Map<string, BgTask>): string {
	if (!tasks.has(desired)) return desired;
	for (let i = 2; i < 100; i++) {
		const candidate = `${desired}-${i}`;
		if (!tasks.has(candidate)) return candidate;
	}
	return `${desired}-${Date.now()}`;
}

/** Format elapsed seconds as compact duration string. */
export function formatDuration(ms: number): string {
	const sec = Math.floor(ms / 1000);
	if (sec < 60) return `${sec}s`;
	if (sec < 3600) return `${Math.floor(sec / 60)}m${sec % 60}s`;
	const h = Math.floor(sec / 3600);
	const m = Math.floor((sec % 3600) / 60);
	return `${h}h${m}m`;
}

export default function bgrunExtension(pi: ExtensionAPI) {
	const tasks = new Map<string, BgTask>();
	let socketPath = "";
	let sessionName = "";

	/** Resolve tmux socket and session name from cwd. */
	function initTmux(cwd: string): void {
		const socketDir = process.env.CLAUDE_TMUX_SOCKET_DIR
			?? `${process.env.TMPDIR ?? "/tmp"}/claude-tmux-sockets`;
		socketPath = `${socketDir}/claude.sock`;
		sessionName = `bgrun-${sanitizeName(basename(cwd))}`;
	}

	/** Run a tmux command and return stdout. Throws on non-zero exit. */
	async function tmux(args: string[]): Promise<string> {
		const result = await pi.exec("tmux", ["-S", socketPath, ...args], { timeout: 5000 });
		if (result.code !== 0) {
			throw new Error(`tmux ${args[0]} failed (code ${result.code}): ${result.stderr.trim()}`);
		}
		return result.stdout.trim();
	}

	/** Ensure the tmux session exists. Creates socket dir + session if missing. */
	async function ensureSession(): Promise<void> {
		const socketDir = dirname(socketPath);
		await pi.exec("mkdir", ["-p", socketDir]);

		try {
			await tmux(["has-session", "-t", sessionName]);
		} catch {
			await tmux(["new-session", "-d", "-s", sessionName, "-n", "_control"]);
		}
	}

	/** Emit stats event for status-bar. */
	function emitStats(): void {
		pi.events.emit("bgrun:stats", { running: tasks.size });
	}

	/** Remove tasks whose tmux windows no longer exist. */
	async function pruneDead(): Promise<void> {
		let aliveNames: Set<string>;
		try {
			const out = await tmux([
				"list-windows", "-t", sessionName,
				"-F", "#{window_name}",
			]);
			aliveNames = new Set(out.split("\n").filter(Boolean));
		} catch {
			aliveNames = new Set();
		}

		let pruned = false;
		for (const name of tasks.keys()) {
			if (!aliveNames.has(name)) {
				tasks.delete(name);
				pruned = true;
			}
		}
		if (pruned) emitStats();
	}

	/** Start a new background task. Returns the task metadata. */
	async function startTask(command: string): Promise<BgTask> {
		await ensureSession();

		const rawName = deriveTaskName(command);
		const name = uniqueName(rawName, tasks);

		await tmux(["new-window", "-t", sessionName, "-n", name]);
		await tmux(["send-keys", "-t", `${sessionName}:${name}`, command, "Enter"]);

		const task: BgTask = { name, command, startedAt: Date.now() };
		tasks.set(name, task);
		emitStats();
		return task;
	}

	/** Capture last N lines from a task's tmux pane. */
	async function captureOutput(taskName: string, lines = 200): Promise<string> {
		try {
			return await tmux([
				"capture-pane", "-p", "-J",
				"-t", `${sessionName}:${taskName}`,
				"-S", `-${lines}`,
			]);
		} catch {
			return "(unable to capture output)";
		}
	}

	/** Kill a specific task's tmux window. */
	async function killTask(taskName: string): Promise<boolean> {
		try {
			await tmux(["kill-window", "-t", `${sessionName}:${taskName}`]);
		} catch {
			// Window may already be dead
		}
		const removed = tasks.delete(taskName);
		emitStats();
		return removed;
	}

	/** Kill all tasks and the tmux session. */
	async function killAll(): Promise<void> {
		try {
			await tmux(["kill-session", "-t", sessionName]);
		} catch {
			// Session may not exist
		}
		tasks.clear();
		emitStats();
	}

	/** Rebuild task list by scanning existing tmux windows. */
	async function syncFromTmux(): Promise<void> {
		tasks.clear();
		try {
			const out = await tmux([
				"list-windows", "-t", sessionName,
				"-F", "#{window_name}",
			]);
			const now = Date.now();
			for (const name of out.split("\n")) {
				if (!name || name === "_control") continue;
				tasks.set(name, { name, command: "(reconnected)", startedAt: now });
			}
		} catch {
			// No session — that's fine
		}
		emitStats();
	}

	// --- Session lifecycle ---

	pi.on("session_start", async (_event, ctx) => {
		initTmux(ctx.cwd);
		await syncFromTmux();
	});

	pi.on("session_switch", async (event, _ctx) => {
		if (event.reason === "new") {
			await killAll();
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (tasks.size === 0) return;
		if (!ctx.hasUI) {
			await killAll();
			return;
		}

		const confirmed = await ctx.ui.confirm(
			"Background Tasks",
			`Kill ${tasks.size} background task(s)?`,
			{ timeout: 5000 },
		);

		if (confirmed) {
			await killAll();
		}
	});

	// --- /bgrun command ---

	pi.registerCommand("bgrun", {
		description: "Start a background task: /bgrun <command>",
		handler: async (args, ctx) => {
			const command = args?.trim();
			if (!command) {
				ctx.ui.notify("Usage: /bgrun <command>", "warning");
				return;
			}
			const task = await startTask(command);
			ctx.ui.notify(
				`Started: ${task.name}\n` +
				`Monitor: tmux -S "${socketPath}" attach -t ${sessionName}:${task.name}`,
				"info",
			);
		},
	});

	// --- /bgtasks command (task manager dialog) ---

	pi.registerCommand("bgtasks", {
		description: "Open background task manager",
		handler: async (_args, ctx) => {
			await pruneDead();

			if (tasks.size === 0) {
				ctx.ui.notify("No background tasks running", "info");
				return;
			}

			await showTaskManager(ctx);
		},
	});

	/** Show the interactive task manager TUI. */
	async function showTaskManager(ctx: ExtensionContext): Promise<void> {
		type View = "list" | "detail";

		await ctx.ui.custom<void>((tui, theme, _kb, done) => {
			let view: View = "list";
			let selectedIndex = 0;
			let capturedOutput = "";
			let capturedTaskName = "";
			let scrollOffset = 0;
			let cachedLines: string[] | undefined;

			function taskList(): BgTask[] {
				return [...tasks.values()];
			}

			function refresh(): void {
				cachedLines = undefined;
				tui.requestRender();
			}

			function handleInput(data: string): void {
				if (view === "detail") {
					handleDetailInput(data);
				} else {
					handleListInput(data);
				}
			}

			function handleListInput(data: string): void {
				const list = taskList();

				if (matchesKey(data, Key.escape) || data === "q") {
					done(undefined);
					return;
				}
				if (matchesKey(data, Key.up) && selectedIndex > 0) {
					selectedIndex--;
					refresh();
					return;
				}
				if (matchesKey(data, Key.down) && selectedIndex < list.length - 1) {
					selectedIndex++;
					refresh();
					return;
				}
				if (matchesKey(data, Key.enter)) {
					const task = list[selectedIndex];
					if (task) {
						capturedTaskName = task.name;
						captureOutput(task.name, 200).then((out) => {
							capturedOutput = out;
							scrollOffset = 0;
							view = "detail";
							refresh();
						});
					}
					return;
				}
				if (data === "k" || matchesKey(data, Key.delete)) {
					const task = list[selectedIndex];
					if (task) {
						killTask(task.name).then(() => {
							if (selectedIndex >= taskList().length) {
								selectedIndex = Math.max(0, taskList().length - 1);
							}
							if (taskList().length === 0) {
								done(undefined);
							} else {
								refresh();
							}
						});
					}
					return;
				}
			}

			function handleDetailInput(data: string): void {
				if (matchesKey(data, Key.escape) || data === "q") {
					view = "list";
					refresh();
					return;
				}
				if (matchesKey(data, Key.up)) {
					scrollOffset = Math.max(0, scrollOffset - 1);
					refresh();
					return;
				}
				if (matchesKey(data, Key.down)) {
					scrollOffset++;
					refresh();
					return;
				}
				if (data === "r") {
					captureOutput(capturedTaskName, 200).then((out) => {
						capturedOutput = out;
						refresh();
					});
					return;
				}
			}

			function renderList(width: number): string[] {
				const lines: string[] = [];
				const add = (s: string) => lines.push(truncateToWidth(s, width));
				const list = taskList();

				add(theme.fg("accent", "─".repeat(width)));
				add(theme.fg("accent", theme.bold(" ⚙ Background Tasks")) +
					theme.fg("dim", ` (${list.length})`));
				add("");

				for (let i = 0; i < list.length; i++) {
					const task = list[i]!;
					const selected = i === selectedIndex;
					const prefix = selected ? theme.fg("accent", " ▸ ") : "   ";
					const elapsed = formatDuration(Date.now() - task.startedAt);
					const icon = theme.fg("success", "●");

					const nameStr = selected
						? theme.fg("accent", task.name)
						: theme.fg("text", task.name);
					const cmdStr = theme.fg("muted", task.command);
					const timeStr = theme.fg("dim", elapsed);

					add(`${prefix}${icon} ${nameStr} ${timeStr}`);
					add(`     ${cmdStr}`);
					if (i < list.length - 1) add("");
				}

				add("");
				add(theme.fg("dim", " ↑↓ navigate • Enter view output • k kill • q/Esc close"));
				add(theme.fg("accent", "─".repeat(width)));

				return lines;
			}

			function renderDetail(width: number): string[] {
				const lines: string[] = [];
				const add = (s: string) => lines.push(truncateToWidth(s, width));

				add(theme.fg("accent", "─".repeat(width)));
				add(theme.fg("accent", theme.bold(` 📋 ${capturedTaskName}`)) +
					theme.fg("dim", " (output)"));
				add(theme.fg("accent", "─".repeat(width)));

				const outputLines = capturedOutput.split("\n");
				const maxVisible = Math.max(5, (tui as any).height
					? (tui as any).height - 6
					: 30);
				const clampedOffset = Math.min(
					scrollOffset,
					Math.max(0, outputLines.length - maxVisible),
				);
				const visible = outputLines.slice(clampedOffset, clampedOffset + maxVisible);

				for (const line of visible) {
					add(` ${theme.fg("text", line)}`);
				}

				if (outputLines.length > maxVisible) {
					add("");
					add(theme.fg("dim",
						` Lines ${clampedOffset + 1}-${clampedOffset + visible.length} of ${outputLines.length}`));
				}

				add("");
				add(theme.fg("dim", " ↑↓ scroll • r refresh • q/Esc back"));
				add(theme.fg("accent", "─".repeat(width)));

				return lines;
			}

			function render(width: number): string[] {
				if (cachedLines) return cachedLines;
				cachedLines = view === "list"
					? renderList(width)
					: renderDetail(width);
				return cachedLines;
			}

			return {
				render,
				invalidate: () => { cachedLines = undefined; },
				handleInput,
			};
		});
	}

	// --- bgrun tool (for LLM) ---

	const BgRunParams = Type.Object({
		action: StringEnum(["start", "list", "capture", "kill"] as const, {
			description: "Action to perform on background tasks",
		}),
		command: Type.Optional(Type.String({
			description: "Shell command to run (required for 'start')",
		})),
		task_id: Type.Optional(Type.String({
			description: "Task name/id (required for 'capture' and 'kill')",
		})),
	});

	pi.registerTool({
		name: "bgrun",
		label: "Background Run",
		description:
			"Run and manage background tasks via tmux. " +
			"Use 'start' to launch a command, 'list' to see all tasks, " +
			"'capture' to get a task's output, 'kill' to stop a task.",
		promptGuidelines: [
			"Use bgrun (not bash) for long-running or background processes: dev servers, watchers, builds, test suites — anything that doesn't terminate quickly.",
		],
		parameters: BgRunParams,

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			switch (params.action) {
				case "start": {
					if (!params.command) {
						throw new Error("'command' is required for 'start' action");
					}
					const task = await startTask(params.command);
					const monitorCmd = `tmux -S "${socketPath}" attach -t ${sessionName}:${task.name}`;
					return {
						content: [{
							type: "text" as const,
							text: `Started background task: ${task.name}\nCommand: ${task.command}\nMonitor: ${monitorCmd}`,
						}],
						details: { task, monitorCmd },
					};
				}

				case "list": {
					await pruneDead();
					const list = [...tasks.values()].map((t) => ({
						name: t.name,
						command: t.command,
						uptime: formatDuration(Date.now() - t.startedAt),
					}));
					return {
						content: [{
							type: "text" as const,
							text: list.length === 0
								? "No background tasks running"
								: `${list.length} task(s):\n${list.map((t) => `  ${t.name}: ${t.command} (${t.uptime})`).join("\n")}`,
						}],
						details: { tasks: list },
					};
				}

				case "capture": {
					if (!params.task_id) {
						throw new Error("'task_id' is required for 'capture' action");
					}
					if (!tasks.has(params.task_id)) {
						throw new Error(`Task '${params.task_id}' not found`);
					}
					const output = await captureOutput(params.task_id);
					return {
						content: [{
							type: "text" as const,
							text: `Output of ${params.task_id}:\n${output}`,
						}],
						details: { task_id: params.task_id, output },
					};
				}

				case "kill": {
					if (!params.task_id) {
						throw new Error("'task_id' is required for 'kill' action");
					}
					const existed = await killTask(params.task_id);
					return {
						content: [{
							type: "text" as const,
							text: existed
								? `Killed task: ${params.task_id}`
								: `Task '${params.task_id}' not found (may have already exited)`,
						}],
						details: { task_id: params.task_id, existed },
					};
				}

				default:
					throw new Error(`Unknown action: ${params.action}`);
			}
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("bgrun "));
			text += theme.fg("accent", args.action ?? "");
			if (args.command) {
				text += " " + theme.fg("muted", args.command);
			}
			if (args.task_id) {
				text += " " + theme.fg("dim", `[${args.task_id}]`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as Record<string, unknown> | undefined;
			const text = result.content[0];
			const raw = text?.type === "text" ? text.text : "";

			if (details?.task) {
				const task = details.task as BgTask;
				return new Text(
					theme.fg("success", "✓ ") +
					theme.fg("accent", task.name) +
					theme.fg("dim", ` — ${task.command}`),
					0, 0,
				);
			}

			if (details?.output) {
				const outputStr = String(details.output);
				const previewLines = outputStr.split("\n").slice(-5);
				const preview = previewLines.join("\n");
				return new Text(
					theme.fg("success", `✓ ${details.task_id}\n`) +
					theme.fg("dim", preview),
					0, 0,
				);
			}

			return new Text(theme.fg("success", "✓ ") + theme.fg("text", raw), 0, 0);
		},
	});
}
