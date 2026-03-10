/**
 * Test helpers for subagent integration tests.
 *
 * Provides:
 * - Mock pi CLI via createMockPi() from @marcfargas/pi-test-harness
 * - Dynamic module loading with graceful skip (tryImport)
 * - Temp directory management
 * - Agent config factories matching the extension's AgentConfig type
 * - writeTestAgents() for writing .md agent files parseable by discoverAgents()
 * - JSONL event builders for mock pi responses
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { AgentConfig, AgentSource } from "../agents.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Re-export AgentConfig so downstream tests can import from helpers alone
// ---------------------------------------------------------------------------

export type { AgentConfig };

// ---------------------------------------------------------------------------
// Mock Pi types (declared locally to avoid hard dep on harness)
// ---------------------------------------------------------------------------

/** Response shape accepted by MockPi.onCall(). */
export interface MockPiResponse {
	output?: string;
	exitCode?: number;
	stderr?: string;
	delay?: number;
	jsonl?: object[];
}

/** Mock pi CLI instance from @marcfargas/pi-test-harness. */
export interface MockPi {
	readonly dir: string;
	install(): void;
	uninstall(): void;
	onCall(response: MockPiResponse): void;
	reset(): void;
	callCount(): number;
}

// ---------------------------------------------------------------------------
// Mock Pi setup
// ---------------------------------------------------------------------------

/**
 * Resolve the mock-pi-script.mjs path from the harness package.
 *
 * On Windows, pi-spawn resolves the pi CLI via process.argv[1].
 * We redirect it to the harness mock script so pi-spawn picks up
 * the mock instead of the real pi CLI.
 */
function findHarnessMockPiScript(): string {
	const mainUrl = import.meta.resolve("@marcfargas/pi-test-harness");
	const mainEntry = fileURLToPath(mainUrl);
	const distDir = path.dirname(mainEntry);
	const harnessDir = path.dirname(distDir);
	const candidates = [
		path.join(distDir, "mock-pi-script.mjs"),
		path.join(harnessDir, "src", "mock-pi-script.mjs"),
	];
	for (const c of candidates) {
		if (fs.existsSync(c)) return c;
	}
	throw new Error(`mock-pi-script.mjs not found in harness. Searched:\n  ${candidates.join("\n  ")}`);
}

/**
 * Create a mock pi CLI instance for integration tests.
 *
 * Wraps createMockPi() from @marcfargas/pi-test-harness with
 * Windows-specific argv[1] and MOCK_PI_QUEUE_DIR patching.
 *
 * Usage:
 * ```typescript
 * let mockPi: MockPi;
 * before(() => { mockPi = createMockPi(); mockPi.install(); });
 * after(() => mockPi.uninstall());
 * beforeEach(() => { tempDir = createTempDir(); mockPi.reset(); });
 * afterEach(() => removeTempDir(tempDir));
 * ```
 */
export function createMockPi(): MockPi {
	 
	const { createMockPi: _createMockPi } = require("@marcfargas/pi-test-harness") as {
		createMockPi: () => MockPi;
	};
	const inner = _createMockPi();
	let originalArgv1: string | undefined;

	return {
		get dir() {
			return inner.dir;
		},
		install() {
			inner.install();
			if (process.platform === "win32") {
				originalArgv1 = process.argv[1];
				process.argv[1] = findHarnessMockPiScript();
				process.env.MOCK_PI_QUEUE_DIR = inner.dir;
			}
		},
		uninstall() {
			if (process.platform === "win32") {
				if (originalArgv1 !== undefined) {
					process.argv[1] = originalArgv1;
					originalArgv1 = undefined;
				}
				delete process.env.MOCK_PI_QUEUE_DIR;
			}
			inner.uninstall();
		},
		onCall(response) {
			return inner.onCall(response);
		},
		reset() {
			return inner.reset();
		},
		callCount() {
			return inner.callCount();
		},
	};
}

// ---------------------------------------------------------------------------
// Temp directory management
// ---------------------------------------------------------------------------

