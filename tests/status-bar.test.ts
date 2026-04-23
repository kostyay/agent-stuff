/**
 * Unit tests for pi-extensions/status-bar — the powerline-styled two-line footer.
 *
 * Tests pure utility functions (hashString, hslToRgbAnsi, formatTokenCount,
 * formatBytesPerSec, getProfileName, getAuthLabel) and the extension's
 * event-driven behavior via mocked ExtensionAPI / ExtensionContext.
 *
 * Layout:
 *   Line 1 (index 0): profile▸auth▸📁dir▸branch + changes + tickets/bgrun + T{n}
 *   Line 2 (index 1): ●mode▸model▸🧠thinking▸████░░ pct% + speed/cache/cost
 *
 * Uses Node's built-in test runner (node:test + node:assert).
 * Run with: node --experimental-strip-types --test tests/status-bar.test.ts
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import statusBarExtension, {
	MUTATING_TOOLS,
	formatBytesPerSec,
	formatTokenCount,
	getAuthLabel,
	getProfileName,
	hashString,
	hslToRgbAnsi,
} from "../pi-extensions/status-bar.ts";

// ---------------------------------------------------------------------------
// Shared test helpers
// ---------------------------------------------------------------------------

/**
 * Save and restore a single environment variable across tests.
 * Call in a `describe` block to register an `afterEach` that restores the value.
 */
function withEnvRestore(varName: string): void {
	const original = process.env[varName];
	afterEach(() => {
		if (original === undefined) {
			delete process.env[varName];
		} else {
			process.env[varName] = original;
		}
	});
}

/** Parse "R;G;B" ANSI string into numeric tuple. */
function parseRgbAnsi(s: string): [number, number, number] {
	const [r, g, b] = s.split(";").map(Number);
	return [r, g, b];
}

// ---------------------------------------------------------------------------
// hashString
// ---------------------------------------------------------------------------

describe("hashString", () => {
	it("returns a positive 32-bit integer", () => {
		const h = hashString("hello");
		assert.equal(typeof h, "number");
		assert.ok(h >= 0, "hash should be non-negative");
		assert.ok(h <= 0xffffffff, "hash should fit in 32 bits");
	});

	it("is deterministic", () => {
		assert.equal(hashString("work"), hashString("work"));
		assert.equal(hashString("personal"), hashString("personal"));
	});

	it("produces different hashes for different inputs", () => {
		assert.notEqual(hashString("work"), hashString("personal"));
		assert.notEqual(hashString("a"), hashString("b"));
	});

	it("handles empty string", () => {
		const h = hashString("");
		assert.equal(typeof h, "number");
		assert.equal(h, 5381); // djb2 initial value with no iterations
	});
});

// ---------------------------------------------------------------------------
// hslToRgbAnsi
// ---------------------------------------------------------------------------

