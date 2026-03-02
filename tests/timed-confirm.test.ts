/**
 * Unit tests for lib/timed-confirm — the reusable timed confirmation dialog.
 *
 * Mocks the ExtensionCommandContext and TUI primitives to test the pure logic:
 * - Enter confirms immediately
 * - Escape cancels immediately
 * - Timer auto-resolves with the default value
 * - Custom options (seconds, defaultValue) are respected
 *
 * Uses Node's built-in test runner (node:test + node:assert).
 * Run with: node --experimental-strip-types --test tests/timed-confirm.test.ts
 */

import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";

import { timedConfirm, type TimedConfirmOptions } from "../lib/timed-confirm.ts";

// ---------------------------------------------------------------------------
// Mocking helpers
// ---------------------------------------------------------------------------

/**
 * Captured component returned by the factory passed to `ctx.ui.custom()`.
 * Exposes `handleInput` so tests can simulate keystrokes.
 */
interface CapturedComponent {
	render: (w: number) => string[];
	invalidate: () => void;
	handleInput: (data: string) => void;
}

/** Raw escape sequences for key simulation. */
const ENTER = "\r";
const ESCAPE = "\x1b";

/**
 * Build a minimal mock of `ExtensionCommandContext` that captures the
 * factory passed to `ctx.ui.custom()` and lets tests drive it.
 */
function createMockCtx() {
	let capturedComponent: CapturedComponent | null = null;
	let resolveCustom: ((value: boolean) => void) | null = null;

	const ctx = {
		ui: {
			custom: <T>(factory: (
				tui: { requestRender: () => void },
				theme: {
					fg: (color: string, text: string) => string;
					bold: (text: string) => string;
				},
				kb: unknown,
				done: (result: T) => void,
			) => CapturedComponent) => {
				return new Promise<T>((resolve) => {
					const tui = { requestRender: () => {} };
					const theme = {
						fg: (_color: string, text: string) => text,
						bold: (text: string) => text,
					};
					const done = (result: T) => resolve(result);
					capturedComponent = factory(tui, theme, null, done);
					resolveCustom = resolve as (value: boolean) => void;
				});
			},
		},
	};

	return {
		ctx: ctx as unknown as Parameters<typeof timedConfirm>[0],
		getComponent: () => capturedComponent,
	};
}

// ---------------------------------------------------------------------------
// Timer control
// ---------------------------------------------------------------------------

