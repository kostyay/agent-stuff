/**
 * Unit tests for pi-extensions/plan-ask — mode rotation and theme color validation.
 *
 * Validates that MODE_DISPLAY colors are valid ThemeColor values, and tests
 * the extension's shortcut/command/event behavior via mocked ExtensionAPI.
 *
 * Uses Node's built-in test runner (node:test + node:assert).
 * Run with: node --experimental-strip-types --test tests/plan-ask.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import planAskExtension, { MODE_DISPLAY } from "../pi-extensions/plan-ask.ts";

// ---------------------------------------------------------------------------
// Valid ThemeColor values from @mariozechner/pi-coding-agent
// Source: node_modules/@mariozechner/pi-coding-agent/dist/core/extensions/types.d.ts
// (ThemeColor union type). Update this set when ThemeColor changes upstream.
// The createMockCtx() helper below also validates colors at call-site via
// theme.fg() which throws on unknown colors — providing a second safety net.
// ---------------------------------------------------------------------------

const VALID_THEME_COLORS = new Set([
	"accent", "border", "borderAccent", "borderMuted",
	"success", "error", "warning", "muted", "dim", "text",
	"thinkingText", "userMessageText", "customMessageText", "customMessageLabel",
	"toolTitle", "toolOutput",
	"mdHeading", "mdLink", "mdLinkUrl", "mdCode", "mdCodeBlock", "mdCodeBlockBorder",
	"mdQuote", "mdQuoteBorder", "mdHr", "mdListBullet",
	"toolDiffAdded", "toolDiffRemoved", "toolDiffContext",
	"syntaxComment", "syntaxKeyword", "syntaxFunction", "syntaxVariable",
	"syntaxString", "syntaxNumber", "syntaxType", "syntaxOperator", "syntaxPunctuation",
	"thinkingOff", "thinkingMinimal", "thinkingLow", "thinkingMedium",
	"thinkingHigh", "thinkingXhigh", "bashMode",
]);

// ---------------------------------------------------------------------------
// MODE_DISPLAY — theme color validation
// ---------------------------------------------------------------------------

describe("MODE_DISPLAY", () => {
	it("every mode color is a valid ThemeColor", () => {
		for (const [mode, display] of Object.entries(MODE_DISPLAY)) {
			assert.ok(
				VALID_THEME_COLORS.has(display.color),
				`Mode "${mode}" uses color "${display.color}" which is not a valid ThemeColor. ` +
				`Valid: ${[...VALID_THEME_COLORS].join(", ")}`,
			);
		}
	});

	it("agent mode uses 'success' color", () => {
		assert.equal(MODE_DISPLAY.agent.color, "success");
	});

	it("ask mode uses a valid non-'info' color", () => {
		assert.notEqual(MODE_DISPLAY.ask.color, "info", "info is not a valid ThemeColor");
		assert.ok(VALID_THEME_COLORS.has(MODE_DISPLAY.ask.color));
	});

	it("plan mode uses 'warning' color", () => {
		assert.equal(MODE_DISPLAY.plan.color, "warning");
	});

	it("every mode has icon and label", () => {
		for (const [mode, display] of Object.entries(MODE_DISPLAY)) {
			assert.ok(display.icon.length > 0, `Mode "${mode}" missing icon`);
			assert.ok(display.label.length > 0, `Mode "${mode}" missing label`);
		}
	});
});

// ---------------------------------------------------------------------------
// Shared mock helpers
// ---------------------------------------------------------------------------

/** Minimal mock of ExtensionAPI that captures registrations. */
function createMockPI() {
	const handlers = new Map<string, ((...args: any[]) => any)[]>();
	const commands = new Map<string, { description: string; handler: (...args: any[]) => any }>();
	const shortcuts = new Map<string, { description: string; handler: (...args: any[]) => any }>();
	let activeTools: string[] = [];
	const entries: any[] = [];

	const pi = {
		on(event: string, handler: (...args: any[]) => any) {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event)!.push(handler);
		},
		registerCommand(name: string, opts: any) {
			commands.set(name, opts);
		},
		registerShortcut(key: string, opts: any) {
			shortcuts.set(key, opts);
		},
		getActiveTools: () => [...activeTools],
		setActiveTools: (tools: string[]) => { activeTools = [...tools]; },
		appendEntry: (_type: string, data: any) => { entries.push(data); },
		sendUserMessage: (_msg: string) => {},
	};

	return { pi: pi as any, handlers, commands, shortcuts, entries, getActiveTools: () => activeTools };
}

