/**
 * Sandbox Extension — OS-level sandboxing for bash commands
 *
 * Uses @anthropic-ai/sandbox-runtime to enforce filesystem and network
 * restrictions on bash commands at the OS level (sandbox-exec on macOS,
 * bubblewrap on Linux).
 *
 * Config files (merged, project takes precedence):
 * - ~/.pi/agent/sandbox.json   (global)
 * - <cwd>/.pi/sandbox.json     (project-local)
 *
 * Array fields (allowedDomains, denyRead, etc.) are unioned across layers,
 * not replaced. Scalar fields (enabled, enableWeakerNestedSandbox) override.
 *
 * Example .pi/sandbox.json:
 * ```json
 * {
 *   "enabled": true,
 *   "network": {
 *     "allowedDomains": ["api.openai.com"],
 *     "deniedDomains": []
 *   },
 *   "filesystem": {
 *     "denyRead": ["~/.ssh"],
 *     "allowWrite": [".", "/tmp"],
 *     "denyWrite": [".env"]
 *   }
 * }
 * ```
 *
 * Per-directory state is remembered across sessions in
 * <profile>/sandbox-state.json (where <profile> is PI_CODING_AGENT_DIR,
 * e.g. ~/.pi/agent-personal). Each profile maintains its own state, so
 * disabling sandbox in "personal" doesn't affect "work". `/sandbox reset`
 * clears the remembered state and falls back to config defaults.
 *
 * Usage:
 * - `pi -e ./sandbox`             — sandbox disabled by default; enable via config or /sandbox on
 * - `pi -e ./sandbox --no-sandbox` — force disable sandboxing (overrides config)
 * - `/sandbox`                    — show current status and configuration
 * - `/sandbox on`                 — enable sandbox at runtime (remembered)
 * - `/sandbox off`                — disable sandbox at runtime (remembered)
 * - `/sandbox reset`              — clear remembered state for this directory
 *
 * Linux also requires: bubblewrap, socat, ripgrep
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { type BashOperations, createBashTool } from "@mariozechner/pi-coding-agent";

// ---------------------------------------------------------------------------
// Config types & defaults
// ---------------------------------------------------------------------------

interface SandboxConfig extends SandboxRuntimeConfig {
	enabled?: boolean;
	ignoreViolations?: Record<string, string[]>;
	enableWeakerNestedSandbox?: boolean;
	enableWeakerNetworkIsolation?: boolean;
}

const DEFAULT_CONFIG: SandboxConfig = {
	enabled: false,
	// Required for Go-based CLIs (gh, docker, etc.) that use the macOS
	// trust daemon for TLS certificate verification.
	enableWeakerNetworkIsolation: true,
	network: {
		allowedDomains: [
			"npmjs.org",
			"*.npmjs.org",
			"registry.npmjs.org",
			"registry.yarnpkg.com",
			"pypi.org",
			"*.pypi.org",
			"github.com",
			"*.github.com",
			"api.github.com",
			"raw.githubusercontent.com",
		],
		deniedDomains: [],
	},
	filesystem: {
		denyRead: ["~/.ssh", "~/.aws", "~/.gnupg"],
		allowWrite: [".", "/tmp"],
		denyWrite: [".env", ".env.*", "*.pem", "*.key"],
	},
};

// ---------------------------------------------------------------------------
// Config loading — arrays are unioned, scalars override
// ---------------------------------------------------------------------------

function uniqueArray<T>(...arrays: (T[] | undefined)[]): T[] {
	return [...new Set(arrays.flatMap((a) => a ?? []))];
}

function mergeConfig(base: SandboxConfig, overrides: Partial<SandboxConfig>): SandboxConfig {
	const result: SandboxConfig = { ...base };

	if (overrides.enabled !== undefined) result.enabled = overrides.enabled;
	if (overrides.enableWeakerNestedSandbox !== undefined)
		result.enableWeakerNestedSandbox = overrides.enableWeakerNestedSandbox;
	if (overrides.enableWeakerNetworkIsolation !== undefined)
		result.enableWeakerNetworkIsolation = overrides.enableWeakerNetworkIsolation;

	if (overrides.network) {
		result.network = {
			allowedDomains: uniqueArray(base.network?.allowedDomains, overrides.network.allowedDomains),
			deniedDomains: uniqueArray(base.network?.deniedDomains, overrides.network.deniedDomains),
		};
	}

	if (overrides.filesystem) {
		result.filesystem = {
			denyRead: uniqueArray(base.filesystem?.denyRead, overrides.filesystem.denyRead),
			allowWrite: uniqueArray(base.filesystem?.allowWrite, overrides.filesystem.allowWrite),
			denyWrite: uniqueArray(base.filesystem?.denyWrite, overrides.filesystem.denyWrite),
		};
	}

	if (overrides.ignoreViolations) {
		result.ignoreViolations = { ...base.ignoreViolations, ...overrides.ignoreViolations };
	}

	return result;
}

function loadConfig(cwd: string): SandboxConfig {
	const globalPath = join(homedir(), ".pi", "agent", "sandbox.json");
	const projectPath = join(cwd, ".pi", "sandbox.json");

	let config = { ...DEFAULT_CONFIG };

	for (const path of [globalPath, projectPath]) {
		if (!existsSync(path)) continue;
		try {
			const partial: Partial<SandboxConfig> = JSON.parse(readFileSync(path, "utf-8"));
			config = mergeConfig(config, partial);
		} catch (e) {
			console.error(`Warning: could not parse ${path}: ${e}`);
		}
	}

	return config;
}

// ---------------------------------------------------------------------------
// Per-directory state persistence (profile-aware)
// ---------------------------------------------------------------------------

/**
 * Resolve the profile directory from PI_CODING_AGENT_DIR env var.
 * Falls back to ~/.pi/agent when unset.
 */
function getProfileDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

/** Path to the state file inside the active profile directory. */
function getStatePath(): string {
	return join(getProfileDir(), "sandbox-state.json");
}

type DirectoryStateMap = Record<string, { enabled: boolean }>;

/** Load the persisted per-directory state map from the active profile. */
function loadDirectoryState(): DirectoryStateMap {
	const statePath = getStatePath();
	if (!existsSync(statePath)) return {};
	try {
		return JSON.parse(readFileSync(statePath, "utf-8")) as DirectoryStateMap;
	} catch {
		return {};
	}
}

/** Persist the sandbox enabled/disabled state for a specific directory. */
function saveDirectoryState(cwd: string, enabled: boolean): void {
	const state = loadDirectoryState();
	state[cwd] = { enabled };
	const dir = getProfileDir();
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(getStatePath(), JSON.stringify(state, null, "\t"), "utf-8");
}

/** Get the persisted state for a directory, or undefined if never set. */
function getDirectoryState(cwd: string): boolean | undefined {
	const state = loadDirectoryState();
	return state[cwd]?.enabled;
}

/** Remove the persisted state for a directory, falling back to config defaults. */
function clearDirectoryState(cwd: string): void {
	const state = loadDirectoryState();
	delete state[cwd];
	const dir = getProfileDir();
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(getStatePath(), JSON.stringify(state, null, "\t"), "utf-8");
}

// ---------------------------------------------------------------------------
// Sandboxed BashOperations
// ---------------------------------------------------------------------------