describe("hslToRgbAnsi", () => {
	it("converts pure red (h=0, s=1, l=0.5)", () => {
		const [r, g, b] = parseRgbAnsi(hslToRgbAnsi(0, 1, 0.5));
		assert.equal(r, 255);
		assert.equal(g, 0);
		assert.equal(b, 0);
	});

	it("converts pure green (h=120, s=1, l=0.5)", () => {
		const [r, g, b] = parseRgbAnsi(hslToRgbAnsi(120, 1, 0.5));
		assert.equal(r, 0);
		assert.equal(g, 255);
		assert.equal(b, 0);
	});

	it("converts pure blue (h=240, s=1, l=0.5)", () => {
		const [r, g, b] = parseRgbAnsi(hslToRgbAnsi(240, 1, 0.5));
		assert.equal(r, 0);
		assert.equal(g, 0);
		assert.equal(b, 255);
	});

	it("converts black (l=0)", () => {
		const [r, g, b] = parseRgbAnsi(hslToRgbAnsi(0, 1, 0));
		assert.equal(r, 0);
		assert.equal(g, 0);
		assert.equal(b, 0);
	});

	it("converts white (l=1)", () => {
		const [r, g, b] = parseRgbAnsi(hslToRgbAnsi(0, 1, 1));
		assert.equal(r, 255);
		assert.equal(g, 255);
		assert.equal(b, 255);
	});

	it("converts grey (s=0)", () => {
		const [r, g, b] = parseRgbAnsi(hslToRgbAnsi(0, 0, 0.5));
		assert.equal(r, 128);
		assert.equal(g, 128);
		assert.equal(b, 128);
	});

	it("returns values in 0-255 range for all hue sectors", () => {
		for (const h of [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330, 359]) {
			const [r, g, b] = parseRgbAnsi(hslToRgbAnsi(h, 0.65, 0.38));
			for (const ch of [r, g, b]) {
				assert.ok(ch >= 0 && ch <= 255, `channel out of range for h=${h}: ${ch}`);
				assert.equal(ch, Math.round(ch), `channel not integer for h=${h}: ${ch}`);
			}
		}
	});

	it("returns semicolon-separated R;G;B string", () => {
		const result = hslToRgbAnsi(0, 1, 0.5);
		assert.match(result, /^\d+;\d+;\d+$/);
	});

	it("covers all six hue sectors with distinct colors", () => {
		const colors = [0, 60, 120, 180, 240, 300].map((h) => hslToRgbAnsi(h, 1, 0.5));
		const unique = new Set(colors);
		assert.equal(unique.size, 6, "all six sectors should produce distinct colors");
	});
});

// ---------------------------------------------------------------------------
// formatBytesPerSec
// ---------------------------------------------------------------------------

describe("formatBytesPerSec", () => {
	it("formats small values as B/s", () => {
		assert.equal(formatBytesPerSec(0), "0B/s");
		assert.equal(formatBytesPerSec(512), "512B/s");
		assert.equal(formatBytesPerSec(999), "999B/s");
	});

	it("formats kilobytes with kB/s suffix", () => {
		assert.equal(formatBytesPerSec(1_000), "1.0kB/s");
		assert.equal(formatBytesPerSec(1_500), "1.5kB/s");
		assert.equal(formatBytesPerSec(999_999), "1000.0kB/s");
	});

	it("formats megabytes with MB/s suffix", () => {
		assert.equal(formatBytesPerSec(1_000_000), "1.0MB/s");
		assert.equal(formatBytesPerSec(2_500_000), "2.5MB/s");
	});
});

// ---------------------------------------------------------------------------
// formatTokenCount
// ---------------------------------------------------------------------------

describe("formatTokenCount", () => {
	it("returns raw number below 1k", () => {
		assert.equal(formatTokenCount(0), "0");
		assert.equal(formatTokenCount(1), "1");
		assert.equal(formatTokenCount(999), "999");
	});

	it("formats thousands with k suffix", () => {
		assert.equal(formatTokenCount(1_000), "1k");
		assert.equal(formatTokenCount(1_500), "1.5k");
		assert.equal(formatTokenCount(12_300), "12.3k");
		assert.equal(formatTokenCount(999_999), "1000k");
	});

	it("formats millions with M suffix", () => {
		assert.equal(formatTokenCount(1_000_000), "1M");
		assert.equal(formatTokenCount(2_500_000), "2.5M");
		assert.equal(formatTokenCount(10_000_000), "10M");
	});

	it("strips trailing .0", () => {
		assert.equal(formatTokenCount(2_000), "2k");
		assert.equal(formatTokenCount(3_000_000), "3M");
	});
});

// ---------------------------------------------------------------------------
// getProfileName
// ---------------------------------------------------------------------------

describe("getProfileName", () => {
	withEnvRestore("PI_CODING_AGENT_DIR");

	it("returns undefined when env var is not set", () => {
		delete process.env.PI_CODING_AGENT_DIR;
		assert.equal(getProfileName(), undefined);
	});

	it("returns undefined when env var is empty", () => {
		process.env.PI_CODING_AGENT_DIR = "";
		assert.equal(getProfileName(), undefined);
	});

	it("returns undefined for the default 'agent' directory name", () => {
		process.env.PI_CODING_AGENT_DIR = "/home/user/.pi/agent";
		assert.equal(getProfileName(), undefined);
	});

	it("returns the basename for a custom directory", () => {
		process.env.PI_CODING_AGENT_DIR = "/home/user/.pi/agent-work";
		assert.equal(getProfileName(), "agent-work");
	});

	it("handles nested paths", () => {
		process.env.PI_CODING_AGENT_DIR = "/some/deep/path/personal";
		assert.equal(getProfileName(), "personal");
	});
});