/** Create a temporary directory for test use. */
export function createTempDir(prefix = "pi-subagent-test-"): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Remove a directory tree, ignoring errors. */
export function removeTempDir(dir: string): void {
	try {
		fs.rmSync(dir, { recursive: true, force: true });
	} catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// Agent config factories
// ---------------------------------------------------------------------------

/**
 * Overrides accepted by makeAgent(). All fields optional —
 * defaults produce a minimal valid AgentConfig.
 */
export interface AgentOverrides {
	description?: string;
	systemPrompt?: string;
	model?: string;
	tools?: string[];
	source?: AgentSource;
	filePath?: string;
}

/**
 * Create a single AgentConfig with sensible defaults.
 *
 * Produces configs matching the extension's AgentConfig interface,
 * including required `systemPrompt`, `source`, and `filePath`.
 */
export function makeAgent(name: string, overrides: AgentOverrides = {}): AgentConfig {
	return {
		name,
		description: overrides.description ?? `Test agent: ${name}`,
		systemPrompt: overrides.systemPrompt ?? "",
		model: overrides.model,
		tools: overrides.tools,
		source: overrides.source ?? "user",
		filePath: overrides.filePath ?? `/tmp/fake-agents/${name}.md`,
	};
}

/**
 * Create an array of minimal AgentConfigs from a list of names.
 *
 * Each agent gets default description, empty system prompt, and "user" source.
 */
export function makeAgentConfigs(names: string[]): AgentConfig[] {
	return names.map((name) => makeAgent(name));
}

// ---------------------------------------------------------------------------
// Write agent .md files to disk (for discoverAgents tests)
// ---------------------------------------------------------------------------

/** Options for a single agent file written by writeTestAgents(). */
export interface TestAgentDef {
	name: string;
	description?: string;
	model?: string;
	tools?: string[];
	systemPrompt?: string;
}

/**
 * Write agent markdown files into a directory, parseable by discoverAgents().
 *
 * Creates `<dir>/<name>.md` for each agent with valid YAML frontmatter.
 * The directory is created if it doesn't exist.
 *
 * @returns Array of absolute paths to the written files.
 */
export function writeTestAgents(dir: string, agents: TestAgentDef[]): string[] {
	fs.mkdirSync(dir, { recursive: true });

	return agents.map((agent) => {
		const frontmatter = [
			`name: ${agent.name}`,
			`description: ${agent.description ?? `Test agent: ${agent.name}`}`,
			agent.model ? `model: ${agent.model}` : null,
			agent.tools?.length ? `tools: ${agent.tools.join(", ")}` : null,
		]
			.filter((line): line is string => line !== null)
			.join("\n");

		const body = agent.systemPrompt ?? `You are ${agent.name}.`;
		const content = `---\n${frontmatter}\n---\n\n${body}\n`;

		const filePath = path.join(dir, `${agent.name}.md`);
		fs.writeFileSync(filePath, content, "utf-8");
		return filePath;
	});
}

// ---------------------------------------------------------------------------
// Dynamic module loading with graceful skip
// ---------------------------------------------------------------------------

/**
 * Try to dynamically import a module, returning null on MODULE_NOT_FOUND.
 *
 * - Bare specifiers (e.g. "@marcfargas/pi-test-harness") → imported as-is.
 * - Relative paths (e.g. "../runner.ts") → resolved from project root
 *   (parent of test/).
 *
 * Only swallows MODULE_NOT_FOUND when the missing module matches the
 * requested bare specifier. All other errors are rethrown.
 */
export async function tryImport<T>(specifier: string): Promise<T | null> {
	const isBare = !(specifier.startsWith(".") || specifier.startsWith("/"));
	try {
		if (!isBare) {
			const projectRoot = path.resolve(__dirname, "..");
			const abs = path.resolve(projectRoot, specifier);
			const url = pathToFileURL(abs).href;
			return (await import(url)) as T;
		}
		return (await import(specifier)) as T;
	} catch (error: unknown) {
		const { code, message } = error as { code?: string; message?: string };
		const isModuleNotFound = code === "MODULE_NOT_FOUND" || code === "ERR_MODULE_NOT_FOUND";
		if (isBare && isModuleNotFound) {
			const msg = String(message ?? "");
			const missing = msg.match(/Cannot find (?:package|module) ['"]([^'"]+)['"]/i)?.[1];
			if (
				missing === specifier ||
				msg.includes(`'${specifier}'`) ||
				msg.includes(`"${specifier}"`)
			) {
				return null;
			}
		}
		throw error;
	}
}

// ---------------------------------------------------------------------------
// JSONL event builders for mock pi responses
// ---------------------------------------------------------------------------

/**
 * Builders for pi JSON-mode JSONL events.
 *
 * Each method returns a plain object matching the event shape emitted
 * by `pi --mode json`. Use with `mockPi.onCall({ jsonl: [...] })`.
 */
export const events = {
	/** Build a message_end event with assistant text. */
	assistantMessage(text: string, model = "mock/test-model"): object {
		return {
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text }],
				model,
				stopReason: "end_turn",
				usage: {
					input: 100,
					output: 50,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 150,
					cost: { total: 0.001 },
				},
			},
		};
	},

	/** Build a message_update event with a text delta. */
	textDelta(delta: string): object {
		return {
			type: "message_update",
			assistantMessageEvent: {
				type: "text_delta",
				delta,
			},
		};
	},

	/** Build a tool_execution_start event. */
	toolStart(toolName: string, args: Record<string, unknown> = {}): object {
		return { type: "tool_execution_start", toolName, args };
	},

	/** Build a tool_execution_end event. */
	toolEnd(toolName: string): object {
		return { type: "tool_execution_end", toolName };
	},

	/** Build a tool_result_end event. */
	toolResult(toolName: string, text: string, isError = false): object {
		return {
			type: "tool_result_end",
			message: {
				role: "toolResult",
				toolName,
				isError,
				content: [{ type: "text", text }],
			},
		};
	},
};