/** Minimal mock of ExtensionContext with theme that validates colors. */
function createMockCtx() {
	const statuses = new Map<string, string>();
	const notifications: Array<{ msg: string; level: string }> = [];

	const ctx = {
		hasUI: true,
		sessionManager: {
			getEntries: () => [],
		},
		ui: {
			setStatus: (key: string, value: string) => { statuses.set(key, value); },
			notify: (msg: string, level: string) => { notifications.push({ msg, level }); },
			theme: {
				fg: (color: string, text: string) => {
					if (!VALID_THEME_COLORS.has(color)) {
						throw new Error(`Unknown theme color: ${color}`);
					}
					return `[${color}]${text}[/${color}]`;
				},
			},
			select: async () => null,
			editor: async () => null,
			input: async () => null,
			runCommand: () => {},
		},
	};

	return { ctx: ctx as any, statuses, notifications };
}

// ---------------------------------------------------------------------------
// planAskExtension — shift+tab mode rotation
// ---------------------------------------------------------------------------

describe("planAskExtension", () => {
	it("registers plan and ask commands", () => {
		const { pi, commands } = createMockPI();
		planAskExtension(pi);
		assert.ok(commands.has("plan"), "should register /plan");
		assert.ok(commands.has("ask"), "should register /ask");
	});

	it("registers shift+tab shortcut", () => {
		const { pi, shortcuts } = createMockPI();
		planAskExtension(pi);
		assert.ok(shortcuts.has("shift+tab"), "should register shift+tab");
	});

	it("shift+tab cycles modes without throwing", async () => {
		const { pi, shortcuts, handlers } = createMockPI();
		planAskExtension(pi);

		// Initialize via session_start
		const { ctx } = createMockCtx();
		for (const h of handlers.get("session_start") ?? []) {
			await h({}, ctx);
		}

		const handler = shortcuts.get("shift+tab")!.handler;

		// agent → ask (this was the crash: "info" color)
		await handler(ctx);

		// ask → plan
		await handler(ctx);

		// plan → agent
		await handler(ctx);
	});

	it("shift+tab from agent to ask uses theme.fg without error", async () => {
		const { pi, shortcuts, handlers } = createMockPI();
		planAskExtension(pi);

		const { ctx, statuses } = createMockCtx();
		for (const h of handlers.get("session_start") ?? []) {
			await h({}, ctx);
		}

		// Agent → Ask — this is the exact transition that was broken
		await shortcuts.get("shift+tab")!.handler(ctx);

		const status = statuses.get("plan-mode");
		assert.ok(status, "status should be set after mode switch");
		assert.ok(status.includes("ask"), "status should contain ask label");
	});

	it("session_start sets initial status without error", async () => {
		const { pi, handlers } = createMockPI();
		planAskExtension(pi);

		const { ctx, statuses } = createMockCtx();
		for (const h of handlers.get("session_start") ?? []) {
			await h({}, ctx);
		}

		assert.ok(statuses.has("plan-mode"), "should set plan-mode status on session_start");
	});

	it("shift+tab notifies with mode label", async () => {
		const { pi, shortcuts, handlers } = createMockPI();
		planAskExtension(pi);

		const { ctx, notifications } = createMockCtx();
		for (const h of handlers.get("session_start") ?? []) {
			await h({}, ctx);
		}

		await shortcuts.get("shift+tab")!.handler(ctx);

		assert.ok(notifications.length > 0, "should notify on mode switch");
		assert.ok(
			notifications[0].msg.includes("ask"),
			"notification should mention the new mode",
		);
	});

	it("full rotation cycle returns to agent mode", async () => {
		const { pi, shortcuts, handlers, getActiveTools } = createMockPI();
		pi.setActiveTools(["read", "bash", "edit", "write"]);
		planAskExtension(pi);

		const { ctx, notifications } = createMockCtx();
		for (const h of handlers.get("session_start") ?? []) {
			await h({}, ctx);
		}

		const handler = shortcuts.get("shift+tab")!.handler;

		// agent → ask
		await handler(ctx);
		assert.ok(notifications.some(n => n.msg.includes("ask")));

		// ask → plan
		await handler(ctx);
		assert.ok(notifications.some(n => n.msg.includes("plan")));

		// plan → agent
		await handler(ctx);
		assert.ok(notifications.some(n => n.msg.includes("agent")));
	});
});
