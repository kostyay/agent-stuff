/**
 * Shared tmux primitives
 *
 * Core tmux session and window management used by both bgrun.ts
 * and the subagent runner. Accepts an `exec` function to avoid
 * depending directly on the pi extension API.
 */

import { createHash } from "node:crypto";
import { basename, dirname } from "node:path";

/** Function signature matching pi.exec(). */
export type ExecFn = (
	command: string,
	args: string[],
	options?: { timeout?: number },
) => Promise<{ stdout: string; stderr: string; code: number }>;

/** Immutable config for a tmux session. */
export interface TmuxConfig {
	socketPath: string;
	sessionName: string;
}

/** Build tmux socket path and session name from a cwd and session prefix. */
export function buildTmuxConfig(cwd: string, prefix: string): TmuxConfig {
	const socketDir =
		process.env.CLAUDE_TMUX_SOCKET_DIR ??
		`${process.env.TMPDIR ?? "/tmp"}/claude-tmux-sockets`;
	const socketPath = `${socketDir}/claude.sock`;
	const dirName = sanitizeName(basename(cwd));
	const hash = createHash("sha256").update(cwd).digest("hex").slice(0, 3);
	const sessionName = `${prefix}-${dirName}-${hash}`;
	return { socketPath, sessionName };
}

/** Run a tmux command and return stdout. Throws on non-zero exit. */
export async function tmuxExec(
	exec: ExecFn,
	config: TmuxConfig,
	args: string[],
): Promise<string> {
	const result = await exec(
		"tmux",
		["-S", config.socketPath, ...args],
		{ timeout: 5000 },
	);
	if (result.code !== 0) {
		throw new Error(
			`tmux ${args[0]} failed (code ${result.code}): ${result.stderr.trim()}`,
		);
	}
	return result.stdout.trim();
}

/** Ensure the tmux session exists. Creates socket dir + session if missing. */
export async function ensureTmuxSession(
	exec: ExecFn,
	config: TmuxConfig,
): Promise<void> {
	const socketDir = dirname(config.socketPath);
	await exec("mkdir", ["-p", socketDir]);

	try {
		await tmuxExec(exec, config, ["has-session", "-t", config.sessionName]);
	} catch {
		await tmuxExec(exec, config, [
			"new-session", "-d", "-s", config.sessionName, "-n", "_control",
		]);
	}
}

/** Query tmux for window names and their pane_dead status. */
export async function listWindowState(
	exec: ExecFn,
	config: TmuxConfig,
): Promise<Map<string, boolean>> {
	try {
		const out = await tmuxExec(exec, config, [
			"list-windows", "-t", config.sessionName,
			"-F", "#{window_name}\t#{pane_dead}",
		]);
		const state = new Map<string, boolean>();
		for (const line of out.split("\n").filter(Boolean)) {
			const tab = line.indexOf("\t");
			const name = tab >= 0 ? line.slice(0, tab) : line;
			const dead = tab >= 0 && line.slice(tab + 1) === "1";
			state.set(name, dead);
		}
		return state;
	} catch {
		return new Map();
	}
}

/** Create a new tmux window running the given command. */
export async function createWindow(
	exec: ExecFn,
	config: TmuxConfig,
	name: string,
	command: string,
	env?: Record<string, string>,
): Promise<void> {
	await ensureTmuxSession(exec, config);

	const envPrefix = env
		? Object.entries(env)
				.map(([k, v]) => `${k}=${shellEscape(v)}`)
				.join(" ") + " "
		: "";

	await tmuxExec(exec, config, [
		"new-window", "-t", config.sessionName, "-n", name,
		"zsh", "-c", `${envPrefix}${command}`,
	]);
	await tmuxExec(exec, config, [
		"set-option", "-t", `${config.sessionName}:${name}`,
		"remain-on-exit", "on",
	]);
}

/** Capture last N lines from a window's tmux pane. */
export async function capturePane(
	exec: ExecFn,
	config: TmuxConfig,
	windowName: string,
	lines = 200,
): Promise<string> {
	try {
		return await tmuxExec(exec, config, [
			"capture-pane", "-p", "-J",
			"-t", `${config.sessionName}:${windowName}`,
			"-S", `-${lines}`,
		]);
	} catch {
		return "(unable to capture output)";
	}
}

/** Kill a specific tmux window. */
export async function killWindow(
	exec: ExecFn,
	config: TmuxConfig,
	windowName: string,
): Promise<void> {
	try {
		await tmuxExec(exec, config, [
			"kill-window", "-t", `${config.sessionName}:${windowName}`,
		]);
	} catch {
		/* window may already be dead */
	}
}

/** Kill the entire tmux session. */
export async function killSession(
	exec: ExecFn,
	config: TmuxConfig,
): Promise<void> {
	try {
		await tmuxExec(exec, config, ["kill-session", "-t", config.sessionName]);
	} catch {
		/* session may not exist */
	}
}

/** List all window names in a session (excluding _control). */
export async function listWindowNames(
	exec: ExecFn,
	config: TmuxConfig,
): Promise<string[]> {
	try {
		const out = await tmuxExec(exec, config, [
			"list-windows", "-t", config.sessionName,
			"-F", "#{window_name}",
		]);
		return out.split("\n").filter((n) => n && n !== "_control");
	} catch {
		return [];
	}
}

// ── Naming Utilities ─────────────────────────────

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

/** Ensure the window name is unique within a set of existing names. */
export function uniqueName(desired: string, existing: Set<string> | Map<string, unknown>): string {
	if (!existing.has(desired)) return desired;
	for (let i = 2; i < 100; i++) {
		const candidate = `${desired}-${i}`;
		if (!existing.has(candidate)) return candidate;
	}
	return `${desired}-${Date.now()}`;
}

/** Format elapsed milliseconds as compact duration string. */
export function formatDuration(ms: number): string {
	const sec = Math.floor(ms / 1000);
	if (sec < 60) return `${sec}s`;
	if (sec < 3600) return `${Math.floor(sec / 60)}m${sec % 60}s`;
	const h = Math.floor(sec / 3600);
	const m = Math.floor((sec % 3600) / 60);
	return `${h}h${m}m`;
}

/** Shell-escape a value for safe embedding in a command string. */
export function shellEscape(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}