// ---------------------------------------------------------------------------
// getAuthLabel
// ---------------------------------------------------------------------------

describe("getAuthLabel", () => {
	it("returns 'no-auth' when model is undefined", () => {
		const ctx = { model: undefined, modelRegistry: { isUsingOAuth: () => false } };
		assert.equal(getAuthLabel(ctx as any), "no-auth");
	});

	it("returns 'oauth' when model uses OAuth", () => {
		const model = { id: "test", provider: "anthropic" };
		const ctx = { model, modelRegistry: { isUsingOAuth: () => true } };
		assert.equal(getAuthLabel(ctx as any), "oauth");
	});

	it("returns 'api-key' when model uses an API key", () => {
		const model = { id: "test", provider: "anthropic" };
		const ctx = { model, modelRegistry: { isUsingOAuth: () => false } };
		assert.equal(getAuthLabel(ctx as any), "api-key");
	});

	it("passes the model to isUsingOAuth", () => {
		const model = { id: "claude-sonnet", provider: "anthropic" };
		let receivedModel: unknown;
		const ctx = {
			model,
			modelRegistry: {
				isUsingOAuth: (m: unknown) => { receivedModel = m; return false; },
			},
		};
		getAuthLabel(ctx as any);
		assert.equal(receivedModel, model);
	});
});

// ---------------------------------------------------------------------------
// MUTATING_TOOLS
// ---------------------------------------------------------------------------

describe("MUTATING_TOOLS", () => {
	it("contains write, edit, and bash", () => {
		assert.ok(MUTATING_TOOLS.has("write"));
		assert.ok(MUTATING_TOOLS.has("edit"));
		assert.ok(MUTATING_TOOLS.has("bash"));
	});

	it("does not contain read-only tools", () => {
		assert.ok(!MUTATING_TOOLS.has("read"));
		assert.ok(!MUTATING_TOOLS.has("grep"));
		assert.ok(!MUTATING_TOOLS.has("find"));
		assert.ok(!MUTATING_TOOLS.has("ls"));
	});
});

// ---------------------------------------------------------------------------
// statusBarExtension (integration via mocked ExtensionAPI)
// ---------------------------------------------------------------------------

