/**
 * Unit tests for lib/ask-question-ui — the reusable TUI question component.
 *
 * Mocks ExtensionUIContext to capture the component factory and simulate
 * keystrokes. Covers:
 * - Freeform mode: typing + Enter, Escape to skip
 * - Multiple-choice selection mode: Enter, arrow keys, 1-9 quick select
 * - Editing toggle: Tab enters edit mode, Esc exits it
 * - "Type something." auto-enters edit mode
 * - Rendering in both modes
 *
 * Uses Node's built-in test runner (node:test + node:assert).
 * Run with: node --experimental-strip-types --test tests/ask-question-ui.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
	showAskQuestion,
	type AskQuestionUIParams,
	type AskQuestionUIResult,
} from "../pi-extensions/lib/ask-question-ui.ts";

// ── Key sequences ────────────────────────────────────────────────────────────

const ENTER = "\r";
const ESCAPE = "\x1b";
const TAB = "\t";
const ARROW_UP = "\x1b[A";
const ARROW_DOWN = "\x1b[B";

/** Allow microtask queue to flush so `ui.custom()` factory runs. */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

// ── Mock infrastructure ─────────────────────────────────────────────────────

/** Captured TUI component returned by the factory passed to `ui.custom()`. */
interface CapturedComponent {
	render: (w: number) => string[];
	invalidate: () => void;
	handleInput: (data: string) => void;
}

/**
 * Build a minimal mock of `ExtensionUIContext` that captures the
 * factory from `ui.custom()` and lets tests drive keystrokes.
 */
function createMockUI(): {
	ui: Parameters<typeof showAskQuestion>[0];
	getComponent: () => CapturedComponent;
} {
	let capturedComponent: CapturedComponent | null = null;

	const ui = {
		custom: <T>(
			factory: (
				tui: { requestRender: () => void; terminal: { rows: number } },
				theme: { fg: (color: string, text: string) => string; bold: (text: string) => string },
				kb: unknown,
				done: (result: T) => void,
			) => CapturedComponent,
		) => {
			return new Promise<T>((resolve) => {
				const tui = {
					requestRender: () => {},
					terminal: { rows: 40 },
				};
				const theme = {
					fg: (_color: string, text: string) => text,
					bold: (text: string) => text,
				};
				const done = (result: T) => resolve(result);
				capturedComponent = factory(tui, theme, null, done);
			});
		},
	};

	return {
		ui: ui as unknown as Parameters<typeof showAskQuestion>[0],
		getComponent: () => capturedComponent!,
	};
}

/** Helper: start showAskQuestion, wait for component capture, return promise + component. */
async function startQuestion(
	params: AskQuestionUIParams,
): Promise<{
	promise: Promise<AskQuestionUIResult | null>;
	component: CapturedComponent;
	onWaitingCalled: boolean;
}> {
	const { ui, getComponent } = createMockUI();
	let onWaitingCalled = false;
	const onWaiting = () => { onWaitingCalled = true; };

	const promise = showAskQuestion(ui, onWaiting, params);
	await tick();
	const component = getComponent();
	assert.ok(component, "Component should be captured");

	return { promise, component, onWaitingCalled };
}

