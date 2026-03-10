/**
 * Unit tests for pi-extensions/subagent/utils — pure helper functions.
 *
 * Covers: zeroUsage, resultIcon, isAgentError, getErrorMessage,
 * aggregateUsage, getFinalOutput, getDisplayItems, mapWithConcurrencyLimit,
 * writePromptToTempFile, parseAgentSegments.
 *
 * Uses Node's built-in test runner (node:test + node:assert).
 * Run with: node --experimental-strip-types --test tests/subagent-utils.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";

import {
	aggregateUsage,
	getDisplayItems,
	getErrorMessage,
	getFinalOutput,
	isAgentError,
	mapWithConcurrencyLimit,
	parseAgentSegments,
	resultIcon,
	writePromptToTempFile,
	zeroUsage,
} from "../pi-extensions/subagent/utils.ts";
import type { SingleResult, UsageStats } from "../pi-extensions/subagent/types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResult(overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		agent: "test",
		agentSource: "user",
		task: "do something",
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: zeroUsage(),
		...overrides,
	};
}

function identityFg(_color: string, text: string): string {
	return text;
}

// ---------------------------------------------------------------------------
// zeroUsage
// ---------------------------------------------------------------------------

describe("zeroUsage", () => {
	it("returns all-zero stats", () => {
		const u = zeroUsage();
		assert.equal(u.input, 0);
		assert.equal(u.output, 0);
		assert.equal(u.cacheRead, 0);
		assert.equal(u.cacheWrite, 0);
		assert.equal(u.cost, 0);
		assert.equal(u.contextTokens, 0);
		assert.equal(u.turns, 0);
	});

	it("returns independent objects each call", () => {
		const a = zeroUsage();
		const b = zeroUsage();
		a.input = 999;
		assert.equal(b.input, 0);
	});
});

// ---------------------------------------------------------------------------
// resultIcon
// ---------------------------------------------------------------------------

describe("resultIcon", () => {
	it("returns hourglass for running (exitCode -1)", () => {
		assert.equal(resultIcon(makeResult({ exitCode: -1 }), identityFg), "⏳");
	});

	it("returns check for success (exitCode 0)", () => {
		assert.equal(resultIcon(makeResult({ exitCode: 0 }), identityFg), "✓");
	});

	it("returns cross for failure (exitCode > 0)", () => {
		assert.equal(resultIcon(makeResult({ exitCode: 1 }), identityFg), "✗");
	});

	it("passes correct color to theme.fg", () => {
		const colors: string[] = [];
		const captureFg = (color: string, text: string) => { colors.push(color); return text; };
		resultIcon(makeResult({ exitCode: -1 }), captureFg);
		resultIcon(makeResult({ exitCode: 0 }), captureFg);
		resultIcon(makeResult({ exitCode: 1 }), captureFg);
		assert.deepEqual(colors, ["warning", "success", "error"]);
	});
});

// ---------------------------------------------------------------------------
// isAgentError
// ---------------------------------------------------------------------------

describe("isAgentError", () => {
	it("false for clean success", () => {
		assert.equal(isAgentError(makeResult()), false);
	});

	it("true for non-zero exit code", () => {
		assert.equal(isAgentError(makeResult({ exitCode: 1 })), true);
	});

	it("true for stopReason error", () => {
		assert.equal(isAgentError(makeResult({ stopReason: "error" })), true);
	});

	it("true for stopReason aborted", () => {
		assert.equal(isAgentError(makeResult({ stopReason: "aborted" })), true);
	});

	it("false for stopReason end_turn", () => {
		assert.equal(isAgentError(makeResult({ stopReason: "end_turn" })), false);
	});
});

// ---------------------------------------------------------------------------
// getErrorMessage
// ---------------------------------------------------------------------------

describe("getErrorMessage", () => {
	it("prefers errorMessage field", () => {
		assert.equal(getErrorMessage(makeResult({ errorMessage: "rate limited", stderr: "x" })), "rate limited");
	});

	it("falls back to stderr", () => {
		assert.equal(getErrorMessage(makeResult({ stderr: "connection refused" })), "connection refused");
	});

	it("falls back to final assistant text", () => {
		const r = makeResult({
			messages: [{ role: "assistant", content: [{ type: "text", text: "went wrong" }] }] as any,
		});
		assert.equal(getErrorMessage(r), "went wrong");
	});

	it("returns (no output) as last resort", () => {
		assert.equal(getErrorMessage(makeResult()), "(no output)");
	});
});

// ---------------------------------------------------------------------------
// aggregateUsage
// ---------------------------------------------------------------------------

describe("aggregateUsage", () => {
	it("returns zeros for empty array", () => {
		const t = aggregateUsage([]);
		assert.equal(t.input, 0);
		assert.equal(t.cost, 0);
	});

	it("sums usage across results", () => {
		const u1: UsageStats = { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, cost: 0.01, contextTokens: 500, turns: 2 };
		const u2: UsageStats = { input: 200, output: 100, cacheRead: 20, cacheWrite: 10, cost: 0.02, contextTokens: 1000, turns: 3 };
		const t = aggregateUsage([makeResult({ usage: u1 }), makeResult({ usage: u2 })]);
		assert.equal(t.input, 300);
		assert.equal(t.output, 150);
		assert.equal(t.cacheRead, 30);
		assert.equal(t.cacheWrite, 15);
		assert.equal(t.turns, 5);
		assert.ok(Math.abs(t.cost - 0.03) < 0.0001);
	});

	it("omits contextTokens from result", () => {
		assert.equal("contextTokens" in aggregateUsage([makeResult()]), false);
	});
});

// ---------------------------------------------------------------------------
// getFinalOutput
// ---------------------------------------------------------------------------

describe("getFinalOutput", () => {
	it("empty string for no messages", () => {
		assert.equal(getFinalOutput([]), "");
	});

	it("returns last assistant text", () => {
		const msgs = [
			{ role: "assistant", content: [{ type: "text", text: "first" }] },
			{ role: "user", content: [{ type: "text", text: "q" }] },
			{ role: "assistant", content: [{ type: "text", text: "second" }] },
		] as any;
		assert.equal(getFinalOutput(msgs), "second");
	});

	it("ignores non-text parts", () => {
		const msgs = [{ role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: {} }] }] as any;
		assert.equal(getFinalOutput(msgs), "");
	});

	it("returns first text part in last assistant msg", () => {
		const msgs = [{
			role: "assistant",
			content: [
				{ type: "toolCall", name: "read", arguments: {} },
				{ type: "text", text: "analysis complete" },
			],
		}] as any;
		assert.equal(getFinalOutput(msgs), "analysis complete");
	});
});

// ---------------------------------------------------------------------------
// getDisplayItems
// ---------------------------------------------------------------------------

describe("getDisplayItems", () => {
	it("empty array for no messages", () => {
		assert.deepEqual(getDisplayItems([]), []);
	});

	it("collects text and toolCall from assistant messages", () => {
		const msgs = [
			{ role: "assistant", content: [{ type: "text", text: "hi" }, { type: "toolCall", name: "bash", arguments: { command: "ls" } }] },
			{ role: "user", content: [{ type: "text", text: "ignored" }] },
			{ role: "assistant", content: [{ type: "text", text: "done" }] },
		] as any;
		const items = getDisplayItems(msgs);
		assert.equal(items.length, 3);
		assert.deepEqual(items[0], { type: "text", text: "hi" });
		assert.deepEqual(items[1], { type: "toolCall", name: "bash", args: { command: "ls" } });
		assert.deepEqual(items[2], { type: "text", text: "done" });
	});

	it("skips non-assistant roles", () => {
		const msgs = [
			{ role: "user", content: [{ type: "text", text: "x" }] },
			{ role: "toolResult", content: [{ type: "text", text: "y" }] },
		] as any;
		assert.deepEqual(getDisplayItems(msgs), []);
	});
});

// ---------------------------------------------------------------------------
// mapWithConcurrencyLimit
// ---------------------------------------------------------------------------

describe("mapWithConcurrencyLimit", () => {
	it("empty input produces empty output", async () => {
		assert.deepEqual(await mapWithConcurrencyLimit([], 4, async (x) => x), []);
	});

	it("preserves order", async () => {
		assert.deepEqual(await mapWithConcurrencyLimit([1, 2, 3, 4, 5], 2, async (x) => x * 10), [10, 20, 30, 40, 50]);
	});

	it("respects concurrency limit", async () => {
		let concurrent = 0;
		let max = 0;
		await mapWithConcurrencyLimit([1, 2, 3, 4, 5, 6], 2, async (x) => {
			concurrent++;
			max = Math.max(max, concurrent);
			await new Promise((r) => setTimeout(r, 10));
			concurrent--;
			return x;
		});
		assert.ok(max <= 2, `max concurrent was ${max}`);
	});

	it("clamps concurrency to at least 1", async () => {
		assert.deepEqual(await mapWithConcurrencyLimit([1, 2], 0, async (x) => x), [1, 2]);
	});

	it("propagates first rejection", async () => {
		await assert.rejects(
			() => mapWithConcurrencyLimit([1, 2, 3], 2, async (x) => { if (x === 2) throw new Error("boom"); return x; }),
			{ message: "boom" },
		);
	});

	it("passes correct index", async () => {
		const indices: number[] = [];
		await mapWithConcurrencyLimit(["a", "b", "c"], 3, async (_, i) => { indices.push(i); });
		assert.deepEqual(indices.sort(), [0, 1, 2]);
	});
});

// ---------------------------------------------------------------------------
// writePromptToTempFile
// ---------------------------------------------------------------------------

describe("writePromptToTempFile", () => {
	it("writes prompt and returns paths", () => {
		const { dir, filePath } = writePromptToTempFile("scout", "You are a scout.");
		try {
			assert.ok(fs.existsSync(filePath));
			assert.ok(filePath.startsWith(dir));
			assert.ok(filePath.includes("prompt-scout"));
			assert.equal(fs.readFileSync(filePath, "utf-8"), "You are a scout.");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("sanitizes special characters", () => {
		const { dir, filePath } = writePromptToTempFile("my/special agent!", "p");
		try {
			assert.ok(filePath.includes("my_special_agent_"));
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("creates file with 0o600 permissions", () => {
		const { dir, filePath } = writePromptToTempFile("test", "secret");
		try {
			assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// parseAgentSegments
// ---------------------------------------------------------------------------

describe("parseAgentSegments", () => {
	it("null for undefined", () => { assert.equal(parseAgentSegments(undefined), null); });
	it("null for empty string", () => { assert.equal(parseAgentSegments(""), null); });
	it("null for whitespace", () => { assert.equal(parseAgentSegments("   "), null); });

	it("double-quoted task", () => {
		assert.deepEqual(parseAgentSegments('scout "scan the codebase"'), [{ agent: "scout", task: "scan the codebase" }]);
	});

	it("single-quoted task", () => {
		assert.deepEqual(parseAgentSegments("scout 'scan the codebase'"), [{ agent: "scout", task: "scan the codebase" }]);
	});

	it("unquoted task", () => {
		assert.deepEqual(parseAgentSegments("scout scan the codebase"), [{ agent: "scout", task: "scan the codebase" }]);
	});

	it("agent name only", () => {
		assert.deepEqual(parseAgentSegments("scout"), [{ agent: "scout", task: "" }]);
	});

	it("chain with -> separator", () => {
		assert.deepEqual(parseAgentSegments('scout "scan" -> planner "make plan"'), [
			{ agent: "scout", task: "scan" },
			{ agent: "planner", task: "make plan" },
		]);
	});

	it("chain with agent-only steps", () => {
		assert.deepEqual(parseAgentSegments('scout "initial" -> reviewer'), [
			{ agent: "scout", task: "initial" },
			{ agent: "reviewer", task: "" },
		]);
	});

	it("multiple -> segments", () => {
		assert.deepEqual(parseAgentSegments("scout a -> planner b -> worker c"), [
			{ agent: "scout", task: "a" },
			{ agent: "planner", task: "b" },
			{ agent: "worker", task: "c" },
		]);
	});

	it("surrounding whitespace", () => {
		assert.deepEqual(parseAgentSegments("  scout scan  ->  planner plan  "), [
			{ agent: "scout", task: "scan" },
			{ agent: "planner", task: "plan" },
		]);
	});

	it("null for empty segments", () => {
		assert.equal(parseAgentSegments(" -> -> "), null);
	});
});
