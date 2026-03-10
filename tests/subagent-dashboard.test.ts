/**
 * Unit tests for pi-extensions/subagent/dashboard — card rendering + context estimation.
 *
 * Covers: estimateContextWindow, renderCard.
 *
 * Requires pi-tui transitively via tui-helpers — skips gracefully if unavailable.
 *
 * Uses Node's built-in test runner (node:test + node:assert).
 * Run with: node --experimental-strip-types --test tests/subagent-dashboard.test.ts
 */

import { before, describe, it } from "node:test";
import assert from "node:assert/strict";

import { tryImport } from "../pi-extensions/subagent/test/helpers.ts";
import type { RunState } from "../pi-extensions/subagent/types.ts";

let mod: typeof import("../pi-extensions/subagent/dashboard.ts") | null = null;

before(async () => {
	try {
		mod = await tryImport<typeof import("../pi-extensions/subagent/dashboard.ts")>("./dashboard.ts");
	} catch {
		// dashboard.ts uses .js import extensions that fail under --experimental-strip-types
		// (works with tsx). Treat any transitive resolution error as "unavailable".
		mod = null;
	}
	if (!mod) console.log("⏭ Skipping dashboard tests: module unavailable (use tsx to run)");
});

function skip(): boolean {
	if (!mod) { console.log("  ⏭ skipped"); return true; }
	return false;
}

function makeRunState(overrides: Partial<RunState> = {}): RunState {
	return {
		id: 1, agent: "scout", task: "scan code", status: "running",
		progress: { toolCount: 3, lastLine: "scanning...", contextTokens: 50000, elapsed: 5000 },
		mode: "single", logEntries: [], logPartial: "",
		...overrides,
	};
}

const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };

// ---------------------------------------------------------------------------
// estimateContextWindow
// ---------------------------------------------------------------------------

describe("estimateContextWindow", () => {
	it("null for undefined", () => { if (skip()) return; assert.equal(mod!.estimateContextWindow(undefined), null); });
	it("null for empty string", () => { if (skip()) return; assert.equal(mod!.estimateContextWindow(""), null); });

	it("200k for claude", () => {
		if (skip()) return;
		assert.equal(mod!.estimateContextWindow("claude-sonnet-4-20250514"), 200_000);
	});

	it("128k for gpt-4o", () => {
		if (skip()) return;
		assert.equal(mod!.estimateContextWindow("gpt-4o-2024-05-13"), 128_000);
	});

	it("1M for gemini", () => {
		if (skip()) return;
		assert.equal(mod!.estimateContextWindow("gemini-2.0-pro"), 1_000_000);
	});

	it("128k for deepseek", () => {
		if (skip()) return;
		assert.equal(mod!.estimateContextWindow("deepseek-chat"), 128_000);
	});

	it("200k for o1/o3/o4", () => {
		if (skip()) return;
		assert.equal(mod!.estimateContextWindow("o1-preview"), 200_000);
		assert.equal(mod!.estimateContextWindow("o3-mini"), 200_000);
		assert.equal(mod!.estimateContextWindow("o4-mini"), 200_000);
	});

	it("case-insensitive", () => {
		if (skip()) return;
		assert.equal(mod!.estimateContextWindow("CLAUDE-SONNET"), 200_000);
	});

	it("null for unrecognized model", () => {
		if (skip()) return;
		assert.equal(mod!.estimateContextWindow("unknown-model-v1"), null);
	});
});

// ---------------------------------------------------------------------------
// renderCard
// ---------------------------------------------------------------------------

describe("renderCard", () => {
	it("returns 6 lines", () => {
		if (skip()) return;
		assert.equal(mod!.renderCard(makeRunState(), 40, theme, 1).length, 6);
	});

	it("top border contains box-drawing corner", () => {
		if (skip()) return;
		assert.ok(mod!.renderCard(makeRunState(), 40, theme, 1)[0].includes("┌"));
	});

	it("bottom border contains box-drawing corner", () => {
		if (skip()) return;
		assert.ok(mod!.renderCard(makeRunState(), 40, theme, 1)[5].includes("└"));
	});

	it("includes agent name", () => {
		if (skip()) return;
		const card = mod!.renderCard(makeRunState({ agent: "myagent" }), 40, theme, 1).join("\n");
		assert.ok(card.includes("myagent"));
	});

	it("running shows bullet icon", () => {
		if (skip()) return;
		assert.ok(mod!.renderCard(makeRunState({ status: "running" }), 40, theme, 1).join("\n").includes("●"));
	});

	it("done shows check icon", () => {
		if (skip()) return;
		assert.ok(mod!.renderCard(makeRunState({ status: "done" }), 40, theme, 1).join("\n").includes("✓"));
	});

	it("error shows cross icon", () => {
		if (skip()) return;
		assert.ok(mod!.renderCard(makeRunState({ status: "error" }), 40, theme, 1).join("\n").includes("✗"));
	});

	it("aborted shows null icon", () => {
		if (skip()) return;
		assert.ok(mod!.renderCard(makeRunState({ status: "aborted" }), 40, theme, 1).join("\n").includes("⊘"));
	});

	it("shows elapsed seconds", () => {
		if (skip()) return;
		const card = mod!.renderCard(
			makeRunState({ progress: { toolCount: 0, lastLine: "", contextTokens: 0, elapsed: 12500 } }),
			40, theme, 1,
		).join("\n");
		assert.ok(card.includes("13s") || card.includes("12s"));
	});

	it("shows tool count", () => {
		if (skip()) return;
		const card = mod!.renderCard(
			makeRunState({ progress: { toolCount: 7, lastLine: "", contextTokens: 0, elapsed: 1000 } }),
			40, theme, 1,
		).join("\n");
		assert.ok(card.includes("T:7"));
	});

	it("shows context bar when model + tokens known", () => {
		if (skip()) return;
		const card = mod!.renderCard(
			makeRunState({ model: "claude-sonnet", progress: { toolCount: 0, lastLine: "", contextTokens: 100_000, elapsed: 1000 } }),
			40, theme, 1,
		).join("\n");
		assert.ok(card.includes("[") && card.includes("]") && card.includes("%"));
	});

	it("shows description when provided", () => {
		if (skip()) return;
		const card = mod!.renderCard(makeRunState({ description: "analyzing auth" }), 40, theme, 1).join("\n");
		assert.ok(card.includes("analyzing auth"));
	});

	it("falls back to lastLine when no description", () => {
		if (skip()) return;
		const card = mod!.renderCard(
			makeRunState({ description: undefined, progress: { toolCount: 0, lastLine: "reading file.ts", contextTokens: 0, elapsed: 1000 } }),
			40, theme, 1,
		).join("\n");
		assert.ok(card.includes("reading file.ts"));
	});

	it("shows step number when present", () => {
		if (skip()) return;
		assert.ok(mod!.renderCard(makeRunState({ step: 3 }), 40, theme, 1).join("\n").includes("#3"));
	});
});