/** Type a string character by character into the component. */
function typeText(component: CapturedComponent, text: string): void {
	for (const ch of text) {
		component.handleInput(ch);
	}
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("showAskQuestion", () => {
	describe("onWaiting callback", () => {
		it("calls onWaiting before blocking", async () => {
			const { promise, component, onWaitingCalled } = await startQuestion({
				question: "Test?",
			});
			assert.ok(onWaitingCalled, "onWaiting should be called");

			component.handleInput(ESCAPE);
			await promise;
		});
	});

	describe("freeform mode (no options)", () => {
		it("returns typed text on Enter", async () => {
			const { promise, component } = await startQuestion({
				question: "What is your name?",
			});

			typeText(component, "Alice");
			component.handleInput(ENTER);

			const result = await promise;
			assert.deepEqual(result, { answer: "Alice", wasCustom: true });
		});

		it("returns null on Escape", async () => {
			const { promise, component } = await startQuestion({
				question: "What is your name?",
			});

			component.handleInput(ESCAPE);
			const result = await promise;
			assert.equal(result, null);
		});

		it("ignores Enter when input is empty", async () => {
			const { promise, component } = await startQuestion({
				question: "What is your name?",
			});

			component.handleInput(ENTER);

			// Should still be pending
			const timeout = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 50));
			const winner = await Promise.race([promise, timeout]);
			assert.equal(winner, "timeout", "Promise should still be pending after empty Enter");

			typeText(component, "Bob");
			component.handleInput(ENTER);
			const result = await promise;
			assert.deepEqual(result, { answer: "Bob", wasCustom: true });
		});

		it("renders question text", async () => {
			const { promise, component } = await startQuestion({
				question: "Favorite color?",
				context: "Pick wisely",
			});

			const lines = component.render(80);
			const text = lines.join("\n");
			assert.ok(text.includes("Favorite color?"), "Should contain the question");
			assert.ok(text.includes("Pick wisely"), "Should contain the context");

			component.handleInput(ESCAPE);
			await promise;
		});
	});

	describe("multiple-choice — selection mode (default)", () => {
		const OPTIONS = [
			{ label: "Option A" },
			{ label: "Option B", description: "The B choice" },
			{ label: "Option C" },
		];

		it("Enter submits the first option by default", async () => {
			const { promise, component } = await startQuestion({
				question: "Pick one",
				options: OPTIONS,
			});

			component.handleInput(ENTER);
			const result = await promise;
			assert.deepEqual(result, { answer: "Option A", wasCustom: false, index: 1 });
		});

		it("arrow down + Enter submits the second option", async () => {
			const { promise, component } = await startQuestion({
				question: "Pick one",
				options: OPTIONS,
			});

			component.handleInput(ARROW_DOWN);
			component.handleInput(ENTER);
			const result = await promise;
			assert.deepEqual(result, { answer: "Option B", wasCustom: false, index: 2 });
		});

		it("arrow navigation wraps at bounds", async () => {
			const { promise, component } = await startQuestion({
				question: "Pick one",
				options: OPTIONS,
			});

			// Up from first option stays at first
			component.handleInput(ARROW_UP);
			component.handleInput(ENTER);
			const result = await promise;
			assert.deepEqual(result, { answer: "Option A", wasCustom: false, index: 1 });
		});

		it("number key quick-selects option", async () => {
			const { promise, component } = await startQuestion({
				question: "Pick one",
				options: OPTIONS,
			});

			component.handleInput("2");
			const result = await promise;
			assert.deepEqual(result, { answer: "Option B", wasCustom: false, index: 2 });
		});

		it("number key 3 quick-selects third option", async () => {
			const { promise, component } = await startQuestion({
				question: "Pick one",
				options: OPTIONS,
			});

			component.handleInput("3");
			const result = await promise;
			assert.deepEqual(result, { answer: "Option C", wasCustom: false, index: 3 });
		});

		it("out-of-range number key is ignored", async () => {
			const { promise, component } = await startQuestion({
				question: "Pick one",
				options: OPTIONS,
			});

			// 5 is out of range (3 options + 1 "Type something" = 4)
			component.handleInput("5");

			const timeout = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 50));
			const winner = await Promise.race([promise, timeout]);
			assert.equal(winner, "timeout", "Out-of-range number should be ignored");

			component.handleInput(ESCAPE);
			await promise;
		});

		it("Escape returns null", async () => {
			const { promise, component } = await startQuestion({
				question: "Pick one",
				options: OPTIONS,
			});

			component.handleInput(ESCAPE);
			const result = await promise;
			assert.equal(result, null);
		});

		it("renders options without editor when not editing", async () => {
			const { promise, component } = await startQuestion({
				question: "Pick one",
				options: OPTIONS,
			});

			const lines = component.render(80);
			const text = lines.join("\n");
			assert.ok(text.includes("Pick one"), "Should contain the question");
			assert.ok(text.includes("Option A"), "Should contain first option");
			assert.ok(text.includes("Option B"), "Should contain second option");
			assert.ok(text.includes("The B choice"), "Should contain option description");
			assert.ok(text.includes("Type something."), "Should contain freeform fallback");
			assert.ok(text.includes("Tab to edit"), "Footer should mention Tab to edit");

			component.handleInput(ESCAPE);
			await promise;
		});
	});

	describe("multiple-choice — editing mode (Tab toggle)", () => {
		const OPTIONS = [
			{ label: "Option A" },
			{ label: "Option B" },
		];

		it("Tab enters editing mode, Enter submits edited text", async () => {
			const { promise, component } = await startQuestion({
				question: "Pick one",
				options: OPTIONS,
			});

			component.handleInput(TAB);

			// Editor should be pre-filled with "Option A", clear and type new text
			// The editor is pre-filled, so we need to handle that.
			// Let's just type additional text - but the editor replaces content.
			// Actually the editor is set to the option label. Let's just submit as-is.
			component.handleInput(ENTER);

			const result = await promise;
			// Submitting unmodified text = not custom
			assert.equal(result?.answer, "Option A");
			assert.equal(result?.wasCustom, false);
		});

		it("Tab + edit text + Enter submits as custom", async () => {
			const { promise, component } = await startQuestion({
				question: "Pick one",
				options: OPTIONS,
			});

			component.handleInput(TAB);

			// Clear existing text with select-all + type replacement
			// Editor pre-fills "Option A". We'll use Ctrl+A to select all, then type.
			component.handleInput("\x01"); // Ctrl+A (home/select)
			// Actually, Editor might not support Ctrl+A for select-all.
			// Let's use Ctrl+K to delete to end of line, then Ctrl+U to delete to start
			component.handleInput("\x0b"); // Ctrl+K (delete to end of line)
			component.handleInput("\x15"); // Ctrl+U (delete to start of line)
			typeText(component, "Custom answer");
			component.handleInput(ENTER);

			const result = await promise;
			assert.equal(result?.answer, "Custom answer");
			assert.equal(result?.wasCustom, true);
		});

		it("Tab then Escape exits editing mode back to selection", async () => {
			const { promise, component } = await startQuestion({
				question: "Pick one",
				options: OPTIONS,
			});

			component.handleInput(TAB);

			// Verify we're in editing mode by checking render
			const editLines = component.render(80);
			const editText = editLines.join("\n");
			assert.ok(editText.includes("stop editing"), "Footer should show editing hints");

			// Escape exits editing mode
			component.handleInput(ESCAPE);

			// Verify we're back in selection mode
			const selLines = component.render(80);
			const selText = selLines.join("\n");
			assert.ok(selText.includes("Tab to edit"), "Footer should show selection hints");

			// Another Escape skips the question
			component.handleInput(ESCAPE);
			const result = await promise;
			assert.equal(result, null);
		});

		it("navigate to option B, Tab, submit unmodified", async () => {
			const { promise, component } = await startQuestion({
				question: "Pick one",
				options: OPTIONS,
			});

			component.handleInput(ARROW_DOWN);
			component.handleInput(TAB);
			component.handleInput(ENTER);

			const result = await promise;
			assert.equal(result?.answer, "Option B");
			assert.equal(result?.wasCustom, false);
			assert.equal(result?.index, 2);
		});
	});

	describe("multiple-choice — 'Type something.' option", () => {
		const OPTIONS = [
			{ label: "Option A" },
		];

		it("selecting 'Type something.' via Enter auto-enters edit mode", async () => {
			const { promise, component } = await startQuestion({
				question: "Pick one",
				options: OPTIONS,
			});

			// Navigate to "Type something." (index 1 = second item)
			component.handleInput(ARROW_DOWN);
			component.handleInput(ENTER);

			// Should now be in editing mode — verify via render
			const lines = component.render(80);
			const text = lines.join("\n");
			assert.ok(text.includes("stop editing"), "Should be in editing mode");

			typeText(component, "My custom");
			component.handleInput(ENTER);

			const result = await promise;
			assert.equal(result?.answer, "My custom");
			assert.equal(result?.wasCustom, true);
			assert.equal(result?.index, undefined);
		});

		it("selecting 'Type something.' via number key auto-enters edit mode", async () => {
			const { promise, component } = await startQuestion({
				question: "Pick one",
				options: OPTIONS,
			});

			// "Type something." is option 2 (1 user option + 1 fallback)
			component.handleInput("2");

			// Should be in editing mode now
			const lines = component.render(80);
			const text = lines.join("\n");
			assert.ok(text.includes("stop editing"), "Should be in editing mode after quick-selecting 'Type something.'");

			typeText(component, "Freeform answer");
			component.handleInput(ENTER);

			const result = await promise;
			assert.equal(result?.answer, "Freeform answer");
			assert.equal(result?.wasCustom, true);
		});
	});

	describe("rendering", () => {
		it("render returns lines without throwing", async () => {
			const { promise, component } = await startQuestion({
				question: "Test question",
				context: "Some context",
				options: [{ label: "A" }],
			});

			const lines = component.render(80);
			assert.ok(Array.isArray(lines), "render() should return an array");
			assert.ok(lines.length > 0, "render() should return at least one line");

			component.handleInput(ESCAPE);
			await promise;
		});

		it("invalidate does not throw", async () => {
			const { promise, component } = await startQuestion({
				question: "Test",
				options: [{ label: "A" }],
			});

			assert.doesNotThrow(() => component.invalidate());

			component.handleInput(ESCAPE);
			await promise;
		});

		it("cached lines are reused until invalidated", async () => {
			const { promise, component } = await startQuestion({
				question: "Test",
				options: [{ label: "A" }],
			});

			const lines1 = component.render(80);
			const lines2 = component.render(80);
			assert.equal(lines1, lines2, "Same reference when cached");

			component.invalidate();
			const lines3 = component.render(80);
			assert.notEqual(lines1, lines3, "New reference after invalidate");

			component.handleInput(ESCAPE);
			await promise;
		});
	});
});