function createSandboxedBashOps(): BashOperations {
	return {
		async exec(command, cwd, { onData, signal, timeout }) {
			if (!existsSync(cwd)) {
				throw new Error(`Working directory does not exist: ${cwd}`);
			}

			const wrappedCommand = await SandboxManager.wrapWithSandbox(command);

			return new Promise((resolve, reject) => {
				const child = spawn("bash", ["-c", wrappedCommand], {
					cwd,
					detached: true,
					stdio: ["ignore", "pipe", "pipe"],
				});

				let timedOut = false;
				let timeoutHandle: NodeJS.Timeout | undefined;

				if (timeout && timeout > 0) {
					timeoutHandle = setTimeout(() => {
						timedOut = true;
						killTree(child);
					}, timeout * 1000);
				}

				child.stdout?.on("data", onData);
				child.stderr?.on("data", onData);

				child.on("error", (err) => {
					if (timeoutHandle) clearTimeout(timeoutHandle);
					reject(err);
				});

				const onAbort = () => killTree(child);
				signal?.addEventListener("abort", onAbort, { once: true });

				child.on("close", (code) => {
					if (timeoutHandle) clearTimeout(timeoutHandle);
					signal?.removeEventListener("abort", onAbort);

					if (signal?.aborted) return reject(new Error("aborted"));
					if (timedOut) return reject(new Error(`timeout:${timeout}`));
					resolve({ exitCode: code });
				});
			});
		},
	};
}

function killTree(child: ReturnType<typeof spawn>) {
	if (child.pid) {
		try {
			process.kill(-child.pid, "SIGKILL");
		} catch {
			child.kill("SIGKILL");
		}
	}
}

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------

function updateStatus(ctx: ExtensionContext, config: SandboxConfig, active: boolean, readonly = false) {
	if (!active) {
		ctx.ui.setStatus("sandbox", ctx.ui.theme.fg("warning", "🔓 Sandbox OFF"));
		return;
	}

	if (readonly) {
		ctx.ui.setStatus(
			"sandbox",
			ctx.ui.theme.fg("accent", "🔒 Sandbox") +
				ctx.ui.theme.fg("warning", " [READONLY]"),
		);
		return;
	}

	const domains = config.network?.allowedDomains?.length ?? 0;
	const writePaths = config.filesystem?.allowWrite?.length ?? 0;
	const denyRead = config.filesystem?.denyRead?.length ?? 0;
	const denyWrite = config.filesystem?.denyWrite?.length ?? 0;

	const parts = [
		`${domains} domains`,
		`${writePaths}W`,
		`${denyRead}DR`,
		`${denyWrite}DW`,
	];

	ctx.ui.setStatus(
		"sandbox",
		ctx.ui.theme.fg("success", `🔒 Sandbox`) +
			ctx.ui.theme.fg("dim", ` [${parts.join(" ")}]`),
	);
}