describe("statusBarExtension", () => {
	/** Minimal mock of ExtensionAPI that captures registered handlers. */
	function createMockPI() {
		const handlers = new Map<string, ((...args: any[]) => any)[]>();
		const eventListeners = new Map<string, ((...args: any[]) => any)[]>();

		const pi = {
			on(event: string, handler: (...args: any[]) => any) {
				if (!handlers.has(event)) handlers.set(event, []);
				handlers.get(event)!.push(handler);
			},
			exec: async () => ({ stdout: "", stderr: "", code: 0 }),
			events: {
				on(event: string, handler: (...args: any[]) => any) {
					if (!eventListeners.has(event)) eventListeners.set(event, []);
					eventListeners.get(event)!.push(handler);
				},
				emit(event: string, data: unknown) {
					for (const handler of eventListeners.get(event) ?? []) {
						handler(data);
					}
				},
			},
			getThinkingLevel: () => "off" as const,
		};

		return { pi: pi as any, handlers, eventListeners };
	}

	/** Minimal mock of ExtensionContext. */
	function createMockCtx(options: {
		branch?: any[];
		model?: any;
		oauth?: boolean;
		cwd?: string;
		contextPercent?: number | null;
	} = {}) {
		let footerFactory: any = null;
		let footerClearedFlag = false;

		return {
			ctx: {
				hasUI: true,
				sessionManager: {
					getBranch: () => options.branch ?? [],
				},
				model: options.model ?? { id: "test-model", provider: "anthropic" },
				modelRegistry: {
					isUsingOAuth: () => options.oauth ?? false,
				},
				cwd: options.cwd ?? "/home/user/project",
				getContextUsage: () => options.contextPercent != null
					? { percent: options.contextPercent, tokens: 1000, contextWindow: 200000 }
					: undefined,
				ui: {
					setFooter: (factory: any) => {
						if (factory === undefined) {
							footerClearedFlag = true;
							footerFactory = null;
						} else {
							footerFactory = factory;
						}
					},
				},
			} as any,
			getFooterFactory: () => footerFactory,
			footerCleared: () => footerClearedFlag,
		};
	}

	/** Create mock footer args and render at the given width. */
	function renderFooter(
		factory: any,
		options: { gitBranch?: string | null; statuses?: Map<string, string> } = {},
	): string[] {
		const tui = { requestRender: () => {} };
		const theme = {
			fg: (_color: string, text: string) => text,
			getFgAnsi: () => "",
			bold: (text: string) => text,
		};
		const footerData = {
			onBranchChange: () => () => {},
			getExtensionStatuses: () => options.statuses ?? new Map<string, string>(),
			getGitBranch: () => options.gitBranch ?? null,
		};
		const component = factory(tui, theme, footerData);
		return component.render(120);
	}

	it("registers all expected event handlers", () => {
		const { pi, handlers } = createMockPI();
		statusBarExtension(pi);

		const registeredEvents = [...handlers.keys()];
		assert.ok(registeredEvents.includes("message_start"));
		assert.ok(registeredEvents.includes("message_update"));
		assert.ok(registeredEvents.includes("message_end"));
		assert.ok(registeredEvents.includes("tool_execution_end"));
		assert.ok(registeredEvents.includes("turn_start"));
		assert.ok(registeredEvents.includes("turn_end"));
		assert.ok(registeredEvents.includes("agent_end"));
		assert.ok(registeredEvents.includes("session_start"));
		assert.ok(registeredEvents.includes("session_shutdown"));
	});

	it("subscribes to ticket:stats and bgrun:stats events", () => {
		const { pi, eventListeners } = createMockPI();
		statusBarExtension(pi);

		assert.ok(eventListeners.has("ticket:stats"), "should listen for ticket:stats");
		assert.ok(eventListeners.has("bgrun:stats"), "should listen for bgrun:stats");
	});

	it("turn_start increments turn count and sets active", async () => {
		const { pi, handlers } = createMockPI();
		statusBarExtension(pi);

		await handlers.get("turn_start")![0]({}, {});
		await handlers.get("turn_start")![0]({}, {});

		const { ctx, getFooterFactory } = createMockCtx({ branch: [] });
		await handlers.get("session_start")![0]({}, ctx);

		const lines = renderFooter(getFooterFactory());
		// Turn count is on line 1 (index 0) in the new layout
		assert.ok(lines[0].includes("T2"), "should show turn count of 2");
	});

	it("turn_end and agent_end clear active state", async () => {
		const { pi, handlers } = createMockPI();
		statusBarExtension(pi);

		const { ctx, getFooterFactory } = createMockCtx({ branch: [] });
		await handlers.get("session_start")![0]({}, ctx);

		// Status icon (●/✓) is on line 2 (index 1) in the mode segment
		await handlers.get("turn_start")![0]({}, {});
		const activeLines = renderFooter(getFooterFactory());
		assert.ok(activeLines[1].includes("●"), "should show ● when active");

		await handlers.get("turn_end")![0]({}, {});
		const idleLines = renderFooter(getFooterFactory());
		assert.ok(idleLines[1].includes("✓"), "should show ✓ after turn_end");

		await handlers.get("turn_start")![0]({}, {});
		await handlers.get("agent_end")![0]({}, {});
		const agentEndLines = renderFooter(getFooterFactory());
		assert.ok(agentEndLines[1].includes("✓"), "should show ✓ after agent_end");
	});

	it("session_start reconstructs turn count from branch history", async () => {
		const { pi, handlers } = createMockPI();
		statusBarExtension(pi);

		const branch = [
			{ type: "message", message: { role: "user" } },
			{
				type: "message", message: {
					role: "assistant",
					usage: { input: 100, output: 50, cacheRead: 0, cacheCreation: 0, cost: { total: 0.01 } },
				},
			},
			{
				type: "message", message: {
					role: "assistant",
					usage: { input: 200, output: 100, cacheRead: 0, cacheCreation: 0, cost: { total: 0.02 } },
				},
			},
			{ type: "custom", customType: "something-else" },
		];
		const { ctx, getFooterFactory } = createMockCtx({ branch });

		await handlers.get("session_start")![0]({}, ctx);
		assert.ok(getFooterFactory(), "setFooter should have been called");

		const lines = renderFooter(getFooterFactory());
		assert.ok(lines[0].includes("T2"), "should count 2 assistant messages as 2 turns");
	});

	it("footer line 1 renders two lines", async () => {
		const { pi, handlers } = createMockPI();
		statusBarExtension(pi);

		const branch = [
			{
				type: "message", message: {
					role: "assistant",
					usage: { input: 1500, output: 300, cacheRead: 0, cacheCreation: 0, cost: { total: 0.005 } },
				},
			},
		];
		const { ctx, getFooterFactory } = createMockCtx({ branch, contextPercent: 25 });
		await handlers.get("session_start")![0]({}, ctx);

		const lines = renderFooter(getFooterFactory());
		assert.equal(lines.length, 2, "footer should render exactly 2 lines");
	});

	it("footer line 2 contains model name and context percentage", async () => {
		const { pi, handlers } = createMockPI();
		statusBarExtension(pi);

		const { ctx, getFooterFactory } = createMockCtx({
			branch: [],
			model: { id: "claude-sonnet-4", provider: "anthropic" },
			contextPercent: 42,
		});
		await handlers.get("session_start")![0]({}, ctx);

		const lines = renderFooter(getFooterFactory());
		// Model and context % are on line 2 (index 1) in the new layout
		assert.ok(lines[1].includes("claude-sonnet-4"), "line 2 should contain model name");
		assert.ok(lines[1].includes("42%"), "line 2 should contain context percentage");
	});

	it("footer line 2 contains cache tokens and cost", async () => {
		const { pi, handlers } = createMockPI();
		statusBarExtension(pi);

		const branch = [
			{
				type: "message", message: {
					role: "assistant",
					usage: { input: 5000, output: 1200, cacheRead: 800, cacheCreation: 0, cost: { total: 0.0123 } },
				},
			},
		];
		const { ctx, getFooterFactory } = createMockCtx({ branch, contextPercent: 10 });
		await handlers.get("session_start")![0]({}, ctx);

		const lines = renderFooter(getFooterFactory());
		assert.ok(lines[1].includes("⚡800"), "should show cache tokens");
		assert.ok(lines[1].includes("$0.0123"), "should show cost");
	});

	it("footer line 2 omits cache when zero", async () => {
		const { pi, handlers } = createMockPI();
		statusBarExtension(pi);

		const branch = [
			{
				type: "message", message: {
					role: "assistant",
					usage: { input: 100, output: 50, cacheRead: 0, cacheCreation: 0, cost: { total: 0.001 } },
				},
			},
		];
		const { ctx, getFooterFactory } = createMockCtx({ branch, contextPercent: 5 });
		await handlers.get("session_start")![0]({}, ctx);

		const lines = renderFooter(getFooterFactory());
		assert.ok(!lines[1].includes("⚡"), "should not show cache icon when zero");
	});

	it("footer line 2 accumulates cache and cost from multiple messages", async () => {
		const { pi, handlers } = createMockPI();
		statusBarExtension(pi);

		const branch = [
			{
				type: "message", message: {
					role: "assistant",
					usage: { input: 1000, output: 200, cacheRead: 50, cacheCreation: 0, cost: { total: 0.01 } },
				},
			},
			{
				type: "message", message: {
					role: "assistant",
					usage: { input: 2000, output: 300, cacheRead: 100, cacheCreation: 0, cost: { total: 0.02 } },
				},
			},
		];
		const { ctx, getFooterFactory } = createMockCtx({ branch, contextPercent: 15 });
		await handlers.get("session_start")![0]({}, ctx);

		const lines = renderFooter(getFooterFactory());
		assert.ok(lines[1].includes("⚡150"), "should sum cache tokens: 50+100=150");
		assert.ok(lines[1].includes("$0.0300"), "should sum costs: 0.01+0.02=0.03");
	});

	it("footer line 1 contains directory name", async () => {
		const { pi, handlers } = createMockPI();
		statusBarExtension(pi);

		const { ctx, getFooterFactory } = createMockCtx({ branch: [], cwd: "/home/user/my-project" });
		await handlers.get("session_start")![0]({}, ctx);

		const lines = renderFooter(getFooterFactory());
		assert.ok(lines[0].includes("my-project"), "line 1 should contain cwd basename");
	});

	it("footer line 1 contains git branch when available", async () => {
		const { pi, handlers } = createMockPI();
		statusBarExtension(pi);

		const { ctx, getFooterFactory } = createMockCtx({ branch: [] });
		await handlers.get("session_start")![0]({}, ctx);

		const lines = renderFooter(getFooterFactory(), { gitBranch: "feat/cool-feature" });
		assert.ok(lines[0].includes("feat/cool-feature"), "line 1 should contain branch name");
	});

	it("footer line 1 shows turn count", async () => {
		const { pi, handlers } = createMockPI();
		statusBarExtension(pi);

		for (let i = 0; i < 3; i++) {
			await handlers.get("turn_start")![0]({}, {});
			await handlers.get("turn_end")![0]({}, {});
		}

		const { ctx, getFooterFactory } = createMockCtx({ branch: [] });
		await handlers.get("session_start")![0]({}, ctx);

		const lines = renderFooter(getFooterFactory());
		assert.ok(lines[0].includes("T3"), "line 1 should show turn count");
	});

	it("footer line 2 shows ✓ when idle and ● when active", async () => {
		const { pi, handlers } = createMockPI();
		statusBarExtension(pi);

		const { ctx, getFooterFactory } = createMockCtx({ branch: [] });
		await handlers.get("session_start")![0]({}, ctx);

		const idleLines = renderFooter(getFooterFactory());
		assert.ok(idleLines[1].includes("✓"), "should show ✓ when idle");

		await handlers.get("turn_start")![0]({}, {});
		const activeLines = renderFooter(getFooterFactory());
		assert.ok(activeLines[1].includes("●"), "should show ● when active");
	});

	it("session_start with reason 'new' resets turn count", async () => {
		const { pi, handlers } = createMockPI();
		statusBarExtension(pi);

		await handlers.get("turn_start")![0]({}, {});
		await handlers.get("turn_end")![0]({}, {});
		await handlers.get("turn_start")![0]({}, {});
		await handlers.get("turn_end")![0]({}, {});

		const { ctx, getFooterFactory } = createMockCtx({ branch: [] });
		await handlers.get("session_start")![0]({ reason: "new" }, ctx);

		const lines = renderFooter(getFooterFactory());
		assert.ok(lines[0].includes("T0"), "turn count should be reset after new session");
	});

	it("session_start with reason 'resume' rebuilds turn count from branch", async () => {
		// Resume loads a different session file, so any in-memory counter from
		// the previous session is discarded and rebuilt from the resumed branch.
		const { pi, handlers } = createMockPI();
		statusBarExtension(pi);

		await handlers.get("turn_start")![0]({}, {});
		await handlers.get("turn_end")![0]({}, {});

		const branch = [
			{ type: "message", message: { role: "user" } },
			{
				type: "message", message: {
					role: "assistant",
					usage: { input: 100, output: 50, cacheRead: 0, cacheCreation: 0, cost: { total: 0.01 } },
				},
			},
		];
		const { ctx, getFooterFactory } = createMockCtx({ branch });
		await handlers.get("session_start")![0]({ reason: "resume" }, ctx);

		const lines = renderFooter(getFooterFactory());
		assert.ok(lines[0].includes("T1"), "turn count should reflect the resumed session's branch");
	});

	it("session_start with reason 'reload' preserves turn count", async () => {
		// Reload keeps the same session, so in-memory counters survive; the
		// handler re-counts from the branch which reflects the live session.
		const { pi, handlers } = createMockPI();
		statusBarExtension(pi);

		await handlers.get("turn_start")![0]({}, {});
		await handlers.get("turn_end")![0]({}, {});

		const { ctx, getFooterFactory } = createMockCtx({ branch: [] });
		await handlers.get("session_start")![0]({ reason: "reload" }, ctx);

		const lines = renderFooter(getFooterFactory());
		assert.ok(lines[0].includes("T1"), "turn count should be preserved on reload");
	});

	it("session_shutdown tears down the footer and clears state", async () => {
		const { pi, handlers } = createMockPI();
		statusBarExtension(pi);

		const { ctx, getFooterFactory, footerCleared } = createMockCtx({ branch: [] });
		await handlers.get("session_start")![0]({ reason: "startup" }, ctx);
		assert.ok(getFooterFactory(), "footer should be registered on session_start");

		await handlers.get("session_shutdown")![0]({}, ctx);
		assert.ok(footerCleared(), "setFooter(undefined) should be called on session_shutdown");
	});

	it("footer handles null context usage gracefully", async () => {
		const { pi, handlers } = createMockPI();
		statusBarExtension(pi);

		const { ctx, getFooterFactory } = createMockCtx({ branch: [], contextPercent: null });
		await handlers.get("session_start")![0]({}, ctx);

		const lines = renderFooter(getFooterFactory());
		assert.equal(lines.length, 2, "should still render 2 lines");
		// Context % is on line 2 (index 1) in the new layout
		assert.ok(lines[1].includes("0%"), "should show 0% when context usage is null");
	});

	it("footer renders 3 lines when sandbox status is present", async () => {
		const { pi, handlers } = createMockPI();
		statusBarExtension(pi);

		const { ctx, getFooterFactory } = createMockCtx({ branch: [] });
		await handlers.get("session_start")![0]({}, ctx);

		const statuses = new Map<string, string>();
		statuses.set("sandbox", "🔒 sandbox active");
		const lines = renderFooter(getFooterFactory(), { statuses });
		assert.equal(lines.length, 3, "should render 3 lines with sandbox");
		assert.ok(lines[2].includes("sandbox active"), "line 3 should contain sandbox status");
	});

	it("footer component has dispose and invalidate", async () => {
		const { pi, handlers } = createMockPI();
		statusBarExtension(pi);

		const { ctx, getFooterFactory } = createMockCtx({ branch: [] });
		await handlers.get("session_start")![0]({}, ctx);

		const factory = getFooterFactory();
		const tui = { requestRender: () => {} };
		const theme = {
			fg: (_c: string, t: string) => t,
			getFgAnsi: () => "",
			bold: (t: string) => t,
		};
		const footerData = {
			onBranchChange: () => () => {},
			getExtensionStatuses: () => new Map<string, string>(),
			getGitBranch: () => null,
		};
		const component = factory(tui, theme, footerData);

		assert.equal(typeof component.dispose, "function");
		assert.equal(typeof component.invalidate, "function");
		assert.equal(typeof component.render, "function");

		component.invalidate();
		component.dispose();
	});

	it("tool_execution_end triggers diff refresh for mutating tools only", async () => {
		let execCalled = false;
		const { pi, handlers } = createMockPI();
		// Override exec to track calls
		pi.exec = async () => {
			execCalled = true;
			return { stdout: "", stderr: "", code: 0 };
		};
		statusBarExtension(pi);

		const { ctx } = createMockCtx();

		// Non-mutating tool should not trigger exec
		execCalled = false;
		await handlers.get("tool_execution_end")![0]({ toolName: "read" }, ctx);
		// Give the debounced timer a chance to fire
		await new Promise((resolve) => setTimeout(resolve, 600));
		assert.ok(!execCalled, "read should not trigger diff refresh");

		// Mutating tool should trigger exec (after debounce)
		execCalled = false;
		await handlers.get("tool_execution_end")![0]({ toolName: "write" }, ctx);
		await new Promise((resolve) => setTimeout(resolve, 600));
		assert.ok(execCalled, "write should trigger diff refresh");
	});
});
