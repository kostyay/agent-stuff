/**
 * Unit tests for pi-extensions/subagent/tui-helpers — TUI rendering primitives.
 *
 * Covers: AGENT_COLORS, agentColor, pad, fuzzyScore, fuzzyFilterAgents,
 * renderBorderRow, borderedRow.
 *
 * Requires @mariozechner/pi-tui for visibleWidth — skips gracefully if unavailable.
 *
 * Uses Node's built-in test runner (node:test + node:assert).
 * Run with: node --experimental-strip-types --test tests/subagent-tui-helpers.test.ts
 */

import { before, describe, it } from "node:test";
import assert from "node:assert/strict";

import { tryImport } from "../pi-extensions/subagent/test/helpers.ts";

let mod: typeof import("../pi-extensions/subagent/tui-helpers.ts") | null = null;

before(async () => {
	mod = await tryImport<typeof import("../pi-extensions/subagent/tui-helpers.ts")>("./tui-helpers.ts");
	if (!mod) console.log("⏭ Skipping tui-helpers tests: pi-tui not available");
});

function skip(): boolean {
	if (!mod) { console.log("  ⏭ skipped"); return true; }
	return false;
}

// ---------------------------------------------------------------------------
// AGENT_COLORS / agentColor
// ---------------------------------------------------------------------------

describe("AGENT_COLORS", () => {
	it("has at least 5 distinct colors", () => {
		if (skip()) return;
		assert.ok(new Set(mod!.AGENT_COLORS).size >= 5);
	});
});

describe("agentColor", () => {
	it("index 1 returns first color", () => {
		if (skip()) return;
		assert.equal(mod!.agentColor(1), mod!.AGENT_COLORS[0]);
	});

	it("wraps around past palette length", () => {
		if (skip()) return;
		const len = mod!.AGENT_COLORS.length;
		assert.equal(mod!.agentColor(len + 1), mod!.AGENT_COLORS[0]);
	});

	it("index 2 returns second color", () => {
		if (skip()) return;
		assert.equal(mod!.agentColor(2), mod!.AGENT_COLORS[1]);
	});
});

// ---------------------------------------------------------------------------
// pad
// ---------------------------------------------------------------------------

describe("pad", () => {
	it("pads short strings", () => {
		if (skip()) return;
		const r = mod!.pad("hi", 10);
		assert.equal(r.length, 10);
		assert.ok(r.startsWith("hi"));
	});

	it("does not truncate long strings", () => {
		if (skip()) return;
		assert.equal(mod!.pad("hello world", 5), "hello world");
	});

	it("exact length unchanged", () => {
		if (skip()) return;
		assert.equal(mod!.pad("abc", 3), "abc");
	});
});

// ---------------------------------------------------------------------------
// fuzzyScore
// ---------------------------------------------------------------------------

describe("fuzzyScore", () => {
	it("> 0 for substring match", () => {
		if (skip()) return;
		assert.ok(mod!.fuzzyScore("scout", "my-scout-agent") > 0);
	});

	it("0 for no match", () => {
		if (skip()) return;
		assert.equal(mod!.fuzzyScore("xyz", "abc"), 0);
	});

	it("case-insensitive", () => {
		if (skip()) return;
		assert.ok(mod!.fuzzyScore("SCOUT", "scout") > 0);
	});

	it("exact substring scores higher than scattered chars", () => {
		if (skip()) return;
		const exact = mod!.fuzzyScore("code", "code-reviewer");
		const scattered = mod!.fuzzyScore("code", "c-o-d-e-other");
		assert.ok(exact > scattered);
	});

	it("substring match scores >= 100", () => {
		if (skip()) return;
		assert.ok(mod!.fuzzyScore("test", "test-agent") >= 100);
	});
});

// ---------------------------------------------------------------------------
// fuzzyFilterAgents
// ---------------------------------------------------------------------------

describe("fuzzyFilterAgents", () => {
	const agents = [
		{ name: "scout", description: "Scan codebase", model: "claude-sonnet", source: "user" as const, systemPrompt: "", filePath: "/tmp/s.md" },
		{ name: "planner", description: "Create plans", model: "gpt-4o", source: "user" as const, systemPrompt: "", filePath: "/tmp/p.md" },
		{ name: "reviewer", description: "Code review", model: "claude-sonnet", source: "project" as const, systemPrompt: "", filePath: "/tmp/r.md" },
	];

	it("returns all for empty query", () => {
		if (skip()) return;
		assert.equal(mod!.fuzzyFilterAgents(agents, "").length, 3);
	});

	it("returns all for whitespace query", () => {
		if (skip()) return;
		assert.equal(mod!.fuzzyFilterAgents(agents, "  ").length, 3);
	});

	it("filters by name", () => {
		if (skip()) return;
		const r = mod!.fuzzyFilterAgents(agents, "scout");
		assert.equal(r.length, 1);
		assert.equal(r[0].name, "scout");
	});

	it("filters by description", () => {
		if (skip()) return;
		assert.ok(mod!.fuzzyFilterAgents(agents, "review").some((a) => a.name === "reviewer"));
	});

	it("filters by model", () => {
		if (skip()) return;
		assert.ok(mod!.fuzzyFilterAgents(agents, "gpt").some((a) => a.name === "planner"));
	});

	it("empty for no matches", () => {
		if (skip()) return;
		assert.equal(mod!.fuzzyFilterAgents(agents, "zzzzz").length, 0);
	});

	it("name match ranks first", () => {
		if (skip()) return;
		assert.equal(mod!.fuzzyFilterAgents(agents, "plan")[0].name, "planner");
	});
});

// ---------------------------------------------------------------------------
// renderBorderRow / borderedRow
// ---------------------------------------------------------------------------

describe("renderBorderRow", () => {
	const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t } as any;

	it("header uses top corners", () => {
		if (skip()) return;
		const r = mod!.renderBorderRow("Title", 40, theme, "header");
		assert.ok(r.includes("╭") && r.includes("╮"));
	});

	it("footer uses bottom corners", () => {
		if (skip()) return;
		const r = mod!.renderBorderRow("Title", 40, theme, "footer");
		assert.ok(r.includes("╰") && r.includes("╯"));
	});

	it("includes the text", () => {
		if (skip()) return;
		assert.ok(mod!.renderBorderRow("Hello", 40, theme, "header").includes("Hello"));
	});
});

describe("borderedRow", () => {
	const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t } as any;

	it("wraps with vertical borders", () => {
		if (skip()) return;
		const r = mod!.borderedRow("content", 20, theme);
		assert.ok(r.startsWith("│") && r.endsWith("│"));
	});
});