function formatConfig(config: SandboxConfig, theme: ExtensionContext["ui"]["theme"]): string {
	const s = (label: string, items: string[] | undefined) =>
		`  ${label}: ${items?.length ? items.join(", ") : theme.fg("dim", "(none)")}`;

	return [
		theme.fg("accent", "Sandbox Configuration"),
		"",
		theme.fg("success", "Network:"),
		s("Allowed", config.network?.allowedDomains),
		s("Denied", config.network?.deniedDomains),
		"",
		theme.fg("success", "Filesystem:"),
		s("Deny Read", config.filesystem?.denyRead),
		s("Allow Write", config.filesystem?.allowWrite),
		s("Deny Write", config.filesystem?.denyWrite),
	].join("\n");
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function sandboxExtension(pi: ExtensionAPI) {
	pi.registerFlag("no-sandbox", {
		description: "Disable OS-level sandboxing for bash commands",
		type: "boolean",
		default: false,
	});

	const localCwd = process.cwd();
	const localBash = createBashTool(localCwd);

	// Tracks whether the sandbox is currently active. Updated by session_start
	// and /sandbox on|off. Checked synchronously by user_bash.
	let sandboxActive = false;

	// Readonly mode state — set by plan-ask extension via pi.events.
	let readonlyActive = false;
	// True when sandbox was inactive before readonly was requested, so we
	// know to deactivate it again when readonly ends.
	let sandboxActivatedForReadonly = false;
	let lastCtx: ExtensionContext | null = null;

	// Sandbox readiness — awaited by the bash tool to avoid races.
	// Resolves to true when sandbox is active, false otherwise.
	let sandboxReady: Promise<boolean> = Promise.resolve(false);

	// Pre-create a single sandboxed bash tool instance (reused across calls)
	const sandboxedBash = createBashTool(localCwd, {
		operations: createSandboxedBashOps(),
	});

	/** Initialize the sandbox runtime with the given config. */
	async function activateSandbox(config: SandboxConfig, ctx: ExtensionContext): Promise<boolean> {
		const platform = process.platform;
		if (platform !== "darwin" && platform !== "linux") {
			sandboxActive = false;
			updateStatus(ctx, config, false);
			ctx.ui.notify(`Sandbox not supported on ${platform}`, "warning");
			return false;
		}

		try {
			await SandboxManager.initialize({
				network: config.network,
				filesystem: config.filesystem,
				ignoreViolations: config.ignoreViolations,
				enableWeakerNestedSandbox: config.enableWeakerNestedSandbox,
				enableWeakerNetworkIsolation: config.enableWeakerNetworkIsolation,
			});
			sandboxActive = true;
			updateStatus(ctx, config, true);
			return true;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			sandboxActive = false;
			updateStatus(ctx, config, false);
			ctx.ui.notify(`Sandbox init failed: ${msg}`, "error");
			return false;
		}
	}

	/** Tear down the sandbox runtime. */
	async function deactivateSandbox(ctx: ExtensionContext): Promise<void> {
		if (sandboxActive) {
			try {
				await SandboxManager.reset();
			} catch {
				// ignore cleanup errors
			}
		}
		sandboxActive = false;
		updateStatus(ctx, loadConfig(ctx.cwd), false);
	}

	// ---- Override the built-in bash tool ----
	pi.registerTool({
		...localBash,
		label: "bash (sandboxed)",
		async execute(id, params, signal, onUpdate, _ctx) {
			const active = await sandboxReady;
			if (!active) {
				return localBash.execute(id, params, signal, onUpdate);
			}
			return sandboxedBash.execute(id, params, signal, onUpdate);
		},
	});

	// ---- Sandbox user ! / !! commands too ----
	pi.on("user_bash", () => {
		if (!sandboxActive) return;
		return { operations: createSandboxedBashOps() };
	});

	// ---- Initialize sandbox on session start ----
	pi.on("session_start", async (_event, ctx) => {
		lastCtx = ctx;
		const noSandbox = pi.getFlag("no-sandbox") as boolean;

		if (noSandbox) {
			sandboxReady = Promise.resolve(false);
			sandboxActive = false;
			updateStatus(ctx, loadConfig(ctx.cwd), false);
			ctx.ui.notify("Sandbox disabled via --no-sandbox", "warning");
			return;
		}

		const config = loadConfig(ctx.cwd);

		// Persisted per-directory state overrides config.enabled
		const persistedState = getDirectoryState(ctx.cwd);
		const enabled = persistedState !== undefined ? persistedState : config.enabled;

		if (!enabled) {
			sandboxReady = Promise.resolve(false);
			sandboxActive = false;
			updateStatus(ctx, config, false);
			const reason = persistedState !== undefined
				? "Sandbox disabled (remembered from last session)"
				: "Sandbox disabled via config";
			ctx.ui.notify(reason, "info");
			return;
		}

		sandboxReady = (async () => {
			const ok = await activateSandbox(config, ctx);
			if (ok) ctx.ui.notify("Sandbox initialized", "info");
			return ok;
		})();

		await sandboxReady;
	});

	// ---- Readonly mode (emitted by plan-ask extension) ----
	pi.events.on("readonly", (data: unknown) => {
		const { enabled, ack } = data as { enabled: boolean; ack: () => void };

		if (!lastCtx) return;

		ack();

		if (enabled === readonlyActive) return;
		readonlyActive = enabled;

		const ctx = lastCtx;
		const config = loadConfig(ctx.cwd);

		if (enabled) {
			// Track if we're spinning up sandbox just for readonly
			sandboxActivatedForReadonly = !sandboxActive;

			const readonlyConfig: SandboxConfig = {
				...config,
				filesystem: {
					...config.filesystem,
					allowWrite: [],
				},
			};
			sandboxReady = activateSandbox(readonlyConfig, ctx).then((ok) => {
				if (ok) {
					updateStatus(ctx, readonlyConfig, true, true);
					ctx.ui.notify("🔒 Sandbox: filesystem set to read-only", "info");
				}
				return ok;
			});
		} else if (sandboxActivatedForReadonly) {
			// Sandbox was off before readonly — tear it back down
			sandboxActivatedForReadonly = false;
			sandboxReady = deactivateSandbox(ctx).then(() => false);
		} else {
			// Sandbox was already on — restore normal config
			sandboxReady = activateSandbox(config, ctx).then((ok) => {
				if (ok) {
					updateStatus(ctx, config, true, false);
					ctx.ui.notify("🔓 Sandbox: filesystem writes restored", "info");
				}
				return ok;
			});
		}
	});

	// ---- Cleanup ----
	pi.on("session_shutdown", async (_event, ctx) => {
		readonlyActive = false;
		sandboxActivatedForReadonly = false;
		lastCtx = null;
		await deactivateSandbox(ctx);
	});

	// ---- /sandbox command — show status, or toggle with on/off ----
	pi.registerCommand("sandbox", {
		description: "Show sandbox status, or toggle with: /sandbox on | off | reset",
		getArgumentCompletions: (prefix: string) => {
			const items = [
				{ value: "on", label: "on", description: "Enable sandbox (remembered)" },
				{ value: "off", label: "off", description: "Disable sandbox (remembered)" },
				{ value: "reset", label: "reset", description: "Clear remembered state, use config defaults" },
			];
			const filtered = items.filter((i) => i.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const arg = args?.trim().toLowerCase();

			// ---- /sandbox off ----
			if (arg === "off") {
				if (!sandboxActive) {
					ctx.ui.notify("Sandbox is already off", "info");
					return;
				}
				await deactivateSandbox(ctx);
				sandboxReady = Promise.resolve(false);
				saveDirectoryState(ctx.cwd, false);
				ctx.ui.notify("Sandbox disabled (will stay off for this directory)", "warning");
				return;
			}

			// ---- /sandbox on ----
			if (arg === "on") {
				if (sandboxActive) {
					ctx.ui.notify("Sandbox is already on", "info");
					return;
				}
				const config = loadConfig(ctx.cwd);
				sandboxReady = activateSandbox(config, ctx).then((ok) => {
					if (ok) {
						saveDirectoryState(ctx.cwd, true);
						ctx.ui.notify("Sandbox enabled (will stay on for this directory)", "info");
					}
					return ok;
				});
				await sandboxReady;
				return;
			}

			// ---- /sandbox reset ----
			if (arg === "reset") {
				clearDirectoryState(ctx.cwd);
				ctx.ui.notify("Cleared remembered sandbox state for this directory. Restart to use config defaults.", "info");
				return;
			}

			// ---- /sandbox (no args) — show status + config ----
			const config = loadConfig(ctx.cwd);
			const { theme } = ctx.ui;
			const status = sandboxActive
				? theme.fg("success", "🔒 ON")
				: theme.fg("warning", "🔓 OFF");
			const hint = sandboxActive
				? theme.fg("dim", "  Use /sandbox off to disable")
				: theme.fg("dim", "  Use /sandbox on to enable");
			const persisted = getDirectoryState(ctx.cwd);
			const persistedNote = persisted !== undefined
				? theme.fg("dim", `\n  Remembered: ${persisted ? "on" : "off"} (use /sandbox reset to clear)`)
				: "";

			ctx.ui.notify(
				`${theme.fg("accent", "Sandbox Status:")} ${status}${persistedNote}\n${hint}\n\n${formatConfig(config, theme)}`,
				"info",
			);
		},
	});
}