// Use Node's mock timers for deterministic timer tests
// Note: we enable/disable per test that needs timer control

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("timedConfirm", () => {
	describe("keyboard input", () => {
		it("resolves true on Enter", async () => {
			const { ctx, getComponent } = createMockCtx();

			const promise = timedConfirm(ctx, {
				title: "Test",
				message: "Confirm?",
				seconds: 60, // long timeout so timer doesn't interfere
			});

			// Give the factory a tick to execute
			await new Promise((r) => setTimeout(r, 0));
			const component = getComponent();
			assert.ok(component, "Component should be captured");

			component.handleInput(ENTER);
			const result = await promise;
			assert.equal(result, true);
		});

		it("resolves false on Escape", async () => {
			const { ctx, getComponent } = createMockCtx();

			const promise = timedConfirm(ctx, {
				title: "Test",
				message: "Confirm?",
				seconds: 60,
			});

			await new Promise((r) => setTimeout(r, 0));
			const component = getComponent();
			assert.ok(component, "Component should be captured");

			component.handleInput(ESCAPE);
			const result = await promise;
			assert.equal(result, false);
		});

		it("ignores unrelated keys", async () => {
			const { ctx, getComponent } = createMockCtx();

			const promise = timedConfirm(ctx, {
				title: "Test",
				message: "Confirm?",
				seconds: 60,
			});

			await new Promise((r) => setTimeout(r, 0));
			const component = getComponent();
			assert.ok(component, "Component should be captured");

			// These should not resolve the promise
			component.handleInput("a");
			component.handleInput("x");
			component.handleInput(" ");

			// Promise should still be pending — verify by racing with a short timeout
			const timeout = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 50));
			const winner = await Promise.race([promise, timeout]);
			assert.equal(winner, "timeout", "Promise should still be pending after unrelated keys");

			// Now confirm to clean up
			component.handleInput(ENTER);
			await promise;
		});

		it("only resolves once even with multiple inputs", async () => {
			const { ctx, getComponent } = createMockCtx();

			const promise = timedConfirm(ctx, {
				title: "Test",
				message: "Confirm?",
				seconds: 60,
			});

			await new Promise((r) => setTimeout(r, 0));
			const component = getComponent();
			assert.ok(component, "Component should be captured");

			component.handleInput(ESCAPE);
			const result = await promise;
			assert.equal(result, false);

			// Subsequent input should not throw or change the result
			component.handleInput(ENTER);
			component.handleInput(ESCAPE);
		});
	});

	describe("timer auto-resolve", () => {
		it("auto-confirms with true after timeout (default)", async () => {
			mock.timers.enable({ apis: ["setInterval", "setTimeout"] });

			const { ctx, getComponent } = createMockCtx();

			const promise = timedConfirm(ctx, {
				title: "Test",
				message: "Confirm?",
				seconds: 3,
			});

			// Let the factory run
			mock.timers.tick(0);
			const component = getComponent();
			assert.ok(component, "Component should be captured");

			// Advance 3 seconds — timer should fire 3 times and auto-confirm
			mock.timers.tick(3000);

			const result = await promise;
			assert.equal(result, true);

			mock.timers.reset();
		});

		it("auto-resolves with false when defaultValue is false", async () => {
			mock.timers.enable({ apis: ["setInterval", "setTimeout"] });

			const { ctx, getComponent } = createMockCtx();

			const promise = timedConfirm(ctx, {
				title: "Test",
				message: "Cancel?",
				seconds: 2,
				defaultValue: false,
			});

			mock.timers.tick(0);
			const component = getComponent();
			assert.ok(component, "Component should be captured");

			mock.timers.tick(2000);

			const result = await promise;
			assert.equal(result, false);

			mock.timers.reset();
		});

		it("keyboard input before timer expires cancels the timer", async () => {
			mock.timers.enable({ apis: ["setInterval", "setTimeout"] });

			const { ctx, getComponent } = createMockCtx();

			const promise = timedConfirm(ctx, {
				title: "Test",
				message: "Confirm?",
				seconds: 5,
			});

			mock.timers.tick(0);
			const component = getComponent();
			assert.ok(component, "Component should be captured");

			// Advance partway, then press Escape
			mock.timers.tick(2000);
			component.handleInput(ESCAPE);

			const result = await promise;
			assert.equal(result, false);

			// Advancing past the original timeout should not cause issues
			mock.timers.tick(5000);

			mock.timers.reset();
		});
	});

	describe("options", () => {
		it("defaults to 5 seconds when seconds is omitted", async () => {
			mock.timers.enable({ apis: ["setInterval", "setTimeout"] });

			const { ctx, getComponent } = createMockCtx();

			const promise = timedConfirm(ctx, {
				title: "Test",
				message: "Confirm?",
			});

			mock.timers.tick(0);
			const component = getComponent();
			assert.ok(component, "Component should be captured");

			// 4 seconds — should still be pending
			mock.timers.tick(4000);

			// Use a resolved promise to check pending state
			let resolved = false;
			promise.then(() => { resolved = true; });
			mock.timers.tick(0);
			assert.equal(resolved, false, "Should not resolve after 4 seconds");

			// 5th second — should resolve
			mock.timers.tick(1000);
			const result = await promise;
			assert.equal(result, true);

			mock.timers.reset();
		});
	});

	describe("rendering", () => {
		it("render returns lines without throwing", async () => {
			const { ctx, getComponent } = createMockCtx();

			const promise = timedConfirm(ctx, {
				title: "Merge PR",
				message: "Merge PR #42 into main?",
				seconds: 60,
			});

			await new Promise((r) => setTimeout(r, 0));
			const component = getComponent();
			assert.ok(component, "Component should be captured");

			const lines = component.render(80);
			assert.ok(Array.isArray(lines), "render() should return an array");
			assert.ok(lines.length > 0, "render() should return at least one line");

			// Should contain the title and message somewhere in the output
			const text = lines.join("\n");
			assert.ok(text.includes("Merge PR"), "Should contain the title");
			assert.ok(text.includes("Merge PR #42 into main?"), "Should contain the message");

			// Clean up
			component.handleInput(ENTER);
			await promise;
		});

		it("invalidate does not throw", async () => {
			const { ctx, getComponent } = createMockCtx();

			const promise = timedConfirm(ctx, {
				title: "Test",
				message: "Confirm?",
				seconds: 60,
			});

			await new Promise((r) => setTimeout(r, 0));
			const component = getComponent();
			assert.ok(component, "Component should be captured");

			assert.doesNotThrow(() => component.invalidate());

			component.handleInput(ENTER);
			await promise;
		});
	});
});
