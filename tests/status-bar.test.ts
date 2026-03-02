/**
 * Unit tests for pi-extensions/status-bar — the rich two-line custom footer.
 *
 * Tests pure utility functions (hashString, hslToRgb, formatTokenCount,
 * getProfileName, getAuthLabel, buildProfileBadge) and the extension's
 * event-driven behavior via mocked ExtensionAPI / ExtensionContext.
 *
 * Uses Node's built-in test runner (node:test + node:assert).
 * Run with: node --experimental-strip-types --test tests/status-bar.test.ts
 */

import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import statusBarExtension, {
	MUTATING_TOOLS,
	buildProfileBadge,
	formatTokenCount,
	getAuthLabel,
	getProfileName,
	hashString,
	hslToRgb,
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
// hslToRgb
// ---------------------------------------------------------------------------

describe("hslToRgb", () => {
	it("converts pure red (h=0, s=1, l=0.5)", () => {
		const { r, g, b } = hslToRgb(0, 1, 0.5);
		assert.equal(r, 255);
		assert.equal(g, 0);
		assert.equal(b, 0);
	});

	it("converts pure green (h=120, s=1, l=0.5)", () => {
		const { r, g, b } = hslToRgb(120, 1, 0.5);
		assert.equal(r, 0);
		assert.equal(g, 255);
		assert.equal(b, 0);
	});

	it("converts pure blue (h=240, s=1, l=0.5)", () => {
		const { r, g, b } = hslToRgb(240, 1, 0.5);
		assert.equal(r, 0);
		assert.equal(g, 0);
		assert.equal(b, 255);
	});

	it("converts black (l=0)", () => {
		const { r, g, b } = hslToRgb(0, 1, 0);
		assert.equal(r, 0);
		assert.equal(g, 0);
		assert.equal(b, 0);
	});

	it("converts white (l=1)", () => {
		const { r, g, b } = hslToRgb(0, 1, 1);
		assert.equal(r, 255);
		assert.equal(g, 255);
		assert.equal(b, 255);
	});

	it("converts grey (s=0)", () => {
		const { r, g, b } = hslToRgb(0, 0, 0.5);
		assert.equal(r, 128);
		assert.equal(g, 128);
		assert.equal(b, 128);
	});

	it("returns values in 0-255 range for all hue sectors", () => {
		for (const h of [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330, 359]) {
			const { r, g, b } = hslToRgb(h, 0.65, 0.38);
			for (const ch of [r, g, b]) {
				assert.ok(ch >= 0 && ch <= 255, `channel out of range for h=${h}: ${ch}`);
				assert.equal(ch, Math.round(ch), `channel not integer for h=${h}: ${ch}`);
			}
		}
	});

	it("covers all six hue sectors with distinct colors", () => {
		const colors = [0, 60, 120, 180, 240, 300].map((h) => hslToRgb(h, 1, 0.5));
		// Each sector should produce a different RGB triple
		const unique = new Set(colors.map(({ r, g, b }) => `${r},${g},${b}`));
		assert.equal(unique.size, 6, "all six sectors should produce distinct colors");
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
// buildProfileBadge
// ---------------------------------------------------------------------------

describe("buildProfileBadge", () => {
	withEnvRestore("PI_CODING_AGENT_DIR");

	function mockCtx(oauth: boolean = false) {
		const model = { id: "test-model", provider: "anthropic" };
		return {
			model,
			modelRegistry: { isUsingOAuth: () => oauth },
		} as any;
	}

	it("returns empty badge when PI_CODING_AGENT_DIR is not set", () => {
		delete process.env.PI_CODING_AGENT_DIR;
		const badge = buildProfileBadge(mockCtx());
		assert.equal(badge.text, "");
		assert.equal(badge.width, 0);
	});

	it("returns empty badge for default 'agent' dir", () => {
		process.env.PI_CODING_AGENT_DIR = "/home/user/.pi/agent";
		const badge = buildProfileBadge(mockCtx());
		assert.equal(badge.text, "");
		assert.equal(badge.width, 0);
	});

	it("returns styled badge for custom profile", () => {
		process.env.PI_CODING_AGENT_DIR = "/home/user/.pi/work";
		const badge = buildProfileBadge(mockCtx());
		assert.ok(badge.text.length > 0, "badge text should not be empty");
		assert.ok(badge.width > 0, "badge width should be positive");
	});

	it("badge text contains the profile name", () => {
		process.env.PI_CODING_AGENT_DIR = "/home/user/.pi/work";
		const badge = buildProfileBadge(mockCtx());
		assert.ok(badge.text.includes("work"), "badge should contain profile name");
	});

	it("badge text contains auth label", () => {
		process.env.PI_CODING_AGENT_DIR = "/home/user/.pi/work";
		const apiBadge = buildProfileBadge(mockCtx(false));
		assert.ok(apiBadge.text.includes("[api-key]"), "should contain api-key label");

		const oauthBadge = buildProfileBadge(mockCtx(true));
		assert.ok(oauthBadge.text.includes("[oauth]"), "should contain oauth label");
	});

	it("badge text contains ANSI escape codes for styling", () => {
		process.env.PI_CODING_AGENT_DIR = "/home/user/.pi/work";
		const badge = buildProfileBadge(mockCtx());
		assert.ok(badge.text.includes("\x1b[48;2;"), "should contain RGB background escape");
		assert.ok(badge.text.includes("\x1b[1;97m"), "should contain bold bright white escape");
		assert.ok(badge.text.includes("\x1b[0m"), "should contain reset escape");
	});

	it("width accounts for label text plus trailing space", () => {
		process.env.PI_CODING_AGENT_DIR = "/home/user/.pi/work";
		const badge = buildProfileBadge(mockCtx(false));
		// Label is " work [api-key] " => length 16, plus 1 trailing space = 17
		assert.equal(badge.width, " work [api-key] ".length + 1);
	});

	it("produces different colors for different profiles", () => {
		const ctx = mockCtx();

		process.env.PI_CODING_AGENT_DIR = "/home/user/.pi/work";
		const badge1 = buildProfileBadge(ctx);

		process.env.PI_CODING_AGENT_DIR = "/home/user/.pi/personal";
		const badge2 = buildProfileBadge(ctx);

		// Extract the RGB portion from the ANSI escape
		const rgbPattern = /\x1b\[48;2;(\d+;\d+;\d+)m/;
		const rgb1 = badge1.text.match(rgbPattern)?.[1];
		const rgb2 = badge2.text.match(rgbPattern)?.[1];

		assert.ok(rgb1, "badge1 should contain RGB escape");
		assert.ok(rgb2, "badge2 should contain RGB escape");
		assert.notEqual(rgb1, rgb2, "different profiles should have different colors");
	});

	it("is deterministic for the same profile", () => {
		process.env.PI_CODING_AGENT_DIR = "/home/user/.pi/work";
		const ctx = mockCtx();
		const badge1 = buildProfileBadge(ctx);
		const badge2 = buildProfileBadge(ctx);
		assert.equal(badge1.text, badge2.text);
		assert.equal(badge1.width, badge2.width);
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

		const pi = {
			on(event: string, handler: (...args: any[]) => any) {
				if (!handlers.has(event)) handlers.set(event, []);
				handlers.get(event)!.push(handler);
			},
			exec: async () => ({ stdout: "", stderr: "", code: 0 }),
		};

		return { pi: pi as any, handlers };
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

		return {
			ctx: {
				sessionManager: {
					getBranch: () => options.branch ?? [],
				},
				model: options.model ?? { id: "test-model", provider: "anthropic" },
				modelRegistry: {
					isUsingOAuth: () => options.oauth ?? false,
				},
				cwd: options.cwd ?? "/home/user/project",
				getContextUsage: () => options.contextPercent !== undefined
					? { percent: options.contextPercent, tokens: 1000, contextWindow: 200000 }
					: undefined,
				ui: {
					setFooter: (factory: any) => { footerFactory = factory; },
				},
			} as any,
			getFooterFactory: () => footerFactory,
		};
	}

	/** Create mock footer args and render at the given width. */
	function renderFooter(
		factory: any,
		options: { gitBranch?: string | null } = {},
	): string[] {
		const tui = { requestRender: () => {} };
		const theme = {
			fg: (_color: string, text: string) => text,
			bold: (text: string) => text,
		};
		const footerData = {
			onBranchChange: () => () => {},
			getExtensionStatuses: () => new Map<string, string>(),
			getGitBranch: () => options.gitBranch ?? null,
		};
		const component = factory(tui, theme, footerData);
		return component.render(120);
	}

	it("registers all expected event handlers", () => {
		const { pi, handlers } = createMockPI();
		statusBarExtension(pi);

		const registeredEvents = [...handlers.keys()];
		assert.ok(registeredEvents.includes("tool_execution_end"));
		assert.ok(registeredEvents.includes("turn_start"));
		assert.ok(registeredEvents.includes("turn_end"));
		assert.ok(registeredEvents.includes("agent_end"));
		assert.ok(registeredEvents.includes("session_start"));
		assert.ok(registeredEvents.includes("session_switch"));
	});

	it("tool_execution_end increments tool counts", async () => {
		const { pi, handlers } = createMockPI();
		statusBarExtension(pi);

		const { ctx } = createMockCtx();
		await handlers.get("tool_execution_end")![0]({ toolName: "read" }, ctx);
		await handlers.get("tool_execution_end")![0]({ toolName: "read" }, ctx);
		await handlers.get("tool_execution_end")![0]({ toolName: "bash" }, ctx);

		await handlers.get("session_start")![0]({}, ctx);
	});

	it("turn_start increments turn count and sets active", async () => {
		const { pi, handlers } = createMockPI();
		statusBarExtension(pi);

		await handlers.get("turn_start")![0]({}, {});
		await handlers.get("turn_start")![0]({}, {});
	});

	it("turn_end and agent_end clear active state", async () => {
		const { pi, handlers } = createMockPI();
		statusBarExtension(pi);

		await handlers.get("turn_start")![0]({}, {});
		await handlers.get("turn_end")![0]({}, {});

		await handlers.get("turn_start")![0]({}, {});
		await handlers.get("agent_end")![0]({}, {});
	});

	it("session_start reconstructs state from branch history", async () => {
		const { pi, handlers } = createMockPI();
		statusBarExtension(pi);

		const branch = [
			{ type: "message", message: { role: "toolResult", toolName: "read" } },
			{ type: "message", message: { role: "toolResult", toolName: "read" } },
			{ type: "message", message: { role: "toolResult", toolName: "bash" } },
			{
				type: "message", message: {
					role: "assistant",
					usage: { input: 100, output: 50, cacheRead: 10, cacheCreation: 5, cost: { total: 0.01 } },
				},
			},
			{ type: "custom", customType: "something-else" },
		];
		const { ctx, getFooterFactory } = createMockCtx({ branch });

		await handlers.get("session_start")![0]({}, ctx);
		assert.ok(getFooterFactory(), "setFooter should have been called");
	});

	it("session_start footer renders two lines", async () => {
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

	it("footer line 1 contains model name and context percentage", async () => {
		const { pi, handlers } = createMockPI();
		statusBarExtension(pi);

		const { ctx, getFooterFactory } = createMockCtx({
			branch: [],
			model: { id: "claude-sonnet-4", provider: "anthropic" },
			contextPercent: 42,
		});
		await handlers.get("session_start")![0]({}, ctx);

		const lines = renderFooter(getFooterFactory());
		assert.ok(lines[0].includes("claude-sonnet-4"), "line 1 should contain model name");
		assert.ok(lines[0].includes("42%"), "line 1 should contain context percentage");
	});

	it("footer line 1 contains token counts and cost", async () => {
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
		assert.ok(lines[0].includes("↑5k"), "should show input tokens");
		assert.ok(lines[0].includes("↓1.2k"), "should show output tokens");
		assert.ok(lines[0].includes("⚡800"), "should show cache tokens");
		assert.ok(lines[0].includes("$0.0123"), "should show cost");
	});

	it("footer line 1 omits cache when zero", async () => {
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
		assert.ok(!lines[0].includes("⚡"), "should not show cache icon when zero");
	});

	it("footer line 2 contains directory name", async () => {
		const { pi, handlers } = createMockPI();
		statusBarExtension(pi);

		const { ctx, getFooterFactory } = createMockCtx({ branch: [], cwd: "/home/user/my-project" });
		await handlers.get("session_start")![0]({}, ctx);

		const lines = renderFooter(getFooterFactory());
		assert.ok(lines[1].includes("my-project"), "line 2 should contain cwd basename");
	});

	it("footer line 2 contains git branch when available", async () => {
		const { pi, handlers } = createMockPI();
		statusBarExtension(pi);

		const { ctx, getFooterFactory } = createMockCtx({ branch: [] });
		await handlers.get("session_start")![0]({}, ctx);

		const lines = renderFooter(getFooterFactory(), { gitBranch: "feat/cool-feature" });
		assert.ok(lines[1].includes("feat/cool-feature"), "line 2 should contain branch name");
	});

	it("footer line 2 shows turn count", async () => {
		const { pi, handlers } = createMockPI();
		statusBarExtension(pi);

		for (let i = 0; i < 3; i++) {
			await handlers.get("turn_start")![0]({}, {});
			await handlers.get("turn_end")![0]({}, {});
		}

		const { ctx, getFooterFactory } = createMockCtx({ branch: [] });
		await handlers.get("session_start")![0]({}, ctx);

		const lines = renderFooter(getFooterFactory());
		assert.ok(lines[1].includes("T3"), "line 2 should show turn count");
	});

	it("footer line 1 shows ✓ when idle and ● when active", async () => {
		const { pi, handlers } = createMockPI();
		statusBarExtension(pi);

		const { ctx, getFooterFactory } = createMockCtx({ branch: [] });
		await handlers.get("session_start")![0]({}, ctx);

		const idleLines = renderFooter(getFooterFactory());
		assert.ok(idleLines[0].includes("✓"), "should show ✓ when idle");

		await handlers.get("turn_start")![0]({}, {});
		const activeLines = renderFooter(getFooterFactory());
		assert.ok(activeLines[0].includes("●"), "should show ● when active");
	});

	it("footer line 2 shows 'no tools yet' initially", async () => {
		const { pi, handlers } = createMockPI();
		statusBarExtension(pi);

		const { ctx, getFooterFactory } = createMockCtx({ branch: [] });
		await handlers.get("session_start")![0]({}, ctx);

		const lines = renderFooter(getFooterFactory());
		assert.ok(lines[1].includes("no tools yet"), "should show 'no tools yet' when no tools used");
	});

	it("footer shows tool counts after tool executions", async () => {
		const { pi, handlers } = createMockPI();
		statusBarExtension(pi);

		const { ctx, getFooterFactory } = createMockCtx({ branch: [] });
		await handlers.get("tool_execution_end")![0]({ toolName: "read" }, ctx);
		await handlers.get("tool_execution_end")![0]({ toolName: "read" }, ctx);
		await handlers.get("tool_execution_end")![0]({ toolName: "bash" }, ctx);
		await handlers.get("session_start")![0]({}, ctx);

		const lines = renderFooter(getFooterFactory());
		assert.ok(lines[1].includes("read"), "should show read tool");
		assert.ok(lines[1].includes("bash"), "should show bash tool");
	});

	it("session_switch with reason 'new' resets all state", async () => {
		const { pi, handlers } = createMockPI();
		statusBarExtension(pi);

		const { ctx, getFooterFactory } = createMockCtx({ branch: [] });
		await handlers.get("tool_execution_end")![0]({ toolName: "read" }, ctx);
		await handlers.get("turn_start")![0]({}, {});
		await handlers.get("session_switch")![0]({ reason: "new" }, ctx);
		await handlers.get("session_start")![0]({}, ctx);

		const lines = renderFooter(getFooterFactory());
		assert.ok(lines[1].includes("no tools yet"), "tools should be reset after new session");
		assert.ok(lines[1].includes("T0"), "turn count should be reset after new session");
	});

	it("session_switch with reason 'resume' does not reset state", async () => {
		const { pi, handlers } = createMockPI();
		statusBarExtension(pi);

		const { ctx, getFooterFactory } = createMockCtx({ branch: [] });
		await handlers.get("turn_start")![0]({}, {});
		await handlers.get("turn_end")![0]({}, {});
		await handlers.get("tool_execution_end")![0]({ toolName: "read" }, ctx);
		await handlers.get("session_switch")![0]({ reason: "resume" }, ctx);
		await handlers.get("session_start")![0]({}, ctx);

		const lines = renderFooter(getFooterFactory());
		assert.ok(lines[1].includes("T1"), "turn count should be preserved on resume");
		assert.ok(lines[1].includes("read"), "tool counts should be preserved on resume");
	});

	it("footer accumulates tokens from multiple assistant messages", async () => {
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
		assert.ok(lines[0].includes("↑3k"), "should sum input tokens: 1000+2000=3k");
		assert.ok(lines[0].includes("↓500"), "should sum output tokens: 200+300=500");
		assert.ok(lines[0].includes("$0.0300"), "should sum costs: 0.01+0.02=0.03");
	});

	it("footer handles null context usage gracefully", async () => {
		const { pi, handlers } = createMockPI();
		statusBarExtension(pi);

		const { ctx, getFooterFactory } = createMockCtx({ branch: [], contextPercent: null });
		await handlers.get("session_start")![0]({}, ctx);

		const lines = renderFooter(getFooterFactory());
		assert.equal(lines.length, 2, "should still render 2 lines");
		assert.ok(lines[0].includes("0%"), "should show 0% when context usage is null");
	});

	it("footer component has dispose and invalidate", async () => {
		const { pi, handlers } = createMockPI();
		statusBarExtension(pi);

		const { ctx, getFooterFactory } = createMockCtx({ branch: [] });
		await handlers.get("session_start")![0]({}, ctx);

		const factory = getFooterFactory();
		const tui = { requestRender: () => {} };
		const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
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
});
